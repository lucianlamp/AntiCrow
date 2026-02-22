// ---------------------------------------------------------------------------
// discordReactions.ts — リアクション収集・ユーザー確認
// ---------------------------------------------------------------------------
// discordBot.ts から分離。Message に対するリアクション待ちロジックを集約。
// ---------------------------------------------------------------------------

import { Message, ReactionCollector } from 'discord.js';
import { logDebug, logError } from './logger';

// -----------------------------------------------------------------------
// アクティブコレクタ管理（外部からのキャンセル用）
// -----------------------------------------------------------------------

/** channelId → アクティブな ReactionCollector（自動却下に使用） */
const activeCollectors = new Map<string, ReactionCollector>();

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

/** メッセージにリアクション待ちして確認を取る（タイムアウトなし） */
export async function waitForConfirmation(
    message: Message,
    botUserId: string | undefined,
): Promise<boolean> {
    const confirmEmoji = '✅';
    const rejectEmoji = '❌';

    try {
        await message.react(confirmEmoji);
        await message.react(rejectEmoji);
        logDebug(`waitForConfirmation: reactions added, waiting for user reaction (no timeout)`);
    } catch (e) {
        logError('waitForConfirmation: failed to add reactions', e);
        return false;
    }

    logDebug(`waitForConfirmation: bot ID = ${botUserId}`);
    const channelId = message.channelId;

    return new Promise<boolean>((resolve) => {
        const collector = message.createReactionCollector({
            filter: (reaction, user) => {
                const emojiName = reaction.emoji.name || '';
                const isTargetEmoji = [confirmEmoji, rejectEmoji].includes(emojiName);
                const isNotBot = user.id !== botUserId;
                logDebug(`waitForConfirmation: reaction '${emojiName}' from user ${user.id} (bot=${!isNotBot}, targetEmoji=${isTargetEmoji})`);
                return isTargetEmoji && isNotBot;
            },
            max: 1,
        });

        // アクティブコレクタに登録
        activeCollectors.set(channelId, collector);

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name;
            logDebug(`waitForConfirmation: collected reaction '${emoji}' from user ${user.tag || user.id}`);
            activeCollectors.delete(channelId);
            collector.stop('received');
            resolve(emoji === confirmEmoji);
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForConfirmation: collector ended — reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (reason !== 'received') {
                resolve(false); // 自動却下またはその他の理由
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForChoice
// -----------------------------------------------------------------------

/** 番号付き絵文字リアクションで選択を待つ（1️⃣~🔟 + ❌、タイムアウトなし） */
export async function waitForChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
): Promise<number> {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const rejectEmoji = '❌';
    const activeEmojis = numberEmojis.slice(0, Math.min(choiceCount, 10));

    try {
        for (const emoji of activeEmojis) {
            await message.react(emoji);
        }
        await message.react(rejectEmoji);
        logDebug(`waitForChoice: ${activeEmojis.length} choice reactions + ❌ added, waiting (no timeout)`);
    } catch (e) {
        logError('waitForChoice: failed to add reactions', e);
        return -1;
    }

    const allEmojis = [...activeEmojis, rejectEmoji];
    const channelId = message.channelId;

    return new Promise<number>((resolve) => {
        const collector = message.createReactionCollector({
            filter: (reaction, user) => {
                const emojiName = reaction.emoji.name || '';
                const isTarget = allEmojis.includes(emojiName);
                const isNotBot = user.id !== botUserId;
                logDebug(`waitForChoice: reaction '${emojiName}' from user ${user.id} (bot=${!isNotBot}, target=${isTarget})`);
                return isTarget && isNotBot;
            },
            max: 1,
        });

        // アクティブコレクタに登録
        activeCollectors.set(channelId, collector);

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name || '';
            logDebug(`waitForChoice: collected '${emoji}' from user ${user.tag || user.id}`);
            activeCollectors.delete(channelId);
            collector.stop('received');
            if (emoji === rejectEmoji) {
                resolve(-1);
            } else {
                const idx = activeEmojis.indexOf(emoji);
                resolve(idx >= 0 ? idx + 1 : -1);
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForChoice: collector ended — reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (reason !== 'received') {
                resolve(-1);
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForMultiChoice
// -----------------------------------------------------------------------

/**
 * 複数選択待ち: 1️⃣~🔟 で複数選択 → ☑️ で確定、✅ で全選択、❌ で却下。
 * @returns 選択された番号の配列（1-indexed）。空配列 = 却下/自動却下。[-1] = 全選択。
 */
export async function waitForMultiChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
): Promise<number[]> {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const confirmEmoji = '☑️';
    const allEmoji = '✅';
    const rejectEmoji = '❌';
    const activeEmojis = numberEmojis.slice(0, Math.min(choiceCount, 10));

    try {
        for (const emoji of activeEmojis) {
            await message.react(emoji);
        }
        await message.react(confirmEmoji);
        await message.react(allEmoji);
        await message.react(rejectEmoji);
        logDebug(`waitForMultiChoice: ${activeEmojis.length} choices + ☑️/✅/❌ added (no timeout)`);
    } catch (e) {
        logError('waitForMultiChoice: failed to add reactions', e);
        return [];
    }

    const controlEmojis = [confirmEmoji, allEmoji, rejectEmoji];
    const allValidEmojis = [...activeEmojis, ...controlEmojis];
    const channelId = message.channelId;

    return new Promise<number[]>((resolve) => {
        const selected = new Set<number>();

        const collector = message.createReactionCollector({
            filter: (reaction, user) => {
                const emojiName = reaction.emoji.name || '';
                const isTarget = allValidEmojis.includes(emojiName);
                const isNotBot = user.id !== botUserId;
                logDebug(`waitForMultiChoice: reaction '${emojiName}' from user ${user.id} (bot=${!isNotBot}, target=${isTarget})`);
                return isTarget && isNotBot;
            },
        });

        // アクティブコレクタに登録
        activeCollectors.set(channelId, collector);

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name || '';

            if (emoji === rejectEmoji) {
                logDebug(`waitForMultiChoice: rejected by ${user.tag || user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('rejected');
                resolve([]);
                return;
            }

            if (emoji === allEmoji) {
                logDebug(`waitForMultiChoice: all selected by ${user.tag || user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('all');
                resolve([-1]);
                return;
            }

            if (emoji === confirmEmoji) {
                logDebug(`waitForMultiChoice: confirmed [${[...selected].join(',')}] by ${user.tag || user.id}`);
                activeCollectors.delete(channelId);
                collector.stop('confirmed');
                resolve([...selected].sort((a, b) => a - b));
                return;
            }

            // 番号リアクション — 選択/解除
            const idx = activeEmojis.indexOf(emoji);
            if (idx >= 0) {
                const num = idx + 1;
                if (selected.has(num)) {
                    selected.delete(num);
                    logDebug(`waitForMultiChoice: deselected ${num}`);
                } else {
                    selected.add(num);
                    logDebug(`waitForMultiChoice: selected ${num}`);
                }
            }
        });

        collector.on('end', (_collected, reason) => {
            logDebug(`waitForMultiChoice: collector ended — reason: ${reason}`);
            activeCollectors.delete(channelId);
            if (!['rejected', 'all', 'confirmed'].includes(reason || '')) {
                resolve([]); // 自動却下
            }
        });
    });
}
