// ---------------------------------------------------------------------------
// discordReactions.ts — ボタンベース確認 UI
// ---------------------------------------------------------------------------
// リアクション方式を廃止し、discord.js ButtonBuilder / ActionRow を使用。
// ---------------------------------------------------------------------------

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
// アクティブコレクタ管理（外部からのキャンセル用）
// -----------------------------------------------------------------------

/** channelId → アクティブな InteractionCollector（自動却下に使用） */
const activeCollectors = new Map<string, InteractionCollector<ButtonInteraction>>();

/**
 * 指定チャンネルのアクティブな確認コレクタをキャンセルする。
 * 新しいメッセージが来たときに呼び出して、前の確認を自動却下する。
 * @returns キャンセルされた場合 true
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

/** メッセージにボタン待ちして確認を取る（タイムアウトなし） */
export async function waitForConfirmation(
    message: Message,
    botUserId: string | undefined,
): Promise<'approved' | 'rejected' | 'auto'> {
    const channelId = message.channelId;

    try {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('confirm_approve')
                .setLabel('承認')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('confirm_auto')
                .setLabel('連続オートモードで実行')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🤖'),
            new ButtonBuilder()
                .setCustomId('confirm_reject')
                .setLabel('却下')
                .setStyle(ButtonStyle.Danger),
        );

        await message.edit({ components: [row] });
        logDebug('waitForConfirmation: buttons added, waiting for user click (no timeout)');
    } catch (e) {
        logError('waitForConfirmation: failed to add buttons', e);
        return 'rejected';
    }

    return new Promise<'approved' | 'rejected' | 'auto'>((resolve) => {
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => {
                const isNotBot = i.user.id !== botUserId;
                logDebug(`waitForConfirmation: button '${i.customId}' from user ${i.user.id} (bot=${!isNotBot})`);
                return isNotBot && ['confirm_approve', 'confirm_reject', 'confirm_auto'].includes(i.customId);
            },
            max: 1,
        });

        activeCollectors.set(channelId, collector);

        collector.on('collect', async (i) => {
            logDebug(`waitForConfirmation: collected '${i.customId}' from user ${i.user.tag || i.user.id}`);
            activeCollectors.delete(channelId);
            collector.stop('received');

            // ボタンを無効化
            try {
                await i.deferUpdate();
                await message.edit({ components: disableAllButtons(message) });
            } catch { /* ignore */ }

            resolve(i.customId === 'confirm_approve' ? 'approved' : i.customId === 'confirm_auto' ? 'auto' : 'rejected');
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForConfirmation: collector ended — reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (reason !== 'received') {
                // ボタンを無効化
                message.edit({ components: disableAllButtons(message) }).catch(() => { /* ignore */ });
                resolve('rejected'); // 自動却下またはその他の理由
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForChoice
// -----------------------------------------------------------------------

/** ボタンクリックで選択を待つ（最大3つ + ❌、タイムアウトなし） */
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
                .setLabel('エージェントに任せる')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🤖'),
            new ButtonBuilder()
                .setCustomId('choice_reject')
                .setLabel('却下')
                .setStyle(ButtonStyle.Danger),
        );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
        await message.edit({ components: [row] });
        logDebug(`waitForChoice: ${clipped} choice buttons + ❌ added, waiting (no timeout)`);
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
                resolve(0); // エージェント判断
            } else {
                const num = parseInt(i.customId.replace('choice_', ''), 10);
                resolve(num > 0 ? num : -1);
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForChoice: collector ended — reason: ${reason}`);
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
 * 複数選択待ち: ボタントグルで複数選択 → ☑️ で確定、✅ で全選択、❌ で却下。
 * @returns 選択された番号の配列（1-indexed）。空配列 = 却下/自動却下。[-1] = 全選択。
 */
export async function waitForMultiChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
): Promise<number[]> {
    const numberLabels = ['1', '2', '3'];
    const clipped = Math.min(choiceCount, 3);
    const selected = new Set<number>();

    /** 現在の選択状態に基づいてボタン行を構築 */
    function buildRows(): ActionRowBuilder<ButtonBuilder>[] {
        const choiceButtons: ButtonBuilder[] = [];
        for (let i = 0; i < clipped; i++) {
            const num = i + 1;
            const isSelected = selected.has(num);
            choiceButtons.push(
                new ButtonBuilder()
                    .setCustomId(`mchoice_${num}`)
                    .setLabel(`${numberLabels[i]}${isSelected ? ' ✓' : ''}`)
                    .setStyle(isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
        }
        const choiceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...choiceButtons);

        const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('mchoice_confirm')
                .setLabel('確定')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('mchoice_all')
                .setLabel('全選択')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('mchoice_agent')
                .setLabel('エージェントに任せる')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🤖'),
            new ButtonBuilder()
                .setCustomId('mchoice_reject')
                .setLabel('却下')
                .setStyle(ButtonStyle.Danger),
        );

        return [choiceRow, controlRow];
    }

    try {
        await message.edit({ components: buildRows() });
        logDebug(`waitForMultiChoice: ${clipped} toggle buttons + ☑️/✅/❌ added (no timeout)`);
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
                resolve([0]); // エージェント判断
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

            // 番号ボタン — 選択/解除トグル
            const num = parseInt(customId.replace('mchoice_', ''), 10);
            if (num > 0) {
                if (selected.has(num)) {
                    selected.delete(num);
                    logDebug(`waitForMultiChoice: deselected ${num}`);
                } else {
                    selected.add(num);
                    logDebug(`waitForMultiChoice: selected ${num}`);
                }

                // トグル後のボタン状態を更新
                try {
                    await i.deferUpdate();
                    await message.edit({ components: buildRows() });
                } catch { /* ignore */ }
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForMultiChoice: collector ended — reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (!['rejected', 'all', 'confirmed', 'agent'].includes(reason || '')) {
                message.edit({ components: disableAllButtons(message) }).catch(() => { /* ignore */ });
                resolve([]); // 自動却下
            }
        });
    });
}

// -----------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------

/** メッセージの既存ボタンをすべて無効化した ActionRow を返す */
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
