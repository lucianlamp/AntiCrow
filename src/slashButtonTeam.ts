// ---------------------------------------------------------------------------
// slashButtonTeam.ts — チーム・サブエージェント関連ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

import { logDebug, logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { loadTeamConfig, saveTeamConfig } from './teamConfig';
import { BridgeContext } from './bridgeContext';
import { resolveRepoRootFromInteraction } from './slashHelpers';

// ---------------------------------------------------------------------------
// チームモードボタンパネル構築ヘルパー
// ---------------------------------------------------------------------------

export function buildTeamButtons(config: import('./teamConfig').TeamConfig): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('team_on')
            .setLabel('🟢 チームON')
            .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_off')
            .setLabel('🔴 チームOFF')
            .setStyle(!config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_status')
            .setLabel('📊 ステータス')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('team_config')
            .setLabel('⚙️ 設定')
            .setStyle(ButtonStyle.Secondary),
    );
    return [row];
}

// ---------------------------------------------------------------------------
// サブエージェントボタンパネル構築ヘルパー
// ---------------------------------------------------------------------------

export function buildSubagentButtons(agents: { name: string; state: string }[]): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('subagent_spawn')
            .setLabel('🚀 起動')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('subagent_list')
            .setLabel('📋 一覧')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('subagent_killall')
            .setLabel('⏹️ 全停止')
            .setStyle(agents.length > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(agents.length === 0),
    );
    return [row];
}

export function buildSubagentListText(agents: { name: string; state: string }[]): string {
    if (agents.length === 0) {
        return '📋 **サブエージェント管理**\n\n現在実行中のサブエージェントはありません。';
    }
    return `📋 **サブエージェント管理** (${agents.length}件)\n\n`
        + agents.map(a => `  • \`${a.name}\` — ${a.state}`).join('\n');
}

/**
 * チーム関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleTeamButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (!customId.startsWith('team_')) { return false; }

    const teamAction = customId.replace('team_', '');
    const { repoRoot } = resolveRepoRootFromInteraction(interaction, ctx.cdpPool);
    if (!repoRoot) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ ワークスペースが検出されません。', EmbedColor.Warning)] });
        return true;
    }
    const config = loadTeamConfig(repoRoot);
    const agentCount = ctx.subagentManager?.list().length ?? 0;

    switch (teamAction) {
        case 'on': {
            config.enabled = true;
            saveTeamConfig(repoRoot, config);
            await interaction.update({
                embeds: [buildEmbed('🟢 **チームモードを有効化しました！**\n\nメインエージェントが指揮官モードで動作します。', EmbedColor.Success)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        case 'off': {
            config.enabled = false;
            saveTeamConfig(repoRoot, config);
            if (ctx.subagentManager) {
                const agents = ctx.subagentManager.list();
                for (const agent of agents) {
                    try { await ctx.subagentManager.killAgent(agent.name); } catch { /* skip */ }
                }
            }
            await interaction.update({
                embeds: [buildEmbed('🔴 **チームモードを無効化しました。**\n\n全サブエージェントを停止しました。', EmbedColor.Info)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        case 'status': {
            const statusEmoji = config.enabled ? '🟢' : '🔴';
            const statusText = config.enabled ? 'ON' : 'OFF';
            let desc = `${statusEmoji} **エージェントチームモード: ${statusText}**\n\n`
                + `📊 **稼働中**: ${agentCount} / ${config.maxAgents}\n`
                + `⏱️ **タイムアウト**: ${Math.round(config.responseTimeoutMs / 60_000)}分`;
            if (agentCount > 0 && ctx.subagentManager) {
                const agents = ctx.subagentManager.list();
                desc += '\n\n🤖 **サブエージェント一覧**\n' + agents.map(a => `  • **${a.name}** — ${a.state}`).join('\n');
            }
            await interaction.update({
                embeds: [buildEmbed(desc, config.enabled ? EmbedColor.Success : EmbedColor.Info)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        case 'config': {
            const configJson = JSON.stringify(config, null, 2);
            await interaction.update({
                embeds: [buildEmbed(`⚙️ **チーム設定**\n\`\`\`json\n${configJson}\n\`\`\``, EmbedColor.Info)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        default:
            return false;
    }
}

/**
 * サブエージェント関連ボタンを処理する。
 * @returns true: 処理済み, false: 未処理
 */
export async function handleSubagentButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (!customId.startsWith('subagent_')) { return false; }

    const subAction = customId.replace('subagent_', '');
    const mgr = ctx.subagentManager;

    try {
        switch (subAction) {
            case 'spawn': {
                if (!mgr) {
                    await interaction.update({
                        embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                        components: buildSubagentButtons([]) as any,
                    });
                    return true;
                }
                await interaction.deferUpdate();
                const handle = await mgr.spawn();
                const agents = mgr.list();
                await interaction.editReply({
                    embeds: [buildEmbed(
                        `🚀 **サブエージェント \`${handle.name}\` を起動しました！**\n\n`
                        + buildSubagentListText(agents),
                        EmbedColor.Success,
                    )],
                    components: buildSubagentButtons(agents) as any,
                });
                return true;
            }
            case 'list': {
                const agents = mgr?.list() ?? [];
                await interaction.update({
                    embeds: [buildEmbed(buildSubagentListText(agents), EmbedColor.Info)],
                    components: buildSubagentButtons(agents) as any,
                });
                return true;
            }
            case 'killall': {
                if (!mgr) {
                    await interaction.update({
                        embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません。', EmbedColor.Warning)],
                        components: buildSubagentButtons([]) as any,
                    });
                    return true;
                }
                await interaction.deferUpdate();
                await mgr.killAll();
                await interaction.editReply({
                    embeds: [buildEmbed('⏹️ **全サブエージェントを停止しました。**\n\n現在実行中のサブエージェントはありません。', EmbedColor.Success)],
                    components: buildSubagentButtons([]) as any,
                });
                return true;
            }
            default:
                return false;
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError(`subagent button: ${subAction} failed`, e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
                components: buildSubagentButtons(mgr?.list() ?? []) as any,
            }).catch(() => { });
        } else {
            await interaction.update({
                embeds: [buildEmbed(`❌ サブエージェント操作失敗: ${errMsg}`, EmbedColor.Error)],
                components: buildSubagentButtons(mgr?.list() ?? []) as any,
            });
        }
        return true;
    }
}
