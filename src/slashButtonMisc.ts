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
import { getSuggestion, SUGGEST_AUTO_ID, AUTO_PROMPT } from './suggestionButtons';
import { processSuggestionPrompt } from './messageHandler';

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
                embeds: [buildEmbed('📋 VS Code 側にライセンス情報を表示しました。', EmbedColor.Success)],
            });
        } catch (e) {
            logError('pro_info button failed', e);
            await interaction.reply({
                embeds: [buildEmbed('❌ ライセンス情報の取得に失敗しました。', EmbedColor.Error)],
            });
        }
        return true;
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
        return true;
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
            return true;
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
        return true;
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
        return true;
    }

    // ----- 待機キュー全削除ボタン -----
    if (customId === 'queue_clear_waiting') {
        const { clearWaitingMessages } = await import('./messageHandler');
        const count = clearWaitingMessages();
        await interaction.reply({ embeds: [buildEmbed(`✅ ${count}件の待機メッセージを削除しました。`, EmbedColor.Success)] });
        return true;
    }

    // ----- 「エージェントに任せる」ボタン -----
    if (customId === SUGGEST_AUTO_ID) {
        const channelId = interaction.channelId;
        await interaction.reply({ embeds: [buildEmbed('🤖 **エージェントの判断で次のアクションを実行します**', EmbedColor.Info)] });
        processSuggestionPrompt(ctx, channelId, AUTO_PROMPT, interaction.user.id).catch((e: unknown) => {
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
            await interaction.reply({ embeds: [buildEmbed('⚠️ この提案は既に無効です。', EmbedColor.Warning)] });
            return true;
        }
        await interaction.reply({ embeds: [buildEmbed(`💡 **提案を実行:** ${suggestion.label}`, EmbedColor.Info)] });
        // メッセージパイプラインに提案プロンプトを流す（非同期で実行）
        processSuggestionPrompt(ctx, channelId, suggestion.prompt, interaction.user.id).catch((e: unknown) => {
            logError('suggest button: processSuggestionPrompt failed', e);
        });
        return true;
    }

    return false;
}
