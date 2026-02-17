// ---------------------------------------------------------------------------
// discordReactions.ts — リアクション収集・ユーザー確認
// ---------------------------------------------------------------------------
// discordBot.ts から分離。Message に対するリアクション待ちロジックを集約。
// ---------------------------------------------------------------------------

import { Message } from 'discord.js';
import { logInfo, logError, logDebug } from './logger';

// -----------------------------------------------------------------------
// waitForConfirmation
// -----------------------------------------------------------------------

/** メッセージにリアクション待ちして確認を取る */
export async function waitForConfirmation(
    message: Message,
    botUserId: string | undefined,
    timeoutMs: number = 120_000,
): Promise<boolean> {
    const confirmEmoji = '✅';
    const rejectEmoji = '❌';

    try {
        await message.react(confirmEmoji);
        await message.react(rejectEmoji);
        logInfo(`waitForConfirmation: reactions added, waiting for user reaction (timeout=${timeoutMs}ms)`);
    } catch (e) {
        logError('waitForConfirmation: failed to add reactions', e);
        return false;
    }

    logDebug(`waitForConfirmation: bot ID = ${botUserId}`);

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
            time: timeoutMs,
        });

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name;
            logInfo(`waitForConfirmation: collected reaction '${emoji}' from user ${user.tag || user.id}`);
            collector.stop('received');
            resolve(emoji === confirmEmoji);
        });

        collector.on('end', (_collected, reason) => {
            logInfo(`waitForConfirmation: collector ended — reason: ${reason}`);
            if (reason !== 'received') {
                resolve(false); // タイムアウトまたはその他の理由
            }
        });
    });
}

// -----------------------------------------------------------------------
// waitForChoice
// -----------------------------------------------------------------------

/** 番号付き絵文字リアクションで選択を待つ（1️⃣~🔟 + ❌） */
export async function waitForChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
    timeoutMs: number = 120_000,
): Promise<number> {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const rejectEmoji = '❌';
    const activeEmojis = numberEmojis.slice(0, Math.min(choiceCount, 10));

    try {
        for (const emoji of activeEmojis) {
            await message.react(emoji);
        }
        await message.react(rejectEmoji);
        logInfo(`waitForChoice: ${activeEmojis.length} choice reactions + ❌ added, waiting (timeout=${timeoutMs}ms)`);
    } catch (e) {
        logError('waitForChoice: failed to add reactions', e);
        return -1;
    }

    const allEmojis = [...activeEmojis, rejectEmoji];

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
            time: timeoutMs,
        });

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name || '';
            logInfo(`waitForChoice: collected '${emoji}' from user ${user.tag || user.id}`);
            collector.stop('received');
            if (emoji === rejectEmoji) {
                resolve(-1);
            } else {
                const idx = activeEmojis.indexOf(emoji);
                resolve(idx >= 0 ? idx + 1 : -1);
            }
        });

        collector.on('end', (_collected, reason) => {
            logInfo(`waitForChoice: collector ended — reason: ${reason}`);
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
 * @returns 選択された番号の配列（1-indexed）。空配列 = 却下/タイムアウト。[-1] = 全選択。
 */
export async function waitForMultiChoice(
    message: Message,
    botUserId: string | undefined,
    choiceCount: number,
    timeoutMs: number = 120_000,
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
        logInfo(`waitForMultiChoice: ${activeEmojis.length} choices + ☑️/✅/❌ added (timeout=${timeoutMs}ms)`);
    } catch (e) {
        logError('waitForMultiChoice: failed to add reactions', e);
        return [];
    }

    const controlEmojis = [confirmEmoji, allEmoji, rejectEmoji];
    const allValidEmojis = [...activeEmojis, ...controlEmojis];

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
            time: timeoutMs,
        });

        collector.on('collect', (reaction, user) => {
            const emoji = reaction.emoji.name || '';

            if (emoji === rejectEmoji) {
                logInfo(`waitForMultiChoice: rejected by ${user.tag || user.id}`);
                collector.stop('rejected');
                resolve([]);
                return;
            }

            if (emoji === allEmoji) {
                logInfo(`waitForMultiChoice: all selected by ${user.tag || user.id}`);
                collector.stop('all');
                resolve([-1]);
                return;
            }

            if (emoji === confirmEmoji) {
                logInfo(`waitForMultiChoice: confirmed [${[...selected].join(',')}] by ${user.tag || user.id}`);
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
            logInfo(`waitForMultiChoice: collector ended — reason: ${reason}`);
            if (!['rejected', 'all', 'confirmed'].includes(reason || '')) {
                resolve([]); // タイムアウト
            }
        });
    });
}
