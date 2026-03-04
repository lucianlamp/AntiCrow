// ---------------------------------------------------------------------------
// cdpWindowManager.ts — ウィンドウ制御・ポート管理ロジック
// ---------------------------------------------------------------------------
// cdpBridge.ts から分離。closeWindow / minimizeWindow / findFreePort / isPortInUse
// の実装をヘルパー関数として提供。
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as net from 'net';
import { logDebug, logError, logWarn } from './logger';
import { CdpConnection } from './cdpConnection';
import {
    DiscoveredInstance,
    discoverInstances,
    extractWorkspaceName,
} from './cdpTargets';

// ---------------------------------------------------------------------------
// ポート管理
// ---------------------------------------------------------------------------

/**
 * ポート範囲から空きポートを探す。
 * 全ポートを並列に TCP チェックし、最初の空きポートを返す。
 */
export async function findFreePort(ports: number[]): Promise<number> {
    const results = await Promise.allSettled(
        ports.map(async (port) => ({
            port,
            inUse: await isPortInUse(port),
        })),
    );
    for (const result of results) {
        if (result.status === 'fulfilled' && !result.value.inUse) {
            logDebug(`CDP: found free port ${result.value.port} for launch`);
            return result.value.port;
        }
    }
    // 全ポートが使用中の場合はデフォルトの最初のポートで試行
    logWarn(`CDP: all ports in range are in use, falling back to ${ports[0]}`);
    return ports[0];
}

/** ポートが使用中かどうかを TCP 接続でチェックする */
export function isPortInUse(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();
        socket.setTimeout(300);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);  // 接続成功 = 使用中
        });
        socket.once('error', () => {
            socket.destroy();
            resolve(false); // 接続失敗 = 空き
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false); // タイムアウト = 空き
        });
        socket.connect(port, '127.0.0.1');
    });
}

// ---------------------------------------------------------------------------
// closeWindow
// ---------------------------------------------------------------------------

/**
 * 指定ワークスペース名の Antigravity ウィンドウを閉じる。
 * VSCode API の workbench.action.closeWindow を CDP 経由で実行する。
 *
 * メインウィンドウ（現在接続中のターゲット）は閉じないようガードする。
 * 一時的な CdpConnection を作成して実行するため、現在の接続には影響しない。
 *
 * @param conn 現在のメイン CdpConnection（メインウィンドウの判定に使用）
 * @param ports CDP ポート一覧
 * @param workspaceName 閉じたいウィンドウのワークスペース名
 * @returns true: ウィンドウを閉じた, false: ターゲットが見つからない or 失敗
 */
export async function closeWindow(
    conn: CdpConnection,
    ports: number[],
    workspaceName: string,
): Promise<boolean> {
    logDebug(`[closeWindow] ワークスペース "${workspaceName}" のウィンドウを閉じます`);

    try {
        // 1. 全ターゲットを取得
        const instances = await discoverInstances(ports);
        if (instances.length === 0) {
            logWarn('[closeWindow] ターゲットが見つかりませんでした');
            return false;
        }

        // 2. ワークスペース名でマッチング（matchesSubagent と同等の4戦略）
        let targetInstance: DiscoveredInstance | undefined;
        for (const inst of instances) {
            const wsName = extractWorkspaceName(inst.title);
            const matches =
                wsName === workspaceName ||
                inst.title.includes(workspaceName) ||
                inst.title.includes(path.basename(workspaceName));
            if (matches) {
                targetInstance = inst;
                logDebug(`[closeWindow] マッチ: wsName="${wsName}", title="${inst.title.substring(0, 80)}"`);
                break;
            }
        }

        if (!targetInstance) {
            logWarn(`[closeWindow] ワークスペース "${workspaceName}" のターゲットが見つかりませんでした`);
            logDebug(`[closeWindow] 利用可能なターゲット: ${instances.map(i => `"${extractWorkspaceName(i.title) || i.title}"`).join(', ')}`);
            return false;
        }

        // 3. メインウィンドウ（現在接続中）を閉じないようガード
        const currentWsName = conn ? extractWorkspaceName(conn.getActiveTargetTitle() ?? '') : null;
        if (currentWsName === workspaceName) {
            logWarn(`[closeWindow] ワークスペース "${workspaceName}" はメインウィンドウです。閉じません`);
            return false;
        }

        logDebug(`[closeWindow] ターゲット発見: "${targetInstance.title}" (${targetInstance.wsUrl})`);

        // 4. 一時的な CdpConnection を作成して接続
        const tempConn = new CdpConnection(ports);
        try {
            await tempConn.connectToUrl(targetInstance.wsUrl);
            logDebug('[closeWindow] 一時接続に成功');

            // 5a. window.close() でウィンドウを閉じる（第一優先）
            let closed = false;
            try {
                const evalJs = `
                    (async () => {
                        try {
                            window.close();
                            return { success: true, method: 'window.close' };
                        } catch (e) {
                            return { success: false, error: String(e) };
                        }
                    })()
                `;
                const result = await tempConn.evaluate(evalJs);
                logDebug(`[closeWindow] window.close() 結果: ${JSON.stringify(result)}`);
                closed = true;
            } catch (err) {
                logDebug(`[closeWindow] window.close() 失敗: ${err}`);
            }

            // 5b. フォールバック: process.exit(0)
            if (!closed) {
                try {
                    await tempConn.evaluate('process.exit(0)');
                    logDebug('[closeWindow] process.exit(0) で終了');
                    closed = true;
                } catch {
                    // process.exit() は接続切断を引き起こすため、エラーは想定内
                    logDebug('[closeWindow] process.exit(0) 実行（接続切断は想定内）');
                    closed = true;
                }
            }

            // 5c. フォールバック: Browser.close CDP コマンド
            if (!closed) {
                try {
                    await tempConn.send('Browser.close', {});
                    logDebug('[closeWindow] Browser.close で終了');
                    closed = true;
                } catch (err) {
                    logDebug(`[closeWindow] Browser.close 失敗: ${err}`);
                }
            }

            // 6. ウィンドウが閉じてファイルロックが解放されるのを待つ
            await new Promise(resolve => setTimeout(resolve, 5000));

            // 7. ウィンドウが本当に閉じたか確認
            try {
                const remainingInstances = await discoverInstances(ports);
                const stillExists = remainingInstances.some(inst => {
                    const wsName = extractWorkspaceName(inst.title);
                    return wsName === workspaceName ||
                        inst.title.includes(workspaceName);
                });
                if (stillExists) {
                    logWarn(`[closeWindow] ワークスペース "${workspaceName}" のウィンドウがまだ存在しています`);
                    return false;
                }
            } catch {
                // 確認失敗は無視（ウィンドウは閉じている可能性が高い）
            }

            logDebug(`[closeWindow] ワークスペース "${workspaceName}" のウィンドウを閉じました`);
            return true;
        } finally {
            // 一時接続を確実にクリーンアップ
            try {
                tempConn.fullDisconnect();
            } catch {
                // disconnect エラーは無視
            }
        }
    } catch (err) {
        logError(`[closeWindow] エラー: ${err}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// minimizeWindow
// ---------------------------------------------------------------------------

/**
 * サブエージェントのウィンドウを最小化する。
 *
 * CDP の Browser.getWindowForTarget → Browser.setWindowBounds を使用。
 * 一時的な CdpConnection を作成して実行するため、現在の接続には影響しない。
 * ベストエフォート：失敗しても例外をスローしない。
 *
 * @param ports CDP ポート一覧
 * @param workspaceName 最小化したいウィンドウのワークスペース名
 * @returns true: 最小化成功, false: 失敗
 */
export async function minimizeWindow(
    ports: number[],
    workspaceName: string,
): Promise<boolean> {
    logDebug(`[minimizeWindow] ワークスペース "${workspaceName}" のウィンドウを最小化します`);

    try {
        // 1. 全ターゲットを取得
        const instances = await discoverInstances(ports);
        if (instances.length === 0) {
            logWarn('[minimizeWindow] ターゲットが見つかりませんでした');
            return false;
        }

        // 2. ワークスペース名でマッチング
        let targetInstance: DiscoveredInstance | undefined;
        for (const inst of instances) {
            const wsName = extractWorkspaceName(inst.title);
            if (wsName === workspaceName) {
                targetInstance = inst;
                break;
            }
        }

        if (!targetInstance) {
            logWarn(`[minimizeWindow] ワークスペース "${workspaceName}" のターゲットが見つかりませんでした`);
            return false;
        }

        logDebug(`[minimizeWindow] ターゲット発見: "${targetInstance.title}" (${targetInstance.wsUrl})`);

        // 3. 一時的な CdpConnection を作成して接続
        const tempConn = new CdpConnection(ports);
        try {
            await tempConn.connectToUrl(targetInstance.wsUrl);
            logDebug('[minimizeWindow] 一時接続に成功');

            // 4. Browser.getWindowForTarget でウィンドウIDを取得
            let windowId: number | undefined;
            try {
                const windowResult = await tempConn.send('Browser.getWindowForTarget', {
                    targetId: targetInstance.id,
                }) as { windowId?: number; bounds?: unknown };
                windowId = windowResult?.windowId;
                logDebug(`[minimizeWindow] windowId=${windowId}`);
            } catch (err) {
                logDebug(`[minimizeWindow] Browser.getWindowForTarget 失敗: ${err}`);
            }

            if (windowId !== undefined) {
                // 5a. Browser.setWindowBounds で最小化
                try {
                    await tempConn.send('Browser.setWindowBounds', {
                        windowId,
                        bounds: { windowState: 'minimized' },
                    });
                    logDebug(`[minimizeWindow] ワークスペース "${workspaceName}" のウィンドウを最小化しました (CDP)`);
                    return true;
                } catch (err) {
                    logDebug(`[minimizeWindow] Browser.setWindowBounds 失敗: ${err}`);
                }
            }

            // 5b. フォールバック: Electron の BrowserWindow API を使用
            const evalJs = `
                (function() {
                    try {
                        // Electron の BrowserWindow.getFocusedWindow() or getAllWindows()
                        var electron = require('electron');
                        if (electron && electron.remote) {
                            var win = electron.remote.getCurrentWindow();
                            if (win) {
                                win.minimize();
                                return { success: true, method: 'electron.remote' };
                            }
                        }
                    } catch(e) {}
                    try {
                        // process.mainModule 経由
                        var mainModule = process.mainModule || require.main;
                        if (mainModule) {
                            var BrowserWindow = mainModule.require('electron').BrowserWindow;
                            var wins = BrowserWindow.getAllWindows();
                            if (wins && wins.length > 0) {
                                wins[0].minimize();
                                return { success: true, method: 'BrowserWindow.getAllWindows' };
                            }
                        }
                    } catch(e2) {}
                    return { success: false, error: 'No minimize method available' };
                })()
            `;

            const result = await tempConn.evaluate(evalJs);
            const resultObj = result as { success?: boolean; method?: string; error?: string } | null;
            logDebug(`[minimizeWindow] フォールバック結果: ${JSON.stringify(result)}`);

            if (resultObj?.success) {
                logDebug(`[minimizeWindow] ワークスペース "${workspaceName}" のウィンドウを最小化しました (${resultObj.method})`);
                return true;
            }

            logWarn(`[minimizeWindow] ワークスペース "${workspaceName}" のウィンドウを最小化できませんでした`);
            return false;
        } finally {
            try {
                tempConn.fullDisconnect();
            } catch {
                // disconnect エラーは無視
            }
        }
    } catch (err) {
        logWarn(`[minimizeWindow] エラー: ${err}`);
        return false;
    }
}
