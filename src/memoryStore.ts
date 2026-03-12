// ---------------------------------------------------------------------------
// memoryStore.ts — MEMORY.md 管理モジュール
// ---------------------------------------------------------------------------
// グローバル記憶（~/.anticrow/MEMORY.md）と
// ワークスペース記憶（{workspace}/.anticrow/MEMORY.md）の読み書きを管理。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logDebug, logWarn } from './logger';
import { trySummarizeIfNeeded, SUMMARIZE_THRESHOLD_BYTES } from './memorySummarizer';
import { ensureAnticrowGitignore } from './gitignoreHelper';
import type { SummarizeOps } from './memorySummarizer';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const ANTICROW_DIR_NAME = '.anticrow';
const MEMORY_FILE_NAME = 'MEMORY.md';

/** グローバル MEMORY.md のパス */
const GLOBAL_MEMORY_PATH = path.join(os.homedir(), ANTICROW_DIR_NAME, MEMORY_FILE_NAME);

/** MEMORY.md の最大サイズ（バイト）。超過時は古いエントリをアーカイブ（最終安全ネット）。 */
export const MAX_MEMORY_SIZE_BYTES = 50 * 1024; // 50KB

/** サマライズ用 Ops コールバック（extension 起動時に注入） */
let currentSummarizeOps: SummarizeOps | null = null;

/** サマライズ用コールバックを設定する（bridgeLifecycle から呼ぶ） */
export function setSummarizeOps(ops: SummarizeOps | null): void {
    currentSummarizeOps = ops;
    logDebug(`memoryStore: summarize ops ${ops ? 'set' : 'cleared'}`);
}

/** 現在のサマライズ Ops を取得する（テスト用） */
function getSummarizeOps(): SummarizeOps | null {
    return currentSummarizeOps;
}

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/** MEMORY タグから抽出されたエントリ */
export interface MemoryEntry {
    scope: 'global' | 'workspace';
    content: string;
}

// -------------------------------------------------------------------------
// Read
// -------------------------------------------------------------------------

/**
 * グローバル MEMORY.md を読み取る。
 * ファイルが存在しない場合は null を返す。
 */
function readGlobalMemory(): string | null {
    return readMemoryFile(GLOBAL_MEMORY_PATH, 'global');
}

/**
 * ワークスペース固有の MEMORY.md を読み取る。
 * ファイルが存在しない場合は null を返す。
 */
function readWorkspaceMemory(workspacePath: string): string | null {
    const memPath = path.join(workspacePath, ANTICROW_DIR_NAME, MEMORY_FILE_NAME);
    return readMemoryFile(memPath, `workspace(${path.basename(workspacePath)})`);
}

/**
 * グローバル + ワークスペースの MEMORY.md を結合して返す。
 * 両方存在する場合はセクションヘッダー付きで結合。
 */
export function readCombinedMemory(workspacePath?: string): string | null {
    const global = readGlobalMemory();
    const workspace = workspacePath ? readWorkspaceMemory(workspacePath) : null;

    if (!global && !workspace) { return null; }

    const parts: string[] = [];
    if (global) {
        parts.push(`## グローバル記憶\n${global}`);
    }
    if (workspace) {
        const wsName = workspacePath ? path.basename(workspacePath) : 'unknown';
        parts.push(`## ワークスペース記憶（${wsName}）\n${workspace}`);
    }
    return parts.join('\n\n');
}

// -------------------------------------------------------------------------
// Write
// -------------------------------------------------------------------------

/**
 * グローバル MEMORY.md にエントリを追記する。
 */
export function appendToGlobalMemory(entry: string): void {
    appendToMemoryFile(GLOBAL_MEMORY_PATH, entry, 'global');
}

/**
 * ワークスペース固有の MEMORY.md にエントリを追記する。
 */
export function appendToWorkspaceMemory(workspacePath: string, entry: string): void {
    const memPath = path.join(workspacePath, ANTICROW_DIR_NAME, MEMORY_FILE_NAME);
    appendToMemoryFile(memPath, entry, `workspace(${path.basename(workspacePath)})`);
}

// -------------------------------------------------------------------------
// Tag Extraction (MEMORY タグの抽出・除去)
// -------------------------------------------------------------------------

/**
 * テキストから <!-- MEMORY:scope: content --> タグを抽出する。
 * 最大 3 件まで。
 */
export function extractMemoryTags(text: string): MemoryEntry[] {
    const regex = /<!--\s*MEMORY:(global|workspace):\s*(.+?)\s*-->/gs;
    const entries: MemoryEntry[] = [];
    let match;
    while ((match = regex.exec(text)) !== null && entries.length < 3) {
        entries.push({
            scope: match[1] as 'global' | 'workspace',
            content: match[2].trim(),
        });
    }
    return entries;
}

/**
 * テキストから MEMORY タグを除去する。
 * Discord 送信前にタグを取り除くために使用。
 */
export function stripMemoryTags(text: string): string {
    return text.replace(/<!--\s*MEMORY:(global|workspace):\s*.+?\s*-->/gs, '').trim();
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function readMemoryFile(filePath: string, label: string): string | null {
    try {
        if (!fs.existsSync(filePath)) { return null; }
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content.length === 0) { return null; }
        logDebug(`memoryStore: loaded ${label} memory from ${filePath} (${content.length} chars)`);
        return content;
    } catch (e) {
        logDebug(`memoryStore: failed to read ${label} memory: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

function appendToMemoryFile(filePath: string, entry: string, label: string): void {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            logDebug(`memoryStore: created directory ${dir}`);

            // ワークスペース記憶の場合、.gitignore に .anticrow/ を自動追加
            // （グローバル記憶 ~/.anticrow/ は Git リポジトリ外なのでスキップ）
            if (!dir.startsWith(os.homedir() + path.sep + '.anticrow')) {
                const repoRoot = path.resolve(dir, '..');
                ensureAnticrowGitignore(repoRoot);
            }
        }
        const timestamp = new Date().toISOString().slice(0, 10);
        const formattedEntry = `\n\n### ${timestamp}\n${entry.trim()}\n`;
        fs.appendFileSync(filePath, formattedEntry, 'utf-8');
        logDebug(`memoryStore: appended to ${label} memory (${entry.length} chars)`);

        // サイズチェック: サマライズ閾値を超えたら Antigravity に要約を依頼（fire-and-forget）
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > SUMMARIZE_THRESHOLD_BYTES && currentSummarizeOps) {
                // バックグラウンドで非同期実行（完了を待たない）
                trySummarizeIfNeeded(filePath, label, currentSummarizeOps).catch(e => {
                    logWarn(`memoryStore: background summarize failed: ${e instanceof Error ? e.message : e}`);
                });
            } else if (stat.size > MAX_MEMORY_SIZE_BYTES) {
                // サマライズ Ops 未設定時のフォールバック: 従来のアーカイブ
                archiveMemoryFile(filePath, label);
            }
        } catch { /* サイズチェック失敗は無視 */ }
    } catch (e) {
        logDebug(`memoryStore: failed to append to ${label} memory: ${e instanceof Error ? e.message : e}`);
    }
}

/**
 * MEMORY.md の古いエントリの前半をアーカイブファイルに移動する。
 * メインファイルには直近のエントリのみ残す。
 */
export function archiveMemoryFile(filePath: string, label: string): void {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const entries = content.split(/(?=^### \d{4}-\d{2}-\d{2})/m);
        const header = entries[0];
        const dataEntries = entries.slice(1);

        // アーカイブするには最低2エントリ必要
        if (dataEntries.length < 2) { return; }

        // 直近の記憶（最新10件 または 直近7日分）は保持し、それより古いものをアーカイブ対象とする
        const RECENT_COUNT = 10;
        const RECENT_DAYS = 7;
        const nowMs = Date.now();
        const msPerDay = 1000 * 60 * 60 * 24;

        let splitIdx = 0;
        for (let i = 0; i < dataEntries.length; i++) {
            const entry = dataEntries[i];
            const dateMatch = entry.match(/^### (\d{4}-\d{2}-\d{2})/);
            let isRecent = false;

            // 最新 N 件以内なら保持
            if (dataEntries.length - i <= RECENT_COUNT) {
                isRecent = true;
            } else if (dateMatch) {
                // 直近 N 日以内なら保持
                const entryDate = new Date(dateMatch[1]).getTime();
                if (!isNaN(entryDate)) {
                    const daysOld = (nowMs - entryDate) / msPerDay;
                    if (daysOld <= RECENT_DAYS) {
                        isRecent = true;
                    }
                }
            }

            if (isRecent) {
                splitIdx = i;
                break;
            }
        }

        // すべて最新扱いでアーカイブ対象がない場合は、無限肥大化を防ぐため強制的に最古の1件をアーカイブ
        if (splitIdx === 0) {
            splitIdx = 1;
        }

        const archiveEntries = dataEntries.slice(0, splitIdx);
        const keepEntries = dataEntries.slice(splitIdx);

        const dir = path.dirname(filePath);
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const archivePath = path.join(dir, `MEMORY_archive_${dateStr}.md`);

        fs.appendFileSync(archivePath, archiveEntries.join(''), 'utf-8');
        fs.writeFileSync(filePath, header + keepEntries.join(''), 'utf-8');
        logDebug(`memoryStore: archived ${archiveEntries.length} entries from ${label} memory to ${archivePath}`);
    } catch (e) {
        logDebug(`memoryStore: failed to archive ${label} memory: ${e instanceof Error ? e.message : e}`);
    }
}
