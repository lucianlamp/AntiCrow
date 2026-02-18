// ---------------------------------------------------------------------------
// slashHandler.ts — スラッシュコマンド・ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. /schedule, /status, /schedules, /reset, /newchat, /workspaces, /queue, /templates コマンド処理
//   2. ボタンインタラクション処理（スケジュール管理・テンプレート管理）
//   3. ワークスペース関連は workspaceHandler.ts に委譲
// ---------------------------------------------------------------------------
import * as fs from 'fs';

import {
    ChatInputCommandInteraction,
    ButtonInteraction,
    AutocompleteInteraction,
    ModalSubmitInteraction,
    TextChannel,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { parseSkillJson, buildPlan } from './planParser';
import { ChannelIntent } from './types';
import { logInfo, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getCurrentModel, getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getCurrentMode, getAvailableModes, selectMode } from './cdpModes';
import { BridgeContext } from './bridgeContext';
import { buildSkillPrompt, cronToPrefix, resetProcessingFlag } from './messageHandler';
import { getResponseTimeout, getTimezone } from './configHelper';
import { buildWorkspaceListEmbed, getRunningWsNames, handleWorkspaceButton } from './workspaceHandler';
import { TemplateStore } from './templateStore';

// ---------------------------------------------------------------------------
// モジュール状態
// ---------------------------------------------------------------------------

/** チャンネルごとの保留中リネームタイマー */
const pendingRenames = new Map<string, { timer: NodeJS.Timeout; newName: string }>();

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/**
 * チャンネルリネームをデバウンスして実行する。
 */
function debouncedRename(ctx: BridgeContext, channelId: string, newName: string): void {
    const existing = pendingRenames.get(channelId);
    if (existing) {
        clearTimeout(existing.timer);
        logInfo(`debouncedRename: cancelled pending rename for ${channelId}, replacing with "${newName}"`);
    }

    const timer = setTimeout(async () => {
        pendingRenames.delete(channelId);
        if (ctx.bot) {
            try {
                await ctx.bot.renamePlanChannel(channelId, newName);
            } catch (e) {
                logError(`debouncedRename: failed to rename channel ${channelId}`, e);
            }
        }
    }, 2000);

    pendingRenames.set(channelId, { timer, newName });
    logInfo(`debouncedRename: scheduled rename for ${channelId} → "${newName}" (2s delay)`);
}

// ---------------------------------------------------------------------------
// スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------

export async function handleSlashCommand(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
    intent: ChannelIntent | 'admin',
): Promise<void> {
    const commandName = interaction.commandName;

    // 管理系コマンド (/status, /schedules) は専用ハンドラ
    if (intent === 'admin') {
        await handleManageSlash(ctx, interaction, commandName);
        return;
    }

    const { cdp, fileIpc, planStore, executor, scheduler, bot } = ctx;
    if (!cdp || !fileIpc || !planStore || !executor || !scheduler || !bot) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge の内部モジュールが初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    // ユーザー入力を取得
    let userText: string;
    const channelName = commandName;

    if (commandName === 'schedule') {
        const cron = interaction.options.getString('cron', true);
        const prompt = interaction.options.getString('prompt', true);
        userText = `cron: ${cron} で ${prompt} を定期実行して`;
    } else {
        await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応のコマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
        return;
    }

    await interaction.deferReply();

    try {
        logInfo(`handleSlashCommand: /${commandName} (intent=${intent}) text: "${userText.substring(0, 80)}"`);

        const { responsePath } = fileIpc.createRequestId();
        const ipcDir = fileIpc.getIpcDir();
        const { prompt: skillPrompt, tempFiles } = buildSkillPrompt(userText, intent, channelName, responsePath, undefined, undefined, ipcDir);
        logInfo('handleSlashCommand: sending skill prompt via CDP...');

        let skillResponse: string;
        try {
            await cdp.sendPrompt(skillPrompt);
            logInfo('handleSlashCommand: prompt sent, waiting for file response...');

            const responseTimeout = getResponseTimeout();
            skillResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
            logInfo(`handleSlashCommand: skill response received (${skillResponse.length} chars)`);
        } finally {
            // 一時ファイルのクリーンアップ
            for (const f of tempFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        }

        const skillOutput = parseSkillJson(skillResponse);
        if (!skillOutput) {
            logError('handleSlashCommand: skill JSON parse failed');
            await interaction.editReply({
                embeds: [buildEmbed(
                    '⚠️ Antigravity からの応答を解析できませんでした。\n' +
                    '応答:\n```\n' + skillResponse.substring(0, 1000) + '\n```',
                    EmbedColor.Warning
                )]
            });
            return;
        }
        logInfo(`handleSlashCommand: plan parsed — plan_id=${skillOutput.plan_id}, cron=${skillOutput.cron}`);

        const channelId = interaction.channelId;
        const notifyTarget = channelId;
        const plan = buildPlan(skillOutput, channelId, notifyTarget);

        if (plan.discord_templates.ack) {
            await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
        }

        if (plan.requires_confirmation) {
            const confirmLines: string[] = [];
            confirmLines.push('📋 **実行確認**');
            if (plan.human_summary) { confirmLines.push(`**概要:** ${plan.human_summary}`); }
            if (plan.discord_templates.confirm) { confirmLines.push('', plan.discord_templates.confirm); }
            confirmLines.push('', '✅ で承認、❌ で却下');
            const confirmMsg = confirmLines.join('\n');

            const sentMsg = await interaction.followUp({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
            const channel = interaction.channel;
            if (channel && 'messages' in channel) {
                const fetchedMsg = await (channel as TextChannel).messages.fetch(sentMsg.id);
                const confirmed = await bot.waitForConfirmation(fetchedMsg);
                if (!confirmed) {
                    await interaction.followUp({ embeds: [buildEmbed('❌ 却下しました。', EmbedColor.Error)] });
                    return;
                }
            }
            plan.status = 'active';
        } else {
            const summary = plan.human_summary || plan.prompt.substring(0, 100);
            await interaction.followUp({ embeds: [buildEmbed(`📋 **実行予定:** ${summary}`, EmbedColor.Info)] });
        }

        if (plan.cron === null) {
            logInfo(`handleSlashCommand: enqueueing immediate execution for plan ${plan.plan_id} (not persisted)`);
            executor.enqueueImmediate(plan);
        } else {
            logInfo(`handleSlashCommand: registering scheduled plan ${plan.plan_id} with cron=${plan.cron}`);

            const wsName = cdp?.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }

            if (interaction.guildId && bot) {
                const prefix = cronToPrefix(plan.cron!);
                const baseName = plan.human_summary || plan.plan_id;
                const chName = `${prefix} ${baseName}`;
                const planChannelId = await bot.createPlanChannel(interaction.guildId, chName, wsName);
                if (planChannelId) {
                    plan.channel_id = planChannelId;
                    plan.notify_channel_id = planChannelId;
                    logInfo(`handleSlashCommand: created plan channel ${planChannelId} for plan ${plan.plan_id} (workspace=${wsName || 'default'})`);
                }
            }

            planStore.add(plan);
            scheduler.register(plan);
            const channelMention = plan.channel_id ? `<#${plan.channel_id}>` : '#schedule';
            await interaction.followUp({ embeds: [buildEmbed(`📅 定期実行を登録しました: \`${plan.cron}\` (${plan.timezone})\n結果は ${channelMention} チャンネルに通知されます。`, EmbedColor.Success)] });
        }

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleSlashCommand failed', e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        }
    }
}

// ---------------------------------------------------------------------------
// 管理系スラッシュコマンドハンドラ
// ---------------------------------------------------------------------------

async function handleManageSlash(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
    commandName: string,
): Promise<void> {
    const { cdp, bot, planStore, scheduler, executor, fileIpc } = ctx;

    if (commandName === 'status') {
        const cdpOk = cdp ? await cdp.testConnection() : false;
        const botOk = bot?.isReady() || false;
        const scheduledIds = scheduler?.getRegisteredPlanIds() || [];
        const queueLen = executor?.queueLength() || 0;
        const isRunning = executor?.isRunning() || false;

        const activeTarget = cdp?.getActiveTargetTitle() || '未接続';
        const activePort = cdp?.getActiveTargetPort();

        const statusMsg = [
            '📊 **AntiCrow 状態**',
            `- Discord Bot: ${botOk ? '🟢 オンライン' : '🔴 オフライン'}`,
            `- Antigravity 接続: ${cdpOk ? '🟢 接続済み' : '🔴 未接続'}`,
            `- アクティブターゲット: ${activeTarget}`,
            `- スケジュール中: ${scheduledIds.length}件`,
            `- 実行キュー: ${queueLen}件 ${isRunning ? '(実行中)' : '(待機)'}`,
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

    if (commandName === 'reset') {
        try {
            resetProcessingFlag();
            executor?.forceReset();

            if (cdp) {
                await cdp.startNewChat();
            }

            logInfo('handleManageSlash: /reset executed — all states cleared');
            await interaction.reply({ embeds: [buildEmbed('🔄 処理をリセットしました。\n- `isProcessingMessage` → false\n- Executor キュー → クリア\n- Antigravity チャット → 新規セッション', EmbedColor.Success)] });
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleManageSlash: /reset failed', e);
            await interaction.reply({ embeds: [buildEmbed(`❌ リセット失敗: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
        }
        return;
    }

    if (commandName === 'newchat') {
        try {
            if (cdp) {
                await cdp.startNewChat();
                logInfo('handleManageSlash: /newchat executed — new chat started via Ctrl+Shift+L');
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

            logInfo('handleManageSlash: /models — starting getAvailableModels');
            const { models, current, debugLog } = await getAvailableModels(cdp.ops);
            logInfo(`handleManageSlash: /models — got ${models.length} models, current=${current}`);

            // デバッグログをファイルに書き出し
            if (ctx.fileIpc) {
                try {
                    const debugPath = require('path').join(ctx.fileIpc.getIpcDir(), 'models_debug.json');
                    require('fs').writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                    logInfo(`handleManageSlash: /models — debug log saved to ${debugPath}`);
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

            const { embeds, components } = buildModelListEmbed(models, current);
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

            logInfo('handleManageSlash: /mode — starting getAvailableModes');
            const { modes, current, debugLog } = await getAvailableModes(cdp.ops);
            logInfo(`handleManageSlash: /mode — got ${modes.length} modes, current=${current}`);

            // デバッグログをファイルに書き出し
            if (ctx.fileIpc) {
                try {
                    const debugPath = require('path').join(ctx.fileIpc.getIpcDir(), 'modes_debug.json');
                    require('fs').writeFileSync(debugPath, JSON.stringify(debugLog, null, 2), 'utf-8');
                    logInfo(`handleManageSlash: /mode — debug log saved to ${debugPath}`);
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

    await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応の管理コマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
}

// ---------------------------------------------------------------------------
// ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

export async function handleButtonInteraction(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
): Promise<void> {
    const customId = interaction.customId;
    logInfo(`handleButtonInteraction: customId=${customId}`);

    // ワークスペース関連ボタンは workspaceHandler に委譲
    const handled = await handleWorkspaceButton(ctx, interaction);
    if (handled) { return; }

    // ----- スケジュール関連ボタン -----
    if (!ctx.planStore || !ctx.scheduler) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    const timezone = getTimezone();

    try {
        if (customId === 'sched_list') {
            const plans = ctx.planStore.getAll();
            const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
            await interaction.update({ embeds, components: components as any });
            return;
        }

        if (customId.startsWith('sched_toggle_')) {
            const planId = customId.replace('sched_toggle_', '');
            const plan = ctx.planStore.get(planId);
            if (!plan) {
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
                return;
            }

            let renameChannelId: string | undefined;
            let renameNewName: string | undefined;

            if (plan.status === 'active') {
                ctx.planStore.update(planId, { status: 'paused' });
                ctx.scheduler.unregister(planId);
                logInfo(`ButtonHandler: paused plan ${planId}`);

                if (plan.channel_id && ctx.bot) {
                    const baseName = plan.human_summary || planId;
                    if (!baseName.endsWith('（停止中）')) {
                        renameChannelId = plan.channel_id;
                        renameNewName = baseName + '（停止中）';
                    }
                }
            } else if (plan.status === 'paused') {
                ctx.planStore.update(planId, { status: 'active' });
                const updated = ctx.planStore.get(planId);
                if (updated) { ctx.scheduler.register(updated); }
                logInfo(`ButtonHandler: resumed plan ${planId}`);

                if (plan.channel_id && ctx.bot) {
                    const baseName = (plan.human_summary || planId).replace(/（停止中）$/, '');
                    renameChannelId = plan.channel_id;
                    renameNewName = baseName;
                }
            }

            const plans = ctx.planStore.getAll();
            const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
            await interaction.update({ embeds, components: components as any });

            if (renameChannelId && renameNewName && ctx.bot) {
                debouncedRename(ctx, renameChannelId, renameNewName);
            }
            return;
        }

        if (customId.startsWith('sched_delete_')) {
            const planId = customId.replace('sched_delete_', '');
            const plan = ctx.planStore.get(planId);
            if (!plan) {
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const { embeds, components } = buildDeleteConfirmEmbed(plan);
            await interaction.update({ embeds, components: components as any });
            return;
        }

        if (customId.startsWith('sched_confirm_delete_')) {
            const planId = customId.replace('sched_confirm_delete_', '');
            const planToDelete = ctx.planStore.get(planId);
            ctx.scheduler.unregister(planId);
            const removed = ctx.planStore.remove(planId);

            if (removed) {
                logInfo(`ButtonHandler: deleted plan ${planId}`);
                if (planToDelete?.channel_id && ctx.bot) {
                    await ctx.bot.deletePlanChannel(planToDelete.channel_id);
                }
            }

            const plans = ctx.planStore.getAll();
            const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
            await interaction.update({ embeds, components: components as any });
            return;
        }

        if (customId === 'sched_cancel_delete') {
            const plans = ctx.planStore.getAll();
            const { embeds, components } = buildScheduleListEmbed(plans, timezone, await getRunningWsNames());
            await interaction.update({ embeds, components: components as any });
            return;
        }

        // -------------------------------------------------------------------
        // モデル管理ボタン
        // -------------------------------------------------------------------
        if (customId.startsWith('model_select_')) {
            const modelName = customId.replace('model_select_', '');
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const success = await selectModel(cdp.ops, modelName);
            const resultEmbed = buildModelSwitchResultEmbed(modelName, success);

            if (success) {
                // 切替後にリストを更新
                await cdp.ops.sleep(500);
                const { models, current } = await getAvailableModels(cdp.ops);
                const { embeds, components } = buildModelListEmbed(models, current);
                await interaction.editReply({ embeds, components: components as any });
            } else {
                await interaction.followUp({ embeds: [resultEmbed], ephemeral: true });
            }
            return;
        }

        if (customId === 'model_refresh') {
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const { models, current } = await getAvailableModels(cdp.ops);
            const { embeds, components } = buildModelListEmbed(models, current);
            await interaction.editReply({ embeds, components: components as any });
            return;
        }

        // -------------------------------------------------------------------
        // モード管理ボタン
        // -------------------------------------------------------------------
        if (customId.startsWith('mode_select_')) {
            const modeName = customId.replace('mode_select_', '');
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const success = await selectMode(cdp.ops, modeName);
            const resultEmbed = buildModeSwitchResultEmbed(modeName, success);

            if (success) {
                // 切替後にリストを更新
                await cdp.ops.sleep(500);
                const { modes, current } = await getAvailableModes(cdp.ops);
                const { embeds, components } = buildModeListEmbed(modes, current);
                await interaction.editReply({ embeds, components: components as any });
            } else {
                await interaction.followUp({ embeds: [resultEmbed], ephemeral: true });
            }
            return;
        }

        if (customId === 'mode_refresh') {
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const { modes, current } = await getAvailableModes(cdp.ops);
            const { embeds, components } = buildModeListEmbed(modes, current);
            await interaction.editReply({ embeds, components: components as any });
            return;
        }

        // ----- テンプレート関連ボタン -----
        if (customId.startsWith('tpl_')) {
            await handleTemplateButton(ctx, interaction, customId);
            return;
        }

        logWarn(`ButtonHandler: unknown customId: ${customId}`);
        await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なボタン: ${customId}`, EmbedColor.Warning)], ephemeral: true });

    } catch (e) {
        logError(`handleButtonInteraction failed for ${customId}`, e);
        const errMsg = e instanceof Error ? e.message : String(e);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)], ephemeral: true });
        }
    }
}

// ---------------------------------------------------------------------------
// テンプレート一覧パネル生成
// ---------------------------------------------------------------------------

function buildTemplateListPanel(
    templateStore: TemplateStore,
): { embeds: ReturnType<typeof buildEmbed>[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const templates = templateStore.getAll();

    if (templates.length === 0) {
        const embed = buildEmbed('📋 **テンプレート一覧**\n\n保存済みテンプレートはありません。\n「➕ 新規作成」ボタンからテンプレートを追加できます。', EmbedColor.Info);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('tpl_new')
                .setLabel('➕ 新規作成')
                .setStyle(ButtonStyle.Success),
        );
        return { embeds: [embed], components: [row] };
    }

    const lines = ['📋 **テンプレート一覧**\n'];
    templates.forEach((t, i) => {
        const shortPrompt = t.prompt.length > 60 ? t.prompt.substring(0, 60) + '...' : t.prompt;
        lines.push(`**${i + 1}. ${t.name}**\n\`${shortPrompt}\``);
    });

    // 各テンプレートに ▶実行 / 🗑️削除 ボタンを追加（ActionRow 上限考慮: 新規作成ボタン用に4行まで）
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const maxRows = Math.min(templates.length, 4);
    for (let i = 0; i < maxRows; i++) {
        const t = templates[i];
        const safeName = t.name.substring(0, 40);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_run_${safeName}`)
                .setLabel(`▶ ${safeName}`)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`tpl_del_${safeName}`)
                .setLabel(`🗑️ ${safeName}`)
                .setStyle(ButtonStyle.Danger),
        );
        rows.push(row);
    }

    // 新規作成ボタン（最後の ActionRow）
    const createRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('tpl_new')
            .setLabel('➕ 新規作成')
            .setStyle(ButtonStyle.Success),
    );
    rows.push(createRow);

    return { embeds: [buildEmbed(lines.join('\n'), EmbedColor.Info)], components: rows };
}

// ---------------------------------------------------------------------------
// テンプレートボタンハンドラ
// ---------------------------------------------------------------------------

async function handleTemplateButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<void> {
    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    // ➕ 新規作成ボタン → モーダルを表示
    if (customId === 'tpl_new') {
        const modal = new ModalBuilder()
            .setCustomId('tpl_modal_save')
            .setTitle('テンプレート新規作成');

        const nameInput = new TextInputBuilder()
            .setCustomId('tpl_name')
            .setLabel('テンプレート名')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(40)
            .setPlaceholder('例: daily-report');

        const promptInput = new TextInputBuilder()
            .setCustomId('tpl_prompt')
            .setLabel('プロンプト内容')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setPlaceholder('例: 今日のタスクをまとめてください。変数: {{date}}, {{time}}');

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput) as any,
            new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
        );

        await interaction.showModal(modal);
        return;
    }

    // キャンセルボタン
    if (customId === 'tpl_cancel') {
        await interaction.update({ embeds: [buildEmbed('❌ キャンセルしました。', EmbedColor.Info)], components: [] });
        return;
    }

    // ▶ 実行ボタン（一覧から）→ プレビュー確認に遷移
    if (customId.startsWith('tpl_run_')) {
        const name = customId.slice('tpl_run_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const expandedPrompt = TemplateStore.expandVariables(template.prompt);
        const previewLines = [
            `📄 **テンプレート「${name}」プレビュー**`,
            '',
            '```',
            expandedPrompt.length > 500 ? expandedPrompt.substring(0, 500) + '...' : expandedPrompt,
            '```',
        ];

        const safeName = name.substring(0, 40);
        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_confirm_run_${safeName}`)
                .setLabel('▶ 実行')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('tpl_cancel')
                .setLabel('❌ キャンセル')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [buildEmbed(previewLines.join('\n'), EmbedColor.Info)], components: [confirmRow as any] });
        return;
    }

    // 🗑️ 削除ボタン（一覧から）→ 削除確認に遷移
    if (customId.startsWith('tpl_del_') && !customId.startsWith('tpl_confirm_del_')) {
        const name = customId.slice('tpl_del_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const safeName = name.substring(0, 40);
        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`tpl_confirm_del_${safeName}`)
                .setLabel('🗑️ 削除する')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('tpl_cancel')
                .setLabel('❌ キャンセル')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」を本当に削除しますか？`, EmbedColor.Warning)], components: [confirmRow as any] });
        return;
    }

    // ✅ 実行確認ボタン
    if (customId.startsWith('tpl_confirm_run_')) {
        const name = customId.slice('tpl_confirm_run_'.length);
        const template = templateStore.get(name);
        if (!template) {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
            return;
        }

        const cdp = ctx.cdp;
        const executor = ctx.executor;
        const fileIpc = ctx.fileIpc;
        const planStore = ctx.planStore;

        if (!executor || !cdp || !fileIpc || !planStore) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
            return;
        }

        await interaction.update({ embeds: [buildEmbed(`⏳ テンプレート「${name}」を実行中...`, EmbedColor.Info)], components: [] });

        const tplIpcDir = fileIpc.getIpcDir();
        const expandedPrompt = TemplateStore.expandVariables(template.prompt);
        const { responsePath } = fileIpc.createRequestId();
        const { prompt: tplSkillPrompt, tempFiles: tplTempFiles } = buildSkillPrompt(expandedPrompt, 'agent-chat', 'template-run', responsePath, undefined, undefined, tplIpcDir);
        try {
            await cdp.sendPrompt(tplSkillPrompt);
            const responseTimeout = getResponseTimeout();
            const skillResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);

            const skillOutput = parseSkillJson(skillResponse);
            if (!skillOutput) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ 応答を解析できませんでした。', EmbedColor.Warning)] });
                return;
            }

            const plan = buildPlan(skillOutput, interaction.channelId, interaction.channelId);
            if (plan.discord_templates.ack) {
                await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });
            }

            const wsName = cdp.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }

            executor.enqueueImmediate(plan);
            logInfo(`handleTemplateButton: tpl_confirm_run "${name}" — plan ${plan.plan_id} enqueued`);
        } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            logError('handleTemplateButton: tpl_confirm_run failed', e);
            await interaction.editReply({ embeds: [buildEmbed(`❌ テンプレート実行エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
        } finally {
            // 一時ファイルのクリーンアップ
            for (const f of tplTempFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        }
        return;
    }

    // ✅ 削除確認ボタン → 削除後にリストを再表示
    if (customId.startsWith('tpl_confirm_del_')) {
        const name = customId.slice('tpl_confirm_del_'.length);
        const deleted = templateStore.delete(name);
        if (deleted) {
            // 削除成功 → 更新されたテンプレート一覧を再表示
            const { embeds, components } = buildTemplateListPanel(templateStore);
            const successEmbed = buildEmbed(`🗑️ テンプレート「${name}」を削除しました。`, EmbedColor.Success);
            await interaction.update({ embeds: [successEmbed, ...embeds], components: components as any });
        } else {
            await interaction.reply({ embeds: [buildEmbed(`⚠️ テンプレート「${name}」が見つかりません。`, EmbedColor.Warning)], ephemeral: true });
        }
        return;
    }

    logWarn(`handleTemplateButton: unknown tpl_ customId: ${customId}`);
    await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なテンプレートボタン: ${customId}`, EmbedColor.Warning)], ephemeral: true });
}

// ---------------------------------------------------------------------------
// テンプレートモーダル送信ハンドラ
// ---------------------------------------------------------------------------

export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    if (interaction.customId !== 'tpl_modal_save') {
        logWarn(`handleModalSubmit: unknown modal customId: ${interaction.customId}`);
        return;
    }

    const templateStore = ctx.templateStore;
    if (!templateStore) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ TemplateStore が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    const name = interaction.fields.getTextInputValue('tpl_name').trim();
    const prompt = interaction.fields.getTextInputValue('tpl_prompt').trim();

    if (!name || !prompt) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ テンプレート名とプロンプトの両方を入力してください。', EmbedColor.Warning)], ephemeral: true });
        return;
    }

    templateStore.save(name, prompt);

    // 保存後にテンプレート一覧を再表示
    const { embeds, components } = buildTemplateListPanel(templateStore);
    const successEmbed = buildEmbed(`📝 テンプレート「${name}」を保存しました。`, EmbedColor.Success);
    await interaction.reply({ embeds: [successEmbed, ...embeds], components: components as any });
}

// ---------------------------------------------------------------------------
// オートコンプリートハンドラ（互換性のため残す）
// ---------------------------------------------------------------------------

export async function handleAutocomplete(
    ctx: BridgeContext,
    interaction: AutocompleteInteraction,
): Promise<void> {
    // サブコマンドレスのためオートコンプリートは不要だが、
    // Bot 起動時のエラーを防ぐため空の応答を返す
    await interaction.respond([]);
}

