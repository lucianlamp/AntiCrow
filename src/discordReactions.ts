// ---------------------------------------------------------------------------
// discordReactions.ts 窶・繝懊ち繝ｳ繝吶・繧ｹ遒ｺ隱・UI
// ---------------------------------------------------------------------------
// 繝ｪ繧｢繧ｯ繧ｷ繝ｧ繝ｳ譁ｹ蠑上ｒ蟒・ｭ｢縺励‥iscord.js ButtonBuilder / ActionRow 繧剃ｽｿ逕ｨ縲・// ---------------------------------------------------------------------------

import {
    Message,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    InteractionCollector,
    ButtonInteraction,
} from 'discord.js';
import { logDebug, logError } from './logger';

// -----------------------------------------------------------------------
// 繧｢繧ｯ繝・ぅ繝悶さ繝ｬ繧ｯ繧ｿ邂｡逅・ｼ亥､夜Κ縺九ｉ縺ｮ繧ｭ繝｣繝ｳ繧ｻ繝ｫ逕ｨ・・// -----------------------------------------------------------------------

/** channelId 竊・繧｢繧ｯ繝・ぅ繝悶↑ InteractionCollector・郁・蜍募唆荳九↓菴ｿ逕ｨ・・*/
const activeCollectors = new Map<string, InteractionCollector<ButtonInteraction>>();

/**
 * 謖・ｮ壹メ繝｣繝ｳ繝阪Ν縺ｮ繧｢繧ｯ繝・ぅ繝悶↑遒ｺ隱阪さ繝ｬ繧ｯ繧ｿ繧偵く繝｣繝ｳ繧ｻ繝ｫ縺吶ｋ縲・ * 譁ｰ縺励＞繝｡繝・そ繝ｼ繧ｸ縺梧擂縺溘→縺阪↓蜻ｼ縺ｳ蜃ｺ縺励※縲∝燕縺ｮ遒ｺ隱阪ｒ閾ｪ蜍募唆荳九☆繧九・ * @returns 繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺輔ｌ縺溷ｴ蜷・true
 */
export function cancelActiveConfirmation(channelId: string): boolean {
    const collector = activeCollectors.get(channelId);
    if (collector && !collector.ended) {
        logDebug(`cancelActiveConfirmation: cancelling collector for channel ${channelId}`);
        collector.stop('auto_dismissed');
        activeCollectors.delete(channelId);
        return true;
    }
    return false;
}

// -----------------------------------------------------------------------
// waitForConfirmation
// -----------------------------------------------------------------------

/** 繝｡繝・そ繝ｼ繧ｸ縺ｫ繝懊ち繝ｳ蠕・■縺励※遒ｺ隱阪ｒ蜿悶ｋ・医ち繧､繝繧｢繧ｦ繝医↑縺暦ｼ・*/
export async function waitForConfirmation(
    message: Message,
    botUserId: string | undefined,
): Promise<boolean> {
    const channelId = message.channelId;

    try {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_approve')
                .setLabel('謇ｿ隱・)
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('confirm_reject')
                .setLabel('蜊ｴ荳・)
                .setStyle(ButtonStyle.Danger),
        );

        await message.edit({ components: [row] });
        logDebug('waitForConfirmation: buttons added, waiting for user click (no timeout)');
    } catch (e) {
        logError('waitForConfirmation: failed to add buttons', e);
        return false;
    }

    return new Promise<boolean>((resolve) => {
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => {
                const isNotBot = i.user.id !== botUserId;
                logDebug(`waitForConfirmation: button '${i.customId}' from user ${i.user.id} (bot=${!isNotBot})`);
                return isNotBot && ['confirm_approve', 'confirm_reject'].includes(i.customId);
            },
            max: 1,
        });

        activeCollectors.set(channelId, collector);

        collector.on('collect', async (i) => {
            logDebug(`waitForConfirmation: collected '${i.customId}' from user ${i.user.tag || i.user.id}`);
            activeCollectors.delete(channelId);
            collector.stop('received');

            // 繝懊ち繝ｳ繧堤┌蜉ｹ蛹・            try {
                await i.deferUpdate();
                await message.edit({ components: disableAllButtons(message) });
            } catch { /* ignore */ }

            resolve(i.customId === 'confirm_approve');
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForConfirmation: collector ended 窶・reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (reason !== 'received') {
                // 繝懊ち繝ｳ繧堤┌蜉ｹ蛹・                message.edit({ components: disableAllButtons(message) }).catch(() => { /* ignore */ });
                resolve(false); // 閾ｪ蜍募唆荳九∪縺溘・縺昴・莉悶・逅・罰
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForChoice
// -----------------------------------------------------------------------

/** 繝懊ち繝ｳ繧ｯ繝ｪ繝・け縺ｧ驕ｸ謚槭ｒ蠕・▽・域怙螟ｧ3縺､ + 笶後√ち繧､繝繧｢繧ｦ繝医↑縺暦ｼ・*/
export async function waitForChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
): Promise<number> {
    const numberLabels = ['1', '2', '3'];
    const clipped = Math.min(choiceCount, 3);

    try {
        const buttons: ButtonBuilder[] = [];
        for (let i = 0; i < clipped; i++) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`choice_${i + 1}`)
                    .setLabel(numberLabels[i])
                    .setStyle(ButtonStyle.Primary),
            );
        }
        buttons.push(
            new ButtonBuilder()
                .setCustomId('choice_agent')
                .setLabel('繧ｨ繝ｼ繧ｸ繧ｧ繝ｳ繝医↓莉ｻ縺帙ｋ')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('､・),
            new ButtonBuilder()
                .setCustomId('choice_reject')
                .setLabel('蜊ｴ荳・)
                .setStyle(ButtonStyle.Danger),
        );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
        await message.edit({ components: [row] });
        logDebug(`waitForChoice: ${clipped} choice buttons + 笶・added, waiting (no timeout)`);
    } catch (e) {
        logError('waitForChoice: failed to add buttons', e);
        return -1;
    }

    const validIds = Array.from({ length: clipped }, (_, i) => `choice_${i + 1}`).concat('choice_agent', 'choice_reject');
    const channelId = message.channelId;

    return new Promise<number>((resolve) => {
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => {
                const isNotBot = i.user.id !== botUserId;
                logDebug(`waitForChoice: button '${i.customId}' from user ${i.user.id} (bot=${!isNotBot})`);
                return isNotBot && validIds.includes(i.customId);
            },
            max: 1,
        });

        activeCollectors.set(channelId, collector);

        collector.on('collect', async (i) => {
            logDebug(`waitForChoice: collected '${i.customId}' from user ${i.user.tag || i.user.id}`);
            activeCollectors.delete(channelId);
            collector.stop('received');

            try {
                await i.deferUpdate();
                await message.edit({ components: disableAllButtons(message) });
            } catch { /* ignore */ }

            if (i.customId === 'choice_reject') {
                resolve(-1);
            } else if (i.customId === 'choice_agent') {
                resolve(0); // 繧ｨ繝ｼ繧ｸ繧ｧ繝ｳ繝亥愛譁ｭ
            } else {
                const num = parseInt(i.customId.replace('choice_', ''), 10);
                resolve(num > 0 ? num : -1);
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForChoice: collector ended 窶・reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (reason !== 'received') {
                message.edit({ components: disableAllButtons(message) }).catch(() => { /* ignore */ });
                resolve(-1);
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForMultiChoice
// -----------------------------------------------------------------------

/**
 * 隍・焚驕ｸ謚槫ｾ・■: 繝懊ち繝ｳ繝医げ繝ｫ縺ｧ隍・焚驕ｸ謚・竊・笘托ｸ・縺ｧ遒ｺ螳壹≫怛 縺ｧ蜈ｨ驕ｸ謚槭≫搆 縺ｧ蜊ｴ荳九・ * @returns 驕ｸ謚槭＆繧後◆逡ｪ蜿ｷ縺ｮ驟榊・・・-indexed・峨らｩｺ驟榊・ = 蜊ｴ荳・閾ｪ蜍募唆荳九・-1] = 蜈ｨ驕ｸ謚槭・ */
export async function waitForMultiChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
): Promise<number[]> {
    const numberLabels = ['1', '2', '3'];
    const clipped = Math.min(choiceCount, 3);
    const selected = new Set<number>();

    /** 迴ｾ蝨ｨ縺ｮ驕ｸ謚樒憾諷九↓蝓ｺ縺･縺・※繝懊ち繝ｳ陦後ｒ讒狗ｯ・*/
    function buildRows(): ActionRowBuilder<ButtonBuilder>[] {
        const choiceButtons: ButtonBuilder[] = [];
        for (let i = 0; i < clipped; i++) {
            const num = i + 1;
            const isSelected = selected.has(num);
            choiceButtons.push(
                new ButtonBuilder()
                    .setCustomId(`mchoice_${num}`)
                    .setLabel(`${numberLabels[i]}${isSelected ? ' 笨・ : ''}`)
                    .setStyle(isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
        }
        const choiceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...choiceButtons);

        const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('mchoice_confirm')
                .setLabel('遒ｺ螳・)
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('mchoice_all')
                .setLabel('蜈ｨ驕ｸ謚・)
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('mchoice_agent')
                .setLabel('繧ｨ繝ｼ繧ｸ繧ｧ繝ｳ繝医↓莉ｻ縺帙ｋ')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('､・),
            new ButtonBuilder()
                .setCustomId('mchoice_reject')
                .setLabel('蜊ｴ荳・)
                .setStyle(ButtonStyle.Danger),
        );

        return [choiceRow, controlRow];
    }

    try {
        await message.edit({ components: buildRows() });
        logDebug(`waitForMultiChoice: ${clipped} toggle buttons + 笘托ｸ・笨・笶・added (no timeout)`);
    } catch (e) {
        logError('waitForMultiChoice: failed to add buttons', e);
        return [];
    }

    const choiceIds = Array.from({ length: clipped }, (_, i) => `mchoice_${i + 1}`);
    const controlIds = ['mchoice_confirm', 'mchoice_all', 'mchoice_agent', 'mchoice_reject'];
    const allValidIds = [...choiceIds, ...controlIds];
    const channelId = message.channelId;

    return new Promise<number[]>((resolve) => {
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => {
                const isNotBot = i.user.id !== botUserId;
                logDebug(`waitForMultiChoice: button '${i.customId}' from user ${i.user.id} (bot=${!isNotBot})`);
                return isNotBot && allValidIds.includes(i.customId);
            },
        });

        activeCollectors.set(channelId, collector);

        collector.on('collect', async (i) => {
            const customId = i.customId;

            if (customId === 'mchoice_reject') {
                logDebug(`waitForMultiChoice: rejected by ${i.user.tag || i.user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('rejected');
                try {
                    await i.deferUpdate();
                    await message.edit({ components: disableAllButtons(message) });
                } catch { /* ignore */ }
                resolve([]);
                return;
            }

            if (customId === 'mchoice_all') {
                logDebug(`waitForMultiChoice: all selected by ${i.user.tag || i.user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('all');
                try {
                    await i.deferUpdate();
                    await message.edit({ components: disableAllButtons(message) });
                } catch { /* ignore */ }
                resolve([-1]);
                return;
            }

            if (customId === 'mchoice_agent') {
                logDebug(`waitForMultiChoice: agent delegated by ${i.user.tag || i.user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('agent');
                try {
                    await i.deferUpdate();
                    await message.edit({ components: disableAllButtons(message) });
                } catch { /* ignore */ }
                resolve([0]); // 繧ｨ繝ｼ繧ｸ繧ｧ繝ｳ繝亥愛譁ｭ
                return;
            }

            if (customId === 'mchoice_confirm') {
                logDebug(`waitForMultiChoice: confirmed [${[...selected].join(',')}] by ${i.user.tag || i.user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('confirmed');
                try {
                    await i.deferUpdate();
                    await message.edit({ components: disableAllButtons(message) });
                } catch { /* ignore */ }
                resolve([...selected].sort((a, b) => a - b));
                return;
            }

            // 逡ｪ蜿ｷ繝懊ち繝ｳ 窶・驕ｸ謚・隗｣髯､繝医げ繝ｫ
            const num = parseInt(customId.replace('mchoice_', ''), 10);
            if (num > 0) {
                if (selected.has(num)) {
                    selected.delete(num);
                    logDebug(`waitForMultiChoice: deselected ${num}`);
                } else {
                    selected.add(num);
                    logDebug(`waitForMultiChoice: selected ${num}`);
                }

                // 繝医げ繝ｫ蠕後・繝懊ち繝ｳ迥ｶ諷九ｒ譖ｴ譁ｰ
                try {
                    await i.deferUpdate();
                    await message.edit({ components: buildRows() });
                } catch { /* ignore */ }
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForMultiChoice: collector ended 窶・reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (!['rejected', 'all', 'confirmed', 'agent'].includes(reason || '')) {
                message.edit({ components: disableAllButtons(message) }).catch(() => { /* ignore */ });
                resolve([]); // 閾ｪ蜍募唆荳・            }
        });
    });
}

// -----------------------------------------------------------------------
// 繝ｦ繝ｼ繝・ぅ繝ｪ繝・ぅ
// -----------------------------------------------------------------------

/** 繝｡繝・そ繝ｼ繧ｸ縺ｮ譌｢蟄倥・繧ｿ繝ｳ繧偵☆縺ｹ縺ｦ辟｡蜉ｹ蛹悶＠縺・ActionRow 繧定ｿ斐☆ */
function disableAllButtons(message: Message): ActionRowBuilder<ButtonBuilder>[] {
    return message.components.map((row) => {
        const newRow = new ActionRowBuilder<ButtonBuilder>();
        for (const comp of (row as { components: { type: number; customId?: string | null; label?: string | null; style?: number }[] }).components) {
            if (comp.type === ComponentType.Button && comp.customId) {
                const btn = new ButtonBuilder()
                    .setCustomId(comp.customId)
                    .setDisabled(true);
                if (comp.label) { btn.setLabel(comp.label); }
                if (comp.style) { btn.setStyle(comp.style); }
                newRow.addComponents(btn);
            }
        }
        return newRow;
    });
}
