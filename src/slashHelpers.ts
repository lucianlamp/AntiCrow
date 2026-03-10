// ---------------------------------------------------------------------------
// slashHelpers.ts — slashHandler から分離されたヘルパー関数群
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { logDebug, logError } from './logger';
import { BridgeContext } from './bridgeContext';
import { resolveWorkspaceFromChannel } from './discordChannels';
import type { TextChannel, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';

// ---------------------------------------------------------------------------
// モジュール状態
// ---------------------------------------------------------------------------

/** チャンネルごとの保留中リネームタイマー */
const pendingRenames = new Map<string, { timer: NodeJS.Timeout; newName: string }>();

// ---------------------------------------------------------------------------
// ヘルパー関数
// ---------------------------------------------------------------------------

/**
 * チャンネルリネームをデバウンスして実行する。
 */
export function debouncedRename(ctx: BridgeContext, channelId: string, newName: string): void {
    const existing = pendingRenames.get(channelId);
    if (existing) {
        clearTimeout(existing.timer);
        logDebug(`debouncedRename: cancelled pending rename for ${channelId}, replacing with "${newName}"`);
    }

    const timer = setTimeout(async () => {
        pendingRenames.delete(channelId);
        if (ctx.bot) {
            try {
                await ctx.bot.renamePlanChannel(channelId, newName);
            } catch (e) {
                logError(`debouncedRename: failed to rename channel ${channelId}`, e);
            }
        }
    }, 2000);

    pendingRenames.set(channelId, { timer, newName });
    logDebug(`debouncedRename: scheduled rename for ${channelId} → "${newName}" (2s delay)`);
}

/**
 * インタラクションの Discord チャンネルカテゴリからワークスペース名を解決し、
 * 対応する repoRoot パスを返すヘルパー。
 * フォールバックとして workspaceFolders[0] を返す。
 */
export function resolveRepoRootFromInteraction(
    interaction: { channel: unknown },
    cdpPool?: import('./cdpPool').CdpPool | null,
): { repoRoot: string | undefined; wsName: string | null } {
    const channel = interaction.channel;
    let wsName: string | null = null;
    if (channel && typeof channel === 'object' && 'parent' in channel) {
        wsName = resolveWorkspaceFromChannel(channel as TextChannel);
    }
    if (wsName) {
        const wsPaths = cdpPool?.getResolvedWorkspacePaths() ?? {};
        if (wsPaths[wsName]) {
            return { repoRoot: wsPaths[wsName], wsName };
        }
    }
    return { repoRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, wsName };
}

/**
 * チャンネルカテゴリーから対象ワークスペースを解決し、
 * cdpPool から正しい CdpBridge を取得する共通ヘルパー。
 * フォールバックとして ctx.cdp（デフォルト）を返す。
 *
 * ChatInputCommandInteraction（スラッシュコマンド）と
 * ButtonInteraction（ボタン）の両方に対応。
 */
export function resolveTargetCdp(
    ctx: BridgeContext,
    interaction: ChatInputCommandInteraction | ButtonInteraction,
): { cdp: BridgeContext['cdp']; wsKey: string | null } {
    const channel = interaction.channel as TextChannel | null;
    const wsKey = channel ? resolveWorkspaceFromChannel(channel) : null;
    let cdp = ctx.cdp;
    if (wsKey && ctx.cdpPool) {
        const poolCdp = ctx.cdpPool.getActive(wsKey);
        if (poolCdp) {
            cdp = poolCdp;
            logDebug(`resolveTargetCdp: using cdpPool for workspace "${wsKey}"`);
        } else {
            logDebug(`resolveTargetCdp: cdp for workspace "${wsKey}" not active, fallback to default`);
        }
    }
    return { cdp, wsKey };
}
