// ---------------------------------------------------------------------------
// autoModeHistory.ts — オートモード実行履歴のログ保存
// ---------------------------------------------------------------------------
// 責務:
//   1. オートモード各実行のログを JSON ファイルに保存
//   2. 過去の履歴の読み込み
//   3. Discord 表示用フォーマット生成
//
// 保存先: {workspace}/.anticrow/auto-mode-history/{timestamp}.json
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logDebug, logError, logInfo } from './logger';
import type { AutoModeConfig, SafetyCheckResult, StepResult } from './autoModeController';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** オートモード実行履歴の1エントリ */
export interface AutoModeHistoryEntry {
    /** 実行 ID（タイムスタンプベース） */
    id: string;
    /** チャンネル ID */
    channelId: string;
    /** ワークスペースキー */
    wsKey: string;
    /** ユーザーの初期プロンプト */
    originalPrompt: string;
    /** 使用した設定 */
    config: AutoModeConfig;
    /** 開始時刻（ISO 8601） */
    startedAt: string;
    /** 終了時刻（ISO 8601） */
    stoppedAt: string;
    /** 合計実行時間（ミリ秒） */
    totalDuration: number;
    /** 完了ステップ数 */
    completedSteps: number;
    /** 最大ステップ数 */
    maxSteps: number;
    /** 停止理由 */
    stopReason: string;
    /** 各ステップの結果 */
    steps: StepHistoryEntry[];
    /** セーフティ発動回数 */
    safetyTriggerCount: number;
}

/** ステップ履歴（StepResult の永続化用サブセット） */
interface StepHistoryEntry {
    step: number;
    prompt: string;
    responseSummary: string;
    suggestionLabels: string[];
    duration: number;
    safetyResult: SafetyCheckResult;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const ANTICROW_DIR = '.anticrow';
const HISTORY_DIR = 'auto-mode-history';

/** 履歴あたりの最大保持件数 */
const MAX_HISTORY_FILES = 50;

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/**
 * ワークスペースのルートパスを取得する。
 * 取得できない場合は null を返す。
 */
function getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
}

/**
 * 履歴保存ディレクトリのパスを取得し、存在しなければ作成する。
 */
function ensureHistoryDir(): string | null {
    const root = getWorkspaceRoot();
    if (!root) {
        logDebug('autoModeHistory: ワークスペースが見つかりません');
        return null;
    }

    const historyDir = path.join(root, ANTICROW_DIR, HISTORY_DIR);
    try {
        fs.mkdirSync(historyDir, { recursive: true });
        return historyDir;
    } catch (e) {
        logError('autoModeHistory: 履歴ディレクトリの作成に失敗', e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * オートモード実行履歴を JSON ファイルに保存する。
 *
 * @param entry 保存する履歴エントリ
 */
export function saveHistory(entry: AutoModeHistoryEntry): void {
    const historyDir = ensureHistoryDir();
    if (!historyDir) {
        logError('autoModeHistory: 保存先ディレクトリが取得できないため保存をスキップ');
        return;
    }

    const filename = `${entry.id}.json`;
    const filePath = path.join(historyDir, filename);

    try {
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
        logInfo(`autoModeHistory: 履歴を保存しました — ${filePath}`);

        // 古い履歴の清掃
        pruneOldHistory(historyDir);
    } catch (e) {
        logError('autoModeHistory: 履歴の保存に失敗', e);
    }
}

/**
 * 指定チャンネルの過去の履歴を読み込む。
 * channelId が指定されない場合は全チャンネルの履歴を返す。
 *
 * @param channelId フィルタリング用チャンネルID（省略時: 全件）
 * @param limit 取得する最大件数（デフォルト: 10）
 * @returns 履歴エントリの配列（新しい順）
 */
export function loadHistory(channelId?: string, limit: number = 10): AutoModeHistoryEntry[] {
    const historyDir = ensureHistoryDir();
    if (!historyDir) return [];

    try {
        const files = fs.readdirSync(historyDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse(); // 新しい順

        const entries: AutoModeHistoryEntry[] = [];
        for (const file of files) {
            if (entries.length >= limit) break;

            try {
                const content = fs.readFileSync(path.join(historyDir, file), 'utf-8');
                const entry: AutoModeHistoryEntry = JSON.parse(content);

                // channelId フィルタ
                if (channelId && entry.channelId !== channelId) continue;

                entries.push(entry);
            } catch {
                logDebug(`autoModeHistory: 履歴ファイルの読み込みスキップ: ${file}`);
            }
        }

        return entries;
    } catch (e) {
        logError('autoModeHistory: 履歴の読み込みに失敗', e);
        return [];
    }
}

/**
 * 履歴エントリを Discord 表示用のテキストにフォーマットする。
 *
 * @param entries フォーマット対象の履歴エントリ
 * @returns Discord Markdown 形式のテキスト
 */
export function formatHistoryForDiscord(entries: AutoModeHistoryEntry[]): string {
    if (entries.length === 0) {
        return '📋 オートモードの実行履歴はありません。';
    }

    const lines: string[] = [
        '📋 **オートモード実行履歴**',
        '━━━━━━━━━━━━━━━━━━━━',
        '',
    ];

    for (const entry of entries) {
        const startDate = new Date(entry.startedAt);
        const dateStr = `${startDate.getMonth() + 1}/${startDate.getDate()} ${startDate.getHours().toString().padStart(2, '0')}:${startDate.getMinutes().toString().padStart(2, '0')}`;
        const durationStr = formatDurationSimple(entry.totalDuration);
        const statusEmoji = entry.stopReason === 'completed' ? '✅' : entry.stopReason === 'error' ? '❌' : '⏹️';

        lines.push(
            `${statusEmoji} **${dateStr}** — ${entry.originalPrompt.substring(0, 50)}${entry.originalPrompt.length > 50 ? '...' : ''}`,
        );
        lines.push(
            `    ステップ: ${entry.completedSteps}/${entry.maxSteps} | 時間: ${durationStr} | セーフティ: ${entry.safetyTriggerCount}回 | 理由: ${getReasonLabel(entry.stopReason)}`,
        );
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * StepResult[] から AutoModeHistoryEntry を構築する。
 * autoModeController の stopAutoMode() から呼び出されるヘルパー。
 */
export function buildHistoryEntry(
    channelId: string,
    wsKey: string,
    originalPrompt: string,
    config: AutoModeConfig,
    startedAt: number,
    steps: StepResult[],
    stopReason: string,
): AutoModeHistoryEntry {
    const now = Date.now();
    return {
        id: String(startedAt),
        channelId,
        wsKey,
        originalPrompt,
        config,
        startedAt: new Date(startedAt).toISOString(),
        stoppedAt: new Date(now).toISOString(),
        totalDuration: now - startedAt,
        completedSteps: steps.length,
        maxSteps: config.maxSteps,
        stopReason,
        steps: steps.map(s => ({
            step: s.step,
            prompt: s.prompt.substring(0, 200),
            responseSummary: s.response.substring(0, 200),
            suggestionLabels: s.suggestions.map(sg => sg.label),
            duration: s.duration,
            safetyResult: s.safetyResult,
        })),
        safetyTriggerCount: steps.filter(s => !s.safetyResult.safe).length,
    };
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * 古い履歴ファイルを削除して MAX_HISTORY_FILES 件以内に収める。
 */
function pruneOldHistory(historyDir: string): void {
    try {
        const files = fs.readdirSync(historyDir)
            .filter(f => f.endsWith('.json'))
            .sort();

        if (files.length <= MAX_HISTORY_FILES) return;

        const toDelete = files.slice(0, files.length - MAX_HISTORY_FILES);
        for (const file of toDelete) {
            try {
                fs.unlinkSync(path.join(historyDir, file));
                logDebug(`autoModeHistory: 古い履歴を削除: ${file}`);
            } catch {
                // 個別ファイルの削除失敗は無視
            }
        }
    } catch {
        // 清掃失敗は非致命的
    }
}

/**
 * ミリ秒を簡易的な表示形式に変換する。
 */
function formatDurationSimple(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    const remainSec = sec % 60;
    if (min < 60) return `${min}分${remainSec > 0 ? remainSec + '秒' : ''}`;
    const hr = Math.floor(min / 60);
    const remainMin = min % 60;
    return `${hr}時間${remainMin > 0 ? remainMin + '分' : ''}`;
}

/**
 * 停止理由のラベルを返す。
 */
function getReasonLabel(reason: string): string {
    switch (reason) {
        case 'max_steps': return 'ステップ上限';
        case 'max_duration': return '時間上限';
        case 'completed': return '完了';
        case 'similarity': return '類似検知';
        case 'safety_stop': return 'セーフティ停止';
        case 'manual': return '手動停止';
        case 'error': return 'エラー';
        case 'new_session': return '新セッション';
        default: return reason;
    }
}
