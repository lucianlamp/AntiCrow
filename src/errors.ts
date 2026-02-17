// ---------------------------------------------------------------------------
// errors.ts — カスタムエラークラス
// ---------------------------------------------------------------------------
// 責務:
//   1. エラー種別ごとの型安全なエラークラスを提供
//   2. instanceof チェックによるエラーハンドリングの統一
// ---------------------------------------------------------------------------

/**
 * Bridge 全体の基底エラー。
 * すべてのカスタムエラーはこのクラスを継承する。
 */
export class BridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BridgeError';
    }
}

/** CDP 接続の確立に失敗 */
export class CdpConnectionError extends BridgeError {
    constructor(message: string, public readonly port?: number) {
        super(message);
        this.name = 'CdpConnectionError';
    }
}

/** CDP コマンドの実行に失敗（タイムアウト含む） */
export class CdpCommandError extends BridgeError {
    constructor(message: string, public readonly method?: string) {
        super(message);
        this.name = 'CdpCommandError';
    }
}

/** Antigravity ターゲットが見つからない */
export class CdpTargetNotFoundError extends BridgeError {
    constructor(message: string, public readonly targetId?: string) {
        super(message);
        this.name = 'CdpTargetNotFoundError';
    }
}

/** Antigravity の自動起動に失敗 */
export class AntigravityLaunchError extends BridgeError {
    constructor(message: string) {
        super(message);
        this.name = 'AntigravityLaunchError';
    }
}

/** Cascade パネルの iframe が見つからない */
export class CascadePanelError extends BridgeError {
    constructor(message: string) {
        super(message);
        this.name = 'CascadePanelError';
    }
}
