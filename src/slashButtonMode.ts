// ---------------------------------------------------------------------------
// slashButtonMode.ts — モード管理ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import { ButtonInteraction } from 'discord.js';

import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { buildModeListEmbed, buildModeSwitchResultEmbed } from './modeButtons';
import { getAvailableModes, selectMode } from './cdpModes';
import { BridgeContext } from './bridgeContext';

/**
 * モード関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleModeButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (customId.startsWith('mode_select_')) {
        const modeIndex = parseInt(customId.replace('mode_select_', ''), 10);
        await interaction.deferUpdate();

        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnMode.notConnected'), EmbedColor.Warning)] });
            return true;
        }

        // インデックスからモード名を逆引き
        const { modes: currentModes } = await getAvailableModes(cdp.ops);
        const modeName = currentModes[modeIndex];
        if (!modeName) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnMode.indexOutOfRange', String(modeIndex)), EmbedColor.Warning)] });
            return true;
        }

        const success = await selectMode(cdp.ops, modeName);
        const resultEmbed = buildModeSwitchResultEmbed(modeName, success);

        if (success) {
            // 切替後にリストを更新（UI反映を待つため長めに待機）
            await cdp.ops.sleep(1000);
            const { modes, current } = await getAvailableModes(cdp.ops);
            // selectMode 成功時は常に選択したモード名を current として使用する
            // （getAvailableModes はUIの反映遅延で旧モード名を返す場合があるため、
            //   current || modeName では旧値がそのまま使われてしまう）
            const effectiveCurrent = modeName;
            const { embeds, components } = buildModeListEmbed(modes, effectiveCurrent);
            await interaction.editReply({ embeds, components: components as any });
        } else {
            await interaction.followUp({ embeds: [resultEmbed] });
        }
        return true;
    }

    if (customId === 'mode_refresh') {
        await interaction.deferUpdate();

        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnMode.notConnected'), EmbedColor.Warning)] });
            return true;
        }

        const { modes, current } = await getAvailableModes(cdp.ops);
        const { embeds, components } = buildModeListEmbed(modes, current);
        await interaction.editReply({ embeds, components: components as any });
        return true;
    }

    return false;
}
