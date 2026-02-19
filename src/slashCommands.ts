// ---------------------------------------------------------------------------
// slashCommands.ts — スラッシュコマンド定義 & ギルドコマンド登録
// ---------------------------------------------------------------------------

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { logInfo, logError } from './logger';

// -----------------------------------------------------------------------
// コマンド定義
// -----------------------------------------------------------------------

export const slashCommandDefinitions = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Bridge の状態を表示'),

    new SlashCommandBuilder()
        .setName('schedules')
        .setDescription('インタラクティブなスケジュール管理パネルを表示'),

    new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('実行中のタスクをキャンセル'),

    new SlashCommandBuilder()
        .setName('newchat')
        .setDescription('Antigravity で新しいチャットを開く (Ctrl+Shift+L)'),

    new SlashCommandBuilder()
        .setName('workspaces')
        .setDescription('検出された Antigravity ワークスペース一覧を表示'),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('実行キューの状態を表示'),

    new SlashCommandBuilder()
        .setName('templates')
        .setDescription('テンプレート一覧を表示・管理'),

    new SlashCommandBuilder()
        .setName('models')
        .setDescription('利用可能な AI モデル一覧を表示・切り替え'),

    new SlashCommandBuilder()
        .setName('mode')
        .setDescription('AI モード切替（Planning / Fast）'),

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
        logInfo(`SlashCommands: registering ${body.length} guild commands for guild ${guildId}...`);
        await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body },
        );
        logInfo('SlashCommands: guild commands registered successfully');
    } catch (e) {
        logError('SlashCommands: failed to register guild commands', e);
        throw e;
    }
}
