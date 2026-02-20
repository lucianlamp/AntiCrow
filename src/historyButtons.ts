// ---------------------------------------------------------------------------
// historyButtons.ts — Discord インタラクティブボタン UI for 会話履歴管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

// -----------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------

/** 1ページあたりの表示件数 */
const PAGE_SIZE = 5;

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
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setTitle('📜 会話履歴')
        .setColor(0x5865F2)
        .setTimestamp();

    if (conversations.length === 0) {
        embed.setDescription(
            '会話履歴が見つかりませんでした。\n' +
            'Antigravity のチャットパネルが開いていることを確認してください。',
        );
        return { embeds: [embed], components: [] };
    }

    // ページネーション計算
    const totalPages = Math.ceil(conversations.length / PAGE_SIZE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * PAGE_SIZE;
    const pageItems = conversations.slice(start, start + PAGE_SIZE);

    // 説明
    const pageInfo = totalPages > 1 ? ` (${safePage + 1}/${totalPages}ページ)` : '';
    embed.setDescription(`**${conversations.length}件の会話${pageInfo}**`);

    // 一覧をフィールドに
    const listLines = pageItems.map((conv, i) => {
        const globalIdx = start + i;
        const title = conv.title.length > 50
            ? conv.title.substring(0, 47) + '...'
            : conv.title;
        const time = conv.timeAgo ? ` — _${conv.timeAgo}_` : '';
        return `**${globalIdx + 1}.** ${title}${time}`;
    }).join('\n');

    embed.addFields({
        name: '📋 会話一覧',
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
                .setLabel('◀ 前')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
        );
    }

    // 更新
    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId('hist_refresh')
            .setLabel('🔄 更新')
            .setStyle(ButtonStyle.Primary),
    );

    // 次ページ
    if (totalPages > 1) {
        navRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`hist_page_${safePage + 1}`)
                .setLabel('▶ 次')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= totalPages - 1),
        );
    }

    // 閉じる
    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId('hist_close')
            .setLabel('❌ 閉じる')
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
            .setTitle('✅ 会話を切り替えました')
            .setDescription(`**${title}** に切り替えました。`)
            .setColor(0x57F287)
            .setTimestamp();
    } else {
        return new EmbedBuilder()
            .setTitle('❌ 会話切替に失敗')
            .setDescription(
                `**${title}** への切り替えに失敗しました。\n` +
                'Antigravity のチャットパネルが開いていることを確認し、もう一度お試しください。',
            )
            .setColor(0xED4245)
            .setTimestamp();
    }
}
