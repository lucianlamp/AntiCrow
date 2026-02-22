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
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';

import * as vscode from 'vscode';
import { ChannelIntent } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getAvailableModes, selectMode } from './cdpModes';
import { buildHistoryListEmbed, buildHistorySelectResultEmbed } from './historyButtons';
import { openHistoryAndGetList, selectConversation, closePopup } from './cdpHistory';
import { BridgeContext } from './bridgeContext';

import { getTimezone, isUserAllowed } from './configHelper';
import { handleWorkspaceButton, getRunningWsNames } from './workspaceHandler';
import { fetchQuota } from './quotaProvider';
import { handleManageSlash } from './adminHandler';
import { handleTemplateButton, buildTemplateListPanel, handleModalSubmit as handleTemplateModalSubmit } from './templateHandler';
import { getSuggestion } from './suggestionButtons';
import { processSuggestionPrompt } from './messageHandler';

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


        // -------------------------------------------------------------------
        // 会話履歴管理ボタン
        // -------------------------------------------------------------------
        if (customId.startsWith('hist_select_')) {
            const indexStr = customId.replace('hist_select_', '');
            const index = parseInt(indexStr, 10);
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            // まず履歴パネルを開いて一覧を取得（会話タイトル取得用）
            const conversations = await openHistoryAndGetList(cdp.ops);
            const targetConv = conversations.find(c => c.index === index);
            const title = targetConv?.title || `会話 #${index + 1}`;

            const success = await selectConversation(cdp.ops, index);
            // 選択後（成功・失敗問わず）履歴パネルを閉じる
            await closePopup(cdp.ops);
            const resultEmbed = buildHistorySelectResultEmbed(title, success);

            if (success) {
                await interaction.editReply({ embeds: [resultEmbed], components: [] });
            } else {
                await interaction.followUp({ embeds: [resultEmbed], ephemeral: true });
            }
            return;
        }

        if (customId === 'hist_refresh' || customId.startsWith('hist_page_')) {
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
                return;
            }

            const conversations = await openHistoryAndGetList(cdp.ops);
            await closePopup(cdp.ops);

            // ワークスペース名を CDP タイトルから抽出
            const activeTitle = cdp.getActiveTargetTitle() || '';
            const workspaceName = activeTitle.includes(' — ')
                ? activeTitle.split(' — ')[0].trim()
                : undefined;

            let page = 0;
            if (customId.startsWith('hist_page_')) {
                page = parseInt(customId.replace('hist_page_', ''), 10) || 0;
            }

            const { embeds, components } = buildHistoryListEmbed(conversations, page, workspaceName);
            await interaction.editReply({ embeds, components: components as any });
            return;
        }

        if (customId === 'hist_close') {
            try {
                await interaction.message.delete();
            } catch {
                await interaction.deferUpdate();
            }
            return;
        }

        // ----- テンプレート関連ボタン -----
        if (customId.startsWith('tpl_')) {
            await handleTemplateButton(ctx, interaction, customId);
            return;
        }

        // ----- Pro 関連ボタン -----
        if (customId === 'pro_info') {
            try {
                // VS Code 側のライセンス情報コマンドを実行
                await vscode.commands.executeCommand('anti-crow.licenseInfo');
                await interaction.reply({
                    embeds: [buildEmbed('📋 VS Code 側にライセンス情報を表示しました。', EmbedColor.Success)],
                    ephemeral: true,
                });
            } catch (e) {
                logError('pro_info button failed', e);
                await interaction.reply({
                    embeds: [buildEmbed('❌ ライセンス情報の取得に失敗しました。', EmbedColor.Error)],
                    ephemeral: true,
                });
            }
            return;
        }

        if (customId === 'pro_key_input') {
            const modal = new ModalBuilder()
                .setCustomId('pro_key_modal')
                .setTitle('ライセンスキー入力');

            const keyInput = new TextInputBuilder()
                .setCustomId('license_key')
                .setLabel('ライセンスキー')
                .setPlaceholder('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(8)
                .setMaxLength(128);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput),
            );

            await interaction.showModal(modal);
            return;
        }

        // ----- 待機キュー削除ボタン -----
        if (customId === 'queue_clear_waiting') {
            const { clearWaitingMessages } = await import('./messageHandler');
            const count = clearWaitingMessages();
            await interaction.reply({ embeds: [buildEmbed(`✅ ${count}件の待機メッセージを削除しました。`, EmbedColor.Success)] });
            return;
        }

        // ----- 提案ボタン -----
        if (customId.startsWith('suggest_')) {
            const channelId = interaction.channelId;
            const index = parseInt(customId.replace('suggest_', ''), 10);
            const suggestion = getSuggestion(channelId, index);
            if (!suggestion) {
                await interaction.reply({ embeds: [buildEmbed('⚠️ この提案は既に無効です。', EmbedColor.Warning)], ephemeral: true });
                return;
            }
            await interaction.reply({ embeds: [buildEmbed(`💡 **提案を実行:** ${suggestion.label}`, EmbedColor.Info)] });
            // メッセージパイプラインに提案プロンプトを流す（非同期で実行）
            processSuggestionPrompt(ctx, channelId, suggestion.prompt, interaction.user.id).catch((e: unknown) => {
                logError('suggest button: processSuggestionPrompt failed', e);
            });
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
    // Pro ライセンスキー入力モーダル
    if (interaction.customId === 'pro_key_modal') {
        const key = interaction.fields.getTextInputValue('license_key').trim();
        if (!key) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスキーが空です。', EmbedColor.Warning)],
                ephemeral: true,
            });
            return;
        }

        if (!ctx.setLicenseKeyFn) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスシステムが初期化されていません。VS Code 側で `AntiCrow: Set License Key` コマンドを実行してください。', EmbedColor.Warning)],
                ephemeral: true,
            });
            return;
        }

        try {
            const result = await ctx.setLicenseKeyFn(key);
            if (result.valid && result.planType !== 'free') {
                await interaction.reply({
                    embeds: [buildEmbed(`✅ ライセンス認証成功！\n\nプラン: **${result.planType}**\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Success)],
                    ephemeral: true,
                });
            } else {
                await interaction.reply({
                    embeds: [buildEmbed(`⚠️ ライセンスキーが無効です。正しいキーを入力してください。\n\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Warning)],
                    ephemeral: true,
                });
            }
            logDebug(`pro_key_modal: license key set, valid=${result.valid}, plan=${result.planType}`);
        } catch (e) {
            logError('pro_key_modal: failed to set license key', e);
            await interaction.reply({
                embeds: [buildEmbed('❌ ライセンスキーの設定に失敗しました。VS Code 側で `AntiCrow: Set License Key` コマンドを実行してください。', EmbedColor.Error)],
                ephemeral: true,
            });
        }
        return;
    }

    // テンプレート系モーダルに委譲
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
