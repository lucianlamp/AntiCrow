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
import { logDebug, logWarn, logError } from './logger';
import { t } from './i18n';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** レスポンスファイルの最大サイズ（バイト） */
const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024;
/** ファイル出現後の書き込み安定待機（ms） */
const WRITE_SETTLE_MS = 200;
/** ポーリング間隔（ms） */
const POLL_INTERVAL_MS = 500;

/** ワークスペース名をファイル名に安全に使えるようサニタイズする */
export function sanitizeWorkspaceName(name?: string): string {
    if (!name) { return ''; }
    // 特殊文字を除去し、英数字・ハイフン・アンダースコアのみ残す
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
}

/** stale レスポンスの情報 */
export interface StaleResponse {
    requestId: string;
    content: string;
    format: 'json' | 'md';
    filePath: string;
    /** 元の送信先チャンネルID（meta ファイルから取得） */
    channelId?: string;
    /** 元のワークスペース名（meta ファイルから取得、カテゴリ特定に使用） */
    workspaceName?: string;
    /** meta ファイルのパス（クリーンアップ用） */
    metaFilePath?: string;
}

export class FileIpc {
    private readonly ipcDir: string;
    private readonly storagePath: string;
    /** waitForResponse が待機中のリクエストID集合（誤削除防止） */
    private readonly activeRequests = new Set<string>();
    /** 削除から保護するファイル名（basename）の集合 */
    private readonly protectedFiles = new Set<string>();

    constructor(storageUri: vscode.Uri) {
        this.storagePath = storageUri.fsPath;
        this.ipcDir = path.join(this.storagePath, 'ipc');
    }

    /** IPC ディレクトリを初期化 */
    async init(): Promise<void> {
        await fs.promises.mkdir(this.ipcDir, { recursive: true });
        logDebug(`FileIpc: initialized IPC directory at ${this.ipcDir}`);
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
    createRequestId(workspaceName?: string): { requestId: string; responsePath: string } {
        const wsPrefix = sanitizeWorkspaceName(workspaceName);
        const requestId = wsPrefix
            ? `req_${wsPrefix}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`
            : `req_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        const responsePath = path.join(this.ipcDir, `${requestId}_response.json`);
        return { requestId, responsePath };
    }

    /** リクエスト ID を生成し、Markdown レスポンスファイルのパスを返す（実行結果用） */
    createMarkdownRequestId(workspaceName?: string): { requestId: string; responsePath: string } {
        const wsPrefix = sanitizeWorkspaceName(workspaceName);
        const requestId = wsPrefix
            ? `req_${wsPrefix}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`
            : `req_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
        const responsePath = path.join(this.ipcDir, `${requestId}_response.md`);
        return { requestId, responsePath };
    }

    /** リクエストメタデータ（channelId, workspaceName 等）をサイドカーファイルに書き込む */
    writeRequestMeta(requestId: string, channelId: string, workspaceName?: string): void {
        const metaPath = path.join(this.ipcDir, `${requestId}_meta.json`);
        try {
            const meta: Record<string, string> = { channelId };
            if (workspaceName) { meta.workspaceName = workspaceName; }
            fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
            logDebug(`FileIpc: wrote request meta: ${requestId} → channel ${channelId}, workspace ${workspaceName ?? 'none'}`);
        } catch (e) {
            logDebug(`FileIpc: failed to write request meta: ${e}`);
        }
    }

    // -----------------------------------------------------------------
    // アクティブリクエスト管理（cleanupOldFiles 誤削除防止）
    // -----------------------------------------------------------------

    /** waitForResponse 開始時にリクエストIDを登録（関連 tmp ファイルも保護対象に追加可能） */
    registerActiveRequest(requestId: string, associatedFiles?: string[]): void {
        this.activeRequests.add(requestId);
        if (associatedFiles) {
            for (const f of associatedFiles) {
                const basename = path.basename(f);
                this.protectedFiles.add(basename);
                logDebug(`FileIpc: protecting associated file: ${basename}`);
            }
        }
        logDebug(`FileIpc: registered active request: ${requestId} (protected files: ${this.protectedFiles.size})`);
    }

    /** waitForResponse 完了後にリクエストIDを解除（関連 tmp ファイルの保護も解除） */
    unregisterActiveRequest(requestId: string, associatedFiles?: string[]): void {
        this.activeRequests.delete(requestId);
        if (associatedFiles) {
            for (const f of associatedFiles) {
                this.protectedFiles.delete(path.basename(f));
            }
        }
        logDebug(`FileIpc: unregistered active request: ${requestId} (protected files: ${this.protectedFiles.size})`);
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

        logDebug(`FileIpc: waiting for response at ${responsePath} (timeout=${timeoutMs}ms, fs.watch + polling fallback)`);

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
                        logDebug('FileIpc: waitForResponse aborted by signal');
                        reject(new Error('FileIpc: aborted'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }

            const tryReadResponse = async (): Promise<boolean> => {
                if (settled) { return true; }
                try {
                    await fs.promises.access(responsePath, fs.constants.F_OK);
                    // ファイルが存在する → 少し待ってから読み取り（書き込み完了を待つ）
                    await this.sleep(WRITE_SETTLE_MS);

                    // 二重解決防止: readFile 前に settled フラグを先行設定
                    // （fs.watch とポーリングの同時検出レース対策）
                    settled = true;

                    const content = await fs.promises.readFile(responsePath, 'utf-8');

                    // セキュリティ: レスポンスサイズ制限（5MB）
                    const MAX_RESPONSE_SIZE = MAX_RESPONSE_SIZE_BYTES;
                    if (content.length > MAX_RESPONSE_SIZE) {
                        logError(`FileIpc: response file too large (${content.length} bytes > ${MAX_RESPONSE_SIZE}). Truncating.`);
                        try { await fs.promises.unlink(responsePath); } catch (e) { logDebug(`FileIpc: failed to unlink truncated response: ${e}`); }
                        cleanup(); resolve(content.substring(0, MAX_RESPONSE_SIZE));
                        return true;
                    }

                    // 空ファイルの場合はまだ書き込み中の可能性
                    if (content.trim().length === 0) {
                        logDebug('FileIpc: file exists but is empty, waiting...');
                        settled = false; // 空ファイルの場合はフラグを戻す
                        return false;
                    }

                    logDebug(`FileIpc: response received (${content.length} chars)`);

                    // クリーンアップは cleanupOldFiles に任せる（早期削除防止）

                    cleanup(); resolve(content);
                    return true;
                } catch {
                    // ファイルがまだ存在しない — settled を戻す
                    settled = false;
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

            // --- 即時チェック: 既にファイルが存在する場合に即座に検出 ---
            tryReadResponse();

            // --- フォールバック: ポーリング（1秒間隔） ---
            pollTimer = setInterval(async () => {
                if (settled) { return; }
                await checkProgress();
                await tryReadResponse();
            }, POLL_INTERVAL_MS);

            // --- タイムアウト監視（1秒間隔でチェック）: timeoutMs=0 は無制限 ---
            if (timeoutMs > 0) {
                timeoutTimer = setInterval(async () => {
                    if (settled) { return; }
                    if (Date.now() - lastActivityTime >= timeoutMs) {
                        const totalElapsedMs = Date.now() - lastActivityTime;
                        const totalElapsedSec = Math.round(totalElapsedMs / 1000);
                        const progressInfo = lastProgressMtime > 0
                            ? `last progress ${Math.round((Date.now() - lastProgressMtime) / 1000)}s ago`
                            : 'no progress received';

                        // レスポンスファイルの存在チェック（メトリクス用）
                        let responseFileExists = false;
                        try {
                            await fs.promises.access(responsePath, fs.constants.F_OK);
                            responseFileExists = true;
                        } catch { /* not found */ }

                        settled = true;
                        cleanup();

                        // ログ強化: logWarn でメトリクス出力
                        logWarn(`FileIpc: waitForResponse TIMEOUT — elapsed=${totalElapsedSec}s, timeout=${timeoutMs}ms, ${progressInfo}, responseFileExists=${responseFileExists}, path=${responsePath}`);

                        // タイムアウトしたレスポンスファイルは削除しない（stale recovery でピックアップするため残す）
                        if (responseFileExists) {
                            logDebug('FileIpc: timed-out response file exists — leaving for stale recovery');
                        }

                        reject(new IpcTimeoutError(`FileIpc: response timeout (${timeoutMs}ms, ${progressInfo}) — file never appeared at ${responsePath}`));
                    }
                }, POLL_INTERVAL_MS);
            } // if (timeoutMs > 0)
        });
    }

    /**
     * パターンベースのレスポンス待機。
     * primaryPath を優先して監視しつつ、見つからない場合は
     * IPC ディレクトリ内の fallbackPattern に一致するファイルも検索する。
     *
     * チームモードのサブエージェントが instruction.json の response_path ではなく
     * 独自のパスにレスポンスを書き込むケースに対応する。
     */
    async waitForResponseWithPattern(
        primaryPath: string,
        fallbackPattern: RegExp,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<string> {
        let lastActivityTime = Date.now();

        const progressPatternRe = /_response\.(json|md)$/;
        const progressPath = primaryPath.replace(progressPatternRe, '_progress.json');
        let lastProgressMtime = 0;
        const dir = path.dirname(primaryPath);
        const filename = path.basename(primaryPath);
        const progressFilename = path.basename(progressPath);

        logDebug(`FileIpc: waitForResponseWithPattern — primary=${filename}, fallback=${fallbackPattern.source} (timeout=${timeoutMs}ms)`);

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

            if (signal) {
                const onAbort = () => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        logDebug('FileIpc: waitForResponseWithPattern aborted by signal');
                        reject(new Error('FileIpc: aborted'));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }

            const tryReadAt = async (targetPath: string): Promise<string | null> => {
                try {
                    await fs.promises.access(targetPath, fs.constants.F_OK);
                    await this.sleep(WRITE_SETTLE_MS);
                    const content = await fs.promises.readFile(targetPath, 'utf-8');
                    if (content.trim().length === 0) { return null; }
                    if (content.length > MAX_RESPONSE_SIZE_BYTES) {
                        logError(`FileIpc: response file too large (${content.length} bytes). Truncating.`);
                        try { await fs.promises.unlink(targetPath); } catch { /* ignore */ }
                        return content.substring(0, MAX_RESPONSE_SIZE_BYTES);
                    }
                    // クリーンアップは cleanupOldFiles に任せる（早期削除防止）
                    return content;
                } catch {
                    return null;
                }
            };

            const tryReadResponse = async (): Promise<boolean> => {
                if (settled) { return true; }

                // 1. primaryPath を直接チェック
                const primaryContent = await tryReadAt(primaryPath);
                if (primaryContent !== null) {
                    settled = true;
                    logDebug(`FileIpc: response at primary path (${primaryContent.length} chars)`);
                    cleanup(); resolve(primaryContent);
                    return true;
                }

                // 2. fallbackPattern でディレクトリ内を検索
                try {
                    const files = await fs.promises.readdir(dir);
                    for (const f of files) {
                        if (fallbackPattern.test(f)) {
                            const fallbackPath = path.join(dir, f);
                            const fallbackContent = await tryReadAt(fallbackPath);
                            if (fallbackContent !== null) {
                                settled = true;
                                logDebug(`FileIpc: response at fallback: ${f} (${fallbackContent.length} chars)`);
                                cleanup(); resolve(fallbackContent);
                                return true;
                            }
                        }
                    }
                } catch { /* readdir failure */ }

                return false;
            };

            const checkProgress = async () => {
                // primary の進捗ファイル
                try {
                    const progressStat = await fs.promises.stat(progressPath);
                    if (progressStat.mtimeMs > lastProgressMtime) {
                        if (lastProgressMtime > 0) {
                            logDebug(`FileIpc: progress updated, resetting timeout`);
                        }
                        lastProgressMtime = progressStat.mtimeMs;
                        lastActivityTime = Date.now();
                    }
                } catch { /* progress file not found */ }

                // fallbackPattern に一致する進捗ファイルもチェック
                try {
                    const files = await fs.promises.readdir(dir);
                    for (const f of files) {
                        if (f.endsWith('_progress.json') && fallbackPattern.test(f.replace('_progress.json', '_response.md'))) {
                            const fbPath = path.join(dir, f);
                            const stat = await fs.promises.stat(fbPath);
                            if (stat.mtimeMs > lastProgressMtime) {
                                lastProgressMtime = stat.mtimeMs;
                                lastActivityTime = Date.now();
                                logDebug(`FileIpc: fallback progress updated: ${f}`);
                            }
                        }
                    }
                } catch { /* ignore */ }
            };

            // fs.watch
            try {
                watcher = fs.watch(dir, async (_event, changedFile) => {
                    if (settled) { return; }
                    if (changedFile === filename || (changedFile && fallbackPattern.test(changedFile))) {
                        await tryReadResponse();
                    } else if (changedFile === progressFilename || (changedFile && changedFile.endsWith('_progress.json'))) {
                        await checkProgress();
                    }
                });
                watcher.on('error', (err) => {
                    logWarn(`FileIpc: fs.watch error: ${err.message}`);
                    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
                });
            } catch (e) {
                logWarn(`FileIpc: fs.watch failed: ${e instanceof Error ? e.message : e}`);
            }

            tryReadResponse();

            pollTimer = setInterval(async () => {
                if (settled) { return; }
                await checkProgress();
                await tryReadResponse();
            }, POLL_INTERVAL_MS);

            timeoutTimer = setInterval(async () => {
                if (settled) { return; }
                if (Date.now() - lastActivityTime >= timeoutMs) {
                    settled = true;
                    cleanup();
                    const progressInfo = lastProgressMtime > 0
                        ? `last progress ${Math.round((Date.now() - lastProgressMtime) / 1000)}s ago`
                        : 'no progress received';
                    logWarn(`FileIpc: waitForResponseWithPattern TIMEOUT — ${progressInfo}, primary=${filename}`);
                    reject(new IpcTimeoutError(`FileIpc: response timeout (${timeoutMs}ms, ${progressInfo})`));
                }
            }, POLL_INTERVAL_MS);
        });
    }

    // -----------------------------------------------------------------
    // stale レスポンスリカバリー
    // -----------------------------------------------------------------


    /**
     * 起動時に未回収のレスポンスファイルを検出して返却する。
     * ファイルは削除せずに返却し、呼び出し元が処理後に明示的に削除する。
     */
    async recoverStaleResponses(): Promise<StaleResponse[]> {
        const staleResponses: StaleResponse[] = [];
        try {
            const files = await fs.promises.readdir(this.ipcDir);
            for (const f of files) {
                // req_*_response.json or req_*_response.md パターンにマッチ
                // ワークスペースプレフィックス付き（req_{ws}_{ts}_{uuid}）も後方互換でマッチ
                const match = f.match(/^(req_(?:[a-zA-Z0-9_-]+_)?\d+_[a-f0-9]+)_response\.(json|md)$/);
                if (!match) { continue; }

                const requestId = match[1];
                const format = match[2] as 'json' | 'md';
                const fp = path.join(this.ipcDir, f);

                try {
                    const content = await fs.promises.readFile(fp, 'utf-8');
                    if (content.trim().length === 0) {
                        logDebug(`FileIpc: skipping empty stale response: ${f}`);
                        continue;
                    }

                    // メタデータファイルから channelId, workspaceName を読み取り
                    let channelId: string | undefined;
                    let workspaceName: string | undefined;
                    let metaFilePath: string | undefined;
                    const metaPath = path.join(this.ipcDir, `${requestId}_meta.json`);
                    try {
                        const metaContent = await fs.promises.readFile(metaPath, 'utf-8');
                        const meta = JSON.parse(metaContent);
                        if (meta && typeof meta.channelId === 'string') {
                            channelId = meta.channelId;
                            metaFilePath = metaPath;
                        }
                        if (meta && typeof meta.workspaceName === 'string') {
                            workspaceName = meta.workspaceName;
                        }
                        logDebug(`FileIpc: stale response meta found — channelId=${channelId}, workspaceName=${workspaceName ?? 'none'}`);
                    } catch {
                        // meta ファイルなし（後方互換）
                    }

                    staleResponses.push({ requestId, content, format, filePath: fp, channelId, workspaceName, metaFilePath });
                    logWarn(`FileIpc: found stale response: ${f} (${content.length} chars, channelId=${channelId ?? 'none'}, workspace=${workspaceName ?? 'none'})`);
                } catch (e) {
                    logDebug(`FileIpc: failed to read stale response ${f}: ${e}`);
                }
            }
        } catch (e) {
            logDebug(`FileIpc: recoverStaleResponses readdir failed: ${e}`);
        }
        return staleResponses;
    }

    /** stale レスポンスファイルと関連 meta ファイルを安全に削除する */
    async cleanupStaleResponse(filePath: string, metaFilePath?: string): Promise<void> {
        try {
            await fs.promises.unlink(filePath);
            logDebug(`FileIpc: cleaned up stale response: ${path.basename(filePath)}`);
        } catch (e) {
            logDebug(`FileIpc: failed to clean up stale response: ${e}`);
        }
        if (metaFilePath) {
            try {
                await fs.promises.unlink(metaFilePath);
                logDebug(`FileIpc: cleaned up stale meta: ${path.basename(metaFilePath)}`);
            } catch (e) {
                logDebug(`FileIpc: failed to clean up stale meta: ${e}`);
            }
        }
    }

    // -----------------------------------------------------------------
    // ファイルクリーンアップ
    // -----------------------------------------------------------------

    /**
     * 古い IPC ファイルをクリーンアップ。
     * - tmp_* は 30分以上で削除（チームモードのサブエージェント実行に対応）
     * - req_*_progress.json は 30分以上で削除
     * - req_*_response.* は 60分以上で削除（stale recovery 間隔より長く設定）
     * - その他は 30分以上で削除
     * - activeRequests に含まれるファイルはスキップ（誤削除防止）
     * - protectedFiles に含まれるファイルはスキップ（tmp ファイル保護）
     */
    async cleanupOldFiles(): Promise<void> {
        try {
            const files = await fs.promises.readdir(this.ipcDir);
            const now = Date.now();
            for (const f of files) {
                const fp = path.join(this.ipcDir, f);
                try {
                    // activeRequests 保護: 待機中のリクエストに関連するファイルはスキップ
                    let isActive = false;
                    for (const activeId of this.activeRequests) {
                        if (f.startsWith(activeId)) {
                            logDebug(`FileIpc: skipping active request file: ${f}`);
                            isActive = true;
                            break;
                        }
                    }
                    if (isActive) { continue; }

                    // protectedFiles 保護: 明示的に保護されたファイル名はスキップ
                    if (this.protectedFiles.has(f)) {
                        logDebug(`FileIpc: skipping protected file: ${f}`);
                        continue;
                    }

                    const stat = await fs.promises.stat(fp);
                    const ageMs = now - stat.mtimeMs;

                    // tmp_* 系（一時プロンプト/ルール/グローバルファイル）: 30分以上で削除
                    if (f.startsWith('tmp_') && ageMs > 30 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up tmp file ${f}`);
                        continue;
                    }

                    // team_* 系（タスクリスト・個別ステータスファイル）: 60分以上で削除
                    // チームモード実行中はアクティブなため、十分な猶予を設ける
                    if (f.startsWith('team_') && ageMs <= 60 * 60 * 1000) {
                        continue; // 60分以内はスキップ
                    }
                    if (f.startsWith('team_') && ageMs > 60 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up team file ${f}`);
                        continue;
                    }

                    // req_*_progress.json: 応答完了後30分で削除
                    if (f.includes('_progress.json') && ageMs > 30 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up progress file ${f}`);
                        continue;
                    }

                    // req_*_response.*: 60分以上で削除（stale recovery 間隔より長く設定）
                    if (f.includes('_response.') && ageMs > 60 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up old response file ${f}`);
                        continue;
                    }

                    // req_*_meta.json: response と同じ 60分閾値で削除
                    if (f.includes('_meta.json') && ageMs > 60 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up old meta file ${f}`);
                        continue;
                    }

                    // その他（response/meta 以外）: 30分以上前のファイル
                    if (!f.includes('_response.') && !f.includes('_meta.json') && ageMs > 30 * 60 * 1000) {
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up old file ${f}`);
                    }
                } catch (e) { logDebug(`FileIpc: failed to clean up old file ${f}: ${e}`); }
            }
        } catch (e) { logDebug(`FileIpc: cleanupOldFiles readdir failed: ${e}`); }
    }

    /** tmp_* 系ファイルをクリーンアップ（プロンプト送信後に呼ぶ）
     * @param excludeFiles 削除から除外するファイルパスの配列
     * @param minAgeMs 削除対象の最小経過時間（ミリ秒）。デフォルト5分。
     *                 作成から minAgeMs 未満のファイルは削除をスキップする。
     *                 requires_confirmation: false や連続オートモードで
     *                 前のリクエストの tmp ファイルが早期削除されるのを防ぐ。
     */
    async cleanupTmpFiles(excludeFiles?: string[], minAgeMs: number = 5 * 60 * 1000): Promise<void> {
        const excludeSet = excludeFiles ? new Set(excludeFiles.map(f => path.basename(f))) : null;
        const now = Date.now();
        try {
            const files = await fs.promises.readdir(this.ipcDir);
            for (const f of files) {
                if (f.startsWith('tmp_')) {
                    if (excludeSet && excludeSet.has(f)) {
                        logDebug(`FileIpc: skipping excluded tmp file ${f}`);
                        continue;
                    }
                    // protectedFiles 保護: 明示的に保護されたファイル名はスキップ
                    if (this.protectedFiles.has(f)) {
                        logDebug(`FileIpc: skipping protected tmp file ${f}`);
                        continue;
                    }
                    const fp = path.join(this.ipcDir, f);
                    try {
                        const stat = await fs.promises.stat(fp);
                        // age-based 保護: 作成から minAgeMs 未満のファイルはスキップ
                        if (now - stat.mtimeMs < minAgeMs) {
                            logDebug(`FileIpc: skipping young tmp file ${f} (age=${Math.round((now - stat.mtimeMs) / 1000)}s)`);
                            continue;
                        }
                        await fs.promises.unlink(fp);
                        logDebug(`FileIpc: cleaned up tmp file ${f}`);
                    } catch (e) { logDebug(`FileIpc: failed to clean up tmp ${f}: ${e}`); }
                }
            }
        } catch (e) { logDebug(`FileIpc: cleanupTmpFiles failed: ${e}`); }
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

        // キー名のローカライズラベルマッピング
        const labelMap: Record<string, string> = {
            summary: t('ipc.label.summary'),
            result: t('ipc.label.result'),
            changes: t('ipc.label.changes'),
            files_modified: t('ipc.label.files_modified'),
            files_created: t('ipc.label.files_created'),
            files_deleted: t('ipc.label.files_deleted'),
            details: t('ipc.label.details'),
            impact: t('ipc.label.impact'),
            test_results: t('ipc.label.test_results'),
            deploy: t('ipc.label.deploy'),
            notes: t('ipc.label.notes'),
            warnings: t('ipc.label.warnings'),
            errors: t('ipc.label.errors'),
            status: t('ipc.label.status'),
            description: t('ipc.label.description'),
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
