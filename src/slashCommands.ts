// ---------------------------------------------------------------------------
// slashCommands.ts — スラッシュコマンド定義 & ギルドコマンド登録
// ---------------------------------------------------------------------------

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { logDebug, logError } from './logger';
import { t } from './i18n';

// -----------------------------------------------------------------------
// コマンド定義
// -----------------------------------------------------------------------

export const slashCommandDefinitions = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription(t('command.status.desc')),

    new SlashCommandBuilder()
        .setName('schedules')
        .setDescription(t('command.schedules.desc')),

    new SlashCommandBuilder()
        .setName('cancel')
        .setDescription(t('command.cancel.desc')),

    new SlashCommandBuilder()
        .setName('newchat')
        .setDescription(t('command.newchat.desc')),

    new SlashCommandBuilder()
        .setName('workspace')
        .setDescription(t('command.workspace.desc')),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription(t('command.queue.desc')),

    new SlashCommandBuilder()
        .setName('template')
        .setDescription(t('command.template.desc')),

    new SlashCommandBuilder()
        .setName('model')
        .setDescription(t('command.model.desc')),

    new SlashCommandBuilder()
        .setName('mode')
        .setDescription(t('command.mode.desc')),

    new SlashCommandBuilder()
        .setName('history')
        .setDescription(t('command.history.desc')),

    new SlashCommandBuilder()
        .setName('suggest')
        .setDescription(t('command.suggest.desc')),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription(t('command.help.desc')),

    new SlashCommandBuilder()
        .setName('pro')
        .setDescription(t('command.pro.desc')),

    new SlashCommandBuilder()
        .setName('screenshot')
        .setDescription(t('command.screenshot.desc')),

    new SlashCommandBuilder()
        .setName('soul')
        .setDescription(t('command.soul.desc')),

    new SlashCommandBuilder()
        .setName('subagent')
        .setDescription(t('command.subagent.desc')),


    // /team — エージェントチームモード管理
    new SlashCommandBuilder()
        .setName('team')
        .setDescription(t('command.team.desc')),


];

// -----------------------------------------------------------------------
// ギルドコマンド登録
// -----------------------------------------------------------------------

/**
 * ギルドコマンドとして登録する（即時反映）。
 * Bot 起動時に毎回呼んでも冪等。
 */
export async function registerGuildCommands(
    token: string,
    clientId: string,
    guildId: string,
): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(token);
    const body = slashCommandDefinitions.map(c => c.toJSON());

    try {
        logDebug(`SlashCommands: registering ${body.length} guild commands for guild ${guildId}...`);
        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body },
        );
        logDebug('SlashCommands: guild commands registered successfully');
    } catch (e) {
        logError('SlashCommands: failed to register guild commands', e);
        throw e;
    }
}
