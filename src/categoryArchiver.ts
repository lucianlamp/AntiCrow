// ---------------------------------------------------------------------------
// categoryArchiver.ts — ワークスペースカテゴリーのアーカイブ処理
// ---------------------------------------------------------------------------
// bridgeLifecycle.ts から分離。古いワークスペースカテゴリーの自動削除。
// ---------------------------------------------------------------------------

import { DiscordBot } from './discordBot';
import { PlanStore } from './planStore';
import { logInfo, logWarn, logDebug } from './logger';
import { snowflakeToTimestamp } from './discordUtils';

/**
 * 指定日数以上使用されていないワークスペースカテゴリーを削除する。
 * - カテゴリー内チャンネルの lastMessageId から最終使用日時を判定
 * - アクティブなスケジュール（PlanStore）があるチャンネルを含むカテゴリーは保護
 * @returns 削除したカテゴリー数
 */
export async function archiveOldCategories(
    guildId: string,
    botInstance: DiscordBot,
    archiveDays: number,
    planStoreInstance?: PlanStore,
): Promise<number> {
    const wsCategories = botInstance.discoverWorkspaceCategories(guildId);
    if (wsCategories.size === 0) { return 0; }

    const guild = botInstance.getFirstGuild();
    if (!guild) { return 0; }

    const thresholdMs = Date.now() - archiveDays * 24 * 60 * 60 * 1000;
    let archivedCount = 0;

    // アクティブな plan の channel ID を集める
    const activeChannelIds = new Set<string>();
    if (planStoreInstance) {
        const allPlans = planStoreInstance.getAll();
        for (const plan of allPlans) {
            if (plan.channel_id) {
                activeChannelIds.add(plan.channel_id);
            }
        }
    }

    for (const [wsName, categoryId] of wsCategories) {
        const category = guild.channels.cache.get(categoryId);
        if (!category) { continue; }

        // カテゴリー内の子チャンネルを取得
        const children = guild.channels.cache.filter(c => c.parentId === categoryId);

        // アクティブな plan チャンネルがあればスキップ
        let hasActivePlan = false;
        for (const [childId] of children) {
            if (activeChannelIds.has(childId)) {
                hasActivePlan = true;
                break;
            }
        }
        if (hasActivePlan) {
            logDebug(`archiveOldCategories: skipping "${wsName}" — has active plan channels`);
            continue;
        }

        // 最終メッセージ日時を確認
        let latestTimestamp = 0;
        for (const [, child] of children) {
            if ('lastMessageId' in child && child.lastMessageId) {
                const ts = snowflakeToTimestamp(child.lastMessageId);
                if (ts > latestTimestamp) { latestTimestamp = ts; }
            }
        }

        // メッセージがない場合はカテゴリー作成日時を使用
        if (latestTimestamp === 0 && category.createdTimestamp) {
            latestTimestamp = category.createdTimestamp;
        }

        // 閾値より古い場合は削除
        if (latestTimestamp > 0 && latestTimestamp < thresholdMs) {
            const daysAgo = Math.floor((Date.now() - latestTimestamp) / (24 * 60 * 60 * 1000));
            logInfo(`archiveOldCategories: deleting "${wsName}" (last active ${daysAgo} days ago)`);

            // 子チャンネルを先に削除
            for (const [, child] of children) {
                try {
                    if ('delete' in child && typeof child.delete === 'function') {
                        await child.delete();
                    }
                } catch (e) {
                    logWarn(`archiveOldCategories: failed to delete channel ${child.id}: ${e instanceof Error ? e.message : e}`);
                }
            }

            // カテゴリーを削除
            try {
                if ('delete' in category && typeof category.delete === 'function') {
                    await category.delete();
                }
                archivedCount++;
            } catch (e) {
                logWarn(`archiveOldCategories: failed to delete category "${wsName}": ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    return archivedCount;
}
