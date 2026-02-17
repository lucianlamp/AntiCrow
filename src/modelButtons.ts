// ---------------------------------------------------------------------------
// modelButtons.ts — Discord インタラクティブボタン UI for モデル管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

// -----------------------------------------------------------------------
// モデル一覧 Embed + 切替ボタン
// -----------------------------------------------------------------------

export function buildModelListEmbed(
    models: string[],
    currentModel: string | null,
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
    embed.setDescription(`**現在のモデル:** ${currentDisplay}`);

    // モデル一覧をフィールドに追加
    if (models.length > 0) {
        const modelList = models.map((m, i) => {
            const isCurrent = currentModel && m.toLowerCase().includes(currentModel.toLowerCase());
            return `${isCurrent ? '✅' : '⬜'} ${m}`;
        }).join('\n');

        embed.addFields({
            name: `📋 利用可能なモデル (${models.length}件)`,
            value: modelList.length > 1024 ? modelList.substring(0, 1021) + '...' : modelList,
        });
    }

    // ボタン作成（各モデルに切替ボタン）
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    // モデルを5個ずつの ActionRow にまとめる（1行5ボタン × 最大4行 = 20モデル）
    const displayModels = models.slice(0, 20); // Discord 上限を考慮
    for (let i = 0; i < displayModels.length; i += 5) {
        if (components.length >= 4) break; // リフレッシュ用に1行確保

        const row = new ActionRowBuilder<ButtonBuilder>();
        const chunk = displayModels.slice(i, i + 5);

        for (const model of chunk) {
            const isCurrent = currentModel && model.toLowerCase().includes(currentModel.toLowerCase());
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
