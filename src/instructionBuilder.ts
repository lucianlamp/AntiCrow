/**
 * instruction.json 生成の共通ヘルパー
 *
 * bridgeLifecycle.ts / teamOrchestrator.ts の3箇所で使われていた
 * 重複ロジックを DRY に統一する。
 */
import * as fs from 'fs';
import { logInfo, logWarn } from './logger';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------
export interface InstructionOptions {
    /** サブエージェントに渡すプロンプト本文 */
    prompt: string;
    /** タスクの追加コンテキスト（team 情報や report_path など） */
    context?: Record<string, unknown>;
    /** レスポンス書き込み先パス（空文字で省略可） */
    responsePath?: string;
    /** 進捗ファイルパス */
    progressPath: string;
    /** レスポンスフォーマット (デフォルト: 'markdown') */
    format?: 'markdown' | 'json';
    /** constraint テキスト (デフォルト: 標準の実行用 constraint) */
    constraint?: string;
    /** execution_rules 追加ルール */
    executionRules?: string[];
    /** ワークスペース名（loadUserMemory に渡す） */
    workspaceName?: string;
}

// ---------------------------------------------------------------------------
// デフォルト値
// ---------------------------------------------------------------------------
const DEFAULT_CONSTRAINT =
    'すべての作業が完了してから write_to_file で Markdown 形式のレスポンスを1回だけ書き込む。' +
    '途中経過・中間報告は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされ、' +
    '内容がそのまま Discord に送信される。Discord の Markdown 記法に準拠すること' +
    '（**太字**, - 箇条書き, `コード` 等）。結果には何をしたか・変更内容・影響範囲・' +
    'テスト結果・注意点を具体的かつ詳細に記述すること。簡素すぎる報告は避ける。' +
    '重要な学びがあればレスポンス末尾に <!-- MEMORY:global: 内容 --> または ' +
    '<!-- MEMORY:workspace: 内容 --> タグで記録指示を埋め込むこと。' +
    'レスポンスの最後に、ユーザーが次に取るべきアクションの提案を最大3つ、' +
    '<!-- SUGGESTIONS:[{"label":"ボタン表示テキスト","description":"詳細説明","prompt":"実行されるプロンプト"},...] --> ' +
    '形式で埋め込むこと。';

const DEFAULT_EXECUTION_RULES = [
    'このタスクは既に計画済みです。計画の生成や承認は不要で、直ちに実行に移ってください',
    'plan_generation タスクを生成しないでください',
];

const DEFAULT_PROGRESS_INSTRUCTION =
    '進捗ファイルに JSON で進捗状況を定期的に書き込むこと（write_to_file, Overwrite: true）。' +
    '30秒〜1分おきに percent と status を更新する。';

// ---------------------------------------------------------------------------
// 共通ヘルパー: 日時文字列生成
// ---------------------------------------------------------------------------
export function buildDatetimeStr(): string {
    return new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

// ---------------------------------------------------------------------------
// 共通ヘルパー: ルール・メモリ・ユーザー設定の読み込み
// ---------------------------------------------------------------------------
export interface LoadedPromptResources {
    rulesContent: string | null;
    userGlobalRules: string | null;
    userMemory: string | null;
}

export function loadPromptResources(workspaceName?: string): LoadedPromptResources {
    let rulesContent: string | null = null;
    let userGlobalRules: string | null = null;
    let userMemory: string | null = null;
    try {
        const { loadPromptRules, loadUserGlobalRules, loadUserMemory } = require('./executorPromptBuilder');
        rulesContent = loadPromptRules();
        userGlobalRules = loadUserGlobalRules();
        userMemory = loadUserMemory(workspaceName);
    } catch (e) {
        logWarn(`[instructionBuilder] Failed to load rules/memory: ${e}`);
    }
    return { rulesContent, userGlobalRules, userMemory };
}

// ---------------------------------------------------------------------------
// メイン: instruction.json コンテンツ構築
// ---------------------------------------------------------------------------
export function buildInstructionContent(options: InstructionOptions): Record<string, unknown> {
    const {
        prompt,
        context,
        responsePath,
        progressPath,
        format = 'markdown',
        constraint = DEFAULT_CONSTRAINT,
        executionRules = DEFAULT_EXECUTION_RULES,
        workspaceName,
    } = options;

    const { rulesContent, userGlobalRules, userMemory } = loadPromptResources(workspaceName);

    const content: Record<string, unknown> = {
        task: 'execution',
        context: {
            datetime_jst: buildDatetimeStr(),
            ...context,
        },
        prompt,
    };

    // output セクション（responsePath が指定されている場合のみ）
    if (responsePath) {
        content.output = {
            response_path: responsePath,
            format,
            constraint,
        };
    }

    // progress セクション
    content.progress = {
        path: progressPath,
        instruction: DEFAULT_PROGRESS_INSTRUCTION,
        format: { status: '現在のステータス', detail: '詳細（任意）', percent: 50 },
    };

    // execution_rules
    content.execution_rules = executionRules;

    // ルール・メモリ・ユーザー設定を追加
    if (rulesContent) {
        content.rules = rulesContent;
    }
    if (userGlobalRules) {
        content.user_rules = userGlobalRules;
        content.user_rules_instruction = '出力のスタイルや口調に反映してください。';
    }
    if (userMemory) {
        content.memory = userMemory;
        content.memory_instruction = 'これはエージェントの記憶です。過去の学びや教訓を参考にしてください。';
    }

    return content;
}

// ---------------------------------------------------------------------------
// メイン: instruction.json ファイル書き出し
// ---------------------------------------------------------------------------
export function writeInstructionJson(filePath: string, options: InstructionOptions): void {
    const content = buildInstructionContent(options);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
    logInfo(`[instructionBuilder] Wrote instruction file: ${filePath}`);
}
