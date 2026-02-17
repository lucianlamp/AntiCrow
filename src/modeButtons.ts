// ---------------------------------------------------------------------------
// modeButtons.ts — Discord インタラクティブボタン UI for モード管理
// ---------------------------------------------------------------------------

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

// -----------------------------------------------------------------------
// モード一覧 Embed + 切替ボタン
// -----------------------------------------------------------------------

export function buildModeListEmbed(
    modes: string[],
    currentMode: string | null,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const embed = new EmbedBuilder()
        .setTitle('⚡ モード管理')
        .setColor(0x5865F2)
        .setTimestamp();

    if (modes.length === 0 && !currentMode) {
        embed.setDescription(
            'モード情報を取得できませんでした。\n' +
            'チャットパネルが開いていることを確認してください。',
        );
        return { embeds: [embed], components: [] };
    }

    // 現在のモード
    const currentDisplay = currentMode || '不明';
    embed.setDescription(`**現在のモード:** ${currentDisplay}`);

    // モード一覧をフィールドに追加
    if (modes.length > 0) {
        const modeList = modes.map((m) => {
            const isCurrent = currentMode && m.toLowerCase().includes(currentMode.toLowerCase());
            return `${isCurrent ? '✅' : '⬜'} ${m}`;
        }).join('\n');

        embed.addFields({
            name: `📋 利用可能なモード (${modes.length}件)`,
            value: modeList.length > 1024 ? modeList.substring(0, 1021) + '...' : modeList,
        });
    }

    // ボタン作成（各モードに切替ボタン）
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    // モードを5個ずつの ActionRow にまとめる
    const displayModes = modes.slice(0, 20);
    for (let i = 0; i < displayModes.length; i += 5) {
        if (components.length >= 4) break; // リフレッシュ用に1行確保

        const row = new ActionRowBuilder<ButtonBuilder>();
        const chunk = displayModes.slice(i, i + 5);

        for (const mode of chunk) {
            const isCurrent = currentMode && mode.toLowerCase().includes(currentMode.toLowerCase());
            const shortName = mode.substring(0, 80);

            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`mode_select_${shortName}`)
                    .setLabel(mode.length > 20 ? mode.substring(0, 17) + '...' : mode)
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
                .setCustomId('mode_refresh')
                .setLabel('🔄 更新')
                .setStyle(ButtonStyle.Primary),
        );
        components.push(refreshRow);
    }

    return { embeds: [embed], components };
}

// -----------------------------------------------------------------------
// モード切替結果 Embed
// -----------------------------------------------------------------------

export function buildModeSwitchResultEmbed(
    modeName: string,
    success: boolean,
): EmbedBuilder {
    if (success) {
        return new EmbedBuilder()
            .setTitle('✅ モードを切り替えました')
            .setDescription(`**${modeName}** に切り替えました。`)
            .setColor(0x57F287)
            .setTimestamp();
    } else {
        return new EmbedBuilder()
            .setTitle('❌ モード切替に失敗')
            .setDescription(
                `**${modeName}** への切り替えに失敗しました。\n` +
                'チャットパネルが開いていることを確認し、もう一度お試しください。',
            )
            .setColor(0xED4245)
            .setTimestamp();
    }
}
