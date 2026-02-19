// ---------------------------------------------------------------------------
// slashHandler.ts — スラッシュコマンド・ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. /schedule コマンド処理
//   2. ボタンインタラクションのルーティング
//   3. 管理系コマンドは adminHandler.ts, テンプレートは templateHandler.ts に委譲
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
} from 'discord.js';
import { parseSkillJson, buildPlan } from './planParser';
import { ChannelIntent } from './types';
import { logInfo, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getAvailableModes, selectMode } from './cdpModes';
import { BridgeContext } from './bridgeContext';
import { buildSkillPrompt, cronToPrefix, resetProcessingFlag } from './messageHandler';
import { getResponseTimeout, getTimezone, isUserAllowed } from './configHelper';
import { handleWorkspaceButton, getRunningWsNames } from './workspaceHandler';
import { fetchQuota } from './quotaProvider';
import { handleManageSlash } from './adminHandler';
import { handleTemplateButton, buildTemplateListPanel, handleModalSubmit as handleTemplateModalSubmit } from './templateHandler';

// Re-export for backward compatibility
export { handleManageSlash } from './adminHandler';
export { handleTemplateButton, buildTemplateListPanel } from './templateHandler';

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

    // -----------------------------------------------------------------
    // セキュリティ: 全コマンドに対して許可ユーザーID制限を適用
    // -----------------------------------------------------------------
    const authResult = isUserAllowed(interaction.user.id);
    if (!authResult.allowed) {
        logWarn(`handleSlashCommand: user ${interaction.user.tag} (${interaction.user.id}) not allowed — ${authResult.reason}`);
        await interaction.reply({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)], ephemeral: true });
        return;
    }

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
            await executor.enqueueImmediate(plan);
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
            await interaction.editReply({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] }).catch(() => { });
        }
    }
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

    // -----------------------------------------------------------------
    // セキュリティ: ボタン操作にも許可ユーザーID制限を適用
    // -----------------------------------------------------------------
    const authResult = isUserAllowed(interaction.user.id);
    if (!authResult.allowed) {
        logWarn(`handleButtonInteraction: user ${interaction.user.tag} (${interaction.user.id}) not allowed — ${authResult.reason}`);
        await interaction.reply({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)], ephemeral: true });
        return;
    }

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
                const { embeds, components } = buildModelListEmbed(models, current, (await fetchQuota())?.models);
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
            const { embeds, components } = buildModelListEmbed(models, current, (await fetchQuota())?.models);
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

        // -------------------------------------------------------------------
        // クォータ更新ボタン
        // -------------------------------------------------------------------


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
            await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)], ephemeral: true });
        }
    }
}

// ---------------------------------------------------------------------------
// モーダル送信ハンドラ（templateHandler に委譲）
// ---------------------------------------------------------------------------

export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    await handleTemplateModalSubmit(ctx, interaction);
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
