// ---------------------------------------------------------------------------
// slashButtonModel.ts — モデル管理ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import { ButtonInteraction } from 'discord.js';

import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { buildModelListEmbed, buildModelSwitchResultEmbed } from './modelButtons';
import { getAvailableModels, selectModel } from './cdpModels';
import { BridgeContext } from './bridgeContext';
import { fetchQuota } from './quotaProvider';

/**
 * モデル関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleModelButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (customId.startsWith('model_select_')) {
        const modelIndex = parseInt(customId.replace('model_select_', ''), 10);
        await interaction.deferUpdate();

        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnModel.notConnected'), EmbedColor.Warning)] });
            return true;
        }

        // インデックスベースで直接選択（getAvailableModels の再呼出しを省略）
        const success = await selectModel(cdp.ops, modelIndex);
        const resultEmbed = buildModelSwitchResultEmbed(`${t('btnModel.model')} #${modelIndex}`, success);

        if (success) {
            // 切替後にリストを更新
            await cdp.ops.sleep(500);
            const { models, current } = await getAvailableModels(cdp.ops);
            const { embeds, components } = buildModelListEmbed(models, current, (await fetchQuota())?.models);
            await interaction.editReply({ embeds, components: components as any });
        } else {
            await interaction.followUp({ embeds: [resultEmbed] });
        }
        return true;
    }

    if (customId === 'model_refresh') {
        await interaction.deferUpdate();

        const cdp = ctx.cdp;
        if (!cdp) {
            await interaction.followUp({ embeds: [buildEmbed(t('btnModel.notConnected'), EmbedColor.Warning)] });
            return true;
        }

        const { models, current } = await getAvailableModels(cdp.ops);
        const { embeds, components } = buildModelListEmbed(models, current, (await fetchQuota())?.models);
        await interaction.editReply({ embeds, components: components as any });
        return true;
    }

    return false;
}
