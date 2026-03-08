// ---------------------------------------------------------------------------
// cdpHistory.ts — CDP ブリッジ操作インターフェース定義
// ---------------------------------------------------------------------------
// 元々は会話履歴操作の実装を含んでいたが、/history コマンド廃止に伴い
// 型定義のみを残す。CdpBridgeOps は他の CDP モジュールから参照されている。
// ---------------------------------------------------------------------------

import { logDebug } from './logger';

/** CdpBridge の内部操作を外部ヘルパーに公開するインターフェース */
export interface CdpBridgeOps {
    conn: {
        connect(): Promise<void>;
        send(method: string, params: unknown): Promise<unknown>;
        evaluate(expr: string, contextId?: number): Promise<unknown>;
    };
    evaluateInCascade(expression: string): Promise<unknown>;
    sleep(ms: number): Promise<void>;
    resetCascadeContext(): void;
}
