// ---------------------------------------------------------------------------
// slashHandler.ts — スラッシュコマンド・ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   1. ボタンインタラクションのルーティング
//   2. 管理系コマンドは adminHandler.ts, テンプレートは templateHandler.ts に委譲
// ---------------------------------------------------------------------------


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

import { ChannelIntent } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getAvailableModes, selectMode } from './cdpModes';
import { BridgeContext } from './bridgeContext';

import { getTimezone, isUserAllowed } from './configHelper';
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
        logDebug(`debouncedRename: cancelled pending rename for ${channelId}, replacing with "${newName}"`);
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
    logDebug(`debouncedRename: scheduled rename for ${channelId} → "${newName}" (2s delay)`);
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

    // /schedule コマンドは廃止済み — 未対応コマンドとして応答
    await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応のコマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
}

// ---------------------------------------------------------------------------
// ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

export async function handleButtonInteraction(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
): Promise<void> {
    const customId = interaction.customId;
    logDebug(`handleButtonInteraction: customId=${customId}`);

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
                logDebug(`ButtonHandler: paused plan ${planId}`);

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
                logDebug(`ButtonHandler: resumed plan ${planId}`);

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
                logDebug(`ButtonHandler: deleted plan ${planId}`);
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
