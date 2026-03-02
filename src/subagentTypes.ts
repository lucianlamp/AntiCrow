// ---------------------------------------------------------------------------
// subagentTypes.ts — サブエージェント通信の型定義
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1
// ---------------------------------------------------------------------------

/**
 * サブエージェントのライフサイクル状態
 *
 * IDLE → CREATING → LAUNCHING → READY → BUSY → COMPLETED → CLOSING → CLEANED
 */
export type SubagentState =
    | 'IDLE'
    | 'CREATING'
    | 'LAUNCHING'
    | 'READY'
    | 'BUSY'
    | 'COMPLETED'
    | 'CLOSING'
    | 'CLEANED'
    | 'FAILED';

/**
 * メインエージェント → サブエージェントへのプロンプト
 * ファイル IPC で送信される JSON のフォーマット
 */
export interface SubagentPrompt {
    /** メッセージタイプ識別子 */
    type: 'subagent_prompt';
    /** 送信元（メインエージェントのワークスペース名） */
    from: string;
    /** 送信先（サブエージェントのワークスペース名） */
    to: string;
    /** タイムスタンプ（Date.now()） */
    timestamp: number;
    /** 実行するプロンプト */
    prompt: string;
    /** タイムアウト（ミリ秒）。デフォルト: 300000（5分） */
    timeout_ms: number;
    /** レスポンスの書き込み先パス */
    callback_path: string;
}

/**
 * サブエージェント → メインエージェントへのレスポンス
 * ファイル IPC で返されるJSONのフォーマット
 */
export interface SubagentResponse {
    /** メッセージタイプ識別子 */
    type: 'subagent_response';
    /** 送信元（サブエージェントのワークスペース名） */
    from: string;
    /** タイムスタンプ */
    timestamp: number;
    /** 実行結果ステータス */
    status: 'success' | 'error' | 'timeout';
    /** 結果テキスト */
    result: string;
    /** 実行時間（ミリ秒） */
    execution_time_ms: number;
    /** エラー詳細（status が error の場合） */
    error?: string;
}

/**
 * サブエージェントの設定
 */
export interface SubagentConfig {
    /** 最大同時実行数（デフォルト: 3、16GB RAM 想定） */
    maxConcurrent: number;
    /** プロンプト応答タイムアウト（ミリ秒、デフォルト: 300000 = 5分） */
    promptTimeoutMs: number;
    /** ウィンドウ起動タイムアウト（ミリ秒、デフォルト: 30000 = 30秒） */
    launchTimeoutMs: number;
    /** closeWindow タイムアウト（ミリ秒、デフォルト: 5000） */
    closeTimeoutMs: number;
    /** ヘルスチェック間隔（ミリ秒、デフォルト: 30000 = 30秒） */
    healthCheckIntervalMs: number;
    /** レスポンスポーリング間隔（ミリ秒、デフォルト: 2000）※フォールバック用 */
    pollIntervalMs: number;
}

/**
 * デフォルト設定
 */
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
    maxConcurrent: 3,
    promptTimeoutMs: 300_000,
    launchTimeoutMs: 30_000,
    closeTimeoutMs: 5_000,
    healthCheckIntervalMs: 30_000,
    pollIntervalMs: 2_000,
};

/**
 * サブエージェント情報（SubagentHandle の外部公開用）
 */
export interface SubagentInfo {
    name: string;
    branch: string;
    worktreePath: string;
    state: SubagentState;
    createdAt: number;
    currentTask?: string;
}
