// ---------------------------------------------------------------------------
// workspaceResolver.ts — ワークスペース自動切替・自動起動
// ---------------------------------------------------------------------------
// messageHandler.ts の handleDiscordMessage() から分離。
// CDP ターゲットの検出・切替・自動起動ロジックを集約。
// ---------------------------------------------------------------------------

import { TextChannel } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { FileIpc } from './fileIpc';
import { AntigravityLaunchError } from './errors';
import { getCdpPorts, getWorkspacePaths } from './configHelper';
import { logDebug, logWarn } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { t } from './i18n';

export interface ResolveResult {
    /** 使用する CdpBridge インスタンス */
    cdp: CdpBridge;
    /** 自動起動が発生したか */
    autoLaunched: boolean;
}

/**
 * ワークスペースカテゴリーに対応する CDP ターゲットを解決する。
 * 必要に応じてインスタンスの自動起動・切替を行う。
 *
 * @param activeCdp   現在の CdpBridge インスタンス
 * @param wsName      ターゲットワークスペース名（null なら切替不要）
 * @param channel     Discord テキストチャンネル（フィードバック送信用）
 * @param fileIpc     FileIpc インスタンス（ストレージパス取得用）
 * @returns 解決結果。失敗時は null。
 */
export async function resolveWorkspace(
    activeCdp: CdpBridge,
    wsName: string | null,
    channel: TextChannel,
    fileIpc: FileIpc,
): Promise<ResolveResult | null> {
    // ワークスペース名が不明、または既に正しいワークスペースに接続中
    if (!wsName) {
        return { cdp: activeCdp, autoLaunched: false };
    }

    const currentWs = activeCdp.getActiveWorkspaceName();
    logDebug(`workspaceResolver: currentWs=${currentWs || '(null)'}, target=${wsName}`);

    if (currentWs === wsName) {
        return { cdp: activeCdp, autoLaunched: false };
    }

    // 別ワークスペースへの切替が必要
    logDebug(`workspaceResolver: auto-switching "${currentWs}" → "${wsName}"`);
    let autoLaunched = false;

    try {
        const cdpPorts = activeCdp.getPorts();
        let instances = await CdpBridge.discoverInstances(cdpPorts);
        const instancesLog = instances.map(i =>
            `"${i.title}" (port=${i.port}, ws=${CdpBridge.extractWorkspaceName(i.title)})`
        ).join(', ');
        logDebug(`workspaceResolver: discoverInstances found ${instances.length} instance(s): ${instancesLog}`);

        let target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsName);
        logDebug(`workspaceResolver: workspace match for "${wsName}": ${target ? `found id=${target.id}` : 'NOT FOUND'}`);

        // ワークスペースが見つからない場合、workspacePaths 設定から自動起動
        if (!target) {
            const wsPaths = getWorkspacePaths();
            const folderPath = wsPaths[wsName];
            logDebug(`workspaceResolver: workspacePaths keys=${JSON.stringify(Object.keys(wsPaths))}, folderPath for "${wsName}"=${folderPath || '(not found)'}`);

            if (folderPath) {
                logDebug(`workspaceResolver: workspace "${wsName}" not found, auto-opening folder "${folderPath}"...`);
                await channel.send({ embeds: [buildEmbed(t('wsResolver.launching', wsName), EmbedColor.Info)] });
                try {
                    await activeCdp.launchAntigravity(folderPath);
                    const maxWaitMs = 30_000;
                    const pollMs = 2_000;
                    const deadline = Date.now() + maxWaitMs;
                    let pollCount = 0;
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, pollMs));
                        // ポートファイルを再読取して新インスタンスのランダムポートを検出
                        const freshPorts = getCdpPorts(fileIpc.getStoragePath());
                        instances = await CdpBridge.discoverInstances(freshPorts);
                        target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsName);
                        pollCount++;
                        if (target) { break; }
                        logDebug(`workspaceResolver: polling for workspace "${wsName}"... (${pollCount})`);
                    }
                    if (target) {
                        autoLaunched = true;
                        logDebug(`workspaceResolver: auto-launched workspace found (id=${target.id}), waiting for UI init...`);
                    } else {
                        logWarn(`workspaceResolver: workspace not found after ${pollCount} polls`);
                    }
                } catch (autoOpenErr) {
                    const errMsg = autoOpenErr instanceof Error ? autoOpenErr.message : String(autoOpenErr);
                    logWarn(`workspaceResolver: auto-open failed — ${errMsg}`);
                    await channel.send({ embeds: [buildEmbed(t('wsResolver.launchFailed', errMsg), EmbedColor.Warning)] });
                    // AntigravityLaunchError として再分類
                    if (!(autoOpenErr instanceof AntigravityLaunchError)) {
                        logDebug(`workspaceResolver: wrapping error as AntigravityLaunchError`);
                    }
                }
            } else {
                logDebug(`workspaceResolver: workspace "${wsName}" not found, no folderPath configured, trying ensureConnected...`);
                try {
                    await activeCdp.ensureConnected();
                    instances = await CdpBridge.discoverInstances(cdpPorts);
                    target = instances.find(i => CdpBridge.extractWorkspaceName(i.title) === wsName);
                } catch (autoLaunchErr) {
                    logWarn(`workspaceResolver: auto-launch failed — ${autoLaunchErr instanceof Error ? autoLaunchErr.message : autoLaunchErr}`);
                }
            }
        }

        if (target) {
            await activeCdp.switchTarget(target.id);
            logDebug(`workspaceResolver: switched to workspace "${wsName}" (id=${target.id})`);
            return { cdp: activeCdp, autoLaunched };
        } else {
            logWarn(`workspaceResolver: workspace "${wsName}" not found even after auto-open`);
            const wsPaths = getWorkspacePaths();
            if (!wsPaths[wsName]) {
                await channel.send({ embeds: [buildEmbed(t('wsResolver.pathNotSet', wsName), EmbedColor.Warning)] });
            } else {
                await channel.send({ embeds: [buildEmbed(t('wsResolver.launchButNoConnect', wsName), EmbedColor.Warning)] });
            }
            return null;
        }
    } catch (e) {
        logWarn(`workspaceResolver: auto-switch to workspace "${wsName}" failed: ${e instanceof Error ? e.message : e}`);
        return { cdp: activeCdp, autoLaunched: false };
    }
}
