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
     * UIウォッチャーを開始する。
     * autoAccept が有効な場合、VSCode コマンド経由で提案を自動承認し、
     * DOM フォールバックで既知のダイアログ（Continue, Allow, Retry 等）を
     * 自動検出してクリックする。
     * bridgeLifecycle からブリッジ起動時に呼ばれる（常時動作）。
     *
     * **注意:** autoAccept は Pro 限定機能。Free プランでは設定が ON でも無効。
     */
    start(): void {
        // 既存タイマーがあればクリアして再起動（多重起動によるリーク防止）
        this.stop();

        logDebug('UIWatcher: started (command-first hybrid mode)');

        this.timer = setInterval(async () => {
            // autoAccept 設定を毎回チェック（設定変更を動的に反映）
            const autoEnabled = vscode.workspace.getConfiguration('antiCrow')
                .get<boolean>('autoAccept') ?? false;
            if (!autoEnabled) { return; }

            // Pro 限定: Free プランでは autoAccept を無効化
            if (!this.isProCheck()) { return; }

            // autoAccept がオンかつ Pro ライセンスであれば、
            // AntiCrow 経由のジョブ実行中かに関わらず常に自動承認を実行する。
            // （ユーザーが Antigravity に直接入力した場合も自動承認が動作する）

            // =================================================================
            // 統合処理: autoFollowOutput
            // scroll → autoApprove → expand → review → permission を一括実行。
            // 「下にスクロールしながら出てきたボタンを押す」自然なフローで動作。
            // =================================================================
            try {
                await this.cdp.autoFollowOutput();
            } catch (e) {
                this.cdp.ops.resetCascadeContext();
                logDebug(`UIWatcher: autoFollowOutput error (context reset): ${e instanceof Error ? e.message : e}`);
            }
        }, UI_WATCHER_INTERVAL_MS);
    }

    /** UIウォッチャーを停止する */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logDebug('UIWatcher: stopped');
        }
    }
}
