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

/**
 * エラーメッセージから内部実装の詳細を除去し、Discord 表示用にサニタイズする。
 * ファイルパス・ポート番号・WebSocket URL 等が含まれる場合は汎用メッセージに置換。
 */
export function sanitizeErrorForDiscord(rawMessage: string): string {
    const sensitivePatterns = [
        /[A-Z]:\\[^\s]+/gi,               // Windows パス (C:\Users\...)
        /\/(?:home|usr|tmp|var|etc)\b[^\s]*/g, // Unix パス
        /:\d{4,5}\b/g,                     // ポート番号 (:9222, :12345)
        /wss?:\/\/[^\s]+/gi,               // WebSocket URL
        /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s]*/gi, // ローカルURL
        /(?:CDP|Chrome DevTools Protocol)/gi, // CDP 言及
    ];
    for (const pattern of sensitivePatterns) {
        if (pattern.test(rawMessage)) {
            return '内部エラーが発生しました。詳細はログを確認してください。';
        }
    }
    return rawMessage;
}
