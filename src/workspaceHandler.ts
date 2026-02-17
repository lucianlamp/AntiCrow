// ---------------------------------------------------------------------------
// workspaceHandler.ts — ワークスペース管理 UI + ボタンインタラクション
// ---------------------------------------------------------------------------
// 責務:
//   1. ワークスペース一覧 Embed + ボタン構築
//   2. ワークスペース関連ボタンインタラクション処理
//      (ws_refresh, ws_delete, ws_delete_confirm, ws_delete_cancel)
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { logInfo, logError, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { BridgeContext } from './bridgeContext';
import { getArchiveDays } from './configHelper';
import { snowflakeToTimestamp } from './discordUtils';

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
    } catch { /* CDP 未接続時は空セット */ }
    return result;
}

// ---------------------------------------------------------------------------
// ワークスペース一覧 Embed + ボタン構築
// ---------------------------------------------------------------------------

export async function buildWorkspaceListEmbed(ctx: BridgeContext): Promise<{
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
}> {
    const guild = ctx.bot?.getFirstGuild();
    const existingCategories = guild && ctx.bot ? ctx.bot.discoverWorkspaceCategories(guild.id) : new Map<string, string>();

    if (existingCategories.size === 0) {
        return { embeds: [], components: [] };
    }

    // CDP 稼働中のワークスペース名を取得（バッジ表示用）
    // 動的ポートも含めてスキャンするため ctx.cdp からポート一覧を取得
    let runningWsNames = new Set<string>();
    try {
        const ports = ctx.cdp?.getPorts();
        const instances = await CdpBridge.discoverInstances(ports);
        for (const inst of instances) {
            runningWsNames.add(CdpBridge.extractWorkspaceName(inst.title));
        }
    } catch { /* CDP 未接続でもカテゴリー一覧は表示 */ }

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
            // フォールバック 1: カテゴリーの createdTimestamp
            if (latestTs === 0) {
                const cat = guild.channels.cache.get(catId);
                if (cat?.createdTimestamp) {
                    latestTs = cat.createdTimestamp;
                }
            }
            // フォールバック 2: カテゴリー ID の Snowflake タイムスタンプ
            // (createdTimestamp がキャッシュ未取得等で利用できない場合)
            if (latestTs === 0) {
                latestTs = snowflakeToTimestamp(catId);
            }
        }
        categories.push({ wsName, categoryId: catId, lastActivity: latestTs });
    }

    const embed = new EmbedBuilder()
        .setTitle('📁 ワークスペースカテゴリー')
        .setDescription(`${categories.length}件`)
        .setColor(0x5865F2)
        .setTimestamp();

    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    for (const [i, cat] of categories.entries()) {
        const daysAgo = cat.lastActivity > 0
            ? Math.floor((Date.now() - cat.lastActivity) / (24 * 60 * 60 * 1000))
            : -1;
        const lastActivityStr = daysAgo >= 0 ? `${daysAgo}日前` : '不明';

        const cdpBadge = runningWsNames.has(cat.wsName) ? '🟢' : '⚪';
        embed.addFields({
            name: `${cdpBadge} ${i + 1}. ${cat.wsName}`,
            value: `最終使用: ${lastActivityStr}`,
        });

        if (components.length < 4) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`ws_delete:${cat.categoryId}:${cat.wsName}`)
                    .setLabel(`🗑️ ${cat.wsName.substring(0, 20)}カテゴリを削除`)
                    .setStyle(ButtonStyle.Danger),
            );
            components.push(row);
        }
    }

    if (components.length < 5) {
        const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId('ws_refresh')
                .setLabel('🔄 更新')
                .setStyle(ButtonStyle.Secondary),
        );
        components.push(refreshRow);
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
                    await interaction.reply({ embeds: [buildEmbed('⚠️ 更新に失敗しました。もう一度お試しください。', EmbedColor.Warning)], ephemeral: true });
                }
            } catch { /* interaction may have already expired */ }
        }
        return true;
    }

    // ----- ws_delete -----
    if (customId.startsWith('ws_delete:')) {
        const parts = customId.split(':');
        const categoryId = parts[1];
        const wsName = parts.slice(2).join(':');
        if (!ctx.bot) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bot が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
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
                    ephemeral: true,
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
            ephemeral: true,
        });
        return true;
    }

    // ----- ws_delete_confirm -----
    if (customId.startsWith('ws_delete_confirm:')) {
        const parts = customId.split(':');
        const categoryId = parts[1];
        const wsName = parts.slice(2).join(':');
        if (!ctx.bot) {
            await interaction.reply({ embeds: [buildEmbed('⚠️ Bot が初期化されていません。', EmbedColor.Warning)], ephemeral: true });
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
