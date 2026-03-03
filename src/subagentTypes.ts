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
    /** spawn リトライ回数（デフォルト: 3） */
    spawnMaxRetries: number;
    /** stagger 起動の間隔（ミリ秒、デフォルト: 2500） */
    staggerDelayMs: number;
    /** アイドルプールの TTL（ミリ秒、デフォルト: 300_000 = 5分） */
    idleTtlMs: number;
    /** ウィンドウ再利用を有効にするか（デフォルト: true */
    enableWindowReuse: boolean;
}

/**
 * デフォルト設定
 */
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
    maxConcurrent: 3,
    promptTimeoutMs: 900_000,   // 15分（teamConfig.responseTimeoutMs と整合）
    launchTimeoutMs: 60_000,
    closeTimeoutMs: 5_000,
    healthCheckIntervalMs: 30_000,
    pollIntervalMs: 2_000,
    spawnMaxRetries: 3,
    staggerDelayMs: 2_500,
    idleTtlMs: 300_000,         // 5分
    enableWindowReuse: true,    // デフォルトで有効
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

// ---------------------------------------------------------------------------
// チームモード用型定義
// ---------------------------------------------------------------------------

/**
 * メインエージェント → サブエージェントへの指令ファイル
 * ファイル名パターン: team_{requestId}_agent{N}_instruction.json
 */
export interface TeamInstruction {
    /** ペルソナ設定（例: 「あなたはサブエージェント1です」） */
    persona: string;
    /** サブエージェント番号（1-indexed） */
    agentIndex: number;
    /** 割り当てられたタスクの詳細 */
    task: string;
    /** レスポンスを書き込むファイルパス */
    response_path: string;
    /** 進捗を書き込むファイルパス */
    progress_path: string;
    /** 共有コンテキスト（元のユーザーリクエスト等） */
    context: string;
    /** タイムスタンプ */
    timestamp: number;
    /** メインエージェントの requestId */
    requestId: string;
    /** 総サブエージェント数 */
    totalAgents: number;
}

/**
 * サブエージェント → メインエージェントへの報告プロンプトファイル
 * Discord Bot が中継して生成する
 * ファイル名パターン: team_{requestId}_report_agent{N}.json
 */
export interface TeamReport {
    /** ペルソナ設定 */
    persona: string;
    /** 報告元のサブエージェント名 */
    report_from: string;
    /** サブエージェント番号（1-indexed） */
    agentIndex: number;
    /** 元のタスク概要 */
    task_summary: string;
    /** サブエージェントのレスポンス内容 */
    result: string;
    /** 成功/失敗 */
    success: boolean;
    /** 残りのサブエージェント数 */
    remaining_agents: number;
    /** メインエージェントの最終レスポンスパス */
    response_path: string;
    /** タイムスタンプ */
    timestamp: number;
    /** メインエージェントの requestId */
    requestId: string;
    /** 全サブエージェントの報告が揃ったかどうか */
    all_reports_collected: boolean;
    /** 全サブエージェントの報告まとめ（全部揃った場合のみ） */
    all_reports?: Array<{
        agentIndex: number;
        agentName: string;
        success: boolean;
        result: string;
    }>;
}

// ---------------------------------------------------------------------------
// Worktree プール型定義
// ---------------------------------------------------------------------------

/** プール内の worktree エントリの状態 */
export type WorktreePoolEntryState = 'available' | 'in-use';

/** プール内の worktree エントリ */
export interface WorktreePoolEntry {
    /** プール内のインデックス（0-indexed） */
    index: number;
    /** worktree のディレクトリパス */
    path: string;
    /** 現在の状態 */
    state: WorktreePoolEntryState;
    /** 使用中のサブエージェント名（in-use 時） */
    usedBy?: string;
    /** 最終使用時刻 */
    lastUsedAt?: number;
}

