/**
 * ファイルベース IPC モジュール
 *
 * Antigravity にプロンプトで「結果をファイルに書き込め」と指示し、
 * Extension 側はファイルの出現を監視して応答を取得する。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProgressUpdate } from './types';
import { logInfo, logDebug, logWarn, logError } from './logger';

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

    /** リクエスト ID を生成し、レスポンスファイルのパスを返す */
    createRequestId(): { requestId: string; responsePath: string } {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const responsePath = path.join(this.ipcDir, `${requestId}_response.json`);
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
    async waitForResponse(responsePath: string, timeoutMs: number): Promise<string> {
        const pollInterval = 500;
        let lastActivityTime = Date.now();

        // 進捗ファイルのパスを responsePath から導出
        // 例: req_xxx_response.json → req_xxx_progress.json
        const progressPath = responsePath.replace(/_response\.json$/, '_progress.json');
        let lastProgressMtime = 0;

        logInfo(`FileIpc: waiting for response at ${responsePath} (timeout=${timeoutMs}ms, progress-aware)`);

        while (Date.now() - lastActivityTime < timeoutMs) {
            // 1. 進捗ファイルの mtime をチェックしてタイムアウトをリセット
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
                // 進捗ファイルがまだ存在しない → 従来通りのタイムアウト動作
            }

            // 2. レスポンスファイルの存在をチェック
            try {
                await fs.promises.access(responsePath, fs.constants.F_OK);
                // ファイルが存在する → 少し待ってから読み取り（書き込み完了を待つ）
                await this.sleep(500);

                const content = await fs.promises.readFile(responsePath, 'utf-8');

                // セキュリティ: レスポンスサイズ制限（5MB）
                const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
                if (content.length > MAX_RESPONSE_SIZE) {
                    logError(`FileIpc: response file too large (${content.length} bytes > ${MAX_RESPONSE_SIZE}). Truncating.`);
                    // クリーンアップして切り詰め版を返す
                    try { await fs.promises.unlink(responsePath); } catch { /* ignore */ }
                    return content.substring(0, MAX_RESPONSE_SIZE);
                }

                // 空ファイルの場合はまだ書き込み中の可能性
                if (content.trim().length === 0) {
                    logDebug('FileIpc: file exists but is empty, waiting...');
                    await this.sleep(1_000);
                    continue;
                }

                logInfo(`FileIpc: response received (${content.length} chars)`);

                // クリーンアップ
                try {
                    await fs.promises.unlink(responsePath);
                    logDebug('FileIpc: response file cleaned up');
                } catch {
                    logWarn('FileIpc: failed to clean up response file');
                }

                return content;
            } catch {
                // ファイルがまだ存在しない
            }

            await this.sleep(pollInterval);
        }

        // タイムアウト — 経過時間を計算してログに含める
        const elapsedSec = Math.round((Date.now() - lastActivityTime) / 1000);
        const totalElapsed = lastProgressMtime > 0
            ? `last progress ${Math.round((Date.now() - lastProgressMtime) / 1000)}s ago`
            : 'no progress received';

        // タイムアウトしたレスポンスファイルがあれば削除
        try {
            await fs.promises.access(responsePath, fs.constants.F_OK);
            await fs.promises.unlink(responsePath);
            logDebug('FileIpc: cleaned up timed-out response file');
        } catch { /* file doesn't exist, OK */ }

        throw new Error(`FileIpc: response timeout (${timeoutMs}ms, ${totalElapsed}) — file never appeared at ${responsePath}`);
    }

    /** 古い IPC ファイルをクリーンアップ（5分以上前のファイル） */
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
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    /**
     * レスポンス文字列から response / result / reply フィールドを抽出する。
     * JSON `{"response":"..."}` or `{"result":"..."}` or `{"reply":"..."}` 形式の場合はその値を返し、
     * それ以外の場合は元の文字列をそのまま返す。
     */
    static extractResult(raw: string): string {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                if ('response' in parsed) {
                    return String(parsed.response);
                }
                if ('result' in parsed) {
                    return String(parsed.result);
                }
                if ('reply' in parsed) {
                    return String(parsed.reply);
                }
            }
        } catch {
            // JSON でなければそのまま返す
        }
        return raw;
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
        } catch { /* ignore */ }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
