// ---------------------------------------------------------------------------
// quotaButtons.ts — Discord Embed UI for クォータ表示
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { ModelQuota, QuotaData } from './quotaProvider';

// -----------------------------------------------------------------------
// プログレスバー生成
// -----------------------------------------------------------------------

const BAR_LENGTH = 10;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

function progressBar(percentage: number): string {
    const clamped = Math.max(0, Math.min(100, percentage));
    const filled = Math.round((clamped / 100) * BAR_LENGTH);
    return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_LENGTH - filled);
}

function statusEmoji(percentage: number): string {
    if (percentage <= 0) return '🔴';
    if (percentage <= 20) return '🟠';
    if (percentage <= 50) return '🟡';
    return '🟢';
}

// -----------------------------------------------------------------------
// クォータ一覧 Embed
// -----------------------------------------------------------------------

export function buildQuotaEmbed(
    data: QuotaData,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setTitle('📊 モデルクォータ')
        .setColor(0x5865F2)
        .setTimestamp(data.lastUpdated);

    // アカウント情報
    const descLines: string[] = [];
    descLines.push(`**アカウント:** ${data.accountLevel}`);
    if (data.promptCredits) {
        const pc = data.promptCredits;
        descLines.push(`**プロンプトクレジット:** ${pc.used.toLocaleString()} / ${pc.total.toLocaleString()} (残り ${pc.remainingPercentage}%)`);
    }
    embed.setDescription(descLines.join('\n'));

    // 各モデルのクォータ
    if (data.models.length > 0) {
        const modelLines = data.models.map(m => {
            const emoji = statusEmoji(m.remainingPercentage);
            const bar = progressBar(m.remainingPercentage);
            const reset = m.timeUntilResetFormatted && m.timeUntilResetFormatted !== 'N/A'
                ? ` (リセットまで ${m.timeUntilResetFormatted})`
                : '';
            return `${emoji} **${m.displayName}**\n${bar} ${m.remainingPercentage}%${reset}`;
        });

        // Discord Embed フィールドの 1024 文字制限を考慮して分割
        const chunks = splitIntoChunks(modelLines, 900);
        chunks.forEach((chunk, i) => {
            embed.addFields({
                name: i === 0 ? `📋 モデル別クォータ (${data.models.length}件)` : '\u200b',
                value: chunk.join('\n'),
            });
        });
    } else {
        embed.addFields({
            name: '📋 モデル別クォータ',
            value: 'モデル情報が取得できませんでした。',
        });
    }

    // 消耗モデルの警告
    const exhausted = data.models.filter(m => m.isExhausted);
    if (exhausted.length > 0) {
        embed.addFields({
            name: '⚠️ 枯渇モデル',
            value: exhausted.map(m => `- ${m.displayName}`).join('\n'),
        });
    }

    // リフレッシュボタン
    const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('quota_refresh')
            .setLabel('🔄 更新')
            .setStyle(ButtonStyle.Primary),
    );

    return { embeds: [embed], components: [refreshRow] };
}

/**
 * クォータ取得失敗時の Embed
 */
export function buildQuotaErrorEmbed(reason: string): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('📊 モデルクォータ')
        .setDescription(
            `⚠️ クォータ情報の取得に失敗しました。\n\n` +
            `**理由:** ${reason}\n\n` +
            `Antigravity が起動していることを確認してください。`,
        )
        .setColor(0xFEE75C)
        .setTimestamp();
}

/**
 * モデル名の横にクォータ情報を付記したフォーマットを返す
 * modelButtons.ts で使う想定
 */
export function formatModelWithQuota(
    modelName: string,
    quotaModels: ModelQuota[],
): string {
    const match = quotaModels.find(m =>
        m.displayName.toLowerCase() === modelName.toLowerCase() ||
        m.name.toLowerCase() === modelName.toLowerCase(),
    );

    if (!match) { return modelName; }
    const emoji = statusEmoji(match.remainingPercentage);
    return `${modelName} ${emoji} ${match.remainingPercentage}%`;
}

// -----------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------

function splitIntoChunks(lines: string[], maxLength: number): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (const line of lines) {
        if (currentLen + line.length + 1 > maxLength && current.length > 0) {
            chunks.push(current);
            current = [];
            currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + 1;
    }

    if (current.length > 0) { chunks.push(current); }
    return chunks;
}
