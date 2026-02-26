// ---------------------------------------------------------------------------
// suggestionButtons.ts — インテリジェント提案の Discord UI
// ---------------------------------------------------------------------------
// 責務:
//   1. SuggestionItem[] から Discord ActionRow ボタンを生成
//   2. 提案の一時保存と取得（ボタンクリック時に prompt を復元するため）
// ---------------------------------------------------------------------------

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { SuggestionItem } from './suggestionParser';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** ボタン customId のプレフィックス */
export const SUGGEST_BUTTON_PREFIX = 'suggest_';

/** 「エージェントに任せる」ボタンの固定 customId */
export const SUGGEST_AUTO_ID = 'suggest_auto';

/** 自律判断ボタン押下時に実行されるプロンプト */
export const AUTO_PROMPT = '今の状況を見て、次にやるべきことをエージェントの判断で実行してください';

// ---------------------------------------------------------------------------
// 一時ストア（メモリ内）
// ---------------------------------------------------------------------------

/** channelId → SuggestionItem[] のマップ（ボタンクリック時に参照） */
const pendingSuggestions = new Map<string, { items: SuggestionItem[] }>();

/**
 * 提案を一時保存する（ボタンクリック時に取得できるよう）。
 * channelId 単位で管理。新しい提案が来たら上書き。
 */
export function storeSuggestions(channelId: string, items: SuggestionItem[]): void {
    pendingSuggestions.set(channelId, { items });
}

/**
 * channelId + index で提案を取得する。
 * 同一チャンネルで新しい提案が来ると古い提案は上書きされるため、
 * その場合は null を返す。
 */
export function getSuggestion(channelId: string, index: number): SuggestionItem | null {
    const entry = pendingSuggestions.get(channelId);
    if (!entry) return null;
    return entry.items[index] ?? null;
}

// ---------------------------------------------------------------------------
// Discord UI ビルダー
// ---------------------------------------------------------------------------

/** 絵文字プレフィックス */
const SUGGESTION_EMOJIS = ['💡', '🔧', '🚀'];

/**
 * 提案アイテムから Discord ボタン行を生成する。
 * 提案が0個の場合は null を返す。
 */
export function buildSuggestionRow(
    items: SuggestionItem[],
): ActionRowBuilder<ButtonBuilder> | null {
    if (items.length === 0) return null;

    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < items.length && i < 3; i++) {
        const emoji = SUGGESTION_EMOJIS[i] || '💡';
        const button = new ButtonBuilder()
            .setCustomId(`${SUGGEST_BUTTON_PREFIX}${i}`)
            .setLabel(items[i].label)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(emoji);
        row.addComponents(button);
    }

    // 「🤖 エージェントに任せる」ボタンを末尾に追加
    const autoButton = new ButtonBuilder()
        .setCustomId(SUGGEST_AUTO_ID)
        .setLabel('エージェントに任せる')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🤖');
    row.addComponents(autoButton);

    return row;
}

/**
 * 提案アイテムから description 付きのコンテンツテキストを生成する。
 * description を持つ提案がある場合、番号付きリストでボタンの上に表示する。
 * すべての提案に description がない場合はデフォルトの見出しのみ返す。
 */
export function buildSuggestionContent(items: SuggestionItem[]): string {
    const hasDescription = items.some(item => item.description);
    if (!hasDescription) {
        return '💡 **次のアクション提案**';
    }

    const lines = ['💡 **次のアクション提案**', ''];
    for (let i = 0; i < items.length && i < 3; i++) {
        const emoji = SUGGESTION_EMOJIS[i] || '💡';
        const desc = items[i].description || items[i].label;
        lines.push(`${emoji} **${items[i].label}** — ${desc}`);
    }
    return lines.join('\n');
}
