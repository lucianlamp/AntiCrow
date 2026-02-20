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
// 管理系スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------

export async function handleManageSlash(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
    commandName: string,
): Promise<void> {
    const { cdp, bot, planStore, scheduler, executor, fileIpc } = ctx;

    if (commandName === 'status') {
        const cdpOk = cdp ? await cdp.testConnection() : false;
        const botOk = bot?.isReady() || false;
        const scheduledIds = scheduler?.getRegisteredPlanIds() || [];
        const execQueueLen = executor?.queueLength() || 0;
        const isRunning = executor?.isRunning() || false;

        const activeTarget = cdp?.getActiveTargetTitle() || '未接続';

        // メッセージキュー（plan_generation フェーズ含む）の状態
        const msgQueue = getMessageQueueStatus();

        // キュー表示: メッセージキュー（処理待ち全体）と実行キュー（executor内）を統合表示
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
        return;
    }

    if (commandName === 'schedules') {
        if (!planStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ PlanStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
            return;
        }
        const plans = planStore.getAll();
        const timezone = getTimezone();
        const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
        await interaction.reply({ embeds, components: components as any });
        return;
    }

    if (commandName === 'cancel') {
        try {
            resetProcessingFlag();

            // executor の状態を記録
            const execRunning = executor?.isRunning() || false;
            const poolRunning = ctx.executorPool?.isAnyRunning() || false;

            executor?.forceStop();
            ctx.executorPool?.forceStopAll();

            // Antigravity のキャンセルボタンをクリック
            let cancelResult = 'CDP未接続';
            if (cdp) {
                try {
                    cancelResult = await cdp.clickCancelButton();
                } catch (e) {
                    cancelResult = `エラー: ${e instanceof Error ? e.message : e}`;
                    logWarn(`handleManageSlash: /cancel — clickCancelButton failed: ${cancelResult}`);
                }
            }

            logDebug('handleManageSlash: /cancel executed — current job stopped (executor + executorPool)');
            const debugInfo = [
                `executor実行中: ${execRunning}`,
                `pool実行中: ${poolRunning}`,
                `Antigravity停止: ${cancelResult}`,
            ].join('\n');
            await interaction.reply({ embeds: [buildEmbed(`⏹️ キャンセルしました。\n- 実行中のジョブ → キャンセル\n- キュー内の待機ジョブ → 保持\n\n\`\`\`\n${debugInfo}\n\`\`\``, EmbedColor.Success)] });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleManageSlash: /cancel failed', e);
            await interaction.reply({ embeds: [buildEmbed(`❌ キャンセル失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
        }
        return;
    }

    if (commandName === 'newchat') {
        try {
            if (cdp) {
                await cdp.startNewChat();
                logDebug('handleManageSlash: /newchat executed — new chat started via Ctrl+Shift+L');
                await interaction.reply({ embeds: [buildEmbed('🆕 新しいチャットを開きました。', EmbedColor.Success)] });
            } else {
                await interaction.reply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleManageSlash: /newchat failed', e);
            await interaction.reply({ embeds: [buildEmbed(`❌ 新しいチャットの開始に失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
        }
        return;
    }

    if (commandName === 'workspaces') {
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
            logError('handleManageSlash: /workspaces failed', e);
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ embeds: [buildEmbed(`❌ ワークスペース検出失敗: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
            } else {
                await interaction.reply({ embeds: [buildEmbed(`❌ ワークスペース検出失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
            }
        }
        return;
    }

    if (commandName === 'queue') {
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
        return;
    }

    if (commandName === 'templates') {
        const templateStore = ctx.templateStore;
        if (!templateStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
            return;
        }

        // サブコマンドなし: そのまま一覧+ボタンを表示
        const { embeds, components } = buildTemplateListPanel(templateStore);
        await interaction.reply({ embeds, components: components as any });
        return;
    }

    // -----------------------------------------------------------------------
    // /models — モデル一覧 + 切替ボタン
    // -----------------------------------------------------------------------
    if (commandName === 'models') {
        await interaction.deferReply();
        try {
            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            logDebug('handleManageSlash: /models — starting getAvailableModels');
            const { models, current, debugLog } = await getAvailableModels(cdp.ops);
            logDebug(`handleManageSlash: /models — got ${models.length} models, current=${current}`);

            // デバッグログをファイルに書き出し
            if (ctx.fileIpc) {
                try {
                    const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'models_debug.json');
                    fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                    logDebug(`handleManageSlash: /models — debug log saved to ${debugPath}`);
                } catch (writeErr) {
                    logWarn(`handleManageSlash: /models — failed to write debug log: ${writeErr}`);
                }
            }

            // ステップサマリーを生成
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
                logDebug(`handleManageSlash: /models — quota fetched: ${quotaData.models.length} models, account=${quotaData.accountLevel}`);
            } else {
                logWarn('handleManageSlash: /models — fetchQuota returned null (process detection or API call failed)');
            }

            const { embeds, components } = buildModelListEmbed(models, current, quotaData?.models);
            await interaction.editReply({ embeds, components: components as any });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleManageSlash: /models failed', e);
            await interaction.editReply({ embeds: [buildEmbed(`❌ モデル一覧取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        }
        return;
    }

    // -----------------------------------------------------------------------
    // /mode — モード一覧 + 切替ボタン
    // -----------------------------------------------------------------------

    if (commandName === 'mode') {
        await interaction.deferReply();
        try {
            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            logDebug('handleManageSlash: /mode — starting getAvailableModes');
            const { modes, current, debugLog } = await getAvailableModes(cdp.ops);
            logDebug(`handleManageSlash: /mode — got ${modes.length} modes, current=${current}`);

            // デバッグログをファイルに書き出し
            if (ctx.fileIpc) {
                try {
                    const debugPath = path.join(ctx.fileIpc.getIpcDir(), 'modes_debug.json');
                    fs.writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                    logDebug(`handleManageSlash: /mode — debug log saved to ${debugPath}`);
                } catch (writeErr) {
                    logWarn(`handleManageSlash: /mode — failed to write debug log: ${writeErr}`);
                }
            }

            // ステップサマリーを生成
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
            logError('handleManageSlash: /mode failed', e);
            await interaction.editReply({ embeds: [buildEmbed(`❌ モード一覧取得エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        }
        return;
    }

    if (commandName === 'help') {
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
        return;
    }

    await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応の管理コマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
}
