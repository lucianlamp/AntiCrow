// ---------------------------------------------------------------------------
// memorySummarizer.ts — MEMORY.md 自動サマライズモジュール
// ---------------------------------------------------------------------------
// MEMORY.md が一定サイズを超えた場合、古いエントリを
// Antigravity（LLM）に要約させて圧縮する。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from './logger';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** サマライズ発動閾値（バイト） */
export const SUMMARIZE_THRESHOLD_BYTES = 50 * 1024; // 50KB

/** 直近エントリ保持件数 */
export const RECENT_ENTRY_COUNT = 5;

/** 要約の最大文字数 */
export const MAX_SUMMARY_CHARS = 1000;

/** 要約セクションのヘッダー */
const SUMMARY_SECTION_HEADER = '## 過去の記憶（要約）';

/** エントリの区切りパターン */
const ENTRY_PATTERN = /(?=^### \d{4}-\d{2}-\d{2})/m;

/** 二重実行防止用フラグ */
let summarizing = false;

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/** サマライズに必要な CDP/IPC 操作インターフェース */
export interface SummarizeOps {
    /** Antigravity にプロンプトを送信する */
    sendPrompt: (prompt: string) => Promise<void>;
    /** FileIpc のレスポンスパスを生成する */
    createMarkdownRequestId: (wsName?: string) => { requestId: string; responsePath: string };
    /** レスポンスを待機する */
    waitForResponse: (responsePath: string, timeoutMs: number) => Promise<string>;
    /** 一時ファイルを削除する */
    cleanupTmpFiles?: (excludeFiles?: string[]) => Promise<void>;
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

/**
 * MEMORY.md のサイズをチェックし、閾値を超えていればサマライズを実行する。
 * 二重実行を防止するロック機構付き。fire-and-forget で呼び出して良い。
 */
export async function trySummarizeIfNeeded(
    filePath: string,
    label: string,
    ops: SummarizeOps,
): Promise<void> {
    // サイズチェック
    try {
        const stat = fs.statSync(filePath);
        if (stat.size <= SUMMARIZE_THRESHOLD_BYTES) { return; }
    } catch { return; }

    // 二重実行防止
    if (summarizing) {
        logDebug(`memorySummarizer: already summarizing, skipping for ${label}`);
        return;
    }

    summarizing = true;
    try {
        await doSummarize(filePath, label, ops);
    } catch (e) {
        logWarn(`memorySummarizer: summarize failed for ${label}: ${e instanceof Error ? e.message : e}`);
    } finally {
        summarizing = false;
    }
}

/**
 * MEMORY.md を分割し、古いエントリを Antigravity に要約させて再構成する。
 */
async function doSummarize(
    filePath: string,
    label: string,
    ops: SummarizeOps,
): Promise<void> {
    logDebug(`memorySummarizer: starting summarize for ${label} (${filePath})`);

    const content = fs.readFileSync(filePath, 'utf-8');
    const { header, oldEntries, recentEntries, existingSummary } = splitMemoryContent(content);

    if (oldEntries.length === 0) {
        logDebug(`memorySummarizer: no old entries to summarize for ${label}`);
        return;
    }

    // 古いエントリのテキストを連結
    const oldText = oldEntries.join('\n').trim();
    logDebug(`memorySummarizer: ${oldEntries.length} old entries (${oldText.length} chars), ${recentEntries.length} recent entries`);

    // 既存の要約があれば、それも含めて再要約
    const contextPrefix = existingSummary
        ? `以下は過去の要約です。これも含めて全体を再要約してください:\n${existingSummary}\n\n以下は追加の古い記憶です:\n`
        : '';

    // Antigravity に要約を依頼
    const summaryText = await requestSummaryFromAntigravity(
        contextPrefix + oldText,
        label,
        ops,
    );

    if (!summaryText) {
        logWarn(`memorySummarizer: failed to get summary from Antigravity for ${label}`);
        return;
    }

    // MEMORY.md を再構成
    const newContent = rebuildMemoryContent(header, summaryText, recentEntries);
    fs.writeFileSync(filePath, newContent, 'utf-8');
    logDebug(`memorySummarizer: summarized ${label} memory — old ${oldEntries.length} entries → ${summaryText.length} chars summary`);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * MEMORY.md の内容を解析して分割する。
 */
export function splitMemoryContent(content: string): {
    header: string;
    oldEntries: string[];
    recentEntries: string[];
    existingSummary: string | null;
} {
    // 既存の要約セクションを抽出・除去
    let existingSummary: string | null = null;
    let cleanContent = content;

    const summaryStart = content.indexOf(SUMMARY_SECTION_HEADER);
    if (summaryStart !== -1) {
        // 要約セクションの終了位置を探す（次の ## or ### で始まる行）
        const afterHeader = content.indexOf('\n', summaryStart);
        if (afterHeader !== -1) {
            const rest = content.substring(afterHeader + 1);
            const nextSectionMatch = rest.match(/^(#{2,3}\s)/m);
            if (nextSectionMatch && nextSectionMatch.index !== undefined) {
                existingSummary = rest.substring(0, nextSectionMatch.index).trim();
                cleanContent = content.substring(0, summaryStart) + rest.substring(nextSectionMatch.index);
            } else {
                existingSummary = rest.trim();
                cleanContent = content.substring(0, summaryStart);
            }
        }
    }

    // エントリで分割
    const parts = cleanContent.split(ENTRY_PATTERN);
    const header = parts[0]; // ヘッダー部分（タイトル等）
    const allEntries = parts.slice(1);

    // 直近 N 件を保持
    const splitIdx = Math.max(0, allEntries.length - RECENT_ENTRY_COUNT);
    const oldEntries = allEntries.slice(0, splitIdx);
    const recentEntries = allEntries.slice(splitIdx);

    return { header, oldEntries, recentEntries, existingSummary };
}

/**
 * 要約テキストと直近エントリからMEMORY.mdの内容を再構成する。
 */
export function rebuildMemoryContent(
    header: string,
    summaryText: string,
    recentEntries: string[],
): string {
    const parts: string[] = [header.trimEnd()];
    parts.push('');
    parts.push(SUMMARY_SECTION_HEADER);
    parts.push(summaryText.trim());
    parts.push('');
    if (recentEntries.length > 0) {
        parts.push(recentEntries.join('').trimEnd());
        parts.push('');
    }
    return parts.join('\n');
}

/**
 * Antigravity に古い記憶の要約を依頼する。
 */
async function requestSummaryFromAntigravity(
    oldText: string,
    label: string,
    ops: SummarizeOps,
): Promise<string | null> {
    const TIMEOUT_MS = 180_000; // 3分タイムアウト

    // レスポンス用のファイルパスを生成
    const { responsePath } = ops.createMarkdownRequestId();

    // 要約プロンプトを構築
    const prompt = buildSummarizePrompt(oldText, responsePath);

    // 一時ファイルに書き出し
    const tmpPath = responsePath.replace(/_response\.md$/, '_summary_prompt.txt');
    fs.writeFileSync(tmpPath, prompt, 'utf-8');
    logDebug(`memorySummarizer: summary prompt written to ${tmpPath}`);

    try {
        // view_file 形式の1行指示で送信
        const instruction = `以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: ${tmpPath}`;
        await ops.sendPrompt(instruction);
        logDebug(`memorySummarizer: summary prompt sent to Antigravity for ${label}`);

        // レスポンスを待機
        const response = await ops.waitForResponse(responsePath, TIMEOUT_MS);
        logDebug(`memorySummarizer: received summary response (${response.length} chars) for ${label}`);

        // レスポンスから要約テキストを抽出（Markdown として扱う）
        const summary = response.trim();
        if (summary.length === 0) { return null; }

        // 長すぎる場合は切り詰め
        if (summary.length > MAX_SUMMARY_CHARS * 1.5) {
            return summary.substring(0, MAX_SUMMARY_CHARS) + '\n\n（要約が長すぎたため切り詰めました）';
        }
        return summary;
    } catch (e) {
        logWarn(`memorySummarizer: Antigravity summary request failed for ${label}: ${e instanceof Error ? e.message : e}`);
        return null;
    } finally {
        // 一時ファイル削除
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
}

/**
 * 要約プロンプトを構築する。
 */
function buildSummarizePrompt(oldText: string, responsePath: string): string {
    return `{
    "task": "memory_summarize",
    "instruction": "以下の古い記憶エントリを日本語で ${MAX_SUMMARY_CHARS} 文字以内に要約してください。",
    "constraints": [
        "重要な技術的決定、バグ修正パターン、設計原則を優先的に残す",
        "日付情報は省略して内容の本質のみを簡潔にまとめる",
        "箇条書き形式で、カテゴリごとにグループ化する",
        "出力は要約テキストのみ。前置きや説明は不要",
        "${MAX_SUMMARY_CHARS} 文字以内に収めること"
    ],
    "old_entries": ${JSON.stringify(oldText)},
    "output": {
        "method": "write_to_file",
        "path": ${JSON.stringify(responsePath)},
        "format": "要約テキストのみを書き込むこと。JSONではなくプレーンテキスト（Markdown箇条書き）で出力。"
    }
}`;
}

// -------------------------------------------------------------------------
// Testing helpers
// -------------------------------------------------------------------------

/** テスト用: summarizing フラグをリセット */
export function _resetSummarizingFlag(): void {
    summarizing = false;
}
