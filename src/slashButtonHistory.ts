// ---------------------------------------------------------------------------
// slashButtonHistory.ts — 会話履歴管理ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import { ButtonInteraction } from 'discord.js';

import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { buildHistoryListEmbed, buildHistorySelectResultEmbed } from './historyButtons';
import { openHistoryAndGetSections, selectConversation, closePopup, type ConversationSection } from './cdpHistory';
import { BridgeContext } from './bridgeContext';
import { resolveHistoryCdp } from './slashHelpers';

/**
 * 会話履歴関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleHistoryButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (customId.startsWith('hist_select_')) {
        const indexStr = customId.replace('hist_select_', '');
        const index = parseInt(indexStr, 10);
        await interaction.deferUpdate();

        const { cdp } = resolveHistoryCdp(ctx, interaction);
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnHistory.notConnected'), EmbedColor.Warning)] });
            return true;
        }

        // まず履歴パネルを開いてセクション別に取得
        const sections = await openHistoryAndGetSections(cdp.ops);
        const wsSection = sections.find((s: ConversationSection) => s.section === 'workspace');
        const conversations = wsSection
            ? wsSection.items
            : sections.flatMap((s: ConversationSection) => s.items);
        const targetConv = conversations.find(c => c.index === index);
        const title = targetConv?.title || `${t('btnHistory.conversation')} #${index + 1}`;

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
        return true;
    }

    if (customId === 'hist_refresh' || customId.startsWith('hist_page_')) {
        await interaction.deferUpdate();

        const { cdp, wsName } = resolveHistoryCdp(ctx, interaction);
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnHistory.notConnected'), EmbedColor.Warning)] });
            return true;
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
            embeds[0]?.setFooter({ text: t('btnHistory.sectionWarning') });
        }

        await interaction.editReply({ embeds, components: components as any });
        return true;
    }

    if (customId === 'hist_close') {
        try {
            await interaction.message.delete();
        } catch {
            await interaction.deferUpdate();
        }
        return true;
    }

    return false;
}
