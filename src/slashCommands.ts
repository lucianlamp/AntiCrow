// ---------------------------------------------------------------------------
// slashCommands.ts — スラッシュコマンド定義 & ギルドコマンド登録
// ---------------------------------------------------------------------------

import { SlashCommandBuilder, REST, Routes } from 'discord.js';
import { logDebug, logError } from './logger';

// -----------------------------------------------------------------------
// コマンド定義
// -----------------------------------------------------------------------

export const slashCommandDefinitions = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Bot・接続・キュー状態を一覧表示'),

    new SlashCommandBuilder()
        .setName('schedules')
        .setDescription('定期実行の一覧・管理パネルを表示'),

    new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('実行中のタスクをキャンセル'),

    new SlashCommandBuilder()
        .setName('newchat')
        .setDescription('Antigravity で新しいチャットセッションを開始'),

    new SlashCommandBuilder()
        .setName('workspace')
        .setDescription('検出された Antigravity ワークスペース一覧を表示'),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('メッセージ処理キュー・実行キューの詳細を表示'),

    new SlashCommandBuilder()
        .setName('template')
        .setDescription('テンプレート一覧を表示・管理'),

    new SlashCommandBuilder()
        .setName('model')
        .setDescription('利用可能な AI モデル一覧を表示・切り替え'),

    new SlashCommandBuilder()
        .setName('mode')
        .setDescription('AI モード切替（Planning / Fast）'),

    new SlashCommandBuilder()
        .setName('history')
        .setDescription('Antigravity の会話履歴を表示・切り替え'),

    new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('プロジェクトを分析して次にやることを提案します'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('AntiCrow のコマンド一覧と使い方を表示'),

    new SlashCommandBuilder()
        .setName('pro')
        .setDescription('Pro ライセンスの管理・購入・キー入力'),

    new SlashCommandBuilder()
        .setName('screenshot')
        .setDescription('現在の画面のスクリーンショットを取得します'),

    new SlashCommandBuilder()
        .setName('soul')
        .setDescription('SOUL.md（カスタマイズ設定）を編集します'),

    new SlashCommandBuilder()
        .setName('subagent')
        .setDescription('サブエージェント管理'),


    // /team — エージェントチームモード管理
    new SlashCommandBuilder()
        .setName('team')
        .setDescription('エージェントチームモードの管理'),


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
