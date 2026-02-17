// ---------------------------------------------------------------------------
// discordBot.ts — Discord Bot ライフサイクル & チャンネルルーティング
// ---------------------------------------------------------------------------

import {
    Client,
    GatewayIntentBits,
    Message,
    TextChannel,
    EmbedBuilder,
    ChannelType,
    Partials,
    ChatInputCommandInteraction,
    ButtonInteraction,
} from 'discord.js';
import { ChannelIntent } from './types';
import { splitForEmbeds, extractTableFields } from './discordFormatter';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';

export type MessageHandler = (
    message: Message,
    intent: ChannelIntent,
    channelName: string,
) => Promise<void>;

export type InteractionHandler = (
    interaction: ChatInputCommandInteraction,
    intent: ChannelIntent | 'admin',
) => Promise<void>;

export type ButtonHandler = (
    interaction: ButtonInteraction,
) => Promise<void>;

export class DiscordBot {
    private client: Client;
    private token: string;

    private messageHandler: MessageHandler | null = null;
    private interactionHandler: InteractionHandler | null = null;
    private buttonHandler: ButtonHandler | null = null;
    private ready = false;

    constructor(token: string) {
        this.token = token;

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [
                Partials.Message,
                Partials.Reaction,
                Partials.User,
            ],
        });

        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        this.client.on('ready', () => {
            logInfo(`Discord: logged in as ${this.client.user?.tag}`);
            this.ready = true;
        });

        this.client.on('messageCreate', async (msg: Message) => {
            // Bot 自身のメッセージは無視
            if (msg.author.bot) { return; }

            // DM は無視
            if (msg.channel.type !== ChannelType.GuildText) { return; }

            const channel = msg.channel as TextChannel;
            const channelName = channel.name;

            // ワークスペースカテゴリー内の #agent-chat かチェック
            const wsName = DiscordBot.resolveWorkspaceFromChannel(channel);
            if (!wsName) {
                logDebug(`Discord: ignoring message from non-category channel #${channelName}`);
                return;
            }

            logInfo(`Discord: message from workspace "${wsName}" #${channelName}: "${msg.content.substring(0, 80)}..."`);
            if (this.messageHandler) {
                try {
                    await this.messageHandler(msg, 'agent-chat', channelName);
                } catch (e) {
                    logError(`Discord: message handler error in workspace "${wsName}" #${channelName}`, e);
                }
            }
        });

        // ----- Interaction (Slash Command + Button) -----
        this.client.on('interactionCreate', async (interaction) => {
            // ----- Button Interaction -----
            if (interaction.isButton()) {
                logInfo(`Discord: button interaction customId=${interaction.customId} from ${interaction.user.tag}`);
                if (this.buttonHandler) {
                    try {
                        await this.buttonHandler(interaction);
                    } catch (e) {
                        logError(`Discord: button handler error for ${interaction.customId}`, e);
                        const errMsg = e instanceof Error ? e.message : String(e);
                        if (!interaction.replied && !interaction.deferred) {
                            await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)], ephemeral: true }).catch(() => { });
                        }
                    }
                }
                return;
            }

            if (!interaction.isChatInputCommand()) { return; }

            const commandName = interaction.commandName;
            const intent = this.mapCommandToIntent(commandName);
            if (!intent) {
                logWarn(`Discord: unknown slash command /${commandName}`);
                await interaction.reply({ embeds: [buildEmbed(`⚠️ 不明なコマンド: /${commandName}`, EmbedColor.Warning)], ephemeral: true });
                return;
            }

            logInfo(`Discord: slash command /${commandName} (intent=${intent}) from ${interaction.user.tag}`);

            if (this.interactionHandler) {
                try {
                    await this.interactionHandler(interaction, intent);
                } catch (e) {
                    logError(`Discord: interaction handler error for /${commandName}`, e);
                    const errMsg = e instanceof Error ? e.message : String(e);
                    if (interaction.deferred || interaction.replied) {
                        await interaction.editReply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)] }).catch(() => { });
                    } else {
                        await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)], ephemeral: true }).catch(() => { });
                    }
                }
            }
        });

        this.client.on('error', (err) => {
            logError('Discord: client error', err);
        });

        this.client.on('warn', (msg) => {
            logWarn(`Discord: ${msg}`);
        });
    }



    /** スラッシュコマンド名 → intent にマッピング（管理系コマンドは 'admin' を返す） */
    private mapCommandToIntent(commandName: string): ChannelIntent | 'admin' | null {
        switch (commandName) {
            case 'schedule': return 'agent-chat';
            case 'status': return 'admin';
            case 'schedules': return 'admin';
            case 'reset': return 'admin';
            case 'newchat': return 'admin';
            case 'workspaces': return 'admin';
            default: return null;
        }
    }

    /** メッセージハンドラを登録 */
    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    /** スラッシュコマンドハンドラを登録 */
    onInteraction(handler: InteractionHandler): void {
        this.interactionHandler = handler;
    }

    /** ボタンインタラクションハンドラを登録 */
    onButton(handler: ButtonHandler): void {
        this.buttonHandler = handler;
    }

    /** Bot を起動 */
    async start(): Promise<void> {
        logInfo('Discord: starting bot...');
        await this.client.login(this.token);
    }

    /** ready イベントまで待機（Guild キャッシュが利用可能になるまで） */
    waitForReady(timeoutMs = 15_000): Promise<void> {
        if (this.ready) { return Promise.resolve(); }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Discord bot ready timeout'));
            }, timeoutMs);

            this.client.once('ready', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /** Bot を停止 */
    async stop(): Promise<void> {
        logInfo('Discord: stopping bot...');
        this.ready = false;
        this.client.destroy();
    }

    /** Bot がオンラインか */
    isReady(): boolean {
        return this.ready;
    }

    /** 最初の Guild を返す */
    getFirstGuild(): import('discord.js').Guild | null {
        return this.client.guilds.cache.first() || null;
    }

    // -----------------------------------------------------------------------
    // メッセージ送信
    // -----------------------------------------------------------------------

    /** 指定チャンネル ID にメッセージ送信（長文対応） */
    async sendToChannel(channelId: string, text: string, color?: number): Promise<void> {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            logWarn(`Discord: channel ${channelId} not found or not text channel`);
            return;
        }

        await this.sendToTextChannel(channel, text, color);
    }

    /** 指定チャンネル ID で typing indicator を送信 */
    async sendTypingTo(channelId: string): Promise<void> {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel instanceof TextChannel) {
            await channel.sendTyping();
        }
    }

    /** Embed のブランドカラー (Cherry Pink) */
    private static readonly EMBED_COLOR = 0x5865F2;

    /** TextChannel にメッセージ送信（すべて Embed で送信、テーブルは fields に変換） */
    async sendToTextChannel(channel: TextChannel, text: string, color?: number): Promise<void> {
        // Markdown テーブルを検出して fields に変換
        const extracted = extractTableFields(text);

        if (extracted.fields.length > 0) {
            // テーブルあり: description + fields の Embed で送信
            const embed = new EmbedBuilder()
                .setColor(color ?? DiscordBot.EMBED_COLOR);

            if (extracted.description.length > 0) {
                // description が長い場合は切り詰め
                embed.setDescription(
                    extracted.description.length > 4096
                        ? extracted.description.slice(0, 4093) + '...'
                        : extracted.description
                );
            }

            // fields を最大 25 個まで設定
            embed.addFields(
                extracted.fields.slice(0, 25).map(f => ({
                    name: f.name.slice(0, 256),
                    value: f.value.slice(0, 1024),
                    inline: f.inline ?? false,
                }))
            );

            await channel.send({ embeds: [embed] });
            return;
        }

        // テーブルなし: 従来の分割 Embed 送信
        const embedGroups = splitForEmbeds(text);
        for (const group of embedGroups) {
            const embeds = group.map((desc) => {
                const embed = new EmbedBuilder()
                    .setDescription(desc)
                    .setColor(color ?? DiscordBot.EMBED_COLOR);
                return embed;
            });
            await channel.send({ embeds });
        }
    }

    /** メッセージにリアクション待ちして確認を取る */
    async waitForConfirmation(message: Message, timeoutMs: number = 120_000): Promise<boolean> {
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

        const botId = this.client.user?.id;
        logDebug(`waitForConfirmation: bot ID = ${botId}`);

        return new Promise<boolean>((resolve) => {
            const collector = message.createReactionCollector({
                filter: (reaction, user) => {
                    const emojiName = reaction.emoji.name || '';
                    const isTargetEmoji = [confirmEmoji, rejectEmoji].includes(emojiName);
                    const isNotBot = user.id !== botId;
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

    /** 番号付き絵文字リアクションで選択を待つ（1️⃣~🔟 + ❌） */
    async waitForChoice(message: Message, choiceCount: number, timeoutMs: number = 120_000): Promise<number> {
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

        const botId = this.client.user?.id;
        const allEmojis = [...activeEmojis, rejectEmoji];

        return new Promise<number>((resolve) => {
            const collector = message.createReactionCollector({
                filter: (reaction, user) => {
                    const emojiName = reaction.emoji.name || '';
                    const isTarget = allEmojis.includes(emojiName);
                    const isNotBot = user.id !== botId;
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

    /**
     * 複数選択待ち: 1️⃣~🔟 で複数選択 → ☑️ で確定、✅ で全選択、❌ で却下。
     * @returns 選択された番号の配列（1-indexed）。空配列 = 却下/タイムアウト。[-1] = 全選択。
     */
    async waitForMultiChoice(message: Message, choiceCount: number, timeoutMs: number = 120_000): Promise<number[]> {
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

        const botId = this.client.user?.id;
        const controlEmojis = [confirmEmoji, allEmoji, rejectEmoji];
        const allValidEmojis = [...activeEmojis, ...controlEmojis];

        return new Promise<number[]>((resolve) => {
            const selected = new Set<number>();

            const collector = message.createReactionCollector({
                filter: (reaction, user) => {
                    const emojiName = reaction.emoji.name || '';
                    const isTarget = allValidEmojis.includes(emojiName);
                    const isNotBot = user.id !== botId;
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

    // -----------------------------------------------------------------------
    // Schedules カテゴリー & Plan 専用チャンネル管理
    // -----------------------------------------------------------------------

    private static readonly SCHEDULES_CATEGORY_NAME = 'Schedules';

    /**
     * 「Schedules」カテゴリーを取得 or 作成する。
     * カテゴリーが既に存在すればそのまま返す。
     */
    async ensureSchedulesCategory(guildId: string): Promise<string | null> {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) {
            logWarn(`Discord: guild ${guildId} not found`);
            return null;
        }

        // 既存カテゴリーを検索
        const existing = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory
                && c.name === DiscordBot.SCHEDULES_CATEGORY_NAME
        );
        if (existing) {
            logInfo(`Discord: found existing Schedules category: ${existing.id}`);
            return existing.id;
        }

        // 新規作成
        try {
            const category = await guild.channels.create({
                name: DiscordBot.SCHEDULES_CATEGORY_NAME,
                type: ChannelType.GuildCategory,
            });
            logInfo(`Discord: created Schedules category: ${category.id}`);
            return category.id;
        } catch (e) {
            logError('Discord: failed to create Schedules category', e);
            return null;
        }
    }

    /**
     * Plan 専用チャンネルを作成する。
     * workspaceName が指定された場合はそのワークスペースカテゴリー内に、
     * 未指定の場合は従来の Schedules カテゴリー内に作成する。
     */
    async createPlanChannel(guildId: string, channelName: string, workspaceName?: string): Promise<string | null> {
        let categoryId: string | null;
        if (workspaceName) {
            categoryId = await this.ensureWorkspaceCategory(guildId, workspaceName);
        } else {
            categoryId = await this.ensureSchedulesCategory(guildId);
        }
        if (!categoryId) { return null; }

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { return null; }

        const parentLabel = workspaceName ? `workspace "${workspaceName}"` : 'Schedules';
        try {
            const channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: categoryId,
            });
            logInfo(`Discord: created plan channel #${channel.name} (${channel.id}) in ${parentLabel}`);
            return channel.id;
        } catch (e) {
            logError(`Discord: failed to create plan channel "${channelName}" in ${parentLabel}`, e);
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // ワークスペースカテゴリー管理
    // -----------------------------------------------------------------------

    static readonly WORKSPACE_CATEGORY_PREFIX = '🤖 ';

    /**
     * ワークスペース名からカテゴリー名を組み立てる。
     */
    static workspaceCategoryName(workspaceName: string): string {
        return `${DiscordBot.WORKSPACE_CATEGORY_PREFIX}${workspaceName}`;
    }

    /**
     * カテゴリー名からワークスペース名を抽出する。
     * プレフィックスが無ければ null を返す。
     */
    static extractWorkspaceFromCategoryName(categoryName: string): string | null {
        if (categoryName.startsWith(DiscordBot.WORKSPACE_CATEGORY_PREFIX)) {
            return categoryName.slice(DiscordBot.WORKSPACE_CATEGORY_PREFIX.length);
        }
        return null;
    }

    /**
     * ワークスペース用カテゴリーを取得 or 作成する。
     */
    async ensureWorkspaceCategory(guildId: string, workspaceName: string): Promise<string | null> {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) {
            logWarn(`Discord: guild ${guildId} not found`);
            return null;
        }

        const catName = DiscordBot.workspaceCategoryName(workspaceName);

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
            logInfo(`Discord: created workspace category "${catName}": ${category.id}`);
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
    async ensureWorkspaceStructure(guildId: string, workspaceName: string): Promise<string | null> {
        const categoryId = await this.ensureWorkspaceCategory(guildId, workspaceName);
        if (!categoryId) { return null; }

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { return null; }

        // #agent-chat が既にあるかチェック
        const existing = guild.channels.cache.find(
            c => c.type === ChannelType.GuildText
                && c.parentId === categoryId
                && c.name === 'agent-chat'
        );
        if (existing) {
            logDebug(`Discord: workspace "${workspaceName}" already has #agent-chat (${existing.id})`);
            return categoryId;
        }

        try {
            const channel = await guild.channels.create({
                name: 'agent-chat',
                type: ChannelType.GuildText,
                parent: categoryId,
            });
            logInfo(`Discord: created #agent-chat (${channel.id}) in workspace "${workspaceName}"`);
        } catch (e) {
            logError(`Discord: failed to create #agent-chat in workspace "${workspaceName}"`, e);
        }

        return categoryId;
    }

    /**
     * Guild 上のワークスペースカテゴリーを列挙する。
     * @returns ワークスペース名 → カテゴリーID のマップ
     */
    discoverWorkspaceCategories(guildId: string): Map<string, string> {
        const result = new Map<string, string>();
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) { return result; }

        for (const [id, channel] of guild.channels.cache) {
            if (channel.type !== ChannelType.GuildCategory) { continue; }
            const wsName = DiscordBot.extractWorkspaceFromCategoryName(channel.name);
            if (wsName) {
                result.set(wsName, id);
            }
        }
        return result;
    }

    /**
     * テキストチャンネルの親カテゴリーからワークスペース名を特定する。
     * ワークスペースカテゴリー配下の #agent-chat の場合のみ名前を返す。
     */
    static resolveWorkspaceFromChannel(channel: TextChannel): string | null {
        if (!channel.parent) { return null; }
        if (channel.parent.type !== ChannelType.GuildCategory) { return null; }
        return DiscordBot.extractWorkspaceFromCategoryName(channel.parent.name);
    }

    /**
     * Plan 専用チャンネルを削除する。
     */
    async deletePlanChannel(channelId: string): Promise<boolean> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) {
                logWarn(`Discord: channel ${channelId} not found for deletion`);
                return false;
            }
            if ('delete' in channel && typeof channel.delete === 'function') {
                await channel.delete();
                logInfo(`Discord: deleted plan channel ${channelId}`);
                return true;
            }
            logWarn(`Discord: channel ${channelId} is not deletable`);
            return false;
        } catch (e) {
            logError(`Discord: failed to delete plan channel ${channelId}`, e);
            return false;
        }
    }

    /**
     * Plan 専用チャンネルの名前を変更する。
     */
    async renamePlanChannel(channelId: string, newName: string): Promise<boolean> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !(channel instanceof TextChannel)) {
                logWarn(`Discord: channel ${channelId} not found or not text channel for rename`);
                return false;
            }
            await channel.setName(newName);
            logInfo(`Discord: renamed plan channel ${channelId} to "${newName}"`);
            return true;
        } catch (e) {
            logError(`Discord: failed to rename plan channel ${channelId}`, e);
            return false;
        }
    }
}
