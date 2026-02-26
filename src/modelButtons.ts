// ---------------------------------------------------------------------------
// modelButtons.ts — Discord インタラクティブボタン UI for モデル管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { ModelQuota } from './quotaProvider';

// -----------------------------------------------------------------------
// クォータヘルパー
// -----------------------------------------------------------------------

function quotaEmoji(percentage: number): string {
    if (percentage <= 0) return '🔴';
    if (percentage <= 20) return '🟠';
    if (percentage <= 50) return '🟡';
    return '🟢';
}

function findQuota(modelName: string, quotas?: ModelQuota[]): ModelQuota | undefined {
    if (!quotas || quotas.length === 0) { return undefined; }
    const lower = modelName.toLowerCase();
    // 1. 完全一致
    const exact = quotas.find(q =>
        q.displayName.toLowerCase() === lower ||
        q.name.toLowerCase() === lower,
    );
    if (exact) { return exact; }
    // 2. 部分一致（モデル名がクォータ名に含まれる or その逆）
    return quotas.find(q => {
        const dn = q.displayName.toLowerCase();
        const n = q.name.toLowerCase();
        return dn.includes(lower) || lower.includes(dn) ||
            n.includes(lower) || lower.includes(n);
    });
}

function formatResetTime(q: ModelQuota): string {
    if (!q.timeUntilResetFormatted || q.timeUntilResetFormatted === 'N/A') return '';
    return ` ⏳${q.timeUntilResetFormatted}`;
}

// -----------------------------------------------------------------------
// モデル一覧 Embed + 切替ボタン
// -----------------------------------------------------------------------

export function buildModelListEmbed(
    models: string[],
    currentModel: string | null,
    quotas?: ModelQuota[],
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setTitle('🤖 モデル管理')
        .setColor(0x5865F2)
        .setTimestamp();

    if (models.length === 0 && !currentModel) {
        embed.setDescription(
            'モデル情報を取得できませんでした。\n' +
            'チャットパネルが開いていることを確認してください。',
        );
        return { embeds: [embed], components: [] };
    }

    // 現在のモデル
    const currentDisplay = currentModel || '不明';
    const currentQuota = currentModel ? findQuota(currentModel, quotas) : undefined;
    const currentExtra = currentQuota ? ` (${quotaEmoji(currentQuota.remainingPercentage)} ${currentQuota.remainingPercentage}%${formatResetTime(currentQuota)})` : '';
    embed.setDescription(`**現在のモデル:** ${currentDisplay}${currentExtra}`);

    // モデル一覧をフィールドに追加
    if (models.length > 0) {
        const normalizedCurrent = currentModel?.trim().toLowerCase() || '';
        const modelList = models.map((m) => {
            const mLower = m.trim().toLowerCase();
            const isCurrent = normalizedCurrent.length > 0 && (
                mLower === normalizedCurrent ||
                mLower.includes(normalizedCurrent) ||
                normalizedCurrent.includes(mLower)
            );
            const q = findQuota(m, quotas);
            const quotaStr = q ? ` ${quotaEmoji(q.remainingPercentage)} ${q.remainingPercentage}%${formatResetTime(q)}` : '';
            return `${isCurrent ? '✅' : '⬜'} ${m}${quotaStr}`;
        }).join('\n');

        embed.addFields({
            name: `📋 利用可能なモデル (${models.length}件)`,
            value: modelList.length > 1024 ? modelList.substring(0, 1021) + '...' : modelList,
        });
    }

    // ボタン作成（各モデルに切替ボタン）
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    // モデルを5個ずつの ActionRow にまとめる（1行5ボタン × 最大4行 = 20モデル）
    const normalizedCurrentBtn = currentModel?.trim().toLowerCase() || '';
    const displayModels = models.slice(0, 20); // Discord 上限を考慮
    for (let i = 0; i < displayModels.length; i += 5) {
        if (components.length >= 4) break; // リフレッシュ用に1行確保

        const row = new ActionRowBuilder<ButtonBuilder>();
        const chunk = displayModels.slice(i, i + 5);

        for (const model of chunk) {
            const modelLower = model.trim().toLowerCase();
            const isCurrent = normalizedCurrentBtn.length > 0 && (
                modelLower === normalizedCurrentBtn ||
                modelLower.includes(normalizedCurrentBtn) ||
                normalizedCurrentBtn.includes(modelLower)
            );
            // customId は100文字制限があるため、モデル名をハッシュ化せず短縮
            const shortName = model.substring(0, 80);

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`model_select_${shortName}`)
                    .setLabel(model.length > 20 ? model.substring(0, 17) + '...' : model)
                    .setStyle(isCurrent ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setDisabled(!!isCurrent),
            );
        }

        components.push(row);
    }

    // リフレッシュボタン
    if (components.length < 5) {
        const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('model_refresh')
                .setLabel('🔄 更新')
                .setStyle(ButtonStyle.Primary),
        );
        components.push(refreshRow);
    }

    return { embeds: [embed], components };
}

// -----------------------------------------------------------------------
// モデル切替結果 Embed
// -----------------------------------------------------------------------

export function buildModelSwitchResultEmbed(
    modelName: string,
    success: boolean,
): EmbedBuilder {
    if (success) {
        return new EmbedBuilder()
            .setTitle('✅ モデルを切り替えました')
            .setDescription(`**${modelName}** に切り替えました。`)
            .setColor(0x57F287)
            .setTimestamp();
    } else {
        return new EmbedBuilder()
            .setTitle('❌ モデル切替に失敗')
            .setDescription(
                `**${modelName}** への切り替えに失敗しました。\n` +
                'チャットパネルが開いていることを確認し、もう一度お試しください。',
            )
            .setColor(0xED4245)
            .setTimestamp();
    }
}
