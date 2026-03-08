// ---------------------------------------------------------------------------
// embedHelper.ts — Embed ビルダーユーティリティ
// ---------------------------------------------------------------------------

import { EmbedBuilder } from 'discord.js';
import { t } from './i18n';

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
    /** 進捗報告 (Cyan) */
    Progress: 0x00BEBE,
    /** 最終レスポンス (Purple) */
    Response: 0x8D3ED9,
    /** 提案 (Orange) */
    Suggest: 0xF5A623,
} as const;

type EmbedColorValue = (typeof EmbedColor)[keyof typeof EmbedColor];

/**
 * 標準スタイルの Embed を生成する。
 * フッター「Antigravity Bridge」とタイムスタンプを自動付与。
 * showTimestamp が true の場合、フッターに現在時刻を表示する。
 */
export function buildEmbed(
    description: string,
    color: EmbedColorValue = EmbedColor.Info,
    showTimestamp = false,
): EmbedBuilder {
    // Discord は ####（4つ以上の #）をサポートしないため、**太字** 形式に変換
    const sanitized = normalizeHeadings(description || '');
    const embed = new EmbedBuilder()
        .setDescription(sanitized || '\u200b')
        .setColor(color);
    if (showTimestamp) {
        embed.setFooter({ text: 'Antigravity Bridge' });
        embed.setTimestamp();
    }
    return embed;
}

/**
 * Discord Embed 非対応の見出し記法（#### 以上）を **太字** 形式に変換する。
 * Discord がサポートするのは #, ##, ### のみ。
 */
export function normalizeHeadings(text: string): string {
    // 行頭の #{4,} を **太字** に変換（### 以下はそのまま）
    return text.replace(/^(#{4,})\s+(.+)$/gm, (_match, _hashes, title) => {
        return `**${title}**`;
    });
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
            return t('embed.internalError');
        }
    }
    return rawMessage;
}
