// ---------------------------------------------------------------------------
// cdpConnection.ts — CDP WebSocket 接続管理
// ---------------------------------------------------------------------------
// 責務:
//   1. CDP WebSocket の接続・切断ライフサイクル
//   2. CDP コマンド送信 (send) とレスポンス管理
//   3. Runtime.evaluate ヘルパー
//   4. CDP イベントリスナー管理
// ---------------------------------------------------------------------------

import WebSocket from 'ws';
import { logDebug, logError, logWarn } from './logger';
import { CdpConnectionError, CdpCommandError } from './errors';
import {
    CdpTarget,
    DiscoveredInstance,
    discoverInstances,
    findAntigravityTarget,
} from './cdpTargets';

/** CDP コマンド個別タイムアウト (30秒) */
const CDP_COMMAND_TIMEOUT_MS = 30_000;

/** CDP コマンドのコールバック */
interface PendingCallback {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * CDP WebSocket 接続を管理するクラス。
 * ターゲットの発見・スコアリングは cdpTargets.ts に委譲する。
 */
export class CdpConnection {
    private ports: number[];
    private ws: WebSocket | null = null;
    private msgId = 0;
    private pendingCallbacks = new Map<number, PendingCallback>();
    private eventListeners: Array<(method: string, params: unknown) => void> = [];

    // マルチウインドウ対応: アクティブターゲット情報
    private activeTargetId: string | null = null;
    private activeTargetTitle: string | null = null;
    private activeTargetPort: number | null = null;

    constructor(ports: number[]) {
        this.ports = ports;
    }

    // -----------------------------------------------------------------------
    // アクティブターゲット情報
    // -----------------------------------------------------------------------

    getActiveTargetId(): string | null { return this.activeTargetId; }
    getActiveTargetTitle(): string | null { return this.activeTargetTitle; }
    getActiveTargetPort(): number | null { return this.activeTargetPort; }
    getPorts(): number[] { return this.ports; }

    setActiveTarget(id: string | null, title: string | null, port: number | null): void {
        this.activeTargetId = id;
        this.activeTargetTitle = title;
        this.activeTargetPort = port;
    }

    // -----------------------------------------------------------------------
    // WebSocket 接続管理
    // -----------------------------------------------------------------------

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /** WebSocket をターゲットの wsUrl に直接接続する */
    connectToUrl(wsUrl: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                logDebug(`CDP: WebSocket connected to "${this.activeTargetTitle}"`);
                resolve();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleMessage(data);
            });

            this.ws.on('close', () => {
                logWarn('CDP: WebSocket closed');
                this.ws = null;
                // 切断時に未完了のコールバックをすべて reject（デッドロック防止）
                // コピーしてからクリアし、handleMessage とのレースを防止
                if (this.pendingCallbacks.size > 0) {
                    const count = this.pendingCallbacks.size;
                    const callbacks = new Map(this.pendingCallbacks);
                    this.pendingCallbacks.clear();
                    const err = new CdpConnectionError('CDP WebSocket closed unexpectedly', this.activeTargetPort ?? 0);
                    for (const [, cb] of callbacks) {
                        clearTimeout(cb.timer);
                        cb.reject(err);
                    }
                    logWarn(`CDP: rejected ${count} pending callbacks due to close`);
                }
            });

            this.ws.on('error', (err) => {
                logError('CDP: WebSocket error', err);
                reject(new CdpConnectionError(`WebSocket connection failed: ${err.message}`, this.activeTargetPort ?? 0));
            });
        });
    }

    /**
     * CDP 接続を確立する。
     * 以前のアクティブターゲットを優先的に再接続し、なければ自動探索する。
     */
    async connect(): Promise<void> {
        if (this.isConnected()) { return; }

        // switchTarget() で設定された activeTargetId があれば、そのターゲットに再接続を試みる
        let wsUrl: string | null = null;
        if (this.activeTargetId) {
            const instances = await discoverInstances(this.ports);
            const prev = instances.find(i => i.id === this.activeTargetId);
            if (prev) {
                wsUrl = prev.wsUrl;
                this.activeTargetTitle = prev.title;
                this.activeTargetPort = prev.port;
                logDebug(`CDP: reconnecting to previously active target "${prev.title}" (id=${prev.id})`);
            } else {
                logWarn(`CDP: previously active target "${this.activeTargetId}" no longer available, falling back`);
                this.activeTargetId = null;
                this.activeTargetTitle = null;
                this.activeTargetPort = null;
            }
        }

        // activeTargetId が無い（初回接続 or フォールバック）場合は従来の探索
        if (!wsUrl) {
            const found = await findAntigravityTarget(this.ports);
            if (!found) {
                throw new CdpConnectionError(
                    `No Antigravity target found. Is Antigravity running?`,
                    0,
                );
            }
            const { target, port } = found;
            wsUrl = target.webSocketDebuggerUrl;
            this.activeTargetId = target.id;
            this.activeTargetTitle = target.title;
            this.activeTargetPort = port;
        }

        await this.connectToUrl(wsUrl);

        // [Fix: Iframe Delay Issue] 接続成功直後にメインフレームでチャットパネルを強制展開し、iframe の初期化を促す
        try {
            logDebug(`CDP: focusing chat panel to ensure iframe initialization`);
            await this.evaluate(`
            (async () => {
                if (typeof vscode !== 'undefined' && vscode.commands) {
                    await vscode.commands.executeCommand('workbench.panel.chatSidebar.focus');
                }
            })()
        `);
            // パネル展開とiframeのマウントを少し待機
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) {
            logWarn(`CDP: failed to focus chat panel: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** WebSocket を切断する（ターゲット情報は保持） */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /** 完全切断：ターゲット情報もリセットする（Bridge 停止時用） */
    fullDisconnect(): void {
        this.disconnect();
        this.activeTargetId = null;
        this.activeTargetTitle = null;
        this.activeTargetPort = null;
    }

    // -----------------------------------------------------------------------
    // CDP コマンド送信
    // -----------------------------------------------------------------------

    /** CDP コマンド送信 */
    send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new CdpConnectionError('CDP WebSocket is not connected', this.activeTargetPort ?? 0));
                return;
            }

            // msgId オーバーフロー防止: MAX_SAFE_INTEGER に近づいたらリセット
            if (this.msgId >= Number.MAX_SAFE_INTEGER - 1) {
                this.msgId = 0;
            }
            const id = ++this.msgId;

            // 個別コマンドタイムアウト（タイマーハンドルを保持してメモリリーク防止）
            const timer = setTimeout(() => {
                if (this.pendingCallbacks.has(id)) {
                    this.pendingCallbacks.delete(id);
                    reject(new CdpCommandError(`CDP command timeout: ${method}`, method));
                }
            }, CDP_COMMAND_TIMEOUT_MS);

            this.pendingCallbacks.set(id, {
                resolve: (val) => { clearTimeout(timer); resolve(val); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                timer,
            });

            const msg = JSON.stringify({ id, method, params });
            this.ws.send(msg);
        });
    }

    /** Runtime.evaluate のヘルパー（コンテキストID指定可能） */
    async evaluate(expression: string, contextId?: number, returnByValue = true): Promise<unknown> {
        const params: Record<string, unknown> = {
            expression,
            returnByValue,
            awaitPromise: true,
        };
        if (contextId !== undefined) {
            params.contextId = contextId;
        }

        const result = await this.send('Runtime.evaluate', params) as {
            result?: { type?: string; value?: unknown; description?: string; subtype?: string; className?: string };
            exceptionDetails?: unknown;
        };

        // デバッグ: CDP 生レスポンスをログ出力
        logDebug(`CDP evaluate raw: type=${result?.result?.type}, subtype=${result?.result?.subtype}, hasValue=${result?.result?.value !== undefined}, keys=${result ? Object.keys(result).join(',') : 'null'}`);

        if (result?.exceptionDetails) {
            throw new CdpCommandError(
                `CDP evaluate exception: ${JSON.stringify(result.exceptionDetails)}`,
                'Runtime.evaluate',
            );
        }

        // result.result が存在しない or value が取得できない場合の警告
        if (!result?.result) {
            logWarn(`CDP evaluate: result.result is missing. raw=${JSON.stringify(result)}`);
        } else if (result.result.value === undefined && result.result.type === 'object') {
            logWarn(`CDP evaluate: object returned but value is undefined (returnByValue may not have worked). type=${result.result.type}, subtype=${result.result.subtype || 'none'}, description=${result.result.description || 'none'}`);
        }

        return result?.result?.value;
    }

    // -----------------------------------------------------------------------
    // ターゲット切替
    // -----------------------------------------------------------------------

    /**
     * アクティブターゲットを切り替える。
     * 既存接続をクリーンに切断してから新しいターゲットに接続する。
     */
    async switchTarget(targetId: string): Promise<DiscoveredInstance> {
        const instances = await discoverInstances(this.ports);
        const target = instances.find(i => i.id === targetId);

        if (!target) {
            throw new CdpConnectionError(
                `Target "${targetId}" not found. Use /instances to list available targets.`,
                0,
            );
        }

        // 既存接続をクリーンに切断
        this.disconnect();

        // 状態をリセット（タイマーもクリア）
        for (const [, cb] of this.pendingCallbacks) {
            clearTimeout(cb.timer);
        }
        this.msgId = 0;
        this.pendingCallbacks.clear();

        // 新しいターゲットに接続
        this.activeTargetId = target.id;
        this.activeTargetTitle = target.title;
        this.activeTargetPort = target.port;

        await this.connectToUrl(target.wsUrl);
        logDebug(`CDP: switched to target "${target.title}" (id=${target.id}, port=${target.port})`);

        return target;
    }

    // -----------------------------------------------------------------------
    // イベントリスナー
    // -----------------------------------------------------------------------

    /** CDP イベントリスナーを登録する */
    onEvent(listener: (method: string, params: unknown) => void): void {
        this.eventListeners.push(listener);
    }

    /** CDP イベントリスナーをすべて解除 */
    clearEventListeners(): void {
        this.eventListeners = [];
    }

    /** Runtime.enable を有効にし、consoleAPICalled イベントを受信可能にする */
    async enableRuntimeEvents(): Promise<void> {
        await this.send('Runtime.enable', {});
        logDebug('CDP: Runtime.enable done');
    }

    // -----------------------------------------------------------------------
    // 内部ヘルパー
    // -----------------------------------------------------------------------

    /** WebSocket メッセージの処理 */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.id !== undefined && this.pendingCallbacks.has(msg.id)) {
                const cb = this.pendingCallbacks.get(msg.id)!;
                this.pendingCallbacks.delete(msg.id);
                if (msg.error) {
                    cb.reject(new CdpCommandError(`CDP error: ${JSON.stringify(msg.error)}`));
                } else {
                    cb.resolve(msg.result);
                }
            }
            // CDP イベントの通知
            if (msg.method && this.eventListeners.length > 0) {
                for (const listener of this.eventListeners) {
                    try { listener(msg.method, msg.params); } catch (e) { logDebug(`CdpConnection: event listener error: ${e}`); }
                }
            }
        } catch {
            // ignore non-JSON messages
        }
    }
}
