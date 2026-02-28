// ---------------------------------------------------------------------------
// discordBot.ts — Discord Bot ライフサイクル & チャンネルルーティング
// ---------------------------------------------------------------------------
// ファサードとして機能: リアクション待ち → discordReactions.ts,
// チャンネル管理 → discordChannels.ts に委譲。
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
    AutocompleteInteraction,
    ModalSubmitInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    AttachmentBuilder,
} from 'discord.js';
import { ChannelIntent } from './types';
import { splitForEmbeds, extractTableFields } from './discordFormatter';
import { logDebug, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor, normalizeHeadings } from './embedHelper';

// 委譲先モジュール
import * as reactions from './discordReactions';
import * as channels from './discordChannels';

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

export type AutocompleteHandler = (
    interaction: AutocompleteInteraction,
) => Promise<void>;

export type ModalSubmitHandler = (
    interaction: ModalSubmitInteraction,
) => Promise<void>;

export class DiscordBot {
    private client: Client;
    private token: string;

    private messageHandler: MessageHandler | null = null;
    private interactionHandler: InteractionHandler | null = null;
    private buttonHandler: ButtonHandler | null = null;
    private autocompleteHandler: AutocompleteHandler | null = null;
    private modalSubmitHandler: ModalSubmitHandler | null = null;
    private ready = false;
    private currentModelName: string | null = null;

    /** フッターに表示するモデル名を設定 */
    setModelName(name: string | null): void {
        this.currentModelName = name;
    }

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
            logDebug(`Discord: logged in as ${this.client.user?.tag}`);
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

            logDebug(`Discord: message from workspace "${wsName}" #${channelName}: "${msg.content.substring(0, 80)}..."`);
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
                const cid = interaction.customId;
                logDebug(`Discord: button interaction customId=${cid} from ${interaction.user.tag}`);

                // 確認フロー関連ボタン: discordReactions.ts のメッセージコンポーネント
                // コレクタが専用処理する。グローバルハンドラでは一切触らない。
                // ここでスキップしないと、コレクタの deferUpdate() が呼ばれる前に
                // Discord API の 3 秒応答期限が切れ「インタラクションに失敗しました」
                // エラーが発生する。
                if (
                    cid === 'confirm_approve' ||
                    cid === 'confirm_reject' ||
                    cid.startsWith('choice_') ||
                    cid.startsWith('mchoice_')
                ) {
                    return;
                }

                if (this.buttonHandler) {
                    try {
                        await this.buttonHandler(interaction);
                    } catch (e) {
                        logError(`Discord: button handler error for ${cid}`, e);
                        const errMsg = e instanceof Error ? e.message : String(e);
                        if (!interaction.replied && !interaction.deferred) {
                            await interaction.reply({ embeds: [buildEmbed(`❌ エラー: ${errMsg}`, EmbedColor.Error)], ephemeral: true }).catch(() => { });
                        }
                    }
                }
                return;
            }

            // ----- Autocomplete Interaction -----
            if (interaction.isAutocomplete()) {
                if (this.autocompleteHandler) {
                    try {
                        await this.autocompleteHandler(interaction);
                    } catch (e) {
                        logError(`Discord: autocomplete handler error for /${interaction.commandName}`, e);
                    }
                }
                return;
            }

            // ----- Modal Submit Interaction -----
            if (interaction.isModalSubmit()) {
                logDebug(`Discord: modal submit customId=${interaction.customId} from ${interaction.user.tag}`);
                if (this.modalSubmitHandler) {
                    try {
                        await this.modalSubmitHandler(interaction);
                    } catch (e) {
                        logError(`Discord: modal submit handler error for ${interaction.customId}`, e);
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

            logDebug(`Discord: slash command /${commandName} (intent=${intent}) from ${interaction.user.tag}`);

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
            case 'cancel': return 'admin';
            case 'newchat': return 'admin';
            case 'workspace': return 'admin';
            case 'history': return 'admin';
            case 'queue': return 'admin';
            case 'template': return 'admin';
            case 'model': return 'admin';
            case 'mode': return 'admin';
            case 'help': return 'admin';
            case 'suggest': return 'admin';
            case 'pro': return 'admin';
            case 'screenshot': return 'admin';
            case 'soul': return 'admin';
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

    /** オートコンプリートハンドラを登録 */
    onAutocomplete(handler: AutocompleteHandler): void {
        this.autocompleteHandler = handler;
    }

    /** モーダル送信ハンドラを登録 */
    onModalSubmit(handler: ModalSubmitHandler): void {
        this.modalSubmitHandler = handler;
    }

    /** Bot を起動 */
    async start(): Promise<void> {
        logDebug('Discord: starting bot...');
        await this.client.login(this.token);
    }

    /** ready イベントまで待機（Guild キャッシュが利用可能になるまで） */
    waitForReady(timeoutMs = 15_000): Promise<void> {
        if (this.ready) { return Promise.resolve(); }
        return new Promise((resolve, reject) => {
            const onReady = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                this.client.removeListener('ready', onReady);
                reject(new Error('Discord bot ready timeout'));
            }, timeoutMs);

            this.client.once('ready', onReady);
        });
    }

    /** Bot を停止 */
    async stop(): Promise<void> {
        logDebug('Discord: stopping bot...');
        this.ready = false;
        this.client.destroy();
    }

    /** Bot がオンラインか */
    isReady(): boolean {
        return this.ready;
    }

    /** Bot の Application ID (= client.user.id) を返す。ログイン前は null */
    getClientId(): string | null {
        return this.client.user?.id ?? null;
    }

    /** 最初の Guild を返す */
    getFirstGuild(): import('discord.js').Guild | null {
        return this.client.guilds.cache.first() || null;
    }

    /** Guild キャッシュから最初に見つかった #agent-chat チャンネルの ID を返す */
    findFirstAgentChatChannelId(): string | null {
        const guild = this.getFirstGuild();
        if (!guild) { return null; }
        const ch = guild.channels.cache.find(
            c => c.type === ChannelType.GuildText && c.name === 'agent-chat',
        );
        return ch?.id ?? null;
    }

    /** 指定ワークスペース名のカテゴリ配下にある #agent-chat チャンネルの ID を返す */
    findAgentChatChannelByWorkspace(workspaceName: string): string | null {
        const guild = this.getFirstGuild();
        if (!guild) { return null; }
        // カテゴリ名がワークスペース名と一致するカテゴリを探す
        const category = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name === workspaceName,
        );
        if (!category) { return null; }
        // そのカテゴリ配下の #agent-chat を探す
        const ch = guild.channels.cache.find(
            c => c.type === ChannelType.GuildText
                && c.name === 'agent-chat'
                && c.parentId === category.id,
        );
        return ch?.id ?? null;
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

    /** 指定チャンネル ID にコンポーネント（ボタン行等）を送信 */
    async sendComponentsToChannel(
        channelId: string,
        components: ActionRowBuilder<ButtonBuilder>[],
        embed?: EmbedBuilder,
    ): Promise<void> {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            logWarn(`Discord: channel ${channelId} not found or not text channel`);
            return;
        }
        await channel.send({
            embeds: embed ? [embed] : undefined,
            components,
        });
    }

    /** 指定チャンネル ID で typing indicator を送信 */
    async sendTypingTo(channelId: string): Promise<void> {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel instanceof TextChannel) {
            await channel.sendTyping();
        }
    }

    /** ファイル送信結果 */
    static readonly SendFileResult = {} as {
        sent: boolean;
        reason?: 'not_found' | 'too_large' | 'channel_error';
        sizeMB?: string;
        fileName?: string;
    };

    /** 指定チャンネル ID にファイルを添付送信 */
    async sendFileToChannel(channelId: string, filePath: string, comment?: string): Promise<typeof DiscordBot.SendFileResult> {
        const fs = await import('fs');
        const path = await import('path');
        const fileName = path.basename(filePath);

        // ファイル存在チェック
        if (!fs.existsSync(filePath)) {
            logWarn(`Discord: file not found: ${filePath}`);
            return { sent: false, reason: 'not_found', fileName };
        }

        // ファイルサイズチェック（25MB上限）
        const stat = fs.statSync(filePath);
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
        if (stat.size > 25 * 1024 * 1024) {
            logWarn(`Discord: file too large (${sizeMB}MB > 25MB limit): ${filePath}`);
            return { sent: false, reason: 'too_large', sizeMB, fileName };
        }

        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !(channel instanceof TextChannel)) {
            logWarn(`Discord: channel ${channelId} not found or not text channel`);
            return { sent: false, reason: 'channel_error', fileName };
        }

        const attachment = new AttachmentBuilder(filePath, { name: fileName });

        // 画像ファイルの場合は Embed にインライン画像として表示
        const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
        const ext = path.extname(filePath).toLowerCase().replace('.', '');

        if (imageExtensions.has(ext)) {
            const embed = new EmbedBuilder()
                .setImage(`attachment://${fileName}`)
                .setColor(DiscordBot.EMBED_COLOR);
            if (comment) { embed.setDescription(comment); }
            if (this.currentModelName) { embed.setFooter({ text: this.currentModelName }); }
            embed.setTimestamp();
            await channel.send({ embeds: [embed], files: [attachment] });
        } else {
            await channel.send({
                content: comment || undefined,
                files: [attachment],
            });
        }

        logDebug(`Discord: sent file ${fileName} (${sizeMB}MB, embed=${imageExtensions.has(ext)}) to channel ${channelId}`);
        return { sent: true, sizeMB, fileName };
    }

    /** Embed のブランドカラー (Cherry Pink) */
    private static readonly EMBED_COLOR = EmbedColor.Info;

    /** TextChannel にメッセージ送信（すべて Embed で送信、テーブルは fields に変換） */
    async sendToTextChannel(channel: TextChannel, text: string, color?: number): Promise<void> {
        // Discord Embed 非対応の見出し（#### 以上）を正規化
        const normalizedText = normalizeHeadings(text);
        // Markdown テーブルを検出して fields に変換
        const extracted = extractTableFields(normalizedText);

        if (extracted.fields.length > 0) {
            // テーブルあり: description + fields の Embed で送信
            // ただし、Embed サイズ制限を超える場合は splitForEmbeds にフォールバック
            const descLen = extracted.description.length;
            const fieldsCount = extracted.fields.length;
            const totalFieldChars = extracted.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
            const estimatedSize = descLen + totalFieldChars;

            if (descLen > 4096 || fieldsCount > 25 || estimatedSize > 5900) {
                // Embed 制限超過: テーブルを含むテキストを分割 Embed で送信
                logDebug(`Discord: table embed too large (desc=${descLen}, fields=${fieldsCount}, est=${estimatedSize}), falling back to split embeds`);
                // フォールバック: テーブルありでも splitForEmbeds で分割送信
                // （テーブルは Markdown のまま表示される）
            } else {
                const embed = new EmbedBuilder()
                    .setColor(color ?? DiscordBot.EMBED_COLOR);

                if (extracted.description.length > 0) {
                    embed.setDescription(extracted.description);
                }

                embed.addFields(
                    extracted.fields.map(f => ({
                        name: f.name.slice(0, 256),
                        value: f.value.slice(0, 1024),
                        inline: f.inline ?? false,
                    }))
                );

                // フッター（モデル名+タイムスタンプ）
                if (this.currentModelName) {
                    embed.setFooter({ text: this.currentModelName });
                }
                embed.setTimestamp();

                await channel.send({ embeds: [embed] });
                return;
            }
        }

        // テーブルなし: 従来の分割 Embed 送信
        const embedGroups = splitForEmbeds(normalizedText);
        for (const group of embedGroups) {
            const embeds = group.map((desc, idx) => {
                const embed = new EmbedBuilder()
                    .setDescription(desc)
                    .setColor(color ?? DiscordBot.EMBED_COLOR);
                // 最後の Embed にのみフッターとタイムスタンプを付与
                if (idx === group.length - 1) {
                    if (this.currentModelName) {
                        embed.setFooter({ text: this.currentModelName });
                    }
                    embed.setTimestamp();
                }
                return embed;
            });
            await channel.send({ embeds });
        }
    }

    // -----------------------------------------------------------------------
    // リアクション待ち — discordReactions.ts に委譲
    // -----------------------------------------------------------------------

    /** メッセージにリアクション待ちして確認を取る */
    async waitForConfirmation(message: Message): Promise<boolean> {
        return reactions.waitForConfirmation(message, this.client.user?.id);
    }

    /** 番号付き絵文字リアクションで選択を待つ（1️⃣~🔟 + ❌） */
    async waitForChoice(message: Message, choiceCount: number): Promise<number> {
        return reactions.waitForChoice(message, this.client.user?.id, choiceCount);
    }

    /**
     * 複数選択待ち: 1️⃣~🔟 で複数選択 → ☑️ で確定、✅ で全選択、❌ で却下。
     * @returns 選択された番号の配列（1-indexed）。空配列 = 却下/タイムアウト。[-1] = 全選択。
     */
    async waitForMultiChoice(message: Message, choiceCount: number): Promise<number[]> {
        return reactions.waitForMultiChoice(message, this.client.user?.id, choiceCount);
    }

    /** 指定チャンネルのアクティブな確認コレクタをキャンセル（自動却下） */
    cancelActiveConfirmation(channelId: string): boolean {
        return reactions.cancelActiveConfirmation(channelId);
    }

    // -----------------------------------------------------------------------
    // チャンネル管理 — discordChannels.ts に委譲
    // -----------------------------------------------------------------------

    static readonly WORKSPACE_CATEGORY_PREFIX = channels.WORKSPACE_CATEGORY_PREFIX;

    static workspaceCategoryName(workspaceName: string): string {
        return channels.workspaceCategoryName(workspaceName);
    }

    static extractWorkspaceFromCategoryName(categoryName: string): string | null {
        return channels.extractWorkspaceFromCategoryName(categoryName);
    }

    static resolveWorkspaceFromChannel(channel: TextChannel): string | null {
        return channels.resolveWorkspaceFromChannel(channel);
    }

    async ensureSchedulesCategory(guildId: string): Promise<string | null> {
        return channels.ensureSchedulesCategory(this.client, guildId);
    }

    async createPlanChannel(guildId: string, channelName: string, workspaceName?: string): Promise<string | null> {
        return channels.createPlanChannel(this.client, guildId, channelName, workspaceName);
    }

    async ensureWorkspaceCategory(guildId: string, workspaceName: string): Promise<string | null> {
        return channels.ensureWorkspaceCategory(this.client, guildId, workspaceName);
    }

    async ensureWorkspaceStructure(guildId: string, workspaceName: string): Promise<string | null> {
        return channels.ensureWorkspaceStructure(this.client, guildId, workspaceName);
    }

    discoverWorkspaceCategories(guildId: string): Map<string, string> {
        return channels.discoverWorkspaceCategories(this.client, guildId);
    }

    async deletePlanChannel(channelId: string): Promise<boolean> {
        return channels.deletePlanChannel(this.client, channelId);
    }

    async renamePlanChannel(channelId: string, newName: string): Promise<boolean> {
        return channels.renamePlanChannel(this.client, channelId, newName);
    }
}
