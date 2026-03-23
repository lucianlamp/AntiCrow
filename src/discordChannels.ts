// ---------------------------------------------------------------------------
// discordChannels.ts — チャンネル・カテゴリー管理
// ---------------------------------------------------------------------------
// discordBot.ts から分離。Discord Guild のカテゴリー/チャンネル操作を集約。
// ---------------------------------------------------------------------------

import {
    Client,
    TextChannel,
    ChannelType,
    ThreadAutoArchiveDuration,
    EmbedBuilder,
} from 'discord.js';
import { logDebug, logError, logWarn } from './logger';

// -----------------------------------------------------------------------
// 定数・ユーティリティ (static 相当)
// -----------------------------------------------------------------------

export const WORKSPACE_CATEGORY_PREFIX = '🤖 ';

const SCHEDULES_CATEGORY_NAME = 'Schedules';

/** ワークスペース名からカテゴリー名を組み立てる。 */
export function workspaceCategoryName(workspaceName: string): string {
    return `${WORKSPACE_CATEGORY_PREFIX}${workspaceName}`;
}

/** カテゴリー名からワークスペース名を抽出する。プレフィックスが無ければ null を返す。 */
export function extractWorkspaceFromCategoryName(categoryName: string): string | null {
    if (categoryName.startsWith(WORKSPACE_CATEGORY_PREFIX)) {
        return categoryName.slice(WORKSPACE_CATEGORY_PREFIX.length);
    }
    return null;
}

/**
 * テキストチャンネルの親カテゴリーからワークスペース名を特定する。
 * ワークスペースカテゴリー配下の場合のみ名前を返す。
 */
export function resolveWorkspaceFromChannel(channel: TextChannel): string | null {
    if (!channel.parent) { return null; }
    if (channel.parent.type !== ChannelType.GuildCategory) { return null; }
    return extractWorkspaceFromCategoryName(channel.parent.name);
}

// -----------------------------------------------------------------------
// カテゴリー管理
// -----------------------------------------------------------------------

/** 「Schedules」カテゴリーを取得 or 作成する。 */
export async function ensureSchedulesCategory(client: Client, guildId: string): Promise<string | null> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        logWarn(`Discord: guild ${guildId} not found`);
        return null;
    }

    const existing = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory
            && c.name === SCHEDULES_CATEGORY_NAME
    );
    if (existing) {
        logDebug(`Discord: found existing Schedules category: ${existing.id}`);
        return existing.id;
    }

    try {
        const category = await guild.channels.create({
            name: SCHEDULES_CATEGORY_NAME,
            type: ChannelType.GuildCategory,
        });
        logDebug(`Discord: created Schedules category: ${category.id}`);
        return category.id;
    } catch (e) {
        logError('Discord: failed to create Schedules category', e);
        return null;
    }
}

/** ワークスペース用カテゴリーを取得 or 作成する。 */
export async function ensureWorkspaceCategory(client: Client, guildId: string, wsName: string): Promise<string | null> {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        logWarn(`Discord: guild ${guildId} not found`);
        return null;
    }

    const catName = workspaceCategoryName(wsName);

    const existing = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === catName
    );
    if (existing) {
        logDebug(`Discord: found existing workspace category "${catName}": ${existing.id}`);
        return existing.id;
    }

    try {
        const category = await guild.channels.create({
            name: catName,
            type: ChannelType.GuildCategory,
        });
        logDebug(`Discord: created workspace category "${catName}": ${category.id}`);
        return category.id;
    } catch (e) {
        logError(`Discord: failed to create workspace category "${catName}"`, e);
        return null;
    }
}

/**
 * ワークスペース用カテゴリー + #agent-chat チャンネルを作成する。
 * 既に存在していればスキップ。
 * @returns カテゴリーID（失敗時 null）
 */
export async function ensureWorkspaceStructure(client: Client, guildId: string, wsName: string): Promise<string | null> {
    const categoryId = await ensureWorkspaceCategory(client, guildId, wsName);
    if (!categoryId) { return null; }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) { return null; }

    const existing = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText
            && c.parentId === categoryId
            && c.name === 'agent-chat'
    );
    if (existing) {
        logDebug(`Discord: workspace "${wsName}" already has #agent-chat (${existing.id})`);
        return categoryId;
    }

    try {
        const channel = await guild.channels.create({
            name: 'agent-chat',
            type: ChannelType.GuildText,
            parent: categoryId,
        });
        logDebug(`Discord: created #agent-chat (${channel.id}) in workspace "${wsName}"`);
    } catch (e) {
        logError(`Discord: failed to create #agent-chat in workspace "${wsName}"`, e);
    }

    return categoryId;
}

/**
 * Guild 上のワークスペースカテゴリーを列挙する。
 * @returns ワークスペース名 → カテゴリーID のマップ
 */
export function discoverWorkspaceCategories(client: Client, guildId: string): Map<string, string> {
    const result = new Map<string, string>();
    const guild = client.guilds.cache.get(guildId);
    if (!guild) { return result; }

    for (const [id, channel] of guild.channels.cache) {
        if (channel.type !== ChannelType.GuildCategory) { continue; }
        const wsName = extractWorkspaceFromCategoryName(channel.name);
        if (wsName) {
            result.set(wsName, id);
        }
    }
    return result;
}

// -----------------------------------------------------------------------
// Plan チャンネル管理
// -----------------------------------------------------------------------

/**
 * Plan 専用チャンネルを作成する。
 * workspaceName が指定された場合はそのワークスペースカテゴリー内に、
 * 未指定の場合は従来の Schedules カテゴリー内に作成する。
 */
export async function createPlanChannel(
    client: Client,
    guildId: string,
    channelName: string,
    wsName?: string,
): Promise<string | null> {
    let categoryId: string | null;
    if (wsName) {
        categoryId = await ensureWorkspaceCategory(client, guildId, wsName);
    } else {
        categoryId = await ensureSchedulesCategory(client, guildId);
    }
    if (!categoryId) { return null; }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) { return null; }

    const parentLabel = wsName ? `workspace "${wsName}"` : 'Schedules';
    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
        });
        logDebug(`Discord: created plan channel #${channel.name} (${channel.id}) in ${parentLabel}`);
        return channel.id;
    } catch (e) {
        logError(`Discord: failed to create plan channel "${channelName}" in ${parentLabel}`, e);
        return null;
    }
}

/** Plan 専用チャンネルを削除する。 */
export async function deletePlanChannel(client: Client, channelId: string): Promise<boolean> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            logWarn(`Discord: channel ${channelId} not found for deletion`);
            return false;
        }
        if ('delete' in channel && typeof channel.delete === 'function') {
            await channel.delete();
            logDebug(`Discord: deleted plan channel ${channelId}`);
            return true;
        }
        logWarn(`Discord: channel ${channelId} is not deletable`);
        return false;
    } catch (e) {
        logError(`Discord: failed to delete plan channel ${channelId}`, e);
        return false;
    }
}

/** Plan 専用チャンネルの名前を変更する。 */
export async function renamePlanChannel(client: Client, channelId: string, newName: string): Promise<boolean> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            logWarn(`Discord: channel ${channelId} not found or not text channel for rename`);
            return false;
        }
        await channel.setName(newName);
        logDebug(`Discord: renamed plan channel ${channelId} to "${newName}"`);
        return true;
    } catch (e) {
        logError(`Discord: failed to rename plan channel ${channelId}`, e);
        return false;
    }
}

// -----------------------------------------------------------------------
// サブエージェント スレッド管理
// -----------------------------------------------------------------------

/**
 * サブエージェント用のスレッドを #agent-chat 内に作成する。
 * autoArchiveDuration は OneHour（1時間で自動アーカイブ）。
 */
export async function createSubagentThread(
    client: Client,
    channelId: string,
    agentName: string,
    taskSummary?: string,
): Promise<string | null> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            logWarn(`Discord: channel ${channelId} not found or not text channel for thread creation`);
            return null;
        }

        const threadName = `🤖 ${agentName}`;
        const thread = await channel.threads.create({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
            type: ChannelType.PublicThread,
            reason: `サブエージェント ${agentName} の作業スレッド`,
        });
        logDebug(`Discord: created subagent thread "${threadName}" (${thread.id}) in channel ${channelId}`);
        return thread.id;
    } catch (e) {
        logError(`Discord: failed to create subagent thread for "${agentName}" in channel ${channelId}`, e);
        return null;
    }
}

/** サブエージェント用スレッドを手動アーカイブする。 */
export async function archiveSubagentThread(client: Client, threadId: string): Promise<boolean> {
    try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || !thread.isThread()) {
            logWarn(`Discord: thread ${threadId} not found or not a thread for archiving`);
            return false;
        }
        await thread.setArchived(true);
        logDebug(`Discord: archived subagent thread ${threadId}`);
        return true;
    } catch (e) {
        logError(`Discord: failed to archive subagent thread ${threadId}`, e);
        return false;
    }
}

/** サブエージェント用スレッドにメッセージを送信する。 */
export async function sendToSubagentThread(client: Client, threadId: string, message: string): Promise<boolean> {
    try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || !thread.isThread()) {
            logWarn(`Discord: thread ${threadId} not found or not a thread for sending message`);
            return false;
        }
        await thread.send(message);
        logDebug(`Discord: sent message to subagent thread ${threadId}`);
        return true;
    } catch (e) {
        logError(`Discord: failed to send message to subagent thread ${threadId}`, e);
        return false;
    }
}

/** サブエージェント用スレッドに typing indicator を送信する。 */
export async function sendTypingToThread(client: Client, threadId: string): Promise<void> {
    try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || !thread.isThread()) {
            return;
        }
        await thread.sendTyping();
    } catch {
        // typing 送信失敗は無視
    }
}

/** サブエージェント用スレッドに Embed を送信する。 */
export async function sendEmbedToThread(client: Client, threadId: string, embed: EmbedBuilder): Promise<boolean> {
    try {
        const thread = await client.channels.fetch(threadId);
        if (!thread || !thread.isThread()) {
            logWarn(`Discord: thread ${threadId} not found or not a thread for sending embed`);
            return false;
        }
        await thread.send({ embeds: [embed] });
        logDebug(`Discord: sent embed to subagent thread ${threadId}`);
        return true;
    } catch (e) {
        logError(`Discord: failed to send embed to subagent thread ${threadId}`, e);
        return false;
    }
}
