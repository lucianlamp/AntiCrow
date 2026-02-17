// ---------------------------------------------------------------------------
// embedHelper.ts — Embed ビルダーユーティリティ
// ---------------------------------------------------------------------------

import { EmbedBuilder } from 'discord.js';

/** メッセージ種別に応じた Embed カラー */
export const EmbedColor = {
    /** 通常応答・情報 (Discord Blurple) */
    Info: 0x5865F2,
    /** 成功 (Green) */
    Success: 0x57F287,
    /** エラー (Red) */
    Error: 0xED4245,
    /** 警告・確認 (Yellow) */
    Warning: 0xFEE75C,
} as const;

export type EmbedColorValue = (typeof EmbedColor)[keyof typeof EmbedColor];

/**
 * 標準スタイルの Embed を生成する。
 * フッター「Antigravity Bridge」とタイムスタンプを自動付与。
 */
export function buildEmbed(
    description: string,
    color: EmbedColorValue = EmbedColor.Info
): EmbedBuilder {
    return new EmbedBuilder()
        .setDescription(description || '\u200b')
        .setColor(color);
}
