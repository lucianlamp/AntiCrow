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
import { logDebug } from './logger';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** UIウォッチャーの自動クリックルール */
export interface AutoClickRule {
    name: string;            // ルール名（ログ用）
    text?: string;           // テキストマッチ
    selector?: string;       // セレクタマッチ
    tag?: string;            // タグフィルタ
    inCascade?: boolean;     // cascade-panel 内（デフォルト: true）
}

/**
 * デフォルトの自動クリックルール（CDP DOM 操作用）。
 * Accept / Allow / Run 等の承認系はVSCodeコマンドで処理するため、
 * ここには VSCode コマンドでカバーできない UI 操作のみを残す。
 */
export const DEFAULT_AUTO_CLICK_RULES: AutoClickRule[] = [
    // Continue: 警告ダイアログの続行ボタン（VSCode コマンド代替なし）
    { name: 'continue-warning', text: 'Continue', tag: 'button', inCascade: true },
    // Retry: エラー時のリトライボタン（VSCode コマンド代替なし）
    { name: 'retry-error', text: 'Retry', tag: 'button', inCascade: true },
    // Always run: 常時許可ボタン（VSCode コマンド代替なし）
    { name: 'always-run', text: 'Always run', inCascade: true },
    // Expand All: 差分ビューの折りたたみ展開ボタン
    { name: 'expand-all', selector: '[aria-label="Expand All"]', tag: 'button', inCascade: false },
    // Expand: 「N Step Requires Input」表示時の展開ボタン
    { name: 'expand-step-input', text: 'Expand', tag: 'button', inCascade: true },
    // ScrollDown: 出力が長い場合の下矢印スクロールボタン
    { name: 'scroll-down-arrow', selector: '.codicon-arrow-down', tag: 'button', inCascade: true },
    { name: 'scroll-down-arrow-text', text: '↓', tag: 'button', inCascade: true },
];

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** UIウォッチャーのポーリング間隔（ms） */
const UI_WATCHER_INTERVAL_MS = 1_000;

/** VSCode コマンドによる自動承認リスト */
const COMMAND_APPROVALS = [
    'antigravity.agent.acceptAgentStep',    // Agent ステップ承認
    'antigravity.terminalCommand.accept',   // ターミナルコマンド承認
    'antigravity.command.accept',            // コマンド承認
];

// ---------------------------------------------------------------------------
// UIWatcher クラス
// ---------------------------------------------------------------------------

export class UIWatcher {
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly rules: AutoClickRule[] = [...DEFAULT_AUTO_CLICK_RULES];
    private cdp: CdpBridge;
    private isProcessing: () => boolean;

    constructor(cdp: CdpBridge, isProcessing: () => boolean) {
        this.cdp = cdp;
        this.isProcessing = isProcessing;
    }

    /**
     * UIウォッチャーを開始する。
     * autoOperation が有効な場合、既知のダイアログ（Continue, Allow, Retry 等）を
     * 自動検出してクリックし、VSCode コマンド経由で提案を自動承認する。
     * bridgeLifecycle からブリッジ起動時に呼ばれる（常時動作）。
     */
    start(): void {
        // 既存タイマーがあればクリアして再起動（多重起動によるリーク防止）
        this.stop();

        logDebug('UIWatcher: started (command-first hybrid mode)');

        this.timer = setInterval(async () => {
            // autoOperation 設定を毎回チェック（設定変更を動的に反映）
            const autoEnabled = vscode.workspace.getConfiguration('antiCrow')
                .get<boolean>('autoOperation') ?? false;
            if (!autoEnabled) { return; }

            // ANTICROW 経由のジョブ実行中のみ自動承認を行う
            if (!this.isProcessing()) { return; }

            // =================================================================
            // 第1層: VSCode コマンドによる自動承認（UI変更に強い）
            // =================================================================
            for (const cmd of COMMAND_APPROVALS) {
                try {
                    await vscode.commands.executeCommand(cmd);
                } catch { /* コマンドが存在しない/対象なしは無視 */ }
            }

            // =================================================================
            // 第2層: CDP DOM ルールベースの自動クリック（フォールバック）
            // =================================================================
            for (const rule of this.rules) {
                try {
                    const result = await this.cdp.clickElement({
                        text: rule.text,
                        selector: rule.selector,
                        tag: rule.tag,
                        inCascade: rule.inCascade !== false,
                    });

                    if (result.success) {
                        logDebug(`UIWatcher: auto-clicked "${rule.name}" (method=${result.method})`);
                    }
                } catch (e) {
                    // コンテキスト取得失敗時はキャッシュをリセットして次回再取得を促す
                    this.cdp.ops.resetCascadeContext();
                    logDebug(`UIWatcher: rule "${rule.name}" error (context reset): ${e instanceof Error ? e.message : e}`);
                }
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
