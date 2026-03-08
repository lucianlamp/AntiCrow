// ---------------------------------------------------------------------------
// slashHandler.ts — スラッシュコマンド・ボタンインタラクションハンドラ（ファサード）
// ---------------------------------------------------------------------------
// 責務:
//   1. ボタンインタラクションの共通処理（認証・短絡）とルーティング
//   2. 各ドメインハンドラへの委譲
//   3. 後方互換のための re-export
// ---------------------------------------------------------------------------
// モジュール分割により、実装は以下のファイルに分離:
//   - slashHelpers.ts         — ヘルパー関数群
//   - slashButtonSchedule.ts  — スケジュール関連ボタン
//   - slashButtonModel.ts     — モデル管理ボタン
//   - slashButtonMode.ts      — モード管理ボタン
//   - slashButtonHistory.ts   — 会話履歴管理ボタン
//   - slashButtonTeam.ts      — チーム・サブエージェント関連ボタン
//   - slashButtonMisc.ts      — Pro・キュー・提案ボタン
//   - slashModalHandlers.ts   — モーダル送信ハンドラ群
// ---------------------------------------------------------------------------


import {
    ChatInputCommandInteraction,
    ButtonInteraction,
    AutocompleteInteraction,
    ModalSubmitInteraction,
} from 'discord.js';

import { ChannelIntent } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { t } from './i18n';
import { BridgeContext } from './bridgeContext';
import { isUserAllowed } from './configHelper';
import { handleWorkspaceButton } from './workspaceHandler';
import { handleManageSlash } from './adminHandler';

// ドメイン別ボタンハンドラ
import { handleScheduleButton } from './slashButtonSchedule';
import { handleModelButton } from './slashButtonModel';
import { handleModeButton } from './slashButtonMode';
import { handleHistoryButton } from './slashButtonHistory';
import { handleTeamButton } from './slashButtonTeam';
import { handleMiscButton } from './slashButtonMisc';

// autoModeConfig（設定変更ボタン用）
import { loadAutoModeConfig, saveAutoModeConfig, formatConfigForDisplay, setConfigStoragePath } from './autoModeConfig';
import type { AutoModeConfig } from './autoModeController';

// モーダルハンドラ
import { handleModalSubmit as handleModalSubmitImpl } from './slashModalHandlers';

// ---------------------------------------------------------------------------
// 後方互換のための re-export
// ---------------------------------------------------------------------------
export { handleManageSlash } from './adminHandler';
export { handleTemplateButton, buildTemplateListPanel } from './templateHandler';
export { buildTeamButtons } from './slashButtonTeam';
export { debouncedRename, resolveRepoRootFromInteraction, resolveHistoryCdp } from './slashHelpers';

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
        await interaction.reply({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)] });
        return;
    }

    // 管理系コマンド (/status, /schedules) は専用ハンドラ
    if (intent === 'admin') {
        await handleManageSlash(ctx, interaction, commandName);
        return;
    }

    // /schedule コマンドは廃止済み — 未対応コマンドとして応答
    await interaction.reply({ embeds: [buildEmbed(t('slash.unknownCmd', commandName), EmbedColor.Warning)] });
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
    // 確認フロー関連ボタン: discordReactions.ts のメッセージコレクタで処理される
    // グローバル interactionCreate でも発火するが、ここでは無視する
    // 認証チェックよりも前に短絡させることで、コレクタの deferUpdate との
    // 競合（二重応答やタイムアウト）を防止する。
    // -----------------------------------------------------------------
    if (
        customId === 'confirm_approve' ||
        customId === 'confirm_reject' ||
        customId === 'confirm_auto' ||
        customId.startsWith('choice_') ||
        customId.startsWith('mchoice_')
    ) {
        return;
    }

    // -----------------------------------------------------------------
    // セキュリティ: ボタン操作にも許可ユーザーID制限を適用
    // -----------------------------------------------------------------
    const authResult = isUserAllowed(interaction.user.id);
    if (!authResult.allowed) {
        logWarn(`handleButtonInteraction: user ${interaction.user.tag} (${interaction.user.id}) not allowed — ${authResult.reason}`);
        await interaction.reply({ embeds: [buildEmbed(`🔒 ${authResult.reason}`, EmbedColor.Warning)] });
        return;
    }

    // ワークスペース関連ボタンは workspaceHandler に委譲
    const handled = await handleWorkspaceButton(ctx, interaction);
    if (handled) { return; }

    // ----- Bridge 初期化チェック -----
    if (!ctx.planStore || !ctx.scheduler) {
        await interaction.reply({ embeds: [buildEmbed(t('slash.notInit'), EmbedColor.Warning)] });
        return;
    }

    try {
        // ドメイン別ハンドラにルーティング
        if (await handleScheduleButton(ctx, interaction, customId)) { return; }
        if (await handleModelButton(ctx, interaction, customId)) { return; }
        if (await handleModeButton(ctx, interaction, customId)) { return; }
        if (await handleHistoryButton(ctx, interaction, customId)) { return; }
        if (await handleMiscButton(ctx, interaction, customId)) { return; }
        if (await handleTeamButton(ctx, interaction, customId)) { return; }

        // ----- オートモード: 確認モード応答ボタン -----
        if (customId === 'confirm_continue' || customId === 'confirm_stop') {
            try {
                const autoMode: any = await import('./autoModeController');
                if (customId === 'confirm_continue') {
                    autoMode.handleConfirmResponse?.('continue');
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.confirm.continued'), EmbedColor.Success)] });
                } else {
                    autoMode.handleConfirmResponse?.('stop');
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.confirm.stopped'), EmbedColor.Warning)] });
                }
            } catch (e) {
                logWarn(`handleButtonInteraction: autoModeController not available: ${e instanceof Error ? e.message : e}`);
                await interaction.reply({ embeds: [buildEmbed(t('autoMode.notRunning'), EmbedColor.Warning)] });
            }
            return;
        }

        // ----- オートモード: /auto-config 設定変更ボタン -----
        if (customId.startsWith('autoconfig_')) {
            try {
                const channel = interaction.channel;
                if (!channel || !channel.isTextBased()) {
                    await interaction.reply({ embeds: [buildEmbed(t('slash.error', 'Channel not available'), EmbedColor.Warning)] });
                    return;
                }

                // globalStoragePath を設定
                if (ctx.globalStoragePath) {
                    setConfigStoragePath(ctx.globalStoragePath);
                }

                const config = loadAutoModeConfig(channel.id);
                const updated = { ...config };

                // confirmMode 変更
                if (customId.startsWith('autoconfig_confirm_')) {
                    const mode = customId.replace('autoconfig_confirm_', '') as AutoModeConfig['confirmMode'];
                    if (['auto', 'semi', 'manual'].includes(mode)) {
                        updated.confirmMode = mode;
                    }
                }
                // selectionMode 変更
                else if (customId.startsWith('autoconfig_select_')) {
                    const mode = customId.replace('autoconfig_select_', '') as AutoModeConfig['selectionMode'];
                    if (['auto-delegate', 'first', 'ai-select'].includes(mode)) {
                        updated.selectionMode = mode;
                    }
                }
                // maxSteps 変更
                else if (customId.startsWith('autoconfig_steps_')) {
                    const steps = parseInt(customId.replace('autoconfig_steps_', ''), 10);
                    if (!isNaN(steps) && steps >= 1 && steps <= 20) {
                        updated.maxSteps = steps;
                    }
                }

                // 保存
                saveAutoModeConfig(channel.id, updated);

                // 更新された設定を表示
                const displayText = formatConfigForDisplay(updated);
                await interaction.reply({ embeds: [buildEmbed(`✅ 設定を更新しました\n\n${displayText}`, EmbedColor.Success)] });
            } catch (e) {
                logError(`handleButtonInteraction: autoconfig failed`, e);
                await interaction.reply({ embeds: [buildEmbed(t('slash.error', e instanceof Error ? e.message : String(e)), EmbedColor.Error)] });
            }
            return;
        }

        // ----- オートモード関連ボタン -----
        if (
            customId === 'safety_approve' ||
            customId === 'safety_skip' ||
            customId === 'safety_stop' ||
            customId === 'automode_stop' ||
            customId === 'auto_stop'
        ) {
            try {
                const autoMode: any = await import('./autoModeController');
                if (customId === 'safety_approve') {
                    autoMode.handleSafetyResponse?.('approve');
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.safety.approved'), EmbedColor.Success)] });
                } else if (customId === 'safety_skip') {
                    autoMode.handleSafetyResponse?.('skip');
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.safety.skipped'), EmbedColor.Info)] });
                } else if (customId === 'safety_stop' || customId === 'automode_stop') {
                    autoMode.stopAutoMode?.();
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.safety.stopped'), EmbedColor.Warning)] });
                }
            } catch (e) {
                logWarn(`handleButtonInteraction: autoModeController not available: ${e instanceof Error ? e.message : e}`);
                await interaction.reply({ embeds: [buildEmbed(t('autoMode.notRunning'), EmbedColor.Warning)] });
            }
            return;
        }

        logWarn(`ButtonHandler: unknown customId: ${customId}`);
        await interaction.reply({ embeds: [buildEmbed(t('slash.unknownButton', customId), EmbedColor.Warning)] });

    } catch (e) {
        logError(`handleButtonInteraction failed for ${customId}`, e);
        const errMsg = e instanceof Error ? e.message : String(e);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [buildEmbed(t('slash.error', sanitizeErrorForDiscord(errMsg)), EmbedColor.Error)] });
        }
    }
}

// ---------------------------------------------------------------------------
// モーダル送信ハンドラ（slashModalHandlers.ts に委譲）
// ---------------------------------------------------------------------------

export async function handleModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<void> {
    await handleModalSubmitImpl(ctx, interaction);
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
