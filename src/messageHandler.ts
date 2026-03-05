// ---------------------------------------------------------------------------
// messageHandler.ts — Discord メッセージハンドラ（ファサード）
// ---------------------------------------------------------------------------
// 責務:
//   メインメッセージハンドラ（handleDiscordMessage, processSuggestionPrompt）を提供。
//   キュー管理は messageQueue.ts、プラン生成・確認・ディスパッチは planPipeline.ts に委譲。
//   後方互換のため、全公開シンボルを re-export する。
// プロンプト生成 → promptBuilder.ts
// ワークスペース自動切替 → workspaceResolver.ts
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { Message, TextChannel } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { WorkspaceConnectionError } from './cdpPool';
import { ChannelIntent } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { DiscordBot } from './discordBot';
import { downloadAttachments } from './attachmentDownloader';
import { BridgeContext } from './bridgeContext';
import { isUserAllowed, getMaxMessageLength } from './configHelper';
import { getCurrentModel } from './cdpModels';
import { getCurrentMode } from './cdpModes';
import { AUTO_PROMPT } from './suggestionButtons';
import { loadTeamConfig } from './teamConfig';
import { FileIpc } from './fileIpc';
import { getLicenseGate } from './extension';
import { FREE_DAILY_TASK_LIMIT, FREE_WEEKLY_TASK_LIMIT } from './licensing/licenseGate';
import { t } from './i18n';

// 委譲先モジュール
import {
    DEFAULT_WS_KEY,
    setProcessingStatus,
    deleteProcessingStatus,
    getQueueCount,
    setQueueCount,
    getWorkspaceQueue,
    setWorkspaceQueue,
} from './messageQueue';
import {
    resolveReplyContext,
    acquireCdpConnection,
    generatePlan,
    handleConfirmation,
    applyChoiceSelection,
    dispatchPlan,
} from './planPipeline';

// ---------------------------------------------------------------------------
// Re-export for backward compatibility
// 他のファイルが messageHandler からインポートしているシンボルをすべて re-export
// ---------------------------------------------------------------------------
export { buildPlanPrompt, cronToPrefix } from './promptBuilder';
export type { ProcessingPhase } from './messageQueue';
export type { ProcessingStatus } from './messageQueue';
export {
    resetProcessingFlag,
    cancelPlanGeneration,
    getMessageQueueStatus,
    clearWaitingMessages,
    removeWaitingMessage,
    editWaitingMessage,
    getWaitingMessageContent,
} from './messageQueue';


// ---------------------------------------------------------------------------
// メインディスパッチャー
// ---------------------------------------------------------------------------

export async function handleDiscordMessage(
    ctx: BridgeContext,
    message: Message,
    intent: ChannelIntent,
    channelName: string,
): Promise<void> {
    let text = message.content.trim();
    if (!text && message.attachments.size === 0) { return; }

    const channel = message.channel as TextChannel;

    // セキュリティ: 許可ユーザーID制限
    const authResult = isUserAllowed(message.author.id);
    if (!authResult.allowed) {
        logWarn(`handleDiscordMessage: user ${message.author.tag} (${message.author.id}) not allowed — ${authResult.reason}`);
        await channel.send({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)] });
        return;
    }

    // セキュリティ: メッセージ長制限
    const maxLen = getMaxMessageLength();
    if (maxLen > 0 && text.length > maxLen) {
        logWarn(`handleDiscordMessage: message too long (${text.length} > ${maxLen}) from ${message.author.tag}`);
        await channel.send({ embeds: [buildEmbed(`⚠️ メッセージが長すぎます（${text.length}文字）。上限は ${maxLen} 文字です。`, EmbedColor.Warning)] });
        return;
    }

    // 返信コンテキスト解決
    text = await resolveReplyContext(channel, text, message.reference ?? undefined);

    // 依存モジュールの検証
    const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel) ?? undefined;
    const { bot, fileIpc, planStore, scheduler, cdp, cdpPool, executor } = ctx;
    if (!fileIpc || !planStore || !scheduler || !bot) {
        await channel.send({ embeds: [buildEmbed('⚠️ Bridge の内部モジュールが初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    const useCdpPool = !!cdpPool;
    if (!useCdpPool && (!cdp || !executor)) {
        await channel.send({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
        return;
    }

    // -----------------------------------------------------------------------
    // チームモード判定: 有効時もメインエージェントがオーケストレーターとして実行
    // （Plan 生成 → 承認 → メインエージェントで実行。サブエージェントはメインが指揮）
    // -----------------------------------------------------------------------
    // ワークスペースパスの解決: Discordカテゴリー → ワークスペースパス設定 → フォールバック
    const resolvedRepoRoot = (() => {
        if (wsNameFromCategory) {
            const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
            if (wsPaths[wsNameFromCategory]) {
                return wsPaths[wsNameFromCategory];
            }
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    })();
    let isTeamMode = false;
    if (resolvedRepoRoot) {
        const teamConfig = loadTeamConfig(resolvedRepoRoot);
        if (teamConfig.enabled && ctx.teamOrchestrator) {
            // チームモードの Pro 限定チェック
            const gate = getLicenseGate();
            if (gate && !gate.isFeatureAllowed('teamMode')) {
                await channel.send({ embeds: [buildEmbed(t('team.proRequired'), EmbedColor.Warning)] });
                return;
            }
            isTeamMode = true;
            logDebug(`handleDiscordMessage: Team mode enabled for workspace "${wsNameFromCategory || 'local'}" (repoRoot=${resolvedRepoRoot}) — main agent will orchestrate`);
        }
    }

    // メッセージプレビュー（ステータス追跡用）
    const msgPreview = text.substring(0, 50) + (text.length > 50 ? '...' : '') || '（添付ファイル）';
    const wsKeyForStatus = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    try {
        logDebug(`handleDiscordMessage: processing #${channelName} (intent = ${intent}) message: (${text.length} chars)`);

        // ステータス: 接続中
        setProcessingStatus(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'connecting', startTime: Date.now(), messagePreview: msgPreview,
        });

        // CDP 接続の取得
        const connResult = await acquireCdpConnection(ctx, channel, wsNameFromCategory, fileIpc);
        if (!connResult) { return; }
        const { cdp: activeCdp, autoLaunched } = connResult;

        // ACK 送信（モデル/モード情報付き）
        try {
            // cascade コンテキスト汚染防止（接続処理後の残留コンテキストをリセット）
            activeCdp.ops.resetCascadeContext();
            // 直列呼び出し（並列だと cascade コンテキストが競合して取得失敗する）
            const currentMode = await getCurrentMode(activeCdp.ops).catch(() => null);
            activeCdp.ops.resetCascadeContext();
            const currentModel = await getCurrentModel(activeCdp.ops).catch(() => null);
            if (currentModel) { ctx.bot?.setModelName(currentModel); }
            const parts = [currentMode, currentModel].filter(Boolean);
            const ackPrefix = parts.length > 0 ? `[${parts.join(' - ')}]` : '';
            await channel.send({ embeds: [buildEmbed(`🔄 ${ackPrefix} 伝令中...`, EmbedColor.Info)] });
        } catch (sendErr) {
            logError('handleDiscordMessage: failed to send acknowledgement', sendErr);
        }

        // 添付ファイルのダウンロード
        let attachmentPaths: string[] | undefined;
        if (message.attachments.size > 0) {
            logDebug(`handleDiscordMessage: downloading ${message.attachments.size} attachment(s)...`);
            const downloaded = await downloadAttachments(message.attachments, fileIpc.getStoragePath(), fileIpc.createRequestId().requestId);
            if (downloaded.length > 0) {
                attachmentPaths = downloaded.map(d => d.localPath);
                logDebug(`handleDiscordMessage: ${downloaded.length} attachment(s) saved`);
            }
        }
        const resolvedWsPath = wsNameFromCategory ? (ctx.cdpPool?.getResolvedWorkspacePaths() ?? {})[wsNameFromCategory] : undefined;

        // ステータス: Plan 生成中
        setProcessingStatus(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'plan_generating', startTime: Date.now(), messagePreview: msgPreview,
        });

        // Plan 生成
        const result = await generatePlan(
            activeCdp, autoLaunched, fileIpc, channel, text, intent, channelName,
            attachmentPaths, ctx.extensionPath, resolvedWsPath,
        );
        if (!result) { return; }
        const { plan, guild } = result;

        // 計画詳細を Discord に表示
        try {
            const summaryText = plan.action_summary || plan.discord_templates.ack || plan.human_summary
                || plan.prompt.substring(0, 100) + (plan.prompt.length > 100 ? '...' : '');
            const lines: string[] = [];
            lines.push(`📋 **概要:** ${summaryText}`);

            // タスク一覧
            if (plan.tasks && plan.tasks.length > 0) {
                lines.push('');
                lines.push('**タスク:**');
                for (let i = 0; i < plan.tasks.length; i++) {
                    const task = plan.tasks[i];
                    const preview = task.length > 80 ? task.substring(0, 80) + '...' : task;
                    lines.push(`- **${i + 1}.** ${preview}`);
                }
            }

            // 対象ファイル
            if (plan.affected_files && plan.affected_files.length > 0) {
                lines.push('');
                lines.push('**対象ファイル:**');
                for (const file of plan.affected_files) {
                    lines.push(`- \`${file}\``);
                }
            }

            await channel.send({
                embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)]
            });
        } catch (detailErr) {
            logDebug(`handleDiscordMessage: failed to send plan detail: ${detailErr}`);
        }

        // ACK 送信
        if (plan.discord_templates.ack) {
            await channel.send({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
        }

        // 確認フロー
        if (plan.requires_confirmation) {
            // ステータス: 確認待ち
            setProcessingStatus(wsKeyForStatus, {
                wsKey: wsKeyForStatus, phase: 'confirming', startTime: Date.now(), messagePreview: msgPreview,
            });
            const confirmResult = await handleConfirmation(plan, channel, bot);
            if (confirmResult.agentDelegated) {
                // エージェント委任: AUTO_PROMPT を processSuggestionPrompt 経由で実行
                processSuggestionPrompt(ctx, channel.id, AUTO_PROMPT, message.author.id).catch((e: unknown) => {
                    logError('agent delegation from confirmation: processSuggestionPrompt failed', e);
                });
                return;
            }
            if (!confirmResult.confirmed) { return; }
            applyChoiceSelection(plan, confirmResult.selectedChoices);
        }

        // チームモード: サブエージェント向けのタスク指示を付加
        if (isTeamMode) {
            plan.prompt = `【サブエージェントタスク】以下のタスクを実行してください。\n` +
                `結果は明確かつ詳細に記述してください。\n\n` +
                plan.prompt;
            logDebug(`handleDiscordMessage: Team mode — augmented prompt with subagent instructions`);
        }

        // タスク制限チェック（Free プラン用）
        const taskGate = getLicenseGate();
        if (taskGate && !taskGate.canExecuteTask()) {
            const exceeded = taskGate.getExceededLimit();
            const msg = exceeded === 'daily'
                ? t('pipeline.taskLimitReached', String(FREE_DAILY_TASK_LIMIT))
                : t('pipeline.weeklyLimitReached', String(FREE_WEEKLY_TASK_LIMIT));
            await channel.send({ embeds: [buildEmbed(msg, EmbedColor.Warning)] });
            return;
        }

        // ステータス: ディスパッチ中
        setProcessingStatus(wsKeyForStatus, {
            wsKey: wsKeyForStatus, phase: 'dispatching', startTime: Date.now(), messagePreview: msgPreview,
        });

        // タスクカウントをインクリメント
        if (taskGate) { await taskGate.incrementTaskCount(); }

        // 即時実行 or 定期登録
        await dispatchPlan(ctx, plan, channel, activeCdp, wsNameFromCategory, guild, isTeamMode);

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('aborted')) {
            logDebug(`handleDiscordMessage: aborted (expected via /stop)`);
        } else {
            logError('handleDiscordMessage failed', e);
            await channel.send({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
        }
    } finally {
        // 処理完了時にステータスをクリア
        deleteProcessingStatus(wsKeyForStatus);
    }
}

// ---------------------------------------------------------------------------
// 提案ボタンからのプロンプト処理（handleDiscordMessage の簡易版）
// ---------------------------------------------------------------------------

/**
 * 提案ボタンクリック時に呼ばれる。channelId とプロンプトテキストを受け取り、
 * メッセージパイプライン（Plan 生成→確認→実行）に流す。
 */
export async function processSuggestionPrompt(
    ctx: BridgeContext,
    channelId: string,
    promptText: string,
    userId: string,
): Promise<void> {
    // 認証チェック
    const authResult = isUserAllowed(userId);
    if (!authResult.allowed) {
        logWarn(`processSuggestionPrompt: user ${userId} not allowed — ${authResult.reason}`);
        return;
    }

    // Bot & FileIpc チェック
    const { bot, fileIpc, cdpPool, cdp: fallbackCdp } = ctx;
    if (!bot || !fileIpc) {
        logWarn('processSuggestionPrompt: bot or fileIpc not initialized');
        return;
    }

    const client = (bot as any).client;
    if (!client) {
        logWarn('processSuggestionPrompt: bot client not available');
        return;
    }

    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !(fetched instanceof TextChannel)) {
            logWarn(`processSuggestionPrompt: channel ${channelId} not found or not text channel`);
            return;
        }
        channel = fetched;
    } catch (e) {
        logWarn(`processSuggestionPrompt: failed to fetch channel ${channelId}: ${e instanceof Error ? e.message : e}`);
        return;
    }

    const channelName = channel.name;
    logDebug(`processSuggestionPrompt: processing suggestion in #${channelName} (${promptText.length} chars)`);

    // ワークスペース解決
    const wsKey = DiscordBot.resolveWorkspaceFromChannel(channel) || DEFAULT_WS_KEY;

    // キューに追加して直列処理
    const prevCount = getQueueCount(wsKey);
    setQueueCount(wsKey, prevCount + 1);

    const currentQueue = getWorkspaceQueue(wsKey);
    const task = currentQueue.then(async () => {
        try {
            // ACK 送信
            try {
                await channel.send({ embeds: [buildEmbed('💡 提案されたタスクを実行中...', EmbedColor.Info)] });
            } catch { /* ignore */ }

            // ワークスペース解決（カテゴリーから特定）
            const wsNameFromCategory = DiscordBot.resolveWorkspaceFromChannel(channel);

            // CdpBridge 取得
            setProcessingStatus(wsKey, {
                wsKey, phase: 'connecting', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            let activeCdp: CdpBridge;
            if (wsNameFromCategory && cdpPool) {
                try {
                    activeCdp = await cdpPool.acquire(wsNameFromCategory);
                } catch (e) {
                    logError(`processSuggestionPrompt: failed to acquire CdpBridge for workspace "${wsNameFromCategory}"`, e);
                    const displayMsg = (e instanceof WorkspaceConnectionError)
                        ? e.userMessage
                        : `ワークスペース "${wsNameFromCategory}" への接続に失敗しました: ${sanitizeErrorForDiscord(e instanceof Error ? e.message : String(e))}`;
                    await channel.send({ embeds: [buildEmbed(`⚠️ ${displayMsg}`, EmbedColor.Warning)] });
                    return;
                }
            } else if (fallbackCdp) {
                activeCdp = fallbackCdp;
            } else {
                await channel.send({ embeds: [buildEmbed('⚠️ Bridge が未接続です。`/status` を確認してください。', EmbedColor.Warning)] });
                return;
            }

            // Plan 生成ステータス
            setProcessingStatus(wsKey, {
                wsKey, phase: 'plan_generating', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            const wsPaths = cdpPool?.getResolvedWorkspacePaths() ?? {};
            const resolvedWsPath = wsNameFromCategory ? wsPaths[wsNameFromCategory] : undefined;

            const result = await generatePlan(
                activeCdp, false, fileIpc, channel,
                promptText, 'agent-chat', channelName,
                undefined, ctx.extensionPath, resolvedWsPath,
            );
            if (!result) { return; }

            const { plan, guild } = result;

            // 確認フロー
            if (plan.requires_confirmation) {
                setProcessingStatus(wsKey, {
                    wsKey, phase: 'confirming', startTime: Date.now(),
                    messagePreview: promptText.substring(0, 50),
                });
                const confirmResult = await handleConfirmation(plan, channel, bot);
                if (confirmResult.agentDelegated) {
                    processSuggestionPrompt(ctx, channel.id, AUTO_PROMPT, userId).catch((e: unknown) => {
                        logError('agent delegation from suggestion confirmation: processSuggestionPrompt failed', e);
                    });
                    return;
                }
                if (!confirmResult.confirmed) { return; }
                applyChoiceSelection(plan, confirmResult.selectedChoices);
            }

            // タスク制限チェック（Free プラン用）
            const taskGate = getLicenseGate();
            if (taskGate && !taskGate.canExecuteTask()) {
                const exceeded = taskGate.getExceededLimit();
                const msg = exceeded === 'daily'
                    ? t('pipeline.taskLimitReached', String(FREE_DAILY_TASK_LIMIT))
                    : t('pipeline.weeklyLimitReached', String(FREE_WEEKLY_TASK_LIMIT));
                await channel.send({ embeds: [buildEmbed(msg, EmbedColor.Warning)] });
                return;
            }

            // ディスパッチ
            setProcessingStatus(wsKey, {
                wsKey, phase: 'dispatching', startTime: Date.now(),
                messagePreview: promptText.substring(0, 50),
            });

            // タスクカウントをインクリメント
            if (taskGate) { await taskGate.incrementTaskCount(); }

            await dispatchPlan(ctx, plan, channel, activeCdp, wsNameFromCategory ?? undefined, guild);
        } catch (e) {
            logError('processSuggestionPrompt failed', e);
            const errMsg = e instanceof Error ? e.message : String(e);
            await channel.send({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
        } finally {
            const count = getQueueCount(wsKey);
            setQueueCount(wsKey, Math.max(0, count - 1));
            deleteProcessingStatus(wsKey);
        }
    });
    setWorkspaceQueue(wsKey, task);
}

// ---------------------------------------------------------------------------
// enqueueMessage — レガシーラッパー
// ---------------------------------------------------------------------------
// 元の enqueueMessage は messageQueue.ts に移動したが、外部から import されている。
// messageQueue.ts の enqueueMessage は handleFn を引数に取るため、ここでラップする。
// ---------------------------------------------------------------------------

import { enqueueMessage as enqueueMessageInternal } from './messageQueue';

export async function enqueueMessage(
    ctx: BridgeContext,
    message: Message,
    intent: ChannelIntent,
    channelName: string,
): Promise<void> {
    return enqueueMessageInternal(ctx, message, intent, channelName, handleDiscordMessage);
}
