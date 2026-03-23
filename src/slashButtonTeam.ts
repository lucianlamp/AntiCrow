// ---------------------------------------------------------------------------
// slashButtonTeam.ts — チーム・サブエージェント関連ボタンインタラクションハンドラ
// ---------------------------------------------------------------------------

import {
    ButtonInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';


import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';
import { loadTeamConfig, saveTeamConfig } from './teamConfig';
import { BridgeContext } from './bridgeContext';
import { resolveRepoRootFromInteraction } from './slashHelpers';
import * as path from 'path';

// ---------------------------------------------------------------------------
// チームモードボタンパネル構築ヘルパー
// ---------------------------------------------------------------------------

export function buildTeamButtons(config: import('./teamConfig').TeamConfig): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('team_on')
            .setLabel(t('btnTeam.teamOn'))
            .setStyle(config.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_off')
            .setLabel(t('btnTeam.teamOff'))
            .setStyle(!config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('team_status')
            .setLabel(t('btnTeam.status'))
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('team_config')
            .setLabel(t('btnTeam.config'))
            .setStyle(ButtonStyle.Secondary),
    );
    return [row];
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
    // subagent_* ボタンも処理する
    if (customId.startsWith('subagent_')) {
        return handleSubagentButton(ctx, interaction, customId);
    }

    if (!customId.startsWith('team_')) { return false; }

    const teamAction = customId.replace('team_', '');
    const { repoRoot } = resolveRepoRootFromInteraction(interaction, ctx.cdpPool);
    if (!repoRoot) {
        await interaction.reply({ embeds: [buildEmbed(t('btnTeam.wsNotFound'), EmbedColor.Warning)] });
        return true;
    }
    const config = loadTeamConfig(repoRoot);
    const wsName = path.basename(repoRoot);
    const agentCount = ctx.subagentManager?.list(wsName).length ?? 0;

    switch (teamAction) {
        case 'on': {
            config.enabled = true;
            saveTeamConfig(repoRoot, config);
            await interaction.update({
                embeds: [buildEmbed(t('btnTeam.teamEnabled'), EmbedColor.Success)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        case 'off': {
            config.enabled = false;
            saveTeamConfig(repoRoot, config);
            if (ctx.subagentManager) {
                const agents = ctx.subagentManager.list(wsName);
                for (const agent of agents) {
                    try { await ctx.subagentManager.killAgent(agent.name); } catch { /* skip */ }
                }
            }
            await interaction.update({
                embeds: [buildEmbed(t('btnTeam.teamDisabled'), EmbedColor.Info)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        case 'status': {
            const statusEmoji = config.enabled ? '🟢' : '🔴';
            const statusText = config.enabled ? 'ON' : 'OFF';
            let desc = `${statusEmoji} **${t('btnTeam.teamMode')}: ${statusText}**\n\n`
                + `📊 **${t('btnTeam.running')}**: ${agentCount} / ${config.maxAgents}\n`
                + `⏱️ **${t('btnTeam.timeout')}**: ${Math.round(config.responseTimeoutMs / 60_000)}${t('btnTeam.minutes')}`;
            if (agentCount > 0 && ctx.subagentManager) {
                const agents = ctx.subagentManager.list(wsName);
                desc += `\n\n🤖 **${t('btnTeam.agentList')}**\n` + agents.map(a => `  • **${a.name}** — ${a.state}`).join('\n');
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
                embeds: [buildEmbed(`⚙️ **${t('btnTeam.teamConfig')}**\n\`\`\`json\n${configJson}\n\`\`\``, EmbedColor.Info)],
                components: buildTeamButtons(config) as any,
            });
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// サブエージェント管理ボタンハンドラ（admin パネル用）
// ---------------------------------------------------------------------------

async function handleSubagentButton(
    ctx: BridgeContext,
    interaction: ButtonInteraction,
    customId: string,
): Promise<boolean> {
    if (!ctx.subagentManager) {
        await interaction.reply({ embeds: [buildEmbed('⚠️ SubagentManager が初期化されていません', EmbedColor.Warning)] });
        return true;
    }

    // WS を特定（チャンネルカテゴリーから解決）
    const { repoRoot } = resolveRepoRootFromInteraction(interaction, ctx.cdpPool);
    const wsName = repoRoot ? path.basename(repoRoot) : undefined;

    switch (customId) {
        case 'subagent_killall': {
            if (wsName) {
                // WS 別フィルタ: 該当 WS のエージェントのみ kill
                const agents = ctx.subagentManager.list(wsName);
                if (agents.length === 0) {
                    await interaction.reply({ embeds: [buildEmbed(`ℹ️ **${wsName}** に実行中のサブエージェントはありません`, EmbedColor.Info)] });
                    return true;
                }
                let killed = 0;
                for (const agent of agents) {
                    try {
                        await ctx.subagentManager.killAgent(agent.name);
                        killed++;
                    } catch { /* skip */ }
                }
                await interaction.reply({ embeds: [buildEmbed(`🛑 **${wsName}** のサブエージェントを ${killed}/${agents.length} 件停止しました`, EmbedColor.Warning)] });
            } else {
                // WS 特定不能: 後方互換として全エージェント kill
                await ctx.subagentManager.killAll();
                await interaction.reply({ embeds: [buildEmbed('🛑 全サブエージェントを停止しました', EmbedColor.Warning)] });
            }
            return true;
        }
        case 'subagent_list': {
            const agents = wsName
                ? ctx.subagentManager.list(wsName)
                : ctx.subagentManager.list();
            if (agents.length === 0) {
                const scope = wsName ? `**${wsName}** に` : '';
                await interaction.reply({ embeds: [buildEmbed(`ℹ️ ${scope}実行中のサブエージェントはありません`, EmbedColor.Info)] });
                return true;
            }
            const scope = wsName ? ` (${wsName})` : '';
            const desc = `🤖 **サブエージェント一覧${scope}**\n\n`
                + agents.map(a => `• **${a.name}** — ${a.state}`).join('\n');
            await interaction.reply({ embeds: [buildEmbed(desc, EmbedColor.Info)] });
            return true;
        }
        case 'subagent_spawn': {
            // サブエージェントのスポーンは TeamOrchestrator 経由で行われるため、
            // ボタンからの直接スポーンは現時点では未対応
            await interaction.reply({ embeds: [buildEmbed('ℹ️ サブエージェントの起動はチームモードのタスク実行時に自動で行われます', EmbedColor.Info)] });
            return true;
        }
        default:
            return false;
    }
}
