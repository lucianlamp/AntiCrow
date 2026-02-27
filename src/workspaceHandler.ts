// ---------------------------------------------------------------------------
// workspaceHandler.ts — ワークスペース管理 UI + ボタンインタラクション
// ---------------------------------------------------------------------------
// 責務:
//   1. ワークスペース一覧 Embed + ボタン構築
//   2. ワークスペース関連ボタンインタラクション処理
//      (ws_refresh, ws_delete, ws_delete_confirm, ws_delete_cancel,
//       ws_create, ws_modal_create)
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ModalSubmitInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CdpBridge } from './cdpBridge';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { BridgeContext } from './bridgeContext';
import { getArchiveDays, getWorkspaceParentDirs, getConfig } from './configHelper';

import { snowflakeToTimestamp } from './discordUtils';
import { WORKSPACE_CATEGORY_PREFIX } from './discordChannels';


// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** CDP 稼働中ワークスペース名を取得する */
export async function getRunningWsNames(ports?: number[]): Promise<Set<string>> {
    const result = new Set<string>();
    try {
        const instances = await CdpBridge.discoverInstances(ports);
        for (const inst of instances) {
            result.add(CdpBridge.extractWorkspaceName(inst.title));
        }
    } catch (e) { logDebug(`getRunningWsNames: CDP scan failed: ${e}`); }
    return result;
}

// ---------------------------------------------------------------------------
// ワークスペース一覧 Embed + ボタン構築
// ---------------------------------------------------------------------------

const WS_ITEMS_PER_PAGE = 5;

export async function buildWorkspaceListEmbed(ctx: BridgeContext, page = 0): Promise<{
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}> {
    const guild = ctx.bot?.getFirstGuild();
    const existingCategories = guild && ctx.bot ? ctx.bot.discoverWorkspaceCategories(guild.id) : new Map<string, string>();

    if (existingCategories.size === 0) {
        return { embeds: [], components: [] };
    }

    // CDP 稼働中のワークスペース名を取得（バッジ表示用）
    let runningWsNames = new Set<string>();
    try {
        const ports = ctx.cdp?.getPorts();
        const instances = await CdpBridge.discoverInstances(ports);
        for (const inst of instances) {
            runningWsNames.add(CdpBridge.extractWorkspaceName(inst.title));
        }
    } catch (e) { logDebug(`buildWorkspaceListEmbed: CDP scan failed: ${e}`); }

    // 各カテゴリーの最終使用日時を算出
    const categories: { wsName: string; categoryId: string; lastActivity: number }[] = [];
    for (const [wsName, catId] of existingCategories) {
        let latestTs = 0;
        if (guild) {
            const children = guild.channels.cache.filter(c => c.parentId === catId);
            for (const [, child] of children) {
                if ('lastMessageId' in child && child.lastMessageId) {
                    const ts = snowflakeToTimestamp(child.lastMessageId);
                    if (ts > latestTs) { latestTs = ts; }
                }
            }
            if (latestTs === 0) {
                const cat = guild.channels.cache.get(catId);
                if (cat?.createdTimestamp) {
                    latestTs = cat.createdTimestamp;
                }
            }
            if (latestTs === 0) {
                latestTs = snowflakeToTimestamp(catId);
            }
        }
        categories.push({ wsName, categoryId: catId, lastActivity: latestTs });
    }

    // ページネーション計算
    const totalItems = categories.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / WS_ITEMS_PER_PAGE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const startIdx = safePage * WS_ITEMS_PER_PAGE;
    const pageItems = categories.slice(startIdx, startIdx + WS_ITEMS_PER_PAGE);

    const pageIndicator = totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : '';
    const embed = new EmbedBuilder()
        .setTitle('📁 ワークスペースカテゴリー')
        .setDescription(`${totalItems}件${pageIndicator}`)
        .setColor(0x5865F2)
        .setTimestamp();

    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const [i, cat] of pageItems.entries()) {
        const daysAgo = cat.lastActivity > 0
            ? Math.floor((Date.now() - cat.lastActivity) / (24 * 60 * 60 * 1000))
            : -1;
        const lastActivityStr = daysAgo >= 0 ? `${daysAgo}日前` : '不明';

        const cdpBadge = runningWsNames.has(cat.wsName) ? '🟢' : '⚪';
        const globalIdx = startIdx + i + 1;
        embed.addFields({
            name: `${cdpBadge} ${globalIdx}. ${cat.wsName}`,
            value: `最終使用: ${lastActivityStr}`,
        });

        // 削除ボタン行（ActionRow 上限 5 のうちナビ用に2行確保 → 最大3行まで）
        if (components.length < 3) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ws_delete:${cat.categoryId}:${cat.wsName}`)
                    .setLabel(`🗑️ ${cat.wsName.substring(0, 20)}カテゴリを削除`)
                    .setStyle(ButtonStyle.Danger),
            );
            components.push(row);
        }
    }

    // アクション行（新規作成 + 更新）
    if (components.length < 5) {
        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('ws_create')
                .setLabel('➕ 新規作成')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ws_refresh')
                .setLabel('🔄 更新')
                .setStyle(ButtonStyle.Secondary),
        );
        components.push(actionRow);
    }

    // ページネーション行（2ページ以上の場合のみ）
    if (totalPages > 1 && components.length < 5) {
        const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`ws_page:${safePage - 1}`)
                .setLabel('◀ 前へ')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage === 0),
            new ButtonBuilder()
                .setCustomId('ws_page_info')
                .setLabel(`${safePage + 1} / ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`ws_page:${safePage + 1}`)
                .setLabel('次へ ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(safePage >= totalPages - 1),
        );
        components.push(navRow);
    }

    const archiveDays = getArchiveDays();
    if (archiveDays > 0) {
        embed.setFooter({ text: `⏰ 最終使用日から${archiveDays}日間未使用のカテゴリーは自動削除されます` });
    } else {
        embed.setFooter({ text: '⏰ 自動削除: 無効' });
    }

    return { embeds: [embed], components };
}

// ---------------------------------------------------------------------------
// ワークスペース関連ボタンインタラクション
// ---------------------------------------------------------------------------

/**
 * ワークスペース関連ボタンを処理する。
 * @returns ボタンが処理された場合 true、関係ないボタンの場合 false
 */
export async function handleWorkspaceButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
): Promise<boolean> {
    const customId = interaction.customId;

    // ----- ws_page:N (ページネーション) -----
    if (customId.startsWith('ws_page:')) {
        const pageNum = parseInt(customId.split(':')[1], 10);
        if (isNaN(pageNum)) { return false; }
        try {
            await interaction.deferUpdate();
            const { embeds, components } = await buildWorkspaceListEmbed(ctx, pageNum);
            if (embeds.length === 0) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity ワークスペースが見つかりませんでした。', EmbedColor.Warning)], components: [] });
            } else {
                await interaction.editReply({ embeds, components: components as any });
            }
        } catch (e) {
            logError('handleWorkspaceButton: ws_page failed', e);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ embeds: [buildEmbed('⚠️ ページ切り替えに失敗しました。', EmbedColor.Warning)] });
                }
            } catch (e2) { logDebug(`handleWorkspaceButton: interaction response failed: ${e2}`); }
        }
        return true;
    }

    // ----- ws_refresh -----
    if (customId === 'ws_refresh') {
        try {
            await interaction.deferUpdate();
            const { embeds, components } = await buildWorkspaceListEmbed(ctx);
            if (embeds.length === 0) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ Antigravity ワークスペースが見つかりませんでした。', EmbedColor.Warning)], components: [] });
            } else {
                await interaction.editReply({ embeds, components: components as any });
            }
        } catch (e) {
            logError('handleWorkspaceButton: ws_refresh failed', e);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ embeds: [buildEmbed('⚠️ 更新に失敗しました。もう一度お試しください。', EmbedColor.Warning)] });
                }
            } catch (e) { logDebug(`handleWorkspaceButton: interaction response failed: ${e}`); }
        }
        return true;
    }

    // ----- ws_create -----
    if (customId === 'ws_create') {

        const parentDirs = getWorkspaceParentDirs();
        if (parentDirs.length === 0) {
            await interaction.reply({
                embeds: [buildEmbed(
                    '⚠️ **ペアレントディレクトリが未設定です**\n\n' +
                    'Antigravity の設定で `antiCrow.workspaceParentDirs` に\n' +
                    '新規ワークスペースを作成するディレクトリを追加してください。\n\n' +
                    '**設定例:**\n' +
                    '```json\n' +
                    '"antiCrow.workspaceParentDirs": [\n' +
                    '  "C:\\\\Users\\\\user\\\\dev",\n' +
                    '  "C:\\\\Users\\\\user\\\\projects"\n' +
                    ']\n' +
                    '```',
                    EmbedColor.Warning,
                )],
            });
            return true;
        }

        const modal = new ModalBuilder()
            .setCustomId('ws_modal_create')
            .setTitle('新規ワークスペース作成');

        const nameInput = new TextInputBuilder()
            .setCustomId('ws_name')
            .setLabel('ワークスペース名（フォルダ名になります）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(60)
            .setPlaceholder('例: my-new-project');

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput) as any,
        );

        // ペアレントディレクトリが複数の場合はフィールドを追加
        if (parentDirs.length > 1) {
            const dirInput = new TextInputBuilder()
                .setCustomId('ws_parent_dir')
                .setLabel('ペアレントディレクトリ（番号を入力）')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(10)
                .setPlaceholder(parentDirs.map((d, i) => `${i + 1}: ${path.basename(d)}`).join(' / '));

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(dirInput) as any,
            );
        }

        await interaction.showModal(modal);
        return true;
    }

    // ----- ws_delete -----
    if (customId.startsWith('ws_delete:')) {
        const parts = customId.split(':');
        const categoryId = parts[1];
        const wsName = parts.slice(2).join(':');
        if (!ctx.bot) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bot が初期化されていません。', EmbedColor.Warning)] });
            return true;
        }

        // アクティブなスケジュールがあるかチェック
        const guild = ctx.bot.getFirstGuild();
        if (guild) {
            const children = guild.channels.cache.filter(c => c.parentId === categoryId);
            const activePlanChannelIds = new Set<string>();
            if (ctx.planStore) {
                for (const plan of ctx.planStore.getAll()) {
                    if (plan.channel_id) { activePlanChannelIds.add(plan.channel_id); }
                }
            }
            let hasActivePlan = false;
            for (const [childId] of children) {
                if (activePlanChannelIds.has(childId)) {
                    hasActivePlan = true;
                    break;
                }
            }
            if (hasActivePlan) {
                await interaction.reply({
                    embeds: [buildEmbed(`⚠️ ワークスペース「**${wsName}**」にはアクティブなスケジュールがあります。\n先に \`/schedules\` コマンドでスケジュールを削除してから、再度お試しください。`, EmbedColor.Warning)],
                });
                return true;
            }
        }

        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`ws_delete_confirm:${categoryId}:${wsName}`)
                .setLabel('✅ 削除する')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`ws_delete_cancel:${categoryId}`)
                .setLabel('❌ キャンセル')
                .setStyle(ButtonStyle.Secondary),
        );
        await interaction.reply({
            embeds: [buildEmbed(`⚠️ ワークスペース「**${wsName}**」のカテゴリーと全チャンネルを削除します。\n\`workspacePaths\` 設定は保持されるため、次回使用時にカテゴリーは自動再作成されます。\n\nよろしいですか？`, EmbedColor.Warning)],
            components: [confirmRow as any],
        });
        return true;
    }

    // ----- ws_delete_confirm -----
    if (customId.startsWith('ws_delete_confirm:')) {
        const parts = customId.split(':');
        const categoryId = parts[1];
        const wsName = parts.slice(2).join(':');
        if (!ctx.bot) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bot が初期化されていません。', EmbedColor.Warning)] });
            return true;
        }
        try {
            await interaction.deferUpdate();
            const guild = ctx.bot.getFirstGuild();
            if (!guild) {
                await interaction.editReply({ embeds: [buildEmbed('⚠️ Guild が見つかりません。', EmbedColor.Warning)], components: [] });
                return true;
            }

            const children = guild.channels.cache.filter(c => c.parentId === categoryId);
            for (const [, child] of children) {
                try {
                    if ('delete' in child && typeof child.delete === 'function') {
                        await child.delete();
                    }
                } catch (e) {
                    logWarn(`ws_delete_confirm: failed to delete channel ${child.id}: ${e instanceof Error ? e.message : e}`);
                }
            }

            const category = guild.channels.cache.get(categoryId);
            if (category && 'delete' in category && typeof category.delete === 'function') {
                await category.delete();
            }

            logInfo(`handleWorkspaceButton: deleted workspace category "${wsName}" (${categoryId})`);
            await interaction.editReply({
                embeds: [buildEmbed(`🗑️ ワークスペース「**${wsName}**」のカテゴリーを削除しました。`, EmbedColor.Success)],
                components: [],
            });
        } catch (e) {
            logError('handleWorkspaceButton: ws_delete_confirm failed', e);
            const errMsg = e instanceof Error ? e.message : String(e);
            await interaction.editReply({
                embeds: [buildEmbed(`❌ 削除失敗: ${errMsg}`, EmbedColor.Error)],
                components: [],
            });
        }
        return true;
    }

    // ----- ws_delete_cancel -----
    if (customId.startsWith('ws_delete_cancel:')) {
        await interaction.update({
            embeds: [buildEmbed('❌ キャンセルしました。', EmbedColor.Error)],
            components: [],
        });
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// ワークスペース作成モーダル送信ハンドラ
// ---------------------------------------------------------------------------

/**
 * ws_modal_create モーダルの送信を処理する。
 * フォルダ作成 → カテゴリ作成 → #agent-chat チャンネル作成 → 設定更新。
 */
export async function handleWorkspaceModalSubmit(
    ctx: BridgeContext,
    interaction: ModalSubmitInteraction,
): Promise<boolean> {
    if (interaction.customId !== 'ws_modal_create') {
        return false;
    }

    const wsName = interaction.fields.getTextInputValue('ws_name').trim();
    if (!wsName) {
        await interaction.reply({
            embeds: [buildEmbed('⚠️ ワークスペース名が空です。', EmbedColor.Warning)],
        });
        return true;
    }

    // ファイルシステム上の不正な文字をチェック
    if (/[<>:"|?*\/\\]/.test(wsName)) {
        await interaction.reply({
            embeds: [buildEmbed('⚠️ ワークスペース名にファイル名として使用できない文字が含まれています。\n使用不可文字: `< > : " | ? * / \\`', EmbedColor.Warning)],
        });
        return true;
    }

    const parentDirs = getWorkspaceParentDirs();
    if (parentDirs.length === 0) {
        await interaction.reply({
            embeds: [buildEmbed('⚠️ ペアレントディレクトリが設定されていません。', EmbedColor.Warning)],
        });
        return true;
    }

    // ペアレントディレクトリの解決
    let parentDir: string;
    if (parentDirs.length === 1) {
        parentDir = parentDirs[0];
    } else {
        const dirInput = interaction.fields.getTextInputValue('ws_parent_dir').trim();
        const dirIndex = parseInt(dirInput, 10) - 1;
        if (isNaN(dirIndex) || dirIndex < 0 || dirIndex >= parentDirs.length) {
            await interaction.reply({
                embeds: [buildEmbed(
                    `⚠️ 無効な番号です。1〜${parentDirs.length} の番号を入力してください。\n\n` +
                    parentDirs.map((d, i) => `**${i + 1}:** \`${d}\``).join('\n'),
                    EmbedColor.Warning,
                )],
            });
            return true;
        }
        parentDir = parentDirs[dirIndex];
    }

    const fullPath = path.join(parentDir, wsName);

    try {
        await interaction.deferReply();

        // 1. フォルダ作成
        if (fs.existsSync(fullPath)) {
            logDebug(`ws_modal_create: folder already exists: ${fullPath}`);
        } else {
            fs.mkdirSync(fullPath, { recursive: true });
            logInfo(`ws_modal_create: created folder: ${fullPath}`);
        }

        // 2. Discord カテゴリ作成
        if (!ctx.bot) {
            await interaction.editReply({
                embeds: [buildEmbed('⚠️ Bot が初期化されていません。', EmbedColor.Warning)],
            });
            return true;
        }

        const guild = ctx.bot.getFirstGuild();
        if (!guild) {
            await interaction.editReply({
                embeds: [buildEmbed('⚠️ Guild が見つかりません。', EmbedColor.Warning)],
            });
            return true;
        }

        const categoryId = await ctx.bot.ensureWorkspaceCategory(guild.id, wsName);
        if (!categoryId) {
            await interaction.editReply({
                embeds: [buildEmbed('❌ Discord カテゴリの作成に失敗しました。', EmbedColor.Error)],
            });
            return true;
        }

        // 3. #agent-chat チャンネル作成（存在しない場合のみ）
        const existingChat = guild.channels.cache.find(
            c => c.parentId === categoryId && c.name === 'agent-chat',
        );
        let chatChannelId: string;
        if (existingChat) {
            chatChannelId = existingChat.id;
            logDebug(`ws_modal_create: agent-chat already exists: ${chatChannelId}`);
        } else {
            const chatChannel = await guild.channels.create({
                name: 'agent-chat',
                type: ChannelType.GuildText,
                parent: categoryId,
            });
            chatChannelId = chatChannel.id;
            logInfo(`ws_modal_create: created agent-chat channel: ${chatChannelId}`);
        }

        // 4. workspacePaths 設定に追加
        const currentPaths = getConfig().get<Record<string, string>>('workspacePaths') || {};
        if (!currentPaths[wsName]) {
            currentPaths[wsName] = fullPath;
            await getConfig().update('workspacePaths', currentPaths, vscode.ConfigurationTarget.Global);
            logInfo(`ws_modal_create: added workspacePaths["${wsName}"] = "${fullPath}"`);
        }

        await interaction.editReply({
            embeds: [buildEmbed(
                `✅ **ワークスペース「${wsName}」を作成しました！**\n\n` +
                `📁 フォルダ: \`${fullPath}\`\n` +
                `📂 カテゴリ: ${WORKSPACE_CATEGORY_PREFIX}${wsName}\n` +
                `💬 チャンネル: <#${chatChannelId}>\n\n` +
                '`#agent-chat` にメッセージを送ると、ワークスペースが自動起動します。',
                EmbedColor.Success,
            )],
        });

        logInfo(`ws_modal_create: workspace "${wsName}" created successfully (folder=${fullPath}, category=${categoryId}, chat=${chatChannelId})`);
    } catch (e) {
        logError('ws_modal_create: failed', e);
        const errMsg = e instanceof Error ? e.message : String(e);
        try {
            if (interaction.deferred) {
                await interaction.editReply({
                    embeds: [buildEmbed(`❌ ワークスペース作成に失敗しました: ${errMsg}`, EmbedColor.Error)],
                });
            } else {
                await interaction.reply({
                    embeds: [buildEmbed(`❌ ワークスペース作成に失敗しました: ${errMsg}`, EmbedColor.Error)],
                });
            }
        } catch (replyErr) {
            logDebug(`ws_modal_create: interaction response failed: ${replyErr}`);
        }
    }

    return true;
}
