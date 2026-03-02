// ---------------------------------------------------------------------------
// adminHandler.ts — 管理系スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   /status, /schedules, /cancel, /newchat, /workspace, /queue,
//   /templates, /model, /mode, /suggest, /pro, /team コマンドの処理
// ---------------------------------------------------------------------------
import * as vscode from 'vscode';
import {
    ChatInputCommandInteraction,
    TextChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logError, logWarn } from './logger';
import { isDeveloper } from './accessControl';
import { buildEmbed, EmbedColor } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildHistoryListEmbed } from './historyButtons';
import { openHistoryAndGetSections, closePopup, debugConversationAttributes, type ConversationSection } from './cdpHistory';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getCurrentModel, getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getCurrentMode, getAvailableModes, selectMode } from './cdpModes';
import { loadTeamConfig, saveTeamConfig } from './teamConfig';
import { BridgeContext } from './bridgeContext';
import { resetProcessingFlag, getMessageQueueStatus, cancelPlanGeneration, enqueueMessage, clearWaitingMessages } from './messageHandler';
import type { ProcessingPhase } from './messageHandler';
import { getTimezone } from './configHelper';
import { DiscordBot } from './discordBot';
import { getRunningWsNames, buildWorkspaceListEmbed } from './workspaceHandler';
import { fetchQuota } from './quotaProvider';
import { buildTemplateListPanel } from './templateHandler';
import { SUGGEST_AUTO_ID } from './suggestionButtons';
import { readAnticrowMd } from './anticrowCustomizer';

// ---------------------------------------------------------------------------
// コマンドハンドラ（各コマンドの処理を独立関数に分離）
// ---------------------------------------------------------------------------

type CommandHandler = (ctx: BridgeContext, interaction: ChatInputCommandInteraction) => Promise<void>;

/**
 * チャンネルカテゴリーから対象ワークスペースを解決し、
 * cdpPool から正しい CdpBridge を取得する共通ヘルパー。
 * フォールバックとして ctx.cdp（デフォルト）を返す。
 */
function resolveTargetCdp(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): { cdp: BridgeContext['cdp']; wsKey: string | null } {
    const channel = interaction.channel as TextChannel | null;
    const wsKey = channel ? DiscordBot.resolveWorkspaceFromChannel(channel) : null;
    let cdp = ctx.cdp;
    if (wsKey && ctx.cdpPool) {
        const poolCdp = ctx.cdpPool.getActive(wsKey);
        if (poolCdp) {
            cdp = poolCdp;
            logDebug(`resolveTargetCdp: using cdpPool for workspace "${wsKey}"`);
        } else {
            logDebug(`resolveTargetCdp: cdp for workspace "${wsKey}" not active, fallback to default`);
        }
    }
    return { cdp, wsKey };
}

async function handleStatus(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const { cdp, wsKey } = resolveTargetCdp(ctx, interaction);
    const { bot, scheduler, executor } = ctx;
    const cdpOk = cdp ? await cdp.testConnection() : false;
    const botOk = bot?.isReady() || false;
    const scheduledIds = scheduler?.getRegisteredPlanIds() || [];
    const execQueueLen = executor?.queueLength() || 0;
    const isRunning = executor?.isRunning() || false;
    const activeTarget = cdp?.getActiveTargetTitle() || '未接続';

    const msgQueue = getMessageQueueStatus();
    let queueDisplay: string;
    if (msgQueue.total === 0 && execQueueLen === 0) {
        queueDisplay = '0件 (待機)';
    } else {
        const parts: string[] = [];
        if (msgQueue.total > 0) { parts.push(`メッセージ処理中/待機: ${msgQueue.total}件`); }
        if (execQueueLen > 0) { parts.push(`実行キュー: ${execQueueLen}件`); }
        queueDisplay = `${parts.join(' / ')} ${isRunning ? '(実行中)' : ''}`;
    }

    // モデル・モード・クォータ情報を取得（CDP 接続時のみ）
    let modelDisplay = '取得不可';
    let modeDisplay = '取得不可';
    let quotaDisplay = '';

    if (cdpOk && cdp) {
        try {
            // cascade コンテキスト汚染防止 + 直列呼び出し（並列だと競合する）
            cdp.ops.resetCascadeContext();
            const modelName = await getCurrentModel(cdp.ops).catch(() => null);
            cdp.ops.resetCascadeContext();
            const modeName = await getCurrentMode(cdp.ops).catch(() => null);
            // UIボタン名の誤検出を防ぐバリデーション
            const isValidName = (name: string | null): boolean => {
                if (!name || name.length < 2) return false;
                const lower = name.toLowerCase();
                // キーボードショートカットを含む文字列は除外
                if (/ctrl\+|alt\+|shift\+/.test(lower)) return false;
                // 既知のUIボタン名を除外
                const uiPatterns = ['閉じる', 'close', 'その他の操作', '次に進む', '前に戻る',
                    'エディター', 'editor', 'コミット', 'commit', '破棄', 'discard',
                    '受け入れる', 'accept', '分割', 'split', '検索', 'search',
                    '置換', 'replace', '保存', 'save', '実行', 'run', 'debug',
                    'undo', 'redo', '元に戻す', 'やり直し', 'toggle', 'explorer',
                    'terminal', 'problems', 'output'];
                for (const p of uiPatterns) {
                    if (lower.includes(p)) return false;
                }
                return true;
            };
            if (isValidName(modelName)) { modelDisplay = modelName!; }
            if (isValidName(modeName)) { modeDisplay = modeName!; }
        } catch (e) {
            logWarn(`handleStatus: model/mode fetch failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    // クォータ情報取得（CDP 不要）
    try {
        const quotaData = await fetchQuota();
        if (quotaData && quotaData.models.length > 0) {
            // 残量が少ない順にソートして上位3つを表示
            const sorted = [...quotaData.models].sort((a, b) => a.remainingPercentage - b.remainingPercentage);
            const top = sorted.slice(0, 3);
            const quotaEmoji = (pct: number) => pct <= 0 ? '🔴' : pct <= 20 ? '🟠' : pct <= 50 ? '🟡' : '🟢';
            quotaDisplay = top.map(q => `${quotaEmoji(q.remainingPercentage)} ${q.displayName}: ${q.remainingPercentage}%`).join(' / ');
        }
    } catch {
        // クォータ取得失敗は無視
    }

    const wsLabel = wsKey ? ` (${wsKey})` : '';
    const lines = [
        `📊 **AntiCrow 状態**${wsLabel}`,
        `- Discord Bot: ${botOk ? '🟢 オンライン' : '🔴 オフライン'}`,
        `- Antigravity 接続: ${cdpOk ? '🟢 接続済み' : '🔴 未接続'}`,
        `- アクティブターゲット: ${activeTarget}`,
        `- 🤖 モデル: ${modelDisplay}`,
        `- 🎛️ モード: ${modeDisplay}`,
        `- スケジュール中: ${scheduledIds.length}件`,
        `- キュー: ${queueDisplay}`,
    ];

    if (quotaDisplay) {
        lines.push(`- 📊 クォータ: ${quotaDisplay}`);
    }

    await interaction.editReply({ embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)] });
}

async function handleSchedules(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { planStore } = ctx;
    if (!planStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ PlanStore が初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    const plans = planStore.getAll();
    const timezone = getTimezone();
    const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
    await interaction.reply({ embeds, components: components as any });
}

async function handleCancel(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { executor } = ctx;
    const { cdp: targetCdp, wsKey: resolvedWsKey } = resolveTargetCdp(ctx, interaction);
    try {
        // wsKey が null の場合、ExecutorPool のサイズで自動解決を試みる
        // → 1WS なら唯一の WS を対象に、複数WS なら対象特定不能エラー
        let wsKey = resolvedWsKey;
        if (!wsKey && ctx.executorPool) {
            const wsNames = ctx.executorPool.getWorkspaceNames();
            if (wsNames.length === 1) {
                wsKey = wsNames[0];
                logDebug(`handleCancel: wsKey auto-resolved to "${wsKey}" (single workspace in pool)`);
            } else if (wsNames.length > 1) {
                // 複数 WS が存在し対象を特定できない場合はエラー
                logWarn(`handleCancel: cannot resolve target workspace (pool has ${wsNames.length} workspaces: ${wsNames.join(', ')})`);
                await interaction.reply({
                    embeds: [buildEmbed(
                        `⚠️ 対象ワークスペースを特定できません。\n\n` +
                        `現在 ${wsNames.length} 個のワークスペースが接続中です:\n` +
                        wsNames.map(n => `- ${n}`).join('\n') + '\n\n' +
                        `キャンセルしたいワークスペースのカテゴリー配下のチャンネルから \`/cancel\` を送信してください。`,
                        EmbedColor.Warning,
                    )],
                });
                return;
            }
            // wsNames.length === 0: プールが空 → そのまま続行（既存の動作）
        }

        // ワークスペース単位でリセット
        resetProcessingFlag(wsKey ?? undefined);
        cancelPlanGeneration(wsKey ?? undefined);

        // Executor 停止もワークスペース単位
        let execRunning = false;
        let poolRunning = false;
        if (wsKey) {
            // 対象ワークスペースの Executor のみ停止
            execRunning = executor?.isRunning() || false;
            poolRunning = ctx.executorPool?.isRunning(wsKey) || false;
            if (execRunning) { executor?.forceStop(); }
            ctx.executorPool?.forceStop(wsKey);
            logDebug(`handleCancel: /cancel executed — workspace "${wsKey}" stopped`);
        } else {
            // プールが空または未初期化: デフォルト executor のみ停止（後方互換）
            execRunning = executor?.isRunning() || false;
            if (execRunning) { executor?.forceStop(); }
            logDebug('handleCancel: /cancel executed — default executor stopped (no pool entries)');
        }

        let cancelResult = 'CDP未接続';

        if (targetCdp) {
            try {
                cancelResult = await targetCdp.clickCancelButton();
            } catch (e) {
                cancelResult = `エラー: ${e instanceof Error ? e.message : e}`;
                logWarn(`handleCancel: clickCancelButton failed: ${cancelResult}`);
            }
        }

        const debugInfo = [
            `対象WS: ${wsKey || 'デフォルト'}`,
            `executor実行中: ${execRunning}`,
            `pool実行中: ${poolRunning}`,
            `Antigravity停止: ${cancelResult}`,
        ].join('\n');

        // Escape フォールバックのみで停止した場合はメッセージを補足
        const escapeOnly = cancelResult.includes('escape:SENT') && !cancelResult.includes(':OK');
        const wsLabel = wsKey ? ` (${wsKey})` : '';
        const statusMsg = escapeOnly
            ? `⏹️ キャンセルしました${wsLabel}（Escape キーで停止）。\n- 実行中のジョブ → キャンセル\n- キュー内の待機ジョブ → 保持\n\n⚠️ キャンセルボタンが見つからず Escape キーで停止しました。`
            : `⏹️ キャンセルしました${wsLabel}。\n- 実行中のジョブ → キャンセル\n- キュー内の待機ジョブ → 保持`;

        // デバッグ情報は開発者のみ表示
        const replyMsg = isDeveloper(interaction.user.id)
            ? `${statusMsg}\n\n\`\`\`\n${debugInfo}\n\`\`\``
            : statusMsg;
        await interaction.reply({ embeds: [buildEmbed(replyMsg, EmbedColor.Success)] });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleCancel: /cancel failed', e);
        await interaction.reply({ embeds: [buildEmbed(`❌ キャンセル失敗: ${errMsg}`, EmbedColor.Error)] });
    }
}

async function handleNewchat(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { cdp } = resolveTargetCdp(ctx, interaction);
    try {
        if (cdp) {
            await cdp.startNewChat();
            logDebug('handleNewchat: new chat started via Ctrl+Shift+L');
            await interaction.reply({ embeds: [buildEmbed('🆕 新しいチャットを開きました。', EmbedColor.Success)] });
        } else {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleNewchat: failed', e);
        await interaction.reply({ embeds: [buildEmbed(`❌ 新しいチャットの開始に失敗: ${errMsg}`, EmbedColor.Error)] });
    }
}

async function handleWorkspaces(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    try {
        await interaction.deferReply();
        const { embeds, components } = await buildWorkspaceListEmbed(ctx);

        if (embeds.length === 0) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity ワークスペースが見つかりませんでした。Antigravity が起動しているか確認してください。', EmbedColor.Warning)] });
            return;
        }
        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleWorkspaces: failed', e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [buildEmbed(`❌ ワークスペース検出失敗: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        } else {
            await interaction.reply({ embeds: [buildEmbed(`❌ ワークスペース検出失敗: ${errMsg}`, EmbedColor.Error)] });
        }
    }
}

async function handleQueue(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { executor } = ctx;
    const queueInfo = executor?.getQueueInfo();
    if (!queueInfo) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ Executor が初期化されていません。', EmbedColor.Warning)] });
        return;
    }

    const msgQueue = getMessageQueueStatus();
    const hasAnything = !!(queueInfo.current || queueInfo.pending.length > 0 || msgQueue.processing.length > 0 || msgQueue.waiting.length > 0);

    const phaseLabels: Record<ProcessingPhase, string> = {
        connecting: '🔌 接続中',
        plan_generating: '🧠 Plan 生成中',
        confirming: '⏸️ 確認待ち',
        dispatching: '📤 ディスパッチ中',
    };

    const lines: string[] = ['📋 **キュー状態**'];

    // メッセージ処理パイプライン（前段）— processing/waiting 配列から直接表示
    if (msgQueue.processing.length > 0 || msgQueue.waiting.length > 0) {
        const totalCount = msgQueue.processing.length + msgQueue.waiting.length;
        lines.push(`\n📨 **メッセージ処理中:** ${totalCount}件`);
        // 処理中の詳細ステータス
        for (const ps of msgQueue.processing) {
            const elapsed = Math.round((Date.now() - ps.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
            const label = phaseLabels[ps.phase] || ps.phase;
            lines.push(`  - ${label}: ${ps.messagePreview} (${timeStr}経過)`);
        }
        // 待機中メッセージの内容表示
        if (msgQueue.waiting.length > 0) {
            lines.push(`  - ⏳ **待機中: ${msgQueue.waiting.length}件**`);
            for (const w of msgQueue.waiting) {
                const elapsed = Math.round((Date.now() - w.enqueuedAt) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                const timeStr = minutes > 0 ? `${minutes}分${seconds}秒前` : `${seconds}秒前`;
                const preview = w.preview || '(内容なし)';
                lines.push(`    - ${preview}${preview.length >= 50 ? '...' : ''} (${timeStr})`);
            }
        }
    } else {
        lines.push('\n📨 メッセージ処理キュー: なし');
    }

    // 実行キュー（パイプライン後段）— タスクがある場合のみ表示
    if (queueInfo.current) {
        const elapsed = Math.round((Date.now() - queueInfo.current.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
        const summary = queueInfo.current.plan.human_summary || queueInfo.current.plan.plan_id;
        lines.push(`\n🔄 **実行中:** ${summary} (${timeStr}経過)`);
    }

    if (queueInfo.pending.length > 0) {
        lines.push(`\n⏳ **実行待ち:** ${queueInfo.pending.length}件`);
        queueInfo.pending.forEach((p, i) => {
            const summary = p.human_summary || p.plan_id;
            lines.push(`${i + 1}. ${summary}`);
        });
    }

    if (!hasAnything) {
        lines.push('\n✅ すべてのキューが空です。');
    }

    // 待機中メッセージがある場合はボタンを追加
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (msgQueue.waiting.length > 0) {
        // 個別ボタン: 1件につき編集+削除の ActionRow（全削除ボタン行を含め最大5行）
        const maxRows = Math.min(msgQueue.waiting.length, 4); // 全削除ボタンの行を残す
        for (let i = 0; i < maxRows; i++) {
            const w = msgQueue.waiting[i];
            // customId は100文字制限、ラベルは80文字制限
            const idSuffix = w.id.length > 70 ? w.id.substring(0, 70) : w.id;
            const label = w.preview
                ? (w.preview.length > 15 ? w.preview.substring(0, 15) + '…' : w.preview)
                : `#${i + 1}`;
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`queue_edit_waiting_${idSuffix}`)
                    .setLabel(`✏️ ${label}`)
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`queue_remove_waiting_${idSuffix}`)
                    .setLabel(`❌ 削除`)
                    .setStyle(ButtonStyle.Secondary),
            );
            components.push(row);
        }

        // 全削除ボタン
        const clearRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('queue_clear_waiting')
                .setLabel(`🗑️ 待機キュー全削除 (${msgQueue.waiting.length}件)`)
                .setStyle(ButtonStyle.Danger),
        );
        components.push(clearRow);
    }

    await interaction.reply({ embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)], components: components as any });
}

async function handleTemplate(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)] });
        return;
    }
    const { embeds, components } = buildTemplateListPanel(templateStore);
    await interaction.reply({ embeds, components: components as any });
}

async function handleModels(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const { cdp } = resolveTargetCdp(ctx, interaction);
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        logDebug('handleModels: starting getAvailableModels');
        const { models, current, debugLog } = await getAvailableModels(cdp.ops);
        logDebug(`handleModels: got ${models.length} models, current=${current}`);

        // デバッグログファイル書き込みは開発者のみ
        const isDevUser = isDeveloper(interaction.user.id);
        if (isDevUser && ctx.fileIpc) {
            try {
                const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'models_debug.json');
                fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                logDebug(`handleModels: debug log saved to ${debugPath}`);
            } catch (writeErr) {
                logWarn(`handleModels: failed to write debug log: ${writeErr}`);
            }
        }

        if (models.length === 0) {
            if (isDevUser) {
                const stepSummary = debugLog.map(e => `${e.step}: ${e.success ? '✅' : '❌'}`).join(' → ');
                const debugLines = [
                    '🔍 **モデル取得デバッグ情報**',
                    '',
                    `**ステップ**: ${stepSummary || '(なし)'}`,
                    '',
                    '**詳細ログ:**',
                    '```json',
                    JSON.stringify(debugLog, null, 2).substring(0, 800),
                    '```',
                ];
                await interaction.editReply({ embeds: [buildEmbed(debugLines.join('\n'), EmbedColor.Warning)] });
            } else {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ モデル一覧を取得できませんでした。Antigravity の状態を確認してください。', EmbedColor.Warning)] });
            }
            return;
        }

        const quotaData = await fetchQuota();
        if (quotaData) {
            logDebug(`handleModels: quota fetched: ${quotaData.models.length} models, account=${quotaData.accountLevel}`);
        } else {
            logWarn('handleModels: fetchQuota returned null');
        }

        const { embeds, components } = buildModelListEmbed(models, current, quotaData?.models);
        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleModels: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(`❌ モデル一覧取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
    }
}

async function handleMode(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const { cdp } = resolveTargetCdp(ctx, interaction);
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        logDebug('handleMode: starting getAvailableModes');
        const { modes, current, debugLog } = await getAvailableModes(cdp.ops);
        logDebug(`handleMode: got ${modes.length} modes, current=${current}`);

        // デバッグログファイル書き込みは開発者のみ
        const isDevUser = isDeveloper(interaction.user.id);
        if (isDevUser && ctx.fileIpc) {
            try {
                const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'modes_debug.json');
                fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                logDebug(`handleMode: debug log saved to ${debugPath}`);
            } catch (writeErr) {
                logWarn(`handleMode: failed to write debug log: ${writeErr}`);
            }
        }

        if (modes.length === 0) {
            if (isDevUser) {
                const stepSummary = debugLog.map(e => `${e.step}: ${e.success ? '✅' : '❌'}`).join(' → ');
                const debugLines = [
                    '🔍 **モード取得デバッグ情報**',
                    '',
                    `**ステップ**: ${stepSummary || '(なし)'}`,
                    '',
                    '**詳細ログ:**',
                    '```json',
                    JSON.stringify(debugLog, null, 2).substring(0, 800),
                    '```',
                ];
                await interaction.editReply({ embeds: [buildEmbed(debugLines.join('\n'), EmbedColor.Warning)] });
            } else {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ モード一覧を取得できませんでした。Antigravity の状態を確認してください。', EmbedColor.Warning)] });
            }
            return;
        }

        const { embeds, components } = buildModeListEmbed(modes, current);
        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleMode: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(`❌ モード一覧取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
    }
}

async function handleHistory(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const { cdp } = resolveTargetCdp(ctx, interaction);
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        logDebug('handleHistory: starting openHistoryAndGetSections');
        const sections = await openHistoryAndGetSections(cdp.ops);
        logDebug(`handleHistory: got ${sections.length} sections`);

        // 履歴パネルを閉じる（Antigravity UI を元に戻す）
        await closePopup(cdp.ops);

        // workspace セクションの items を取得（フォールバック: 全セクションの items を統合）
        const wsSection = sections.find((s: ConversationSection) => s.section === 'workspace');
        const unknownSection = sections.find((s: ConversationSection) => s.section === 'unknown');
        const conversations = wsSection
            ? wsSection.items
            : sections.flatMap((s: ConversationSection) => s.items);

        // セクションラベルからワークスペース名を抽出（"Recent in anti-crow" → "anti-crow"）
        let workspaceName: string | undefined;
        if (wsSection?.sectionLabel) {
            const match = wsSection.sectionLabel.match(/^Recent in (.+)$/i);
            workspaceName = match ? match[1].trim() : wsSection.sectionLabel;
        } else {
            // フォールバック: CDP タイトルから抽出
            const activeTitle = cdp.getActiveTargetTitle() || '';
            workspaceName = activeTitle.includes(' — ')
                ? activeTitle.split(' — ')[0].trim()
                : undefined;
        }
        logDebug(`handleHistory: workspaceName=${workspaceName || '(unknown)'}, conversations=${conversations.length}`);

        const { embeds, components } = buildHistoryListEmbed(conversations, 0, workspaceName);

        // unknown セクション（セクション分類失敗）の場合、警告をフッターに追加
        if (unknownSection && !wsSection) {
            embeds[0]?.setFooter({ text: '⚠️ セクション分類に失敗しました。別ワークスペースの会話が含まれている可能性があります。' });
        }

        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleHistory: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(`❌ 会話履歴取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
    }
}

async function handleHelp(_ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const helpMsg = [
        '📖 **AntiCrow ヘルプ**',
        '',
        '**コマンド一覧**',
        '`/status` — Bot・接続・キュー状態を表示',
        '`/cancel` — 実行中のタスクをキャンセル',
        '`/queue` — 実行キューの詳細を表示',
        '`/schedules` — 定期実行の一覧・管理',
        '`/newchat` — Antigravity で新しいチャットを開く',
        '`/model` — AI モデルの一覧・切替',
        '`/mode` — AI モード切替（Planning / Fast）',
        '`/history` — 会話履歴を表示・切り替え',
        '`/workspace` — ワークスペース一覧を表示',
        '`/templates` — テンプレート一覧・管理',
        '`/pro` — Pro ライセンス管理・購入・キー入力',
        '`/help` — このヘルプを表示',
        '',
        '**使い方のコツ**',
        '💡 1メッセージ = 1タスクで送信すると精度が上がります',
        '📎 画像やテキストファイルを添付して指示できます',
        '⏱️ 処理中に追加メッセージを送ると自動でキューに追加されます',
        '⏹️ タスクをやめたい時は `/cancel` を使ってください',
    ].join('\n');

    await interaction.reply({ embeds: [buildEmbed(helpMsg, EmbedColor.Info)] });
}

async function handlePro(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    try {
        const { FREE_DAILY_TASK_LIMIT, FREE_WEEKLY_TASK_LIMIT, PRO_ONLY_FEATURES, PURCHASE_URL_MONTHLY, PURCHASE_URL_LIFETIME } = await import('./licensing');

        const lines: string[] = [
            '💎 **AntiCrow Pro**',
            '',
            '**💰 価格プラン**',
            `🆓 **Free** — 無料（1日${FREE_DAILY_TASK_LIMIT}タスク、週${FREE_WEEKLY_TASK_LIMIT}タスク）`,
            '📅 **Monthly** — $5/月（全機能無制限）',
            '♾️ **Lifetime** — $50（買い切り永久）',
            '',
            '**🔒 Pro 限定機能**',
            `${[...PRO_ONLY_FEATURES].map(f => f === 'autoAccept' ? '自動承認' : `\`${f}\``).join(', ')}、無制限タスク`,
        ];

        // トライアル情報を追加
        const trialDays = ctx.getTrialDaysRemaining?.();
        if (trialDays !== undefined) {
            if (trialDays > 0) {
                lines.push('');
                lines.push(`🆓 **Proトライアル期間**: 残り **${trialDays}** 日`);
            } else {
                lines.push('');
                lines.push('⏰ **Proトライアル期間終了** — Pro にアップグレードして全機能を使い続けましょう！');
            }
        }

        // --- ActionRow: 購入リンクボタン ---
        const purchaseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setLabel('📅 Monthly ($5/月)')
                .setStyle(ButtonStyle.Link)
                .setURL(PURCHASE_URL_MONTHLY),
            new ButtonBuilder()
                .setLabel('♾️ Lifetime ($50)')
                .setStyle(ButtonStyle.Link)
                .setURL(PURCHASE_URL_LIFETIME),
        );

        // --- ActionRow: 操作ボタン ---
        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('pro_info')
                .setLabel('📋 ライセンス情報')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('pro_key_input')
                .setLabel('🔑 キー入力')
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.reply({
            embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)],
            components: [purchaseRow, actionRow],
        });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handlePro: failed', e);
        await interaction.reply({ embeds: [buildEmbed(`❌ Pro 情報取得エラー: ${errMsg}`, EmbedColor.Error)] });
    }
}

// ---------------------------------------------------------------------------
// /suggest
// ---------------------------------------------------------------------------

/** 定型の提案リクエストプロンプト */
const SUGGEST_PROMPT =
    '現在のプロジェクトの状態を分析して、次にやるべきタスクを3個提案してください。\n' +
    '各提案は実行可能な具体的な指示として記述してください。\n\n' +
    '提案は以下の形式でレスポンスの末尾に含めてください:\n' +
    '```\n' +
    '<!-- SUGGESTIONS: [\n' +
    '  { "label": "ボタンに表示する短いラベル", "prompt": "実行するプロンプト", "description": "提案の説明" },\n' +
    '  ...\n' +
    '] -->\n' +
    '```\n' +
    '- label: 80文字以内の短いボタンラベル\n' +
    '- prompt: そのタスクを実行するための具体的で詳細なプロンプト\n' +
    '- description: ボタンの上に表示される説明テキスト（1行）\n' +
    '- 必ず3個の提案を含めること\n' +
    '- SUGGESTIONS タグはレスポンスの最後に配置すること';

async function handleSuggest(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ テキストチャンネルでのみ使用できます。', EmbedColor.Warning)] });
        return;
    }

    // スラッシュコマンドの応答（「エージェントに任せる」ボタン付き）
    const autoButton = new ButtonBuilder()
        .setCustomId(SUGGEST_AUTO_ID)
        .setLabel('エージェントに任せる')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🤖');
    const autoRow = new ActionRowBuilder<ButtonBuilder>().addComponents(autoButton);
    await interaction.reply({
        embeds: [buildEmbed('💡 プロジェクトを分析して提案を生成中なのだ…\nしばらく待ってほしいのだ！', EmbedColor.Info)],
        components: [autoRow],
    });

    // 合成 Message オブジェクトを作成して enqueueMessage に流す
    const syntheticMessage = {
        id: `suggest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: SUGGEST_PROMPT,
        channel,
        author: interaction.user,
        attachments: new Map(),
        reference: null,
    } as unknown as import('discord.js').Message;

    try {
        const wsName = DiscordBot.resolveWorkspaceFromChannel(channel as TextChannel) ?? 'agent-chat';
        await enqueueMessage(ctx, syntheticMessage, 'agent-chat', wsName);
    } catch (e) {
        logError('handleSuggest: failed to enqueue synthetic message', e);
    }
}

// ---------------------------------------------------------------------------
// /screenshot
// ---------------------------------------------------------------------------

async function handleScreenshot(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const { cdp, wsKey } = resolveTargetCdp(ctx, interaction);

        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        const buffer = await cdp.getScreenshot();
        if (buffer) {
            const wsLabel = wsKey ? ` (${wsKey})` : '';
            const attachment = new AttachmentBuilder(buffer, { name: 'screenshot.png' });
            await interaction.editReply({ content: `📸${wsLabel}`, files: [attachment] });
        } else {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ スクリーンショットの取得に失敗しました。', EmbedColor.Warning)] });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleScreenshot: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(`❌ スクリーンショット取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
    }
}


// ---------------------------------------------------------------------------
// /soul — SOUL.md 編集モーダル
// ---------------------------------------------------------------------------

async function handleSoul(
    _ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    const current = readAnticrowMd() ?? '';

    // Discord モーダルの TextInput は最大4000文字
    if (current.length > 4000) {
        await interaction.reply({
            embeds: [buildEmbed(
                `⚠️ SOUL.md が ${current.length} 文字あり、Discord モーダルの上限（4000文字）を超えています。\nテキストエディタで直接編集してください。`,
                EmbedColor.Warning,
            )],
        });
        return;
    }

    const textInput = new TextInputBuilder()
        .setCustomId('soul_content')
        .setLabel('SOUL.md の内容')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(4000);

    if (current.length > 0) {
        textInput.setValue(current);
    }

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);

    const modal = new ModalBuilder()
        .setCustomId('soul_edit_modal')
        .setTitle('SOUL.md 編集')
        .addComponents(row);

    await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// /subagent — サブエージェント管理
// ---------------------------------------------------------------------------

async function handleSubagent(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    const action = interaction.options.getString('action') || 'list';
    const targetName = interaction.options.getString('name') || '';

    const mgr = ctx.subagentManager;

    try {
        switch (action) {
            case 'spawn': {
                if (!mgr) {
                    await interaction.reply({
                        embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。Bridge を起動してください。', EmbedColor.Warning)],
                    });
                    return;
                }
                await interaction.deferReply();
                const handle = await mgr.spawn();
                const name = handle.name;
                const state = handle.state;
                await interaction.editReply({
                    embeds: [buildEmbed(
                        `🚀 サブエージェントを起動しました\n\n` +
                        `- **名前**: \`${name}\`\n` +
                        `- **状態**: ${state}`,
                        EmbedColor.Success,
                    )],
                });
                break;
            }

            case 'list': {
                if (!mgr) {
                    await interaction.reply({
                        embeds: [buildEmbed('📋 **サブエージェント一覧**\n\nSubagentManager が未初期化です。', EmbedColor.Info)],
                    });
                    return;
                }
                const agents = mgr.list();
                if (agents.length === 0) {
                    await interaction.reply({
                        embeds: [buildEmbed('📋 **サブエージェント一覧**\n\n現在実行中のサブエージェントはありません。', EmbedColor.Info)],
                    });
                } else {
                    const lines = agents.map((a: { name: string; state: string }) =>
                        `- \`${a.name}\` — ${a.state}`,
                    );
                    await interaction.reply({
                        embeds: [buildEmbed(
                            `📋 **サブエージェント一覧** (${agents.length}件)\n\n${lines.join('\n')}`,
                            EmbedColor.Info,
                        )],
                    });
                }
                break;
            }

            case 'kill': {
                if (!mgr) {
                    await interaction.reply({
                        embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                    });
                    return;
                }
                if (!targetName) {
                    await interaction.reply({
                        embeds: [buildEmbed('⚠️ `name` オプションでサブエージェント名を指定してください。', EmbedColor.Warning)],
                    });
                    return;
                }
                await interaction.deferReply();
                await mgr.killAgent(targetName);
                await interaction.editReply({
                    embeds: [buildEmbed(`⏹️ サブエージェント \`${targetName}\` を停止しました。`, EmbedColor.Success)],
                });
                break;
            }

            case 'killall': {
                if (!mgr) {
                    await interaction.reply({
                        embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                    });
                    return;
                }
                await interaction.deferReply();
                await mgr.killAll();
                await interaction.editReply({
                    embeds: [buildEmbed('⏹️ 全サブエージェントを停止しました。', EmbedColor.Success)],
                });
                break;
            }

            default:
                await interaction.reply({
                    embeds: [buildEmbed(`⚠️ 不明なアクション: \`${action}\`\n使用可能: spawn, list, kill, killall`, EmbedColor.Warning)],
                });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError(`handleSubagent: ${action} failed`, e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
            }).catch(() => { });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
            });
        }
    }
}

// ---------------------------------------------------------------------------
// /team — エージェントチームモード管理
// ---------------------------------------------------------------------------

/**
 * チームモード操作パネル（ボタン付き）を構築する。
 */
function buildTeamPanel(
    config: import('./teamConfig').TeamConfig,
    agentCount: number,
): { embeds: ReturnType<typeof buildEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const statusEmoji = config.enabled ? '🟢' : '🔴';
    const statusText = config.enabled ? 'ON' : 'OFF';

    const embed = buildEmbed(
        `${statusEmoji} **エージェントチームモード: ${statusText}**\n\n`
        + `📊 **稼働中サブエージェント**: ${agentCount} / ${config.maxAgents}\n`
        + `⏱️ **タイムアウト**: ${Math.round(config.responseTimeoutMs / 60_000)}分\n`
        + `🔄 **監視間隔**: ${Math.round(config.monitorIntervalMs / 1_000)}秒\n`
        + `🤖 **自動スポーン**: ${config.autoSpawn ? 'ON' : 'OFF'}`,
        config.enabled ? EmbedColor.Success : EmbedColor.Info,
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('team_on')
            .setLabel('🟢 チームON')
            .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_off')
            .setLabel('🔴 チームOFF')
            .setStyle(!config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_status')
            .setLabel('📊 ステータス')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('team_config')
            .setLabel('⚙️ 設定')
            .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
}

async function handleTeam(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    const action = interaction.options.getString('action') ?? 'status';
    const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!repoRoot) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ ワークスペースが検出されません。', EmbedColor.Warning)] });
        return;
    }

    try {
        const config = loadTeamConfig(repoRoot);
        const agentCount = ctx.subagentManager?.list().length ?? 0;

        switch (action) {
            case 'on': {
                config.enabled = true;
                saveTeamConfig(repoRoot, config);
                const panel = buildTeamPanel(config, agentCount);
                await interaction.reply({
                    embeds: [buildEmbed('✅ **エージェントチームモードを有効化しました！**\n\nメインエージェントが指揮官モードで動作します。', EmbedColor.Success)],
                    components: panel.components as any,
                });
                break;
            }
            case 'off': {
                config.enabled = false;
                saveTeamConfig(repoRoot, config);
                // 全サブエージェント停止
                if (ctx.subagentManager) {
                    const agents = ctx.subagentManager.list();
                    for (const agent of agents) {
                        try {
                            await ctx.subagentManager.killAgent(agent.name);
                        } catch { /* ignore */ }
                    }
                }
                const panel = buildTeamPanel(config, 0);
                await interaction.reply({
                    embeds: [buildEmbed('🔴 **エージェントチームモードを無効化しました。**\n\n全サブエージェントを停止しました。', EmbedColor.Info)],
                    components: panel.components as any,
                });
                break;
            }
            case 'config': {
                const configJson = JSON.stringify(config, null, 2);
                await interaction.reply({
                    embeds: [buildEmbed(`⚙️ **チーム設定** (\`.anticrow/team.json\`)\n\`\`\`json\n${configJson}\n\`\`\``, EmbedColor.Info)],
                });
                break;
            }
            case 'status':
            default: {
                const panel = buildTeamPanel(config, agentCount);
                // サブエージェント一覧も表示
                if (agentCount > 0 && ctx.subagentManager) {
                    const agents = ctx.subagentManager.list();
                    const agentList = agents.map(a =>
                        `  • **${a.name}** — ${a.state}`
                    ).join('\n');
                    panel.embeds.push(buildEmbed(`🤖 **サブエージェント一覧**\n${agentList}`, EmbedColor.Info));
                }
                await interaction.reply({ embeds: panel.embeds, components: panel.components as any });
                break;
            }
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError(`handleTeam: ${action} failed`, e);
        await interaction.reply({
            embeds: [buildEmbed(`❌ チームモード操作失敗: ${errMsg}`, EmbedColor.Error)],
        });
    }
}

// ---------------------------------------------------------------------------
// コマンドディスパッチマップ
// ---------------------------------------------------------------------------

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
    status: handleStatus,
    schedules: handleSchedules,
    cancel: handleCancel,
    newchat: handleNewchat,
    workspace: handleWorkspaces,
    queue: handleQueue,
    template: handleTemplate,
    model: handleModels,
    mode: handleMode,
    history: handleHistory,
    suggest: handleSuggest,
    help: handleHelp,
    pro: handlePro,
    screenshot: handleScreenshot,
    soul: handleSoul,
    subagent: handleSubagent,
    team: handleTeam,
};

// ---------------------------------------------------------------------------
// メインディスパッチャー
// ---------------------------------------------------------------------------

export async function handleManageSlash(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
    commandName: string,
): Promise<void> {
    const handler = COMMAND_HANDLERS[commandName];
    if (handler) {
        await handler(ctx, interaction);
    } else {
        await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応の管理コマンド: /${commandName}`, EmbedColor.Warning)] });
    }
}

