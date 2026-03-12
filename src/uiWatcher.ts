// ---------------------------------------------------------------------------
// uiWatcher.ts — UI自動操作ウォッチャー
// ---------------------------------------------------------------------------
// 責務:
//   1. Antigravity UI の自動操作（Continue, Retry 等の自動クリック）
//   2. VSCode コマンドによる自動承認（Agent ステップ承認等）
// executor.ts から分離（改善計画フェーズ3）
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { CdpBridge } from './cdpBridge';
import { logDebug, logInfo } from './logger';
import { isAgentRunning } from './cdpUI';

/** UIウォッチャーのポーリング間隔（ms） */
const UI_WATCHER_INTERVAL_MS = 1_000;


// ---------------------------------------------------------------------------
// UIWatcher クラス
// ---------------------------------------------------------------------------

export class UIWatcher {
    private timer: ReturnType<typeof setInterval> | null = null;
    private cdp: CdpBridge;
    private isProcessing: () => boolean;
    private isProCheck: () => boolean;
    private onAgentStateChange: ((running: boolean) => void) | null = null;
    private lastAgentRunning = false;
    private idleDebounceCount = 0;
    /** autoFollowOutput の連続失敗カウンター */
    private consecutiveErrors = 0;
    /** isAgentRunning の連続失敗カウンター（CDP接続問題の検出用） */
    private agentCheckErrors = 0;
    /** isAgentRunning 連続失敗の警告ログ出力閾値 */
    private static readonly AGENT_CHECK_ERROR_WARN_THRESHOLD = 5;
    /** isAgentRunning 連続失敗の再接続試行閾値 */
    private static readonly AGENT_CHECK_RECONNECT_THRESHOLD = 10;
    /** running → idle 遷移のデバウンス閾値（N回連続 false で idle 確定） */
    private static readonly IDLE_DEBOUNCE_THRESHOLD = 3;
    /** 連続失敗時の警告ログ出力閾値 */
    private static readonly CONSECUTIVE_ERROR_WARN_THRESHOLD = 5;
    /** 連続失敗時の CDP 再接続試行閾値 */
    private static readonly CONSECUTIVE_ERROR_RECONNECT_THRESHOLD = 10;

    /**
     * @param cdp - CDP ブリッジ
     * @param isProcessing - ジョブ実行中かどうかのチェック関数
     * @param isProCheck - Pro ライセンスかどうかのチェック関数（循環依存回避のためコールバック注入）
     */
    constructor(cdp: CdpBridge, isProcessing: () => boolean, isProCheck?: () => boolean) {
        this.cdp = cdp;
        this.isProcessing = isProcessing;
        this.isProCheck = isProCheck ?? (() => true);  // デフォルトは制限なし
    }

    /**
     * エージェント実行状態の変化を通知するコールバックを設定する。
     * ステータスバーの表示更新に使用する。
     */
    setAgentStateCallback(cb: (running: boolean) => void): void {
        this.onAgentStateChange = cb;
    }

    /**
     * UIウォッチャーを開始する。
     * autoAcceptEnhanced が有効な場合、VSCode コマンド経由で提案を自動承認し、
     * 自動スクロール、UI展開、権限ダイアログ処理を行う。
     * bridgeLifecycle からブリッジ起動時に呼ばれる（常時動作）。
     *
     * **注意:** autoAcceptEnhanced は Pro 限定機能。Free プランでは設定が ON でも無効。
     * pesosz/antigravity-auto-accept のみを使用する場合は OFF にする。
     */
    start(): void {
        // 既存タイマーがあればクリアして再起動（多重起動によるリーク防止）
        this.stop();

        logDebug('UIWatcher: started (command-first hybrid mode)');

        this.timer = setInterval(async () => {
            // autoAcceptEnhanced 設定を毎回チェック（設定変更を動的に反映）
            const autoEnabled = vscode.workspace.getConfiguration('antiCrow')
                .get<boolean>('autoAcceptEnhanced') ?? false;
            if (!autoEnabled) {
                // autoAcceptEnhanced OFF の場合、agentRunning 状態をリセット
                if (this.lastAgentRunning) {
                    this.lastAgentRunning = false;
                    this.onAgentStateChange?.(false);
                }
                return;
            }

            // Pro 限定: Free プランでは autoAcceptEnhanced を無効化
            if (!this.isProCheck()) { return; }

            // エージェント実行中かどうかを検出し、状態変化時にコールバックを発火
            // running → idle 遷移はデバウンスで安定化（DOM瞬間消失によるフラップ防止）
            try {
                // CDP接続を事前に確保（切断状態での evaluate 失敗を防止）
                await this.cdp.ops.conn.connect();
                const running = await isAgentRunning(this.cdp.ops);
                // 成功時はエラーカウンターをリセット
                if (this.agentCheckErrors > 0) {
                    logDebug(`UIWatcher: isAgentRunning recovered after ${this.agentCheckErrors} consecutive errors`);
                    this.agentCheckErrors = 0;
                }
                if (running) {
                    // running 検出 → 即時反映（デバウンスカウンターをリセット）
                    this.idleDebounceCount = 0;
                    if (!this.lastAgentRunning) {
                        this.lastAgentRunning = true;
                        this.onAgentStateChange?.(true);
                        logDebug('UIWatcher: agent state changed — running');
                    }
                } else if (this.lastAgentRunning) {
                    // running → idle 遷移はデバウンス（N回連続 false で確定）
                    this.idleDebounceCount++;
                    if (this.idleDebounceCount >= UIWatcher.IDLE_DEBOUNCE_THRESHOLD) {
                        this.lastAgentRunning = false;
                        this.idleDebounceCount = 0;
                        this.onAgentStateChange?.(false);
                        logDebug('UIWatcher: agent state changed — idle (debounced)');
                    } else {
                        logDebug(`UIWatcher: idle debounce ${this.idleDebounceCount}/${UIWatcher.IDLE_DEBOUNCE_THRESHOLD}`);
                    }
                }
            } catch (e) {
                // isAgentRunning の失敗は running 扱い（フラップ防止）
                this.idleDebounceCount = 0;
                this.agentCheckErrors++;
                if (this.agentCheckErrors === UIWatcher.AGENT_CHECK_ERROR_WARN_THRESHOLD) {
                    logInfo(`UIWatcher: ⚠️ isAgentRunning ${this.agentCheckErrors}回連続失敗 — CDP接続に問題がある可能性があります: ${e instanceof Error ? e.message : e}`);
                } else if (this.agentCheckErrors >= UIWatcher.AGENT_CHECK_RECONNECT_THRESHOLD
                    && this.agentCheckErrors % UIWatcher.AGENT_CHECK_RECONNECT_THRESHOLD === 0) {
                    logInfo(`UIWatcher: 🔄 isAgentRunning ${this.agentCheckErrors}回連続失敗 — CDP再接続を試行します`);
                    try {
                        this.cdp.ops.resetCascadeContext();
                        await this.cdp.ops.conn.connect();
                        this.agentCheckErrors = 0;
                        logInfo('UIWatcher: isAgentRunning CDP再接続成功');
                    } catch (reconnectErr) {
                        logInfo(`UIWatcher: isAgentRunning CDP再接続失敗 — ${reconnectErr instanceof Error ? reconnectErr.message : reconnectErr}`);
                    }
                } else {
                    logDebug(`UIWatcher: isAgentRunning error (${this.agentCheckErrors}x): ${e instanceof Error ? e.message : e}`);
                }
            }

            // =================================================================
            // 統合処理: autoFollowOutput
            // scroll → autoApprove → expand → permission を一括実行。
            // 「下にスクロールしながら出てきたボタンを押す」自然なフローで動作。
            // エージェント待機中（🟡）はスクロール不要 → 実行中（🟢）のみ実行。
            // =================================================================

            if (this.lastAgentRunning) {
                try {
                    await this.cdp.autoFollowOutput();
                    // 成功時は連続失敗カウンターをリセット
                    if (this.consecutiveErrors > 0) {
                        logDebug(`UIWatcher: autoFollowOutput recovered after ${this.consecutiveErrors} consecutive errors`);
                        this.consecutiveErrors = 0;
                    }
                } catch (e) {
                    this.consecutiveErrors++;
                    this.cdp.ops.resetCascadeContext();

                    if (this.consecutiveErrors === UIWatcher.CONSECUTIVE_ERROR_WARN_THRESHOLD) {
                        logInfo(`UIWatcher: ⚠️ autoFollowOutput ${this.consecutiveErrors}回連続失敗 — CDP接続に問題がある可能性があります`);
                    } else if (this.consecutiveErrors >= UIWatcher.CONSECUTIVE_ERROR_RECONNECT_THRESHOLD
                        && this.consecutiveErrors % UIWatcher.CONSECUTIVE_ERROR_RECONNECT_THRESHOLD === 0) {
                        logInfo(`UIWatcher: 🔄 autoFollowOutput ${this.consecutiveErrors}回連続失敗 — CDP再接続を試行します`);
                        try {
                            await this.cdp.ops.conn.connect();
                            this.consecutiveErrors = 0;
                            logInfo('UIWatcher: CDP再接続成功');
                        } catch (reconnectErr) {
                            logInfo(`UIWatcher: CDP再接続失敗 — ${reconnectErr instanceof Error ? reconnectErr.message : reconnectErr}`);
                        }
                    } else {
                        logDebug(`UIWatcher: autoFollowOutput error (${this.consecutiveErrors}x, context reset): ${e instanceof Error ? e.message : e}`);
                    }
                }
            }
        }, UI_WATCHER_INTERVAL_MS);
    }

    /** UIウォッチャーを停止する */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            // 停止時に agentRunning とデバウンスカウンター、連続失敗カウンターをリセット
            this.idleDebounceCount = 0;
            this.consecutiveErrors = 0;
            this.agentCheckErrors = 0;
            if (this.lastAgentRunning) {
                this.lastAgentRunning = false;
                this.onAgentStateChange?.(false);
            }
            logDebug('UIWatcher: stopped');
        }
    }
}
