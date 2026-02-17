// ---------------------------------------------------------------------------
// types.ts — 共通型定義
// ---------------------------------------------------------------------------

/** チャンネルの用途 intent */
export type ChannelIntent = 'agent-chat';

/** 確認フローの選択モード */
export type ChoiceMode = 'none' | 'single' | 'multi' | 'all';

/** Plan のライフサイクル状態 */
export type PlanStatus = 'pending_confirmation' | 'active' | 'paused' | 'completed';

/** 実行履歴エントリ */
export interface PlanExecution {
    executed_at: string;       // ISO 8601
    success: boolean;
    duration_ms: number;
    result_preview?: string;   // 最初の200文字
}

/** Discord テンプレート群 */
export interface DiscordTemplates {
    ack?: string;
    confirm?: string;
    run_start?: string;
    run_success_prefix?: string;
    run_error?: string;
}

/** Skill JSON 出力 / 永続化される計画 */
export interface Plan {
    plan_id: string;
    timezone: string;               // "Asia/Tokyo"
    cron: string | null;            // null = 即時実行のみ
    prompt: string;
    requires_confirmation: boolean;
    choice_mode?: ChoiceMode;        // 確認時の選択モード（デフォルト: 'none'）
    source_channel_id: string;
    notify_channel_id: string;      // デフォルト: source チャンネル
    channel_id?: string;            // 自動作成された専用チャンネル ID（Schedules カテゴリー内）
    discord_templates: DiscordTemplates;
    human_summary?: string;
    attachment_paths?: string[];     // Discord 添付ファイルのローカルパス
    workspace_name?: string;        // 紐づくワークスペース名（カテゴリーベースルーティング用）
    status: PlanStatus;
    created_at: string;             // ISO 8601
    last_executed_at?: string;      // ISO 8601
    execution_count?: number;
    executions?: PlanExecution[];    // 直近10件
}

/** Skill が返す生の JSON（source/notify は拡張が後付け） */
export interface SkillOutput {
    plan_id: string;
    timezone: string;
    cron: string;
    prompt: string;
    requires_confirmation: boolean;
    choice_mode?: ChoiceMode;        // 確認時の選択モード（デフォルト: 'none'）
    discord_templates: DiscordTemplates;
    human_summary?: string;
    attachment_paths?: string[];     // Discord 添付ファイルのローカルパス（拡張が後付け）
}

/** 実行キューに入るジョブ */
export interface ExecutionJob {
    plan: Plan;
    triggerType: 'schedule' | 'immediate';
}

/** 進捗ファイルのスキーマ（AI が中間ファイルに書き込む） */
export interface ProgressUpdate {
    timestamp: string;       // ISO 8601
    status: string;          // 例: '分析中', 'コード修正中', 'テスト実行中'
    detail?: string;         // 詳細情報
    percent?: number;        // 0-100（任意）
}

/** UI要素クリック操作のオプション */
export interface ClickOptions {
    selector?: string;       // CSS セレクタ
    text?: string;           // ボタンのテキスト
    tag?: string;            // タグフィルタ（デフォルト: '*'）
    x?: number;              // X 座標
    y?: number;              // Y 座標
    inCascade?: boolean;     // cascade-panel iframe 内で実行（デフォルト: true）
}

/** UI要素クリック操作の結果 */
export interface ClickResult {
    success: boolean;
    method?: string;         // 'selector_hit' | 'coordinate_hit' | 'text_hit'
    target?: string;         // 何をクリックしたか
    error?: string;
}

