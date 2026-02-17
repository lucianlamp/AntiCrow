// ---------------------------------------------------------------------------
// slashHandler.ts — スラッシュコマンド・ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. /schedule, /status, /schedules, /reset, /newchat, /workspaces コマンド処理
//   2. ボタンインタラクション処理（スケジュール管理）
//   3. ワークスペース関連は workspaceHandler.ts に委譲
// ---------------------------------------------------------------------------

import {
    ChatInputCommandInteraction,
    ButtonInteraction,
    TextChannel,
} from 'discord.js';
import { parseSkillJson, buildPlan } from './planParser';
import { ChannelIntent } from './types';
import { logInfo, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { BridgeContext } from './bridgeContext';
import { buildSkillPrompt, cronToPrefix, resetProcessingFlag } from './messageHandler';
import { getResponseTimeout, getTimezone } from './configHelper';
import { buildWorkspaceListEmbed, getRunningWsNames, handleWorkspaceButton } from './workspaceHandler';

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
        const skillPrompt = buildSkillPrompt(userText, intent, channelName, responsePath);
        logInfo('handleSlashCommand: sending skill prompt via CDP...');

        let skillResponse: string;
        await cdp.sendPrompt(skillPrompt);
        logInfo('handleSlashCommand: prompt sent, waiting for file response...');

        const responseTimeout = getResponseTimeout();
        skillResponse = await fileIpc.waitForResponse(responsePath, responseTimeout);
        logInfo(`handleSlashCommand: skill response received (${skillResponse.length} chars)`);

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

        await interaction.editReply({ embeds: [buildEmbed(plan.discord_templates.ack, EmbedColor.Info)] });

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
    const { cdp, bot, planStore, scheduler, executor } = ctx;

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
            `- CDP接続: ${cdpOk ? '🟢 接続済み' : '🔴 未接続'}`,
            `- アクティブターゲット: ${activeTarget}${activePort ? ` (port ${activePort})` : ''}`,
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
                await interaction.reply({ embeds: [buildEmbed('⚠️ CDP が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
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
