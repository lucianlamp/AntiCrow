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

//   - slashButtonTeam.ts      — チーム・サブエージェント関連ボタン
//   - slashButtonMisc.ts      — Pro・キュー・提案ボタン
//   - slashModalHandlers.ts   — モーダル送信ハンドラ群
// ---------------------------------------------------------------------------


import {
    ChatInputCommandInteraction,
    ButtonInteraction,
    AutocompleteInteraction,
    ModalSubmitInteraction,
    TextChannel,
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
export { debouncedRename, resolveRepoRootFromInteraction } from './slashHelpers';

// ---------------------------------------------------------------------------
// マルチWSボタン: customId から wsKey を抽出するヘルパー
// ---------------------------------------------------------------------------

/** オートモード系ボタンのベースID一覧 */
const AUTO_MODE_BUTTON_BASES = [
    'confirm_continue', 'confirm_stop',
    'safety_approve', 'safety_skip', 'safety_stop',
    'automode_stop', 'auto_stop',
] as const;

/**
 * オートモード系ボタンの customId を解析して action と wsKey を返す。
 * 形式: `{action}:{wsKey}` または `{action}`（後方互換）
 * @returns { action, wsKey } または undefined（マッチしない場合）
 */
export function parseAutoModeButtonId(customId: string): { action: string; wsKey?: string } | undefined {
    for (const base of AUTO_MODE_BUTTON_BASES) {
        if (customId === base) {
            return { action: base };
        }
        if (customId.startsWith(base + ':')) {
            const wsKey = customId.slice(base.length + 1);
            return { action: base, wsKey: wsKey || undefined };
        }
    }
    return undefined;
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

        if (await handleMiscButton(ctx, interaction, customId)) { return; }
        if (await handleTeamButton(ctx, interaction, customId)) { return; }

        // ----- 連続オートモード: 確認モード応答ボタン -----
        const confirmParsed = parseAutoModeButtonId(customId);
        if (confirmParsed && (confirmParsed.action === 'confirm_continue' || confirmParsed.action === 'confirm_stop')) {
            try {
                const autoMode: any = await import('./autoModeController');
                if (confirmParsed.action === 'confirm_continue') {
                    autoMode.handleConfirmResponse?.('continue', confirmParsed.wsKey);
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.confirm.continued'), EmbedColor.Success)] });
                } else {
                    autoMode.handleConfirmResponse?.('stop', confirmParsed.wsKey);
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.confirm.stopped'), EmbedColor.Warning)] });
                }
            } catch (e) {
                logWarn(`handleButtonInteraction: autoModeController not available: ${e instanceof Error ? e.message : e}`);
                await interaction.reply({ embeds: [buildEmbed(t('autoMode.notRunning'), EmbedColor.Warning)] });
            }
            return;
        }

        // ----- 連続オートモード: /auto-config 設定変更ボタン -----
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

        // ----- 連続オートモード関連ボタン -----
        const safetyParsed = parseAutoModeButtonId(customId);
        if (safetyParsed && (
            safetyParsed.action === 'safety_approve' ||
            safetyParsed.action === 'safety_skip' ||
            safetyParsed.action === 'safety_stop' ||
            safetyParsed.action === 'automode_stop' ||
            safetyParsed.action === 'auto_stop'
        )) {
            try {
                const autoMode: any = await import('./autoModeController');
                if (safetyParsed.action === 'safety_approve') {
                    autoMode.handleSafetyResponse?.('approve', safetyParsed.wsKey);
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.safety.approved'), EmbedColor.Success)] });
                } else if (safetyParsed.action === 'safety_skip') {
                    autoMode.handleSafetyResponse?.('skip', safetyParsed.wsKey);
                    await interaction.reply({ embeds: [buildEmbed(t('autoMode.safety.skipped'), EmbedColor.Info)] });
                } else {
                    // safety_stop / automode_stop / auto_stop
                    const ch = interaction.channel;
                    if (ch && ch.isTextBased() && !ch.isDMBased()) {
                        await autoMode.stopAutoMode?.(ch as TextChannel, 'manual', safetyParsed.wsKey);
                    } else {
                        logWarn('handleButtonInteraction: auto_stop — channel is not TextChannel, calling handleSafetyResponse instead');
                        autoMode.handleSafetyResponse?.('stop', safetyParsed.wsKey);
                    }
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
