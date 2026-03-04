// ---------------------------------------------------------------------------
// historyButtons.ts — Discord インタラクティブボタン UI for 会話履歴管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { t } from './i18n';

// -----------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------

/** 1ページあたりの表示件数 */
const PAGE_SIZE = 5;

/** 英語短縮形の timeAgo を日本語に変換する */
export function formatTimeAgoJa(timeAgo: string): string {
    // 「数字 + 単位」の形式を解析
    const match = timeAgo.match(/^(\d+)\s*(mo|m|h|d|w|y)$/i);
    if (!match) { return timeAgo; }
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const unitMap: Record<string, string> = {
        m: t('history.timeUnit.m'),
        h: t('history.timeUnit.h'),
        d: t('history.timeUnit.d'),
        w: t('history.timeUnit.w'),
        mo: t('history.timeUnit.mo'),
        y: t('history.timeUnit.y'),
    };
    return `${num}${unitMap[unit] || timeAgo}`;
}

// -----------------------------------------------------------------------
// 会話一覧 Embed + 切替ボタン
// -----------------------------------------------------------------------

/**
 * 会話一覧を Embed + ボタンで表示する。
 *
 * @param conversations - cdpHistory.getConversationList() の結果
 * @param page - 表示ページ (0-indexed)
 */
export function buildHistoryListEmbed(
    conversations: { title: string; index: number; timeAgo?: string }[],
    page: number = 0,
    workspaceName?: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const wsLabel = workspaceName ? ` — ${workspaceName}` : '';
    const embed = new EmbedBuilder()
        .setTitle(t('history.title', wsLabel))
        .setColor(0x5865F2)
        .setTimestamp();

    if (conversations.length === 0) {
        embed.setDescription(t('history.empty'));
        return { embeds: [embed], components: [] };
    }

    // ページネーション計算
    const totalPages = Math.ceil(conversations.length / PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * PAGE_SIZE;
    const pageItems = conversations.slice(start, start + PAGE_SIZE);

    // 説明
    const pageInfo = totalPages > 1 ? ` (${t('history.page', `${safePage + 1}/${totalPages}`)})` : '';
    embed.setDescription(t('history.count', String(conversations.length), pageInfo));

    // 一覧をフィールドに
    const listLines = pageItems.map((conv, i) => {
        const globalIdx = start + i;
        const title = conv.title.length > 50
            ? conv.title.substring(0, 47) + '...'
            : conv.title;
        const time = conv.timeAgo ? ` — _${formatTimeAgoJa(conv.timeAgo)}_` : '';
        return `**${globalIdx + 1}.** ${title}${time}`;
    }).join('\n');

    embed.addFields({
        name: t('history.fieldName'),
        value: listLines.length > 1024 ? listLines.substring(0, 1021) + '...' : listLines,
    });

    // ボタン作成
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    // 各会話に切替ボタン（1行5ボタン × 最大1行）
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const item of pageItems) {
        const globalIdx = conversations.indexOf(item);
        const label = (globalIdx + 1).toString();

        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`hist_select_${item.index}`)
                .setLabel(label)
                .setStyle(ButtonStyle.Secondary),
        );
    }
    if (row.components.length > 0) {
        components.push(row);
    }

    // ナビゲーション行: ◀前 / 🔄更新 / ▶次 / ❌閉じる
    const navRow = new ActionRowBuilder<ButtonBuilder>();

    // 前ページ
    if (totalPages > 1) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`hist_page_${safePage - 1}`)
                .setLabel(t('history.button.prev'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
        );
    }

    // 更新
    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId('hist_refresh')
            .setLabel(t('history.button.refresh'))
            .setStyle(ButtonStyle.Primary),
    );

    // 次ページ
    if (totalPages > 1) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`hist_page_${safePage + 1}`)
                .setLabel(t('history.button.next'))
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= totalPages - 1),
        );
    }

    // 閉じる
    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId('hist_close')
            .setLabel(t('history.button.close'))
            .setStyle(ButtonStyle.Danger),
    );

    components.push(navRow);

    return { embeds: [embed], components };
}

// -----------------------------------------------------------------------
// 会話切替結果 Embed
// -----------------------------------------------------------------------

export function buildHistorySelectResultEmbed(
    title: string,
    success: boolean,
): EmbedBuilder {
    if (success) {
        return new EmbedBuilder()
            .setTitle(t('history.switchSuccess'))
            .setDescription(t('history.switchSuccessDesc', title))
            .setColor(0x57F287)
            .setTimestamp();
    } else {
        return new EmbedBuilder()
            .setTitle(t('history.switchFail'))
            .setDescription(t('history.switchFailDesc', title))
            .setColor(0xED4245)
            .setTimestamp();
    }
}
