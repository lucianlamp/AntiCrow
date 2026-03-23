/**
 * instruction.json 生成の共通ヘルパー
 *
 * bridgeLifecycle.ts / teamOrchestrator.ts の3箇所で使われていた
 * 重複ロジックを DRY に統一する。
 */
import * as fs from 'fs';
import { logInfo, logWarn } from './logger';
import { t, tArray } from './i18n';

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
// デフォルト値（i18n 対応: 実行時に t() で解決）
// ---------------------------------------------------------------------------
function getDefaultConstraint(): string {
    return t('instruction.constraint');
}

function getDefaultExecutionRules(): string[] {
    return tArray('instruction.execution_rules');
}

function getDefaultProgressInstruction(): string {
    return t('instruction.progress.instruction');
}

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
        constraint,
        executionRules,
        workspaceName,
    } = options;

    // デフォルト値は i18n 対応のため関数呼び出しで取得
    const resolvedConstraint = constraint ?? getDefaultConstraint();
    const resolvedExecutionRules = executionRules ?? getDefaultExecutionRules();

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
            constraint: resolvedConstraint,
        };
    }

    // progress セクション
    content.progress = {
        path: progressPath,
        instruction: getDefaultProgressInstruction(),
        format: { status: t('instruction.progress.status'), detail: t('instruction.progress.detail'), percent: 50 },
    };

    // execution_rules
    content.execution_rules = resolvedExecutionRules;

    // ルール・メモリ・ユーザー設定を追加
    if (rulesContent) {
        content.rules = rulesContent;
    }
    if (userGlobalRules) {
        content.user_rules = userGlobalRules;
        content.user_rules_instruction = t('instruction.user_rules_instruction');
    }
    if (userMemory) {
        content.memory = userMemory;
        content.memory_instruction = t('instruction.memory_instruction');
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
