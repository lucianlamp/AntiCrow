/**
 * ファイルベース IPC モジュール
 *
 * Antigravity にプロンプトで「結果をファイルに書き込め」と指示し、
 * Extension 側はファイルの出現を監視して応答を取得する。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProgressUpdate } from './types';
import { IpcTimeoutError } from './errors';
import { logInfo, logDebug, logWarn, logError } from './logger';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** レスポンスファイルの最大サイズ（バイト） */
const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024;
/** ファイル出現後の書き込み安定待機（ms） */
const WRITE_SETTLE_MS = 500;
/** ポーリング間隔（ms） */
const POLL_INTERVAL_MS = 1_000;

export class FileIpc {
    private readonly ipcDir: string;
    private readonly storagePath: string;

    constructor(storageUri: vscode.Uri) {
        this.storagePath = storageUri.fsPath;
        this.ipcDir = path.join(this.storagePath, 'ipc');
    }

    /** IPC ディレクトリを初期化 */
    async init(): Promise<void> {
        await fs.promises.mkdir(this.ipcDir, { recursive: true });
        logInfo(`FileIpc: initialized IPC directory at ${this.ipcDir}`);
    }

    /** IPC ディレクトリのパスを取得 */
    getIpcDir(): string {
        return this.ipcDir;
    }

    /** ストレージベースパスを取得 */
    getStoragePath(): string {
        return this.storagePath;
    }

    /** リクエスト ID を生成し、レスポンスファイルのパスを返す（JSON形式 — 計画生成用） */
    createRequestId(): { requestId: string; responsePath: string } {
        const requestId = `req_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        const responsePath = path.join(this.ipcDir, `${requestId}_response.json`);
        return { requestId, responsePath };
    }

    /** リクエスト ID を生成し、Markdown レスポンスファイルのパスを返す（実行結果用） */
    createMarkdownRequestId(): { requestId: string; responsePath: string } {
        const requestId = `req_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        const responsePath = path.join(this.ipcDir, `${requestId}_response.md`);
        return { requestId, responsePath };
    }

    /**
     * レスポンスファイルの出現を待機する。
     * ポーリング方式（fs.watch は Windows で不安定なため）。
     *
     * 進捗ファイルの更新を検知してタイムアウトをリセットする:
     *   - 進捗ファイル（*_progress.json）の mtime が更新されるたびにタイムアウト起点をリセット
     *   - 最後の進捗報告（または初回送信）から timeoutMs 経過で初めてタイムアウト
     */
    async waitForResponse(responsePath: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
        let lastActivityTime = Date.now();

        // 進捗ファイルのパスを responsePath から導出
        const progressPattern = /_response\.(json|md)$/;
        const progressPath = responsePath.replace(progressPattern, '_progress.json');
        let lastProgressMtime = 0;
        const dir = path.dirname(responsePath);
        const filename = path.basename(responsePath);
        const progressFilename = path.basename(progressPath);

        logInfo(`FileIpc: waiting for response at ${responsePath} (timeout=${timeoutMs}ms, fs.watch + polling fallback)`);

        // 既に abort 済みの場合は即時 reject
        if (signal?.aborted) {
            return Promise.reject(new Error('FileIpc: aborted before waiting'));
        }

        return new Promise<string>((resolve, reject) => {
            let settled = false;
            let watcher: fs.FSWatcher | null = null;
            let pollTimer: ReturnType<typeof setInterval> | null = null;
            let timeoutTimer: ReturnType<typeof setInterval> | null = null;

            const cleanup = () => {
                if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                if (timeoutTimer) { clearInterval(timeoutTimer); timeoutTimer = null; }
            };

            // AbortSignal リスナー: abort 時に即座にクリーンアップ & reject
            if (signal) {
                const onAbort = () => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        logInfo('FileIpc: waitForResponse aborted by signal');
                        reject(new Error('FileIpc: aborted'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }

            const tryReadResponse = async (): Promise<boolean> => {
                try {
                    await fs.promises.access(responsePath, fs.constants.F_OK);
                    // ファイルが存在する → 少し待ってから読み取り（書き込み完了を待つ）
                    await this.sleep(WRITE_SETTLE_MS);

                    const content = await fs.promises.readFile(responsePath, 'utf-8');

                    // セキュリティ: レスポンスサイズ制限（5MB）
                    const MAX_RESPONSE_SIZE = MAX_RESPONSE_SIZE_BYTES;
                    if (content.length > MAX_RESPONSE_SIZE) {
                        logError(`FileIpc: response file too large (${content.length} bytes > ${MAX_RESPONSE_SIZE}). Truncating.`);
                        try { await fs.promises.unlink(responsePath); } catch (e) { logDebug(`FileIpc: failed to unlink truncated response: ${e}`); }
                        if (!settled) { settled = true; cleanup(); resolve(content.substring(0, MAX_RESPONSE_SIZE)); }
                        return true;
                    }

                    // 空ファイルの場合はまだ書き込み中の可能性
                    if (content.trim().length === 0) {
                        logDebug('FileIpc: file exists but is empty, waiting...');
                        return false;
                    }

                    logInfo(`FileIpc: response received (${content.length} chars)`);

                    // クリーンアップ
                    try {
                        await fs.promises.unlink(responsePath);
                        logDebug('FileIpc: response file cleaned up');
                    } catch {
                        logWarn('FileIpc: failed to clean up response file');
                    }

                    if (!settled) { settled = true; cleanup(); resolve(content); }
                    return true;
                } catch {
                    // ファイルがまだ存在しない
                    return false;
                }
            };

            const checkProgress = async () => {
                try {
                    const progressStat = await fs.promises.stat(progressPath);
                    if (progressStat.mtimeMs > lastProgressMtime) {
                        if (lastProgressMtime > 0) {
                            logDebug(`FileIpc: progress file updated, resetting timeout (mtime: ${new Date(progressStat.mtimeMs).toISOString()})`);
                        }
                        lastProgressMtime = progressStat.mtimeMs;
                        lastActivityTime = Date.now();
                    }
                } catch {
                    // 進捗ファイルがまだ存在しない
                }
            };

            // --- fs.watch でディレクトリを監視 ---
            try {
                watcher = fs.watch(dir, async (event, changedFile) => {
                    if (settled) { return; }
                    if (changedFile === filename) {
                        await tryReadResponse();
                    } else if (changedFile === progressFilename) {
                        await checkProgress();
                    }
                });
                watcher.on('error', (err) => {
                    logWarn(`FileIpc: fs.watch error, falling back to polling only: ${err.message}`);
                    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
                });
                logDebug('FileIpc: fs.watch started successfully');
            } catch (e) {
                logWarn(`FileIpc: fs.watch failed to start, using polling only: ${e instanceof Error ? e.message : e}`);
            }

            // --- フォールバック: ポーリング（1秒間隔） ---
            pollTimer = setInterval(async () => {
                if (settled) { return; }
                await checkProgress();
                await tryReadResponse();
            }, POLL_INTERVAL_MS);

            // --- タイムアウト監視（1秒間隔でチェック） ---
            timeoutTimer = setInterval(() => {
                if (settled) { return; }
                if (Date.now() - lastActivityTime >= timeoutMs) {
                    const totalElapsed = lastProgressMtime > 0
                        ? `last progress ${Math.round((Date.now() - lastProgressMtime) / 1000)}s ago`
                        : 'no progress received';
                    settled = true;
                    cleanup();

                    // タイムアウトしたレスポンスファイルがあれば削除
                    fs.promises.access(responsePath, fs.constants.F_OK)
                        .then(() => fs.promises.unlink(responsePath))
                        .then(() => logDebug('FileIpc: cleaned up timed-out response file'))
                        .catch(() => { /* file doesn't exist, OK */ });

                    reject(new IpcTimeoutError(`FileIpc: response timeout (${timeoutMs}ms, ${totalElapsed}) — file never appeared at ${responsePath}`));
                }
            }, POLL_INTERVAL_MS);
        });
    }

    /** 古い IPC ファイルをクリーンアップ（1分以上前のファイル） */
    async cleanupOldFiles(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.ipcDir);
            const now = Date.now();
            for (const f of files) {
                const fp = path.join(this.ipcDir, f);
                try {
                    const stat = await fs.promises.stat(fp);
                    if (now - stat.mtimeMs > 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up old file ${f}`);
                    }
                } catch (e) { logDebug(`FileIpc: failed to clean up old file ${f}: ${e}`); }
            }
        } catch (e) { logDebug(`FileIpc: cleanupOldFiles readdir failed: ${e}`); }
    }

    /**
     * レスポンス文字列からテキストコンテンツを抽出する。
     *
     * 以下の優先順でキーを探索し、最初に見つかった文字列値を返す:
     *   response → result → reply → content → text → output → message
     *
     * いずれのキーも該当しない場合、JSON オブジェクトが文字列値を1つだけ持つなら
     * その値をフォールバックとして返す（未知のスキーマに対応）。
     *
     * JSON でない場合やパースに失敗した場合は元の文字列をそのまま返す。
     */
    static extractResult(raw: string): string {
        const trimmed = raw.trim();
        // JSON オブジェクトらしき文字列でなければ早期リターン
        if (!trimmed.startsWith('{')) {
            return raw;
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                // 計画JSON形式: discord_templates.ack を最優先で抽出
                if (parsed.discord_templates && typeof parsed.discord_templates === 'object' && typeof parsed.discord_templates.ack === 'string') {
                    return parsed.discord_templates.ack;
                }

                // リッチJSON展開: summary 以外にもオブジェクト/配列キーがある場合
                const hasNestedData = Object.values(parsed).some(
                    v => (typeof v === 'object' && v !== null),
                );
                if (hasNestedData) {
                    const formatted = FileIpc.formatJsonForDiscord(parsed);
                    if (formatted) {
                        logDebug(`FileIpc.extractResult: formatted complex JSON (${formatted.length} chars)`);
                        return formatted;
                    }
                }

                // 既知のキーを優先順に試行（summary を最優先）
                const knownKeys = ['summary', 'response', 'result', 'reply', 'content', 'text', 'output', 'message'];
                let bestValue: string | null = null;

                for (const key of knownKeys) {
                    if (key in parsed && typeof parsed[key] === 'string') {
                        const val = parsed[key] as string;
                        if (val.length > 20) {
                            // 十分な長さがあればそのまま採用
                            return val;
                        }
                        // 短い値は一旦保持し、他により長い値がないか探す
                        if (!bestValue) { bestValue = val; }
                    }
                }

                // 短い値しか見つからなかった場合、全文字列値から最長を探す
                if (bestValue && bestValue.length <= 20) {
                    const allStringValues = Object.entries(parsed)
                        .filter(([, v]) => typeof v === 'string' && (v as string).length > 0)
                        .sort(([, a], [, b]) => (b as string).length - (a as string).length);
                    if (allStringValues.length > 0 && (allStringValues[0][1] as string).length > bestValue.length) {
                        logDebug(`FileIpc.extractResult: short value "${bestValue}" found, using longer "${allStringValues[0][0]}" key instead`);
                        return allStringValues[0][1] as string;
                    }
                }

                if (bestValue) { return bestValue; }

                // フォールバック: 文字列値が1つだけなら抽出
                const stringValues = Object.values(parsed).filter((v): v is string => typeof v === 'string');
                if (stringValues.length === 1) {
                    logDebug(`FileIpc.extractResult: fallback — extracted single string value from JSON`);
                    return stringValues[0];
                }
            }
        } catch {
            // JSON でなければそのまま返す
        }
        return raw;
    }

    /**
     * 複雑なネスト JSON を Discord 向けの Markdown 形式に展開する。
     * 
     * 主に実行結果 JSON（summary, changes, test_results, deploy 等）を
     * 人間が読みやすい形式に変換する。
     */
    static formatJsonForDiscord(obj: Record<string, unknown>): string | null {
        const lines: string[] = [];

        // キー名の日本語ラベルマッピング
        const labelMap: Record<string, string> = {
            summary: '📋 概要',
            result: '結果',
            changes: '📝 変更内容',
            files_modified: '変更ファイル',
            files_created: '新規ファイル',
            files_deleted: '削除ファイル',
            details: '詳細',
            impact: '🔍 影響範囲',
            test_results: '🧪 テスト結果',
            deploy: '🚀 デプロイ',
            notes: '⚠️ 注意点',
            warnings: '⚠️ 警告',
            errors: '❌ エラー',
            status: 'ステータス',
            description: '説明',
        };

        const getLabel = (key: string): string => labelMap[key] || key;

        const formatValue = (value: unknown, depth: number = 0): string[] => {
            const result: string[] = [];
            const indent = '  '.repeat(depth);

            if (typeof value === 'string') {
                result.push(`${indent}${value}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                result.push(`${indent}${String(value)}`);
            } else if (Array.isArray(value)) {
                for (const item of value) {
                    if (typeof item === 'string') {
                        result.push(`${indent}- ${item}`);
                    } else if (typeof item === 'object' && item !== null) {
                        // 配列内のオブジェクト: キーバリューを箇条書き
                        const parts: string[] = [];
                        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                                parts.push(`**${getLabel(k)}:** ${v}`);
                            }
                        }
                        if (parts.length > 0) {
                            result.push(`${indent}- ${parts.join(' / ')}`);
                        }
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                        result.push(`${indent}**${getLabel(k)}:** ${v}`);
                    } else if (Array.isArray(v)) {
                        result.push(`${indent}**${getLabel(k)}:**`);
                        result.push(...formatValue(v, depth + 1));
                    } else if (typeof v === 'object' && v !== null) {
                        result.push(`${indent}**${getLabel(k)}:**`);
                        result.push(...formatValue(v, depth + 1));
                    }
                }
            }

            return result;
        };

        // summary/result をトップに配置
        const topKeys = ['summary', 'result', 'response', 'message'];
        for (const key of topKeys) {
            if (key in obj && typeof obj[key] === 'string') {
                lines.push(`**${getLabel(key)}:** ${obj[key]}`);
            }
        }

        // 残りのキーを処理
        for (const [key, value] of Object.entries(obj)) {
            if (topKeys.includes(key) && typeof value === 'string') { continue; }
            if (value === null || value === undefined) { continue; }

            if (typeof value === 'string') {
                lines.push(`**${getLabel(key)}:** ${value}`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                lines.push(`**${getLabel(key)}:** ${value}`);
            } else if (typeof value === 'object') {
                lines.push(`\n**${getLabel(key)}:**`);
                lines.push(...formatValue(value, 0));
            }
        }

        if (lines.length === 0) { return null; }
        return lines.join('\n');
    }

    /** リクエストIDから進捗ファイルパスを生成 */
    createProgressPath(requestId: string): string {
        return path.join(this.ipcDir, `${requestId}_progress.json`);
    }

    /** 進捗ファイルを読み取る（存在しなければ null） */
    async readProgress(progressPath: string): Promise<ProgressUpdate | null> {
        try {
            await fs.promises.access(progressPath, fs.constants.F_OK);
            const content = await fs.promises.readFile(progressPath, 'utf-8');
            if (content.trim().length === 0) { return null; }
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object' && 'status' in parsed) {
                return parsed as ProgressUpdate;
            }
        } catch {
            // ファイルが存在しない or 読み取り中の競合 → null
        }
        return null;
    }

    /** 進捗ファイルをクリーンアップ */
    async cleanupProgress(progressPath: string): Promise<void> {
        try {
            await fs.promises.unlink(progressPath);
            logDebug('FileIpc: progress file cleaned up');
        } catch (e) { logDebug(`FileIpc: cleanupProgress failed: ${e}`); }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
