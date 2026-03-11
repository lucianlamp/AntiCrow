// ---------------------------------------------------------------------------
// adminHandler.ts — 管理系スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   /status, /schedules, /stop, /newchat, /workspace, /queue,
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

import { readAnticrowMd } from './anticrowCustomizer';
import { t } from './i18n';
import { loadAutoModeConfig, saveAutoModeConfig, parseAutoModeArgs, formatConfigForDisplay, setConfigStoragePath } from './autoModeConfig';
import { isAutoModeActive, stopAutoMode } from './autoModeController';
import { handleUpdate } from './slashButtonUpdate';
import { resolveTargetCdp } from './slashHelpers';

// ---------------------------------------------------------------------------
// コマンドハンドラ（各コマンドの処理を独立関数に分離）
// ---------------------------------------------------------------------------

type CommandHandler = (ctx: BridgeContext, interaction: ChatInputCommandInteraction) => Promise<void>;

async function handleStatus(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const { cdp, wsKey } = resolveTargetCdp(ctx, interaction);
    const { bot, scheduler, executor } = ctx;
    const cdpOk = cdp ? await cdp.testConnection() : false;
    const botOk = bot?.isReady() || false;
    const scheduledIds = scheduler?.getRegisteredPlanIds() || [];
    const execQueueLen = executor?.queueLength() || 0;
    const isRunning = executor?.isRunning() || false;
    const activeTarget = cdp?.getActiveTargetTitle() || t('admin.status.notConnected');

    const msgQueue = getMessageQueueStatus();
    let queueDisplay: string;
    if (msgQueue.total === 0 && execQueueLen === 0) {
        queueDisplay = t('admin.status.queueEmpty');
    } else {
        const parts: string[] = [];
        if (msgQueue.total > 0) { parts.push(t('admin.status.msgProcessing', String(msgQueue.total))); }
        if (execQueueLen > 0) { parts.push(t('admin.status.execQueue', String(execQueueLen))); }
        queueDisplay = `${parts.join(' / ')} ${isRunning ? t('admin.status.running') : ''}`;
    }

    // モデル・モード・クォータ情報を取得（CDP 接続時のみ）
    let modelDisplay = t('admin.status.unavailable');
    let modeDisplay = t('admin.status.unavailable');
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
        t('admin.status.title', wsLabel),
        t('admin.status.discordBot', botOk ? t('admin.status.botOnline') : t('admin.status.botOffline')),
        t('admin.status.antigravity', cdpOk ? t('admin.status.cdpConnected') : t('admin.status.cdpDisconnected')),
        t('admin.status.activeTarget', activeTarget),
        t('admin.status.model', modelDisplay),
        t('admin.status.mode', modeDisplay),
        t('admin.status.scheduled', String(scheduledIds.length)),
        t('admin.status.queue', queueDisplay),
    ];

    if (quotaDisplay) {
        lines.push(t('admin.status.quota', quotaDisplay));
    }

    await interaction.editReply({ embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)] });
}

async function handleSchedules(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { planStore } = ctx;
    if (!planStore) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.schedules.notInit'), EmbedColor.Warning)] });
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
                        t('admin.stop.cannotResolve', String(wsNames.length), wsNames.map(n => `- ${n}`).join('\n')),
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
            logDebug(`handleCancel: /stop executed — workspace "${wsKey}" stopped`);
        } else {
            // プールが空または未初期化: デフォルト executor のみ停止（後方互換）
            execRunning = executor?.isRunning() || false;
            if (execRunning) { executor?.forceStop(); }
            logDebug('handleCancel: /stop executed — default executor stopped (no pool entries)');
        }

        // オートモード停止（Executor 停止後にループも止める）
        if (isAutoModeActive(wsKey ?? undefined)) {
            const channel = interaction.channel as TextChannel;
            await stopAutoMode(channel, 'manual_stop', wsKey ?? undefined);
            logDebug(`handleCancel: auto mode stopped via /stop command (wsKey=${wsKey ?? 'default'})`);
        }

        let cancelResult = t('admin.cancel.cdpNotConnected');

        if (targetCdp) {
            try {
                cancelResult = await targetCdp.clickCancelButton();
            } catch (e) {
                cancelResult = t('admin.cancel.error', e instanceof Error ? e.message : String(e));
                logWarn(`handleCancel: clickCancelButton failed: ${cancelResult}`);
            }
        }

        const debugInfo = [
            t('admin.cancel.targetWs', wsKey || t('admin.cancel.targetDefault')),
            t('admin.cancel.execRunning', String(execRunning)),
            t('admin.cancel.poolRunning', String(poolRunning)),
            t('admin.cancel.antigravityStop', cancelResult),
        ].join('\n');

        // Escape フォールバックのみで停止した場合はメッセージを補足
        const escapeOnly = cancelResult.includes('escape:SENT') && !cancelResult.includes(':OK');
        const wsLabel = wsKey ? ` (${wsKey})` : '';
        const statusMsg = escapeOnly
            ? t('admin.cancel.successEscape', wsLabel)
            : t('admin.cancel.success', wsLabel);

        // デバッグ情報は開発者のみ表示
        const replyMsg = isDeveloper(interaction.user.id)
            ? `${statusMsg}\n\n\`\`\`\n${debugInfo}\n\`\`\``
            : statusMsg;
        await interaction.reply({ embeds: [buildEmbed(replyMsg, EmbedColor.Success)] });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleCancel: /stop failed', e);
        await interaction.reply({ embeds: [buildEmbed(t('admin.cancel.failed', errMsg), EmbedColor.Error)] });
    }
}

async function handleNewchat(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { cdp } = resolveTargetCdp(ctx, interaction);
    try {
        if (cdp) {
            await cdp.startNewChat();
            logDebug('handleNewchat: new chat started via Ctrl+Shift+L');
            await interaction.reply({ embeds: [buildEmbed(t('admin.newchat.success'), EmbedColor.Success)] });
        } else {
            await interaction.reply({ embeds: [buildEmbed(t('admin.newchat.notInit'), EmbedColor.Warning)] });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleNewchat: failed', e);
        await interaction.reply({ embeds: [buildEmbed(t('admin.newchat.failed', errMsg), EmbedColor.Error)] });
    }
}

async function handleWorkspaces(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    try {
        await interaction.deferReply();
        const { embeds, components } = await buildWorkspaceListEmbed(ctx);

        if (embeds.length === 0) {
            await interaction.editReply({ embeds: [buildEmbed(t('admin.workspace.notFound'), EmbedColor.Warning)] });
            return;
        }
        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleWorkspaces: failed', e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [buildEmbed(t('admin.workspace.failed', errMsg), EmbedColor.Error)] }).catch(() => { });
        } else {
            await interaction.reply({ embeds: [buildEmbed(t('admin.workspace.failed', errMsg), EmbedColor.Error)] });
        }
    }
}

async function handleQueue(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { executor } = ctx;
    const queueInfo = executor?.getQueueInfo();
    if (!queueInfo) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.queue.notInit'), EmbedColor.Warning)] });
        return;
    }

    const msgQueue = getMessageQueueStatus();
    const hasAnything = !!(queueInfo.current || queueInfo.pending.length > 0 || msgQueue.processing.length > 0 || msgQueue.waiting.length > 0);

    const phaseLabels: Record<ProcessingPhase, string> = {
        connecting: t('admin.queue.phaseConnecting'),
        plan_generating: t('admin.queue.phasePlanGenerating'),
        confirming: t('admin.queue.phaseConfirming'),
        dispatching: t('admin.queue.phaseDispatching'),
    };

    const lines: string[] = [t('admin.queue.title')];

    // メッセージ処理パイプライン（前段）— processing/waiting 配列から直接表示
    if (msgQueue.processing.length > 0 || msgQueue.waiting.length > 0) {
        const totalCount = msgQueue.processing.length + msgQueue.waiting.length;
        lines.push(t('admin.queue.msgProcessingTitle', String(totalCount)));
        // 処理中の詳細ステータス
        for (const ps of msgQueue.processing) {
            const elapsed = Math.round((Date.now() - ps.startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const timeStr = minutes > 0 ? t('admin.queue.timeMinSec', String(minutes), String(seconds)) : t('admin.queue.timeSec', String(seconds));
            const label = phaseLabels[ps.phase] || ps.phase;
            lines.push(`  - ${label}: ${ps.messagePreview} (${t('admin.queue.elapsed', timeStr)})`);
        }
        // 待機中メッセージの内容表示
        if (msgQueue.waiting.length > 0) {
            lines.push(t('admin.queue.waitingTitle', String(msgQueue.waiting.length)));
            for (const w of msgQueue.waiting) {
                const elapsed = Math.round((Date.now() - w.enqueuedAt) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                const timeStr = minutes > 0 ? t('admin.queue.timeMinSec', String(minutes), String(seconds)) : t('admin.queue.timeSec', String(seconds));
                const preview = w.preview || t('admin.queue.noContent');
                lines.push(`    - ${preview}${preview.length >= 50 ? '...' : ''} (${t('admin.queue.timeAgo', timeStr)})`);
            }
        }
    } else {
        lines.push(t('admin.queue.msgEmpty'));
    }

    // 実行キュー（パイプライン後段）— タスクがある場合のみ表示
    if (queueInfo.current) {
        const elapsed = Math.round((Date.now() - queueInfo.current.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = minutes > 0 ? t('admin.queue.timeMinSec', String(minutes), String(seconds)) : t('admin.queue.timeSec', String(seconds));
        const summary = queueInfo.current.plan.human_summary || queueInfo.current.plan.plan_id;
        lines.push(t('admin.queue.executingTitle', summary, timeStr));
    }

    if (queueInfo.pending.length > 0) {
        lines.push(t('admin.queue.pendingTitle', String(queueInfo.pending.length)));
        queueInfo.pending.forEach((p, i) => {
            const summary = p.human_summary || p.plan_id;
            lines.push(`${i + 1}. ${summary}`);
        });
    }

    if (!hasAnything) {
        lines.push(t('admin.queue.allEmpty'));
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
                    .setLabel(t('admin.queue.deleteLabel'))
                    .setStyle(ButtonStyle.Secondary),
            );
            components.push(row);
        }

        // 全削除ボタン
        const clearRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('queue_clear_waiting')
                .setLabel(t('admin.queue.clearLabel', String(msgQueue.waiting.length)))
                .setStyle(ButtonStyle.Danger),
        );
        components.push(clearRow);
    }

    await interaction.reply({ embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)], components: components as any });
}

async function handleTemplate(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.template.notInit'), EmbedColor.Warning)] });
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
            await interaction.editReply({ embeds: [buildEmbed(t('admin.models.notInit'), EmbedColor.Warning)] });
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
                    t('admin.models.debugTitle'),
                    '',
                    t('admin.models.debugSteps', stepSummary || t('admin.models.debugNone')),
                    '',
                    t('admin.models.debugDetail'),
                    '```json',
                    JSON.stringify(debugLog, null, 2).substring(0, 800),
                    '```',
                ];
                await interaction.editReply({ embeds: [buildEmbed(debugLines.join('\n'), EmbedColor.Warning)] });
            } else {
                await interaction.editReply({ embeds: [buildEmbed(t('admin.models.notAvailable'), EmbedColor.Warning)] });
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
        await interaction.editReply({ embeds: [buildEmbed(t('admin.models.error', errMsg), EmbedColor.Error)] }).catch(() => { });
    }
}

async function handleMode(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const { cdp } = resolveTargetCdp(ctx, interaction);
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed(t('admin.mode.notInit'), EmbedColor.Warning)] });
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
                    t('admin.mode.debugTitle'),
                    '',
                    t('admin.mode.debugSteps', stepSummary || t('admin.mode.debugNone')),
                    '',
                    t('admin.mode.debugDetail'),
                    '```json',
                    JSON.stringify(debugLog, null, 2).substring(0, 800),
                    '```',
                ];
                await interaction.editReply({ embeds: [buildEmbed(debugLines.join('\n'), EmbedColor.Warning)] });
            } else {
                await interaction.editReply({ embeds: [buildEmbed(t('admin.mode.notAvailable'), EmbedColor.Warning)] });
            }
            return;
        }

        const { embeds, components } = buildModeListEmbed(modes, current);
        await interaction.editReply({ embeds, components: components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleMode: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(t('admin.mode.error', errMsg), EmbedColor.Error)] }).catch(() => { });
    }
}


async function handleHelp(_ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const helpMsg = [
        t('admin.help.title'),
        '',
        t('admin.help.commandsTitle'),
        t('admin.help.cmdStatus'),
        t('admin.help.cmdStop'),
        t('admin.help.cmdQueue'),
        t('admin.help.cmdSchedules'),
        t('admin.help.cmdNewchat'),
        t('admin.help.cmdModel'),
        t('admin.help.cmdMode'),

        t('admin.help.cmdWorkspace'),
        t('admin.help.cmdTemplates'),
        t('admin.help.cmdPro'),
        t('admin.help.cmdTeam'),
        t('admin.help.cmdScreenshot'),
        t('admin.help.cmdSoul'),
        t('admin.help.cmdSuggest'),
        t('admin.help.cmdAuto'),
        t('admin.help.cmdUpdate'),
        t('admin.help.cmdHelp'),
        '',
        t('admin.help.tipsTitle'),
        t('admin.help.tip1'),
        t('admin.help.tip2'),
        t('admin.help.tip3'),
        t('admin.help.tip4'),
    ].join('\n');

    await interaction.reply({ embeds: [buildEmbed(helpMsg, EmbedColor.Info)] });
}

async function handlePro(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    try {
        const { FREE_DAILY_TASK_LIMIT, FREE_WEEKLY_TASK_LIMIT, PRO_ONLY_FEATURES, PURCHASE_URL_LIFETIME } = await import('./licensing');

        const lines: string[] = [
            t('admin.pro.title'),
            '',
            t('admin.pro.priceTitle'),
            t('admin.pro.free', String(FREE_DAILY_TASK_LIMIT), String(FREE_WEEKLY_TASK_LIMIT)),
            t('admin.pro.lifetime'),
            '',
            t('admin.pro.featuresTitle'),
            `${[...PRO_ONLY_FEATURES].map(f => f === 'autoAccept' ? t('admin.pro.autoAcceptLabel') : `\`${f}\``).join(', ')}${t('admin.pro.unlimitedTasks') ? ', ' + t('admin.pro.unlimitedTasks') : ''}`,
        ];

        // トライアル情報を追加
        const trialDays = ctx.getTrialDaysRemaining?.();
        if (trialDays !== undefined) {
            if (trialDays > 0) {
                lines.push('');
                lines.push(t('admin.pro.trialRemaining', String(trialDays)));
            } else {
                lines.push('');
                lines.push(t('admin.pro.trialExpired'));
            }
        }

        // --- ActionRow: 購入リンクボタン ---
        const purchaseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setLabel(t('admin.pro.lifetimeButton'))
                .setStyle(ButtonStyle.Link)
                .setURL(PURCHASE_URL_LIFETIME),
        );

        // --- ActionRow: 操作ボタン ---
        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('pro_info')
                .setLabel(t('admin.pro.infoButton'))
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('pro_key_input')
                .setLabel(t('admin.pro.keyButton'))
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.reply({
            embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)],
            components: [purchaseRow, actionRow],
        });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handlePro: failed', e);
        await interaction.reply({ embeds: [buildEmbed(t('admin.pro.error', errMsg), EmbedColor.Error)] });
    }
}

// ---------------------------------------------------------------------------
// /suggest
// ---------------------------------------------------------------------------

/** 定型の提案リクエストプロンプト */
const SUGGEST_PROMPT = t('admin.suggest.prompt');

async function handleSuggest(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.suggest.textOnly'), EmbedColor.Warning)] });
        return;
    }

    // スラッシュコマンドの応答（提案生成中メッセージ、ボタンなし）
    await interaction.reply({
        embeds: [buildEmbed(t('admin.suggest.generating'), EmbedColor.Info)],
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
            await interaction.editReply({ embeds: [buildEmbed(t('admin.screenshot.notInit'), EmbedColor.Warning)] });
            return;
        }

        const buffer = await cdp.getScreenshot();
        if (buffer) {
            const wsLabel = wsKey ? ` (${wsKey})` : '';
            const attachment = new AttachmentBuilder(buffer, { name: 'screenshot.png' });
            await interaction.editReply({ content: `📸${wsLabel}`, files: [attachment] });
        } else {
            await interaction.editReply({ embeds: [buildEmbed(t('admin.screenshot.failed'), EmbedColor.Warning)] });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleScreenshot: failed', e);
        await interaction.editReply({ embeds: [buildEmbed(t('admin.screenshot.error', errMsg), EmbedColor.Error)] }).catch(() => { });
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
                t('admin.soul.tooLong', String(current.length)),
                EmbedColor.Warning,
            )],
        });
        return;
    }

    const textInput = new TextInputBuilder()
        .setCustomId('soul_content')
        .setLabel(t('admin.soul.label'))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(4000);

    if (current.length > 0) {
        textInput.setValue(current);
    }

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);

    const modal = new ModalBuilder()
        .setCustomId('soul_edit_modal')
        .setTitle(t('admin.soul.modalTitle'))
        .addComponents(row);

    await interaction.showModal(modal);
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
        `${statusEmoji} **${t('admin.team.modeLabel', statusText)}**\n\n`
        + `${t('admin.team.agentCount', String(agentCount), String(config.maxAgents))}\n`
        + `${t('admin.team.timeout', String(Math.round(config.responseTimeoutMs / 60_000)))}\n`
        + `${t('admin.team.monitorInterval', String(Math.round(config.monitorIntervalMs / 1_000)))}\n`
        + `${t('admin.team.autoSpawn', config.autoSpawn ? 'ON' : 'OFF')}`,
        config.enabled ? EmbedColor.Success : EmbedColor.Info,
    );

    // チームモード操作ボタン行
    const teamRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('team_on')
            .setLabel(t('admin.team.onLabel'))
            .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_off')
            .setLabel(t('admin.team.offLabel'))
            .setStyle(!config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_status')
            .setLabel(t('admin.team.statusLabel'))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('team_config')
            .setLabel(t('admin.team.configLabel'))
            .setStyle(ButtonStyle.Secondary),
    );

    // サブエージェント管理ボタン行
    const subagentRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('subagent_spawn')
            .setLabel(t('admin.subagent.launchLabel'))
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('subagent_list')
            .setLabel(t('admin.subagent.listLabel'))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('subagent_killall')
            .setLabel(t('admin.subagent.stopAllLabel'))
            .setStyle(agentCount > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(agentCount === 0),
    );

    return { embeds: [embed], components: [teamRow, subagentRow] };
}

async function handleTeam(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    // Discord チャンネルカテゴリからワークスペースを解決
    const channel = interaction.channel as TextChannel | null;
    const wsName = channel ? DiscordBot.resolveWorkspaceFromChannel(channel) : null;
    let repoRoot: string | undefined;
    if (wsName) {
        const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
        if (wsPaths[wsName]) {
            repoRoot = wsPaths[wsName];
        }
    }
    if (!repoRoot) {
        repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    if (!repoRoot) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.team.noWorkspace'), EmbedColor.Warning)] });
        return;
    }

    try {
        const config = loadTeamConfig(repoRoot);
        const agentCount = ctx.subagentManager?.list().length ?? 0;

        // 常にステータスパネル＋ボタンを表示
        const panel = buildTeamPanel(config, agentCount);

        // サブエージェント一覧も表示
        if (agentCount > 0 && ctx.subagentManager) {
            const agents = ctx.subagentManager.list();
            const agentList = agents.map(a =>
                `  • **${a.name}** — ${a.state}`
            ).join('\n');
            panel.embeds.push(buildEmbed(`${t('admin.team.agentListTitle')}\n${agentList}`, EmbedColor.Info));
        }
        await interaction.reply({ embeds: panel.embeds, components: panel.components as any });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleTeam failed', e);
        await interaction.reply({
            embeds: [buildEmbed(t('admin.team.error', errMsg), EmbedColor.Error)],
        });
    }
}

// ---------------------------------------------------------------------------
// /auto — オートモード（AI自動連続実行）
// ---------------------------------------------------------------------------

async function handleAutoMode(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    const channel = interaction.channel as TextChannel | null;
    if (!channel || !channel.isTextBased()) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.suggest.textOnly'), EmbedColor.Warning)] });
        return;
    }

    // Pro ライセンスチェック
    const { getLicenseGate } = await import('./extension');
    const gate = getLicenseGate();
    if (gate && !gate.isFeatureAllowed('autoMode')) {
        await interaction.reply({ embeds: [buildEmbed(t('autoMode.proRequired'), EmbedColor.Warning)] });
        return;
    }

    // autoModeController をロード
    try {
        const autoMode: any = await import('./autoModeController');

        // 既に実行中か確認
        if (autoMode.isAutoModeActive?.()) {
            await interaction.reply({ embeds: [buildEmbed(t('autoMode.alreadyRunning'), EmbedColor.Warning)] });
            return;
        }

        // --- オプション引数パース ---
        // globalStoragePath を autoModeConfig に設定
        if (ctx.globalStoragePath) {
            setConfigStoragePath(ctx.globalStoragePath);
        }

        // スラッシュコマンドの prompt オプション取得
        const rawInput = interaction.options.getString('prompt') || '';

        // 保存済み設定を読み込み
        const savedConfig = loadAutoModeConfig(channel.id);

        // コマンドオプション（--steps, --confirm, --select, --duration）をパース
        const { config: cmdConfig, prompt: userPrompt } = parseAutoModeArgs(rawInput);

        // 保存済み設定 → コマンドオプションで上書き
        const mergedConfig = { ...savedConfig, ...cmdConfig };

        // プロンプトが空の場合のデフォルト
        const finalPrompt = userPrompt || t('autoMode.defaultPrompt');

        // /auto コマンドの応答: オートモード開始メッセージ + 停止ボタン
        const durationMin = Math.round(mergedConfig.maxDuration / 60000);
        await interaction.reply({
            embeds: [buildEmbed(
                t('autoMode.started', finalPrompt.substring(0, 100), String(mergedConfig.maxSteps), String(durationMin)),
                EmbedColor.Success,
            )],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId('automode_stop')
                    .setLabel(t('autoMode.stopButton'))
                    .setStyle(ButtonStyle.Danger),
            )],
        });

        // autoModeController の startAutoMode を呼ぶ（設定付き）
        autoMode.startAutoMode?.(channel, channel.id, finalPrompt, mergedConfig).catch((e: unknown) => {
            logError('handleAutoMode: startAutoMode failed', e);
        });
    } catch (e) {
        logWarn(`handleAutoMode: autoModeController not available yet: ${e instanceof Error ? e.message : e}`);
        await interaction.reply({
            embeds: [buildEmbed(
                '⚠️ オートモードコントローラーがまだ初期化されていません。\nautoModeController.ts のビルドを待ってください。',
                EmbedColor.Warning,
            )],
        });
    }
}

// ---------------------------------------------------------------------------
// /auto-config — オートモード設定の表示・変更
// ---------------------------------------------------------------------------

async function handleAutoConfig(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    const channel = interaction.channel as TextChannel | null;
    if (!channel || !channel.isTextBased()) {
        await interaction.reply({ embeds: [buildEmbed(t('admin.suggest.textOnly'), EmbedColor.Warning)] });
        return;
    }

    // globalStoragePath を autoModeConfig に設定
    if (ctx.globalStoragePath) {
        setConfigStoragePath(ctx.globalStoragePath);
    }

    // 現在の設定を読み込み
    const config = loadAutoModeConfig(channel.id);
    const displayText = formatConfigForDisplay(config);

    // 設定変更ボタン
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('autoconfig_confirm_auto')
            .setLabel('⚡ auto')
            .setStyle(config.confirmMode === 'auto' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_confirm_semi')
            .setLabel('🔄 semi')
            .setStyle(config.confirmMode === 'semi' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_confirm_manual')
            .setLabel('✋ manual')
            .setStyle(config.confirmMode === 'manual' ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    const selectRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('autoconfig_select_auto-delegate')
            .setLabel('🤖 auto-delegate')
            .setStyle(config.selectionMode === 'auto-delegate' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_select_first')
            .setLabel('1️⃣ first')
            .setStyle(config.selectionMode === 'first' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_select_ai-select')
            .setLabel('🧠 ai-select')
            .setStyle(config.selectionMode === 'ai-select' ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    const stepsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('autoconfig_steps_3')
            .setLabel('3ステップ')
            .setStyle(config.maxSteps === 3 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_steps_5')
            .setLabel('5ステップ')
            .setStyle(config.maxSteps === 5 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_steps_10')
            .setLabel('10ステップ')
            .setStyle(config.maxSteps === 10 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('autoconfig_steps_20')
            .setLabel('20ステップ')
            .setStyle(config.maxSteps === 20 ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    await interaction.reply({
        embeds: [buildEmbed(displayText, EmbedColor.Info)],
        components: [confirmRow, selectRow, stepsRow],
    });
}

// ---------------------------------------------------------------------------
// コマンドディスパッチマップ
// ---------------------------------------------------------------------------

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
    status: handleStatus,
    schedules: handleSchedules,
    stop: handleCancel,
    newchat: handleNewchat,
    workspace: handleWorkspaces,
    queue: handleQueue,
    template: handleTemplate,
    model: handleModels,
    mode: handleMode,

    suggest: handleSuggest,
    help: handleHelp,
    pro: handlePro,
    screenshot: handleScreenshot,
    soul: handleSoul,
    team: handleTeam,
    auto: handleAutoMode,
    'auto-config': handleAutoConfig,
    update: handleUpdate,
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
        await interaction.reply({ embeds: [buildEmbed(t('admin.unknownCommand', commandName), EmbedColor.Warning)] });
    }
}

