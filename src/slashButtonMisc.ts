// ---------------------------------------------------------------------------
// slashButtonMisc.ts — Pro・キュー・提案関連ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ActionRowBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
} from 'discord.js';

import * as vscode from 'vscode';
import { logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { BridgeContext } from './bridgeContext';
import { handleTemplateButton } from './templateHandler';
import { getSuggestion, getAllSuggestions, SUGGEST_AUTO_ID, SUGGEST_AUTO_MODE_ID, AUTO_PROMPT } from './suggestionButtons';
import { processSuggestionPrompt } from './messageHandler';
import { t } from './i18n';
import { loadTeamConfig } from './teamConfig';
import { startAutoMode } from './autoModeController';

/**
 * テンプレート・Pro・キュー・提案関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleMiscButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    // ----- テンプレート関連ボタン -----
    if (customId.startsWith('tpl_')) {
        await handleTemplateButton(ctx, interaction, customId);
        return true;
    }

    // ----- Pro 関連ボタン -----
    if (customId === 'pro_info') {
        try {
            // VS Code 側のライセンス情報コマンドを実行
            await vscode.commands.executeCommand('anti-crow.licenseInfo');
            await interaction.reply({
                embeds: [buildEmbed(t('misc.pro.infoShown'), EmbedColor.Success)],
            });
        } catch (e) {
            logError('pro_info button failed', e);
            await interaction.reply({
                embeds: [buildEmbed(t('misc.pro.infoError'), EmbedColor.Error)],
            });
        }
        return true;
    }

    if (customId === 'pro_key_input') {
        const modal = new ModalBuilder()
            .setCustomId('pro_key_modal')
            .setTitle(t('misc.pro.keyModalTitle'));

        const keyInput = new TextInputBuilder()
            .setCustomId('license_key')
            .setLabel(t('misc.pro.keyLabel'))
            .setPlaceholder('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(8)
            .setMaxLength(128);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput),
        );

        await interaction.showModal(modal);
        return true;
    }

    // ----- 待機キュー編集ボタン -----
    if (customId.startsWith('queue_edit_waiting_')) {
        const msgId = customId.replace('queue_edit_waiting_', '');
        const { getWaitingMessageContent } = await import('./messageHandler');
        const content = getWaitingMessageContent(msgId);
        if (content === null) {
            await interaction.reply({
                embeds: [buildEmbed(t('misc.queue.messageProcessed'), EmbedColor.Warning)],
            });
            return true;
        }

        const modal = new ModalBuilder()
            .setCustomId(`queue_edit_modal_${msgId}`)
            .setTitle(t('misc.queue.editModalTitle'));

        const contentInput = new TextInputBuilder()
            .setCustomId('queue_edit_content')
            .setLabel(t('misc.queue.editLabel'))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(2000)
            .setValue(content.substring(0, 2000));

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(contentInput) as any,
        );

        await interaction.showModal(modal);
        return true;
    }

    // ----- 待機キュー個別削除ボタン -----
    if (customId.startsWith('queue_remove_waiting_')) {
        const msgId = customId.replace('queue_remove_waiting_', '');
        const { removeWaitingMessage } = await import('./messageHandler');
        const removed = removeWaitingMessage(msgId);
        if (removed) {
            await interaction.update({
                embeds: [buildEmbed(t('misc.queue.removed'), EmbedColor.Success)],
                components: [],
            });
        } else {
            await interaction.update({
                embeds: [buildEmbed(t('misc.queue.messageProcessed'), EmbedColor.Warning)],
                components: [],
            });
        }
        return true;
    }

    // ----- 待機キュー全削除ボタン -----
    if (customId === 'queue_clear_waiting') {
        const { clearWaitingMessages } = await import('./messageHandler');
        const count = clearWaitingMessages();
        await interaction.reply({ embeds: [buildEmbed(t('misc.queue.cleared', String(count)), EmbedColor.Success)] });
        return true;
    }

    // ----- 「🔄 オートモードで実行」ボタン（Phase 3: /suggest → /auto 連携） -----
    if (customId === SUGGEST_AUTO_MODE_ID) {
        const channelId = interaction.channelId;
        const suggestions = getAllSuggestions(channelId);

        if (!suggestions || suggestions.length === 0) {
            await interaction.reply({ embeds: [buildEmbed(t('misc.suggest.expired'), EmbedColor.Warning)] });
            return true;
        }

        // 全SUGGESTIONSを初期プロンプトとしてオートモード開始
        const suggestionPrompts = suggestions.map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`).join('\n');
        const autoPrompt = `以下の提案をすべて順番に実行してください:\n\n${suggestionPrompts}`;

        const channel = interaction.channel;
        if (!channel || !('send' in channel)) {
            await interaction.reply({ embeds: [buildEmbed('チャンネルが見つかりません', EmbedColor.Error)] });
            return true;
        }

        await interaction.reply({ embeds: [buildEmbed('🔄 **自律モードを開始します...**\n提案をすべて順番に自動実行します', EmbedColor.Info)] });

        // ワークスペースキーの取得
        const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const wsKey = repoRoot || 'default';

        // オートモード開始
        const prompt = await startAutoMode(channel as any, wsKey, autoPrompt, { maxSteps: suggestions.length + 2 });
        // プロンプトをパイプラインに投入
        processSuggestionPrompt(ctx, channelId, prompt, interaction.user.id).catch((e: unknown) => {
            logError('suggest_auto_mode button: processSuggestionPrompt failed', e);
        });
        return true;
    }

    // ----- 「エージェントに任せる」ボタン -----
    if (customId === SUGGEST_AUTO_ID) {
        const channelId = interaction.channelId;
        // 直前の提案を取得してプロンプトに含める
        const suggestions = getAllSuggestions(channelId);
        let prompt = AUTO_PROMPT;
        if (suggestions && suggestions.length > 0) {
            const suggestionContext = suggestions.map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`).join('\n');
            prompt = t('misc.suggest.autoPromptPrefix', suggestionContext, AUTO_PROMPT);
        }
        // チームモードが有効な場合、プロンプトにチーム活用の指示を追加
        const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (repoRoot) {
            const teamConfig = loadTeamConfig(repoRoot);
            if (teamConfig.enabled) {
                prompt += `\n\nエージェントチームモードが有効です（最大${teamConfig.maxAgents}エージェント）。タスクを分割して並列実行できる場合は、チームを有効活用してください。`;
            }
        }
        await interaction.reply({ embeds: [buildEmbed(t('misc.suggest.auto'), EmbedColor.Info)] });
        processSuggestionPrompt(ctx, channelId, prompt, interaction.user.id).catch((e: unknown) => {
            logError('suggest_auto button: processSuggestionPrompt failed', e);
        });
        return true;
    }

    // ----- 提案ボタン -----
    if (customId.startsWith('suggest_')) {
        const channelId = interaction.channelId;
        const index = parseInt(customId.replace('suggest_', ''), 10);
        const suggestion = getSuggestion(channelId, index);
        if (!suggestion) {
            await interaction.reply({ embeds: [buildEmbed(t('misc.suggest.expired'), EmbedColor.Warning)] });
            return true;
        }
        await interaction.reply({ embeds: [buildEmbed(t('misc.suggest.executing', suggestion.label), EmbedColor.Info)] });
        // メッセージパイプラインに提案プロンプトを流す（非同期で実行）
        processSuggestionPrompt(ctx, channelId, suggestion.prompt, interaction.user.id).catch((e: unknown) => {
            logError('suggest button: processSuggestionPrompt failed', e);
        });
        return true;
    }

    return false;
}
