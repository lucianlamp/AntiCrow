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
import { loadTeamConfig, saveTeamConfig } from './teamConfig';
import { ChannelIntent } from './types';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord } from './embedHelper';
import { buildScheduleListEmbed, buildDeleteConfirmEmbed, naturalTextToCron, cronToHuman } from './scheduleButtons';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getAvailableModels, selectModel } from './cdpModels';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getAvailableModes, selectMode } from './cdpModes';
import { buildHistoryListEmbed, buildHistorySelectResultEmbed } from './historyButtons';
import { openHistoryAndGetSections, selectConversation, closePopup, type ConversationSection } from './cdpHistory';
import { BridgeContext } from './bridgeContext';
import { resolveWorkspaceFromChannel } from './discordChannels';

import { getTimezone, isUserAllowed } from './configHelper';
import { handleWorkspaceButton, handleWorkspaceModalSubmit, getRunningWsNames } from './workspaceHandler';
import { fetchQuota } from './quotaProvider';
import { handleManageSlash } from './adminHandler';
import { handleTemplateButton, buildTemplateListPanel, handleModalSubmit as handleTemplateModalSubmit } from './templateHandler';
import { TemplateStore } from './templateStore';
import { getSuggestion, SUGGEST_AUTO_ID, AUTO_PROMPT } from './suggestionButtons';
import { processSuggestionPrompt } from './messageHandler';
import { updateAnticrowMd } from './anticrowCustomizer';

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

/**
 * インタラクションの Discord チャンネルカテゴリからワークスペース名を解決し、
 * 対応する repoRoot パスを返すヘルパー。
 * フォールバックとして workspaceFolders[0] を返す。
 */
function resolveRepoRootFromInteraction(
    interaction: { channel: unknown },
    cdpPool?: import('./cdpPool').CdpPool | null,
): { repoRoot: string | undefined; wsName: string | null } {
    const channel = interaction.channel;
    let wsName: string | null = null;
    if (channel && typeof channel === 'object' && 'parent' in channel) {
        wsName = resolveWorkspaceFromChannel(channel as import('discord.js').TextChannel);
    }
    if (wsName) {
        const wsPaths = cdpPool?.getResolvedWorkspacePaths() ?? {};
        if (wsPaths[wsName]) {
            return { repoRoot: wsPaths[wsName], wsName };
        }
    }
    return { repoRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, wsName };
}

/**
 * ボタンインタラクションからワークスペースを解決し、
 * 対応する CdpBridge を取得する共通ヘルパー。
 * フォールバックとして ctx.cdp（デフォルト）を返す。
 */
function resolveHistoryCdp(
    ctx: BridgeContext,
    interaction: { channel: unknown },
): { cdp: BridgeContext['cdp']; wsName: string | null } {
    const channel = interaction.channel;
    let wsName: string | null = null;
    if (channel && typeof channel === 'object' && 'parent' in channel) {
        wsName = resolveWorkspaceFromChannel(channel as import('discord.js').TextChannel);
    }
    let cdp = ctx.cdp;
    if (wsName && ctx.cdpPool) {
        const poolCdp = ctx.cdpPool.getActive(wsName);
        if (poolCdp) {
            cdp = poolCdp;
            logDebug(`resolveHistoryCdp: using cdpPool for workspace "${wsName}"`);
        } else {
            logDebug(`resolveHistoryCdp: cdp for workspace "${wsName}" not active, fallback to default`);
        }
    }
    return { cdp, wsName };
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
    await interaction.reply({ embeds: [buildEmbed(`⚠️ 未対応のコマンド: /${commandName}`, EmbedColor.Warning)] });
}

// ---------------------------------------------------------------------------
// チームモードボタンパネル構築ヘルパー
// ---------------------------------------------------------------------------

function buildTeamButtons(config: import('./teamConfig').TeamConfig): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('team_on')
            .setLabel('🟢 チームON')
            .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_off')
            .setLabel('🔴 チームOFF')
            .setStyle(!config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_status')
            .setLabel('📊 ステータス')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('team_config')
            .setLabel('⚙️ 設定')
            .setStyle(ButtonStyle.Secondary),
    );
    return [row];
}

// ---------------------------------------------------------------------------
// サブエージェントボタンパネル構築ヘルパー
// ---------------------------------------------------------------------------

function buildSubagentButtons(agents: { name: string; state: string }[]): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('subagent_spawn')
            .setLabel('🚀 起動')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('subagent_list')
            .setLabel('📋 一覧')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('subagent_killall')
            .setLabel('⏹️ 全停止')
            .setStyle(agents.length > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(agents.length === 0),
    );
    return [row];
}

function buildSubagentListText(agents: { name: string; state: string }[]): string {
    if (agents.length === 0) {
        return '📋 **サブエージェント管理**\n\n現在実行中のサブエージェントはありません。';
    }
    return `📋 **サブエージェント管理** (${agents.length}件)\n\n`
        + agents.map(a => `  • \`${a.name}\` — ${a.state}`).join('\n');
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

    // ----- スケジュール関連ボタン -----
    if (!ctx.planStore || !ctx.scheduler) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)] });
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

        // ➕ 新規作成ボタン → モーダルを表示
        if (customId === 'sched_new') {
            const modal = new ModalBuilder()
                .setCustomId('sched_modal_new')
                .setTitle('スケジュール新規作成');

            const promptInput = new TextInputBuilder()
                .setCustomId('sched_prompt')
                .setLabel('実行内容（プロンプト）')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(2000)
                .setPlaceholder('例: 今日のタスクをまとめてレポートしてください。変数: {{date}}, {{env:XXX}}');

            const cronInput = new TextInputBuilder()
                .setCustomId('sched_cron_text')
                .setLabel('実行スケジュール（自然文 or cron式）')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100)
                .setPlaceholder('例: 毎日9時 / 平日の18時 / 3時間おき / 0 9 * * *');

            const summaryInput = new TextInputBuilder()
                .setCustomId('sched_summary')
                .setLabel('スケジュール名（省略可）')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(60)
                .setPlaceholder('例: 日次レポート');

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
                new ActionRowBuilder<TextInputBuilder>().addComponents(cronInput) as any,
                new ActionRowBuilder<TextInputBuilder>().addComponents(summaryInput) as any,
            );

            await interaction.showModal(modal);
            return;
        }

        if (customId.startsWith('sched_toggle_')) {
            const planId = customId.replace('sched_toggle_', '');
            const plan = ctx.planStore.get(planId);
            if (!plan) {
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)] });
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
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)] });
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

        // ▶️ 即時実行ボタン
        if (customId.startsWith('sched_run_')) {
            const planId = customId.replace('sched_run_', '');
            const plan = ctx.planStore.get(planId);
            if (!plan) {
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)] });
                return;
            }

            const summary = plan.human_summary || plan.prompt.substring(0, 60);
            await interaction.reply({
                embeds: [buildEmbed(`▶️ スケジュール「${summary}」を即時実行します...`, EmbedColor.Info)],
            });

            // 変数展開
            const expandedPrompt = TemplateStore.expandVariables(plan.prompt);

            // 即時実行用の Plan を複製（元の Plan は変更しない）
            const immediatePlan: import('./types').Plan = {
                ...plan,
                plan_id: plan.plan_id + '_run_' + Date.now(),
                prompt: expandedPrompt,
                cron: null,
                notify_channel_id: interaction.channelId || plan.notify_channel_id,
            };

            const wsName = plan.workspace_name || '';
            if (ctx.executorPool) {
                await ctx.executorPool.enqueueImmediate(wsName, immediatePlan);
            } else if (ctx.executor) {
                await ctx.executor.enqueueImmediate(immediatePlan);
            }
            logDebug(`sched_run: enqueued immediate execution for plan ${planId}`);
            return;
        }

        // ✏️ 編集ボタン → モーダル表示
        if (customId.startsWith('sched_edit_')) {
            const planId = customId.replace('sched_edit_', '');
            const plan = ctx.planStore.get(planId);
            if (!plan) {
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)] });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`sched_modal_edit_${planId}`)
                .setTitle('スケジュール編集');

            const promptInput = new TextInputBuilder()
                .setCustomId('sched_edit_prompt')
                .setLabel('実行内容（プロンプト）')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(2000)
                .setValue(plan.prompt.substring(0, 2000));

            const cronInput = new TextInputBuilder()
                .setCustomId('sched_edit_cron_text')
                .setLabel('実行スケジュール（自然文 or cron式）')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100)
                .setValue(plan.cron || '')
                .setPlaceholder('例: 毎日9時 / 平日の18時 / 0 9 * * *');

            const summaryInput = new TextInputBuilder()
                .setCustomId('sched_edit_summary')
                .setLabel('スケジュール名（省略可）')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(60)
                .setValue(plan.human_summary || '');

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput) as any,
                new ActionRowBuilder<TextInputBuilder>().addComponents(cronInput) as any,
                new ActionRowBuilder<TextInputBuilder>().addComponents(summaryInput) as any,
            );

            await interaction.showModal(modal);
            return;
        }

        // -------------------------------------------------------------------
        // モデル管理ボタン
        // -------------------------------------------------------------------
        if (customId.startsWith('model_select_')) {
            const modelIndex = parseInt(customId.replace('model_select_', ''), 10);
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            // インデックスベースで直接選択（getAvailableModels の再呼出しを省略）
            const success = await selectModel(cdp.ops, modelIndex);
            const resultEmbed = buildModelSwitchResultEmbed(`モデル #${modelIndex}`, success);

            if (success) {
                // 切替後にリストを更新
                await cdp.ops.sleep(500);
                const { models, current } = await getAvailableModels(cdp.ops);
                const { embeds, components } = buildModelListEmbed(models, current, (await fetchQuota())?.models);
                await interaction.editReply({ embeds, components: components as any });
            } else {
                await interaction.followUp({ embeds: [resultEmbed] });
            }
            return;
        }

        if (customId === 'model_refresh') {
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
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
            const modeIndex = parseInt(customId.replace('mode_select_', ''), 10);
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            // インデックスからモード名を逆引き
            const { modes: currentModes } = await getAvailableModes(cdp.ops);
            const modeName = currentModes[modeIndex];
            if (!modeName) {
                await interaction.followUp({ embeds: [buildEmbed(`⚠️ モードインデックス ${modeIndex} が範囲外です。一覧を更新してください。`, EmbedColor.Warning)] });
                return;
            }

            const success = await selectMode(cdp.ops, modeName);
            const resultEmbed = buildModeSwitchResultEmbed(modeName, success);

            if (success) {
                // 切替後にリストを更新（UI反映を待つため長めに待機）
                await cdp.ops.sleep(1000);
                const { modes, current } = await getAvailableModes(cdp.ops);
                // selectMode 成功時は常に選択したモード名を current として使用する
                // （getAvailableModes はUIの反映遅延で旧モード名を返す場合があるため、
                //   current || modeName では旧値がそのまま使われてしまう）
                const effectiveCurrent = modeName;
                const { embeds, components } = buildModeListEmbed(modes, effectiveCurrent);
                await interaction.editReply({ embeds, components: components as any });
            } else {
                await interaction.followUp({ embeds: [resultEmbed] });
            }
            return;
        }

        if (customId === 'mode_refresh') {
            await interaction.deferUpdate();

            const cdp = ctx.cdp;
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
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

            const { cdp } = resolveHistoryCdp(ctx, interaction);
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            // まず履歴パネルを開いてセクション別に取得
            const sections = await openHistoryAndGetSections(cdp.ops);
            const wsSection = sections.find((s: ConversationSection) => s.section === 'workspace');
            const conversations = wsSection
                ? wsSection.items
                : sections.flatMap((s: ConversationSection) => s.items);
            const targetConv = conversations.find(c => c.index === index);
            const title = targetConv?.title || `会話 #${index + 1}`;

            // globalIndex を使って selectConversation を呼び出す
            const globalIdx = targetConv?.globalIndex ?? index;
            const success = await selectConversation(cdp.ops, globalIdx);
            // 選択後（成功・失敗問わず）履歴パネルを閉じる
            await closePopup(cdp.ops);
            const resultEmbed = buildHistorySelectResultEmbed(title, success);

            if (success) {
                await interaction.editReply({ embeds: [resultEmbed], components: [] });
            } else {
                await interaction.followUp({ embeds: [resultEmbed] });
            }
            return;
        }

        if (customId === 'hist_refresh' || customId.startsWith('hist_page_')) {
            await interaction.deferUpdate();

            const { cdp, wsName } = resolveHistoryCdp(ctx, interaction);
            if (!cdp) {
                await interaction.followUp({ embeds: [buildEmbed('⚠️ Antigravity との接続が初期化されていません。', EmbedColor.Warning)] });
                return;
            }

            const sections = await openHistoryAndGetSections(cdp.ops);
            await closePopup(cdp.ops);

            // workspace セクションの items のみ使用
            const wsSection = sections.find((s: ConversationSection) => s.section === 'workspace');
            const unknownSection = sections.find((s: ConversationSection) => s.section === 'unknown');
            const conversations = wsSection
                ? wsSection.items
                : sections.flatMap((s: ConversationSection) => s.items);

            // ワークスペース名: セクションラベルから抽出、フォールバックとしてチャンネルカテゴリ/CDPタイトル
            let workspaceName: string | undefined;
            if (wsSection?.sectionLabel) {
                const match = wsSection.sectionLabel.match(/^Recent in (.+)$/i);
                workspaceName = match ? match[1].trim() : wsSection.sectionLabel;
            } else {
                workspaceName = wsName || undefined;
                if (!workspaceName) {
                    const activeTitle = cdp.getActiveTargetTitle() || '';
                    workspaceName = activeTitle.includes(' — ')
                        ? activeTitle.split(' — ')[0].trim()
                        : undefined;
                }
            }

            let page = 0;
            if (customId.startsWith('hist_page_')) {
                page = parseInt(customId.replace('hist_page_', ''), 10) || 0;
            }

            const { embeds, components } = buildHistoryListEmbed(conversations, page, workspaceName);

            // unknown セクション（セクション分類失敗）の場合、警告をフッターに追加
            if (unknownSection && !wsSection) {
                embeds[0]?.setFooter({ text: '⚠️ セクション分類に失敗しました。別ワークスペースの会話が含まれている可能性があります。' });
            }

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
                });
            } catch (e) {
                logError('pro_info button failed', e);
                await interaction.reply({
                    embeds: [buildEmbed('❌ ライセンス情報の取得に失敗しました。', EmbedColor.Error)],
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

        // ----- 待機キュー編集ボタン -----
        if (customId.startsWith('queue_edit_waiting_')) {
            const msgId = customId.replace('queue_edit_waiting_', '');
            const { getWaitingMessageContent } = await import('./messageHandler');
            const content = getWaitingMessageContent(msgId);
            if (content === null) {
                await interaction.reply({
                    embeds: [buildEmbed('⚠️ 該当のメッセージは既に処理済みか削除されています', EmbedColor.Warning)],
                });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`queue_edit_modal_${msgId}`)
                .setTitle('メッセージ編集');

            const contentInput = new TextInputBuilder()
                .setCustomId('queue_edit_content')
                .setLabel('メッセージ内容')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(2000)
                .setValue(content.substring(0, 2000));

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(contentInput) as any,
            );

            await interaction.showModal(modal);
            return;
        }

        // ----- 待機キュー個別削除ボタン -----
        if (customId.startsWith('queue_remove_waiting_')) {
            const msgId = customId.replace('queue_remove_waiting_', '');
            const { removeWaitingMessage } = await import('./messageHandler');
            const removed = removeWaitingMessage(msgId);
            if (removed) {
                await interaction.update({
                    embeds: [buildEmbed(`✅ 待機メッセージを削除しました`, EmbedColor.Success)],
                    components: [],
                });
            } else {
                await interaction.update({
                    embeds: [buildEmbed(`⚠️ 該当のメッセージは既に処理済みか削除されています`, EmbedColor.Warning)],
                    components: [],
                });
            }
            return;
        }

        // ----- 待機キュー全削除ボタン -----
        if (customId === 'queue_clear_waiting') {
            const { clearWaitingMessages } = await import('./messageHandler');
            const count = clearWaitingMessages();
            await interaction.reply({ embeds: [buildEmbed(`✅ ${count}件の待機メッセージを削除しました。`, EmbedColor.Success)] });
            return;
        }

        // ----- 「エージェントに任せる」ボタン -----
        if (customId === SUGGEST_AUTO_ID) {
            const channelId = interaction.channelId;
            await interaction.reply({ embeds: [buildEmbed('🤖 **エージェントの判断で次のアクションを実行します**', EmbedColor.Info)] });
            processSuggestionPrompt(ctx, channelId, AUTO_PROMPT, interaction.user.id).catch((e: unknown) => {
                logError('suggest_auto button: processSuggestionPrompt failed', e);
            });
            return;
        }

        // ----- 提案ボタン -----
        if (customId.startsWith('suggest_')) {
            const channelId = interaction.channelId;
            const index = parseInt(customId.replace('suggest_', ''), 10);
            const suggestion = getSuggestion(channelId, index);
            if (!suggestion) {
                await interaction.reply({ embeds: [buildEmbed('⚠️ この提案は既に無効です。', EmbedColor.Warning)] });
                return;
            }
            await interaction.reply({ embeds: [buildEmbed(`💡 **提案を実行:** ${suggestion.label}`, EmbedColor.Info)] });
            // メッセージパイプラインに提案プロンプトを流す（非同期で実行）
            processSuggestionPrompt(ctx, channelId, suggestion.prompt, interaction.user.id).catch((e: unknown) => {
                logError('suggest button: processSuggestionPrompt failed', e);
            });
            return;
        }

        // ----- チームモード関連ボタン -----
        if (customId.startsWith('team_')) {
            const teamAction = customId.replace('team_', '');
            const { repoRoot } = resolveRepoRootFromInteraction(interaction, ctx.cdpPool);
            if (!repoRoot) {
                await interaction.reply({ embeds: [buildEmbed('⚠️ ワークスペースが検出されません。', EmbedColor.Warning)] });
                return;
            }
            const config = loadTeamConfig(repoRoot);
            const agentCount = ctx.subagentManager?.list().length ?? 0;

            switch (teamAction) {
                case 'on': {
                    config.enabled = true;
                    saveTeamConfig(repoRoot, config);
                    await interaction.update({
                        embeds: [buildEmbed('🟢 **チームモードを有効化しました！**\n\nメインエージェントが指揮官モードで動作します。', EmbedColor.Success)],
                        components: buildTeamButtons(config) as any,
                    });
                    return;
                }
                case 'off': {
                    config.enabled = false;
                    saveTeamConfig(repoRoot, config);
                    if (ctx.subagentManager) {
                        const agents = ctx.subagentManager.list();
                        for (const agent of agents) {
                            try { await ctx.subagentManager.killAgent(agent.name); } catch { /* skip */ }
                        }
                    }
                    await interaction.update({
                        embeds: [buildEmbed('🔴 **チームモードを無効化しました。**\n\n全サブエージェントを停止しました。', EmbedColor.Info)],
                        components: buildTeamButtons(config) as any,
                    });
                    return;
                }
                case 'status': {
                    const statusEmoji = config.enabled ? '🟢' : '🔴';
                    const statusText = config.enabled ? 'ON' : 'OFF';
                    let desc = `${statusEmoji} **エージェントチームモード: ${statusText}**\n\n`
                        + `📊 **稼働中**: ${agentCount} / ${config.maxAgents}\n`
                        + `⏱️ **タイムアウト**: ${Math.round(config.responseTimeoutMs / 60_000)}分`;
                    if (agentCount > 0 && ctx.subagentManager) {
                        const agents = ctx.subagentManager.list();
                        desc += '\n\n🤖 **サブエージェント一覧**\n' + agents.map(a => `  • **${a.name}** — ${a.state}`).join('\n');
                    }
                    await interaction.update({
                        embeds: [buildEmbed(desc, config.enabled ? EmbedColor.Success : EmbedColor.Info)],
                        components: buildTeamButtons(config) as any,
                    });
                    return;
                }
                case 'config': {
                    const configJson = JSON.stringify(config, null, 2);
                    await interaction.update({
                        embeds: [buildEmbed(`⚙️ **チーム設定**\n\`\`\`json\n${configJson}\n\`\`\``, EmbedColor.Info)],
                        components: buildTeamButtons(config) as any,
                    });
                    return;
                }
                default:
                    break;
            }
        }

        // ----- サブエージェント関連ボタン -----
        if (customId.startsWith('subagent_')) {
            const subAction = customId.replace('subagent_', '');
            const mgr = ctx.subagentManager;

            try {
                switch (subAction) {
                    case 'spawn': {
                        if (!mgr) {
                            await interaction.update({
                                embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                                components: buildSubagentButtons([]) as any,
                            });
                            return;
                        }
                        await interaction.deferUpdate();
                        const handle = await mgr.spawn();
                        const agents = mgr.list();
                        await interaction.editReply({
                            embeds: [buildEmbed(
                                `🚀 **サブエージェント \`${handle.name}\` を起動しました！**\n\n`
                                + buildSubagentListText(agents),
                                EmbedColor.Success,
                            )],
                            components: buildSubagentButtons(agents) as any,
                        });
                        return;
                    }
                    case 'list': {
                        const agents = mgr?.list() ?? [];
                        await interaction.update({
                            embeds: [buildEmbed(buildSubagentListText(agents), EmbedColor.Info)],
                            components: buildSubagentButtons(agents) as any,
                        });
                        return;
                    }
                    case 'killall': {
                        if (!mgr) {
                            await interaction.update({
                                embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                                components: buildSubagentButtons([]) as any,
                            });
                            return;
                        }
                        await interaction.deferUpdate();
                        await mgr.killAll();
                        await interaction.editReply({
                            embeds: [buildEmbed('⏹️ **全サブエージェントを停止しました。**\n\n現在実行中のサブエージェントはありません。', EmbedColor.Success)],
                            components: buildSubagentButtons([]) as any,
                        });
                        return;
                    }
                    default:
                        break;
                }
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                logError(`subagent button: ${subAction} failed`, e);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
                        components: buildSubagentButtons(mgr?.list() ?? []) as any,
                    }).catch(() => { });
                } else {
                    await interaction.update({
                        embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
                        components: buildSubagentButtons(mgr?.list() ?? []) as any,
                    });
                }
                return;
            }
        }

        logWarn(`ButtonHandler: unknown customId: ${customId}`);
        await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なボタン: ${customId}`, EmbedColor.Warning)] });

    } catch (e) {
        logError(`handleButtonInteraction failed for ${customId}`, e);
        const errMsg = e instanceof Error ? e.message : String(e);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${sanitizeErrorForDiscord(errMsg)}`, EmbedColor.Error)] });
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
    // ワークスペース作成モーダルは workspaceHandler に委譲
    if (interaction.customId === 'ws_modal_create') {
        await handleWorkspaceModalSubmit(ctx, interaction);
        return;
    }

    // SOUL.md 編集モーダル
    if (interaction.customId === 'soul_edit_modal') {
        const content = interaction.fields.getTextInputValue('soul_content');
        const result = updateAnticrowMd(content, 'overwrite');
        if (result.success) {
            const bytes = Buffer.byteLength(content, 'utf-8');
            await interaction.reply({
                embeds: [buildEmbed(`✅ SOUL.md を更新しました（${bytes} bytes）`, EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(`❌ SOUL.md の更新に失敗しました: ${result.error || '不明なエラー'}`, EmbedColor.Error)],
            });
        }
        return;
    }

    // Pro ライセンスキー入力モーダル
    if (interaction.customId === 'pro_key_modal') {
        const key = interaction.fields.getTextInputValue('license_key').trim();
        if (!key) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスキーが空です。', EmbedColor.Warning)],
            });
            return;
        }

        if (!ctx.setLicenseKeyFn) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ ライセンスシステムが初期化されていません。VS Code 側で `AntiCrow: Set License Key` コマンドを実行してください。', EmbedColor.Warning)],
            });
            return;
        }

        try {
            const result = await ctx.setLicenseKeyFn(key);
            if (result.valid && result.planType !== 'free') {
                await interaction.reply({
                    embeds: [buildEmbed(`✅ ライセンス認証成功！\n\nプラン: **${result.planType}**\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Success)],
                });
            } else {
                await interaction.reply({
                    embeds: [buildEmbed(`⚠️ ライセンスキーが無効です。正しいキーを入力してください。\n\nキー: \`${key.substring(0, 8)}...\``, EmbedColor.Warning)],
                });
            }
            logDebug(`pro_key_modal: license key set, valid=${result.valid}, plan=${result.planType}`);
        } catch (e) {
            logError('pro_key_modal: failed to set license key', e);
            const errDetail = e instanceof Error ? e.message : String(e);
            await interaction.reply({
                embeds: [buildEmbed(`❌ ライセンスキーの設定中にエラーが発生しました。\n\n**エラー:** ${errDetail}\n\nキーが保存済みの場合は、次回の自動検証で反映されます。手動で再試行する場合は \`/pro\` → 🔑キー入力 を再度お試しください。`, EmbedColor.Error)],
            });
        }
        return;
    }

    // テンプレート系モーダルに委譲
    if (interaction.customId.startsWith('tpl_')) {
        await handleTemplateModalSubmit(ctx, interaction);
        return;
    }

    // ----- キュー編集モーダル -----
    if (interaction.customId.startsWith('queue_edit_modal_')) {
        const msgId = interaction.customId.replace('queue_edit_modal_', '');
        const newContent = interaction.fields.getTextInputValue('queue_edit_content').trim();
        if (!newContent) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ メッセージ内容が空です。', EmbedColor.Warning)],
            });
            return;
        }

        const { editWaitingMessage } = await import('./messageHandler');
        const edited = editWaitingMessage(msgId, newContent);
        if (edited) {
            await interaction.reply({
                embeds: [buildEmbed(`✅ 待機メッセージを編集しました`, EmbedColor.Success)],
            });
        } else {
            await interaction.reply({
                embeds: [buildEmbed(`⚠️ 該当のメッセージは既に処理済みか削除されています`, EmbedColor.Warning)],
            });
        }
        return;
    }

    // ----- スケジュール新規作成モーダル -----
    if (interaction.customId === 'sched_modal_new') {
        const prompt = interaction.fields.getTextInputValue('sched_prompt').trim();
        const cronText = interaction.fields.getTextInputValue('sched_cron_text').trim();
        const summary = interaction.fields.getTextInputValue('sched_summary')?.trim() || undefined;

        if (!prompt) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ プロンプトが空です。', EmbedColor.Warning)],
            });
            return;
        }

        // 自然文 → cron 変換
        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    `⚠️ スケジュール「${cronText}」を cron 式に変換できませんでした。\n\n` +
                    '**対応形式の例:**\n' +
                    '- `毎日9時` / `毎日 09:30`\n' +
                    '- `毎週月曜の10時`\n' +
                    '- `平日の18時`\n' +
                    '- `3時間おき` / `30分おき`\n' +
                    '- `毎月1日の9時`\n' +
                    '- cron 式: `0 9 * * *`',
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)],
            });
            return;
        }

        // Plan 生成
        const { v4: uuidv4 } = await import('uuid');
        const plan: import('./types').Plan = {
            plan_id: uuidv4(),
            timezone: getTimezone(),
            cron,
            prompt,
            requires_confirmation: false,
            source_channel_id: interaction.channelId || '',
            notify_channel_id: interaction.channelId || '',
            discord_templates: {},
            human_summary: summary || prompt.substring(0, 60),
            status: 'active' as const,
            created_at: new Date().toISOString(),
            execution_count: 0,
        };

        ctx.planStore.add(plan);
        ctx.scheduler.register(plan);

        const humanCron = cronToHuman(cron);
        logDebug(`sched_modal_new: created plan ${plan.plan_id}, cron=${cron} (${humanCron})`);

        await interaction.reply({
            embeds: [buildEmbed(
                `✅ スケジュールを登録しました！\n\n` +
                `**${plan.human_summary}**\n` +
                `⏰ \`${cron}\` (${humanCron})\n` +
                `🆔 \`${plan.plan_id.substring(0, 8)}...\`\n\n` +
                `入力: 「${cronText}」`,
                EmbedColor.Success,
            )],
        });
        return;
    }

    // ----- スケジュール編集モーダル -----
    if (interaction.customId.startsWith('sched_modal_edit_')) {
        const planId = interaction.customId.replace('sched_modal_edit_', '');
        const prompt = interaction.fields.getTextInputValue('sched_edit_prompt').trim();
        const cronText = interaction.fields.getTextInputValue('sched_edit_cron_text').trim();
        const summary = interaction.fields.getTextInputValue('sched_edit_summary')?.trim() || undefined;

        if (!prompt) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ プロンプトが空です。', EmbedColor.Warning)],
            });
            return;
        }

        const cron = naturalTextToCron(cronText);
        if (!cron) {
            await interaction.reply({
                embeds: [buildEmbed(
                    `⚠️ スケジュール「${cronText}」を cron 式に変換できませんでした。\n\n` +
                    '**対応形式の例:**\n' +
                    '- `毎日9時` / `毎日 09:30`\n' +
                    '- `毎週月曜の10時`\n' +
                    '- `平日の18時`\n' +
                    '- `3時間おき` / `30分おき`\n' +
                    '- `毎月1日の9時`\n' +
                    '- cron 式: `0 9 * * *`',
                    EmbedColor.Warning,
                )],
            });
            return;
        }

        if (!ctx.planStore || !ctx.scheduler) {
            await interaction.reply({
                embeds: [buildEmbed('⚠️ Bridge が初期化されていません。', EmbedColor.Warning)],
            });
            return;
        }

        const oldPlan = ctx.planStore.get(planId);
        if (!oldPlan) {
            await interaction.reply({
                embeds: [buildEmbed(`⚠️ 計画 \`${planId}\` が見つかりません。`, EmbedColor.Warning)],
            });
            return;
        }

        const oldCron = oldPlan.cron;
        ctx.planStore.update(planId, {
            prompt,
            cron,
            human_summary: summary || prompt.substring(0, 60),
        });

        // Scheduler 再登録
        ctx.scheduler.unregister(planId);
        const updatedPlan = ctx.planStore.get(planId);
        if (updatedPlan && updatedPlan.status === 'active') {
            ctx.scheduler.register(updatedPlan);
        }

        const humanCron = cronToHuman(cron);
        const oldHumanCron = oldCron ? cronToHuman(oldCron) : '—';
        logDebug(`sched_modal_edit: updated plan ${planId}, cron=${oldCron} → ${cron}`);

        await interaction.reply({
            embeds: [buildEmbed(
                `✅ スケジュールを更新しました！\n\n` +
                `**${summary || prompt.substring(0, 60)}**\n` +
                `⏰ \`${cron}\` (${humanCron})\n` +
                (oldCron !== cron ? `📝 変更前: \`${oldCron}\` (${oldHumanCron})\n` : '') +
                `🆔 \`${planId.substring(0, 8)}...\``,
                EmbedColor.Success,
            )],
        });
        return;
    }
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
