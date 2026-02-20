// ---------------------------------------------------------------------------
// adminHandler.ts — 管理系スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   /status, /schedules, /cancel, /newchat, /workspaces, /queue,
//   /templates, /models, /mode コマンドの処理
// ---------------------------------------------------------------------------
import {
    ChatInputCommandInteraction,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getCurrentModel, getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getCurrentMode, getAvailableModes, selectMode } from './cdpModes';
import { BridgeContext } from './bridgeContext';
import { resetProcessingFlag, getMessageQueueStatus } from './messageHandler';
import { getTimezone } from './configHelper';
import { getRunningWsNames, buildWorkspaceListEmbed } from './workspaceHandler';
import { fetchQuota } from './quotaProvider';
import { buildTemplateListPanel } from './templateHandler';

// ---------------------------------------------------------------------------
// コマンドハンドラ（各コマンドの処理を独立関数に分離）
// ---------------------------------------------------------------------------

type CommandHandler = (ctx: BridgeContext, interaction: ChatInputCommandInteraction) => Promise<void>;

async function handleStatus(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { cdp, bot, scheduler, executor } = ctx;
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
        if (msgQueue.total > 0) { parts.push(`メッセージ待ち: ${msgQueue.total}件`); }
        if (execQueueLen > 0) { parts.push(`実行待ち: ${execQueueLen}件`); }
        queueDisplay = `${parts.join(' / ')} ${isRunning ? '(実行中)' : ''}`;
    }

    const statusMsg = [
        '📊 **AntiCrow 状態**',
        `- Discord Bot: ${botOk ? '🟢 オンライン' : '🔴 オフライン'}`,
        `- Antigravity 接続: ${cdpOk ? '🟢 接続済み' : '🔴 未接続'}`,
        `- アクティブターゲット: ${activeTarget}`,
        `- スケジュール中: ${scheduledIds.length}件`,
        `- キュー: ${queueDisplay}`,
    ].join('\n');

    await interaction.reply({ embeds: [buildEmbed(statusMsg, EmbedColor.Info)] });
}

async function handleSchedules(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { planStore } = ctx;
    if (!planStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ PlanStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }
    const plans = planStore.getAll();
    const timezone = getTimezone();
    const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
    await interaction.reply({ embeds, components: components as any });
}

async function handleCancel(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { cdp, executor } = ctx;
    try {
        resetProcessingFlag();
        const execRunning = executor?.isRunning() || false;
        const poolRunning = ctx.executorPool?.isAnyRunning() || false;

        executor?.forceStop();
        ctx.executorPool?.forceStopAll();

        let cancelResult = 'CDP未接続';
        if (cdp) {
            try {
                cancelResult = await cdp.clickCancelButton();
            } catch (e) {
                cancelResult = `エラー: ${e instanceof Error ? e.message : e}`;
                logWarn(`handleCancel: clickCancelButton failed: ${cancelResult}`);
            }
        }

        logDebug('handleCancel: /cancel executed — current job stopped (executor + executorPool)');
        const debugInfo = [
            `executor実行中: ${execRunning}`,
            `pool実行中: ${poolRunning}`,
            `Antigravity停止: ${cancelResult}`,
        ].join('\n');
        await interaction.reply({ embeds: [buildEmbed(`⏹️ キャンセルしました。\n- 実行中のジョブ → キャンセル\n- キュー内の待機ジョブ → 保持\n\n\`\`\`\n${debugInfo}\n\`\`\``, EmbedColor.Success)] });
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleCancel: /cancel failed', e);
        await interaction.reply({ embeds: [buildEmbed(`❌ キャンセル失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
    }
}

async function handleNewchat(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { cdp } = ctx;
    try {
        if (cdp) {
            await cdp.startNewChat();
            logDebug('handleNewchat: new chat started via Ctrl+Shift+L');
            await interaction.reply({ embeds: [buildEmbed('🆕 新しいチャットを開きました。', EmbedColor.Success)] });
        } else {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleNewchat: failed', e);
        await interaction.reply({ embeds: [buildEmbed(`❌ 新しいチャットの開始に失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
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
            await interaction.reply({ embeds: [buildEmbed(`❌ ワークスペース検出失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
        }
    }
}

async function handleQueue(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const { executor } = ctx;
    const queueInfo = executor?.getQueueInfo();
    if (!queueInfo) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ Executor が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    const lines: string[] = ['📋 **実行キュー**'];

    if (queueInfo.current) {
        const elapsed = Math.round((Date.now() - queueInfo.current.startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
        const summary = queueInfo.current.plan.human_summary || queueInfo.current.plan.plan_id;
        lines.push(`\n🔄 **実行中:** ${summary} (${timeStr}経過)`);
    } else {
        lines.push('\n✅ 現在実行中のタスクはありません。');
    }

    if (queueInfo.pending.length > 0) {
        lines.push(`\n⏳ **待機中:** ${queueInfo.pending.length}件`);
        queueInfo.pending.forEach((p, i) => {
            const summary = p.human_summary || p.plan_id;
            lines.push(`${i + 1}. ${summary}`);
        });
    } else {
        lines.push('\n待機中のタスクはありません。');
    }

    await interaction.reply({ embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)] });
}

async function handleTemplates(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }
    const { embeds, components } = buildTemplateListPanel(templateStore);
    await interaction.reply({ embeds, components: components as any });
}

async function handleModels(ctx: BridgeContext, interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    try {
        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        logDebug('handleModels: starting getAvailableModels');
        const { models, current, debugLog } = await getAvailableModels(cdp.ops);
        logDebug(`handleModels: got ${models.length} models, current=${current}`);

        if (ctx.fileIpc) {
            try {
                const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'models_debug.json');
                fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                logDebug(`handleModels: debug log saved to ${debugPath}`);
            } catch (writeErr) {
                logWarn(`handleModels: failed to write debug log: ${writeErr}`);
            }
        }

        const stepSummary = debugLog.map(e => `${e.step}: ${e.success ? '✅' : '❌'}`).join(' → ');

        if (models.length === 0) {
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
        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
            return;
        }

        logDebug('handleMode: starting getAvailableModes');
        const { modes, current, debugLog } = await getAvailableModes(cdp.ops);
        logDebug(`handleMode: got ${modes.length} modes, current=${current}`);

        if (ctx.fileIpc) {
            try {
                const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'modes_debug.json');
                fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                logDebug(`handleMode: debug log saved to ${debugPath}`);
            } catch (writeErr) {
                logWarn(`handleMode: failed to write debug log: ${writeErr}`);
            }
        }

        const stepSummary = debugLog.map(e => `${e.step}: ${e.success ? '✅' : '❌'}`).join(' → ');

        if (modes.length === 0) {
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
        '`/models` — AI モデルの一覧・切替',
        '`/mode` — AI モード切替（Planning / Fast）',
        '`/workspaces` — ワークスペース一覧を表示',
        '`/templates` — テンプレート一覧・管理',
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

// ---------------------------------------------------------------------------
// コマンドディスパッチマップ
// ---------------------------------------------------------------------------

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
    status: handleStatus,
    schedules: handleSchedules,
    cancel: handleCancel,
    newchat: handleNewchat,
    workspaces: handleWorkspaces,
    queue: handleQueue,
    templates: handleTemplates,
    models: handleModels,
    mode: handleMode,
    help: handleHelp,
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
        await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応の管理コマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
    }
}

