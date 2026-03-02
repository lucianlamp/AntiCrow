// ---------------------------------------------------------------------------
// subagentIpc.ts — サブエージェント ファイル IPC ヘルパー
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §3, §4, §10
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn, logError } from './logger';
import { SubagentPrompt, SubagentResponse } from './subagentTypes';

// ---------------------------------------------------------------------------
// セキュリティバリデーション（§10）
// ---------------------------------------------------------------------------

/**
 * IPC ファイルパスが globalStorage/ipc 内に収まっているか検証する。
 * パストラバーサル攻撃を防止。
 */
export function validateIpcPath(filePath: string, ipcDir: string): boolean {
    const resolved = path.resolve(filePath);
    const resolvedIpc = path.resolve(ipcDir);
    return resolved.startsWith(resolvedIpc + path.sep) || resolved === resolvedIpc;
}

/**
 * エージェント名のバリデーション。
 * 英数字・ハイフン・アンダースコアのみ許可。
 */
export function validateAgentName(name: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 64;
}

// ---------------------------------------------------------------------------
// プロンプト書き込み（メインエージェント側）
// ---------------------------------------------------------------------------

/**
 * サブエージェント向けのプロンプトファイルを書き込む。
 *
 * @param ipcDir globalStorage/ipc ディレクトリパス
 * @param prompt 送信するプロンプトデータ
 * @returns 書き込んだファイルのパス
 */
export function writePrompt(ipcDir: string, prompt: SubagentPrompt): string {
    // バリデーション
    if (!validateAgentName(prompt.to)) {
        throw new Error(`無効なエージェント名: "${prompt.to}"`);
    }

    const filename = `subagent_${prompt.to}_prompt_${prompt.timestamp}.json`;
    const filePath = path.join(ipcDir, filename);

    if (!validateIpcPath(filePath, ipcDir)) {
        throw new Error(`パストラバーサル検出: "${filePath}"`);
    }

    // ディレクトリがなければ作成
    if (!fs.existsSync(ipcDir)) {
        fs.mkdirSync(ipcDir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(prompt, null, 2), 'utf-8');
    logDebug(`[subagentIpc] プロンプトを書き込みました: ${filename}`);
    return filePath;
}

// ---------------------------------------------------------------------------
// レスポンス書き込み（サブエージェント側）
// ---------------------------------------------------------------------------

/**
 * レスポンスファイルを書き込む。
 *
 * @param callbackPath レスポンスの書き込み先パス
 * @param response レスポンスデータ
 * @param ipcDir 検証用の ipcDir パス
 */
export function writeResponse(
    callbackPath: string,
    response: SubagentResponse,
    ipcDir: string,
): void {
    if (!validateIpcPath(callbackPath, ipcDir)) {
        throw new Error(`パストラバーサル検出 (response): "${callbackPath}"`);
    }

    fs.writeFileSync(callbackPath, JSON.stringify(response, null, 2), 'utf-8');
    logDebug(`[subagentIpc] レスポンスを書き込みました: ${path.basename(callbackPath)}`);
}

// ---------------------------------------------------------------------------
// レスポンス監視（メインエージェント側）— fs.watch + debounce (§11)
// ---------------------------------------------------------------------------

/**
 * レスポンスファイルの出現を監視する。
 * fs.watch() + debounce で効率的に検知。Windows の重複イベントを吸収。
 * フォールバックとしてポーリングも併用。
 *
 * @param callbackPath 監視するレスポンスファイルパス
 * @param timeoutMs タイムアウト（ミリ秒）
 * @param pollIntervalMs ポーリング間隔（ミリ秒）
 * @returns レスポンスデータ or null（タイムアウト）
 */
export function watchResponse(
    callbackPath: string,
    timeoutMs: number,
    pollIntervalMs: number = 2000,
): Promise<SubagentResponse | null> {
    return new Promise((resolve) => {
        const dir = path.dirname(callbackPath);
        const basename = path.basename(callbackPath);
        let watcher: fs.FSWatcher | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let resolved = false;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            if (resolved) return;
            resolved = true;
            if (watcher) {
                try { watcher.close(); } catch { /* ignore */ }
                watcher = null;
            }
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
        };

        const tryRead = (): SubagentResponse | null => {
            try {
                if (fs.existsSync(callbackPath)) {
                    const data = fs.readFileSync(callbackPath, 'utf-8');
                    const parsed = JSON.parse(data) as SubagentResponse;
                    if (parsed.type === 'subagent_response') {
                        return parsed;
                    }
                }
            } catch (err) {
                logWarn(`[subagentIpc] レスポンス読み取りエラー: ${err}`);
            }
            return null;
        };

        const onDetected = () => {
            const resp = tryRead();
            if (resp) {
                cleanup();
                resolve(resp);
            }
        };

        // fs.watch() でイベント駆動検知（debounce 500ms で Windows 重複イベント吸収）
        try {
            watcher = fs.watch(dir, (_event, filename) => {
                if (filename !== basename) return;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(onDetected, 500);
            });
            watcher.on('error', (err) => {
                logWarn(`[subagentIpc] fs.watch エラー: ${err}。ポーリングにフォールバック`);
                if (watcher) {
                    try { watcher.close(); } catch { /* ignore */ }
                    watcher = null;
                }
            });
        } catch (err) {
            logWarn(`[subagentIpc] fs.watch 初期化失敗: ${err}。ポーリングのみ使用`);
        }

        // ポーリング（フォールバック）
        pollTimer = setInterval(() => {
            if (resolved) return;
            onDetected();
        }, pollIntervalMs);

        // タイムアウト
        timeoutTimer = setTimeout(() => {
            if (resolved) return;
            logWarn(`[subagentIpc] レスポンスタイムアウト (${timeoutMs}ms): ${basename}`);
            cleanup();
            resolve(null);
        }, timeoutMs);

        // 初回チェック（既に存在する場合）
        onDetected();
    });
}

// ---------------------------------------------------------------------------
// プロンプト監視（サブエージェント側）— fs.watch
// ---------------------------------------------------------------------------

/**
 * 自分宛てのプロンプトファイルを監視する。
 * 新着プロンプトが届くと onPrompt コールバックが呼ばれる。
 *
 * @param ipcDir globalStorage/ipc ディレクトリパス
 * @param myName 自分のワークスペース名
 * @param onPrompt プロンプト受信時のコールバック
 * @returns watcher を停止する関数
 */
export function watchPrompts(
    ipcDir: string,
    myName: string,
    onPrompt: (prompt: SubagentPrompt, filePath: string) => void,
): () => void {
    const prefix = `subagent_${myName}_prompt_`;
    let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // ディレクトリがなければ作成
    if (!fs.existsSync(ipcDir)) {
        fs.mkdirSync(ipcDir, { recursive: true });
    }

    const watcher = fs.watch(ipcDir, (_event, filename) => {
        if (!filename || !filename.startsWith(prefix)) return;

        // debounce (500ms) — Windows の重複イベント吸収
        const existing = debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        debounceTimers.set(filename, setTimeout(() => {
            debounceTimers.delete(filename);
            const filePath = path.join(ipcDir, filename);

            try {
                if (!fs.existsSync(filePath)) return;
                const data = fs.readFileSync(filePath, 'utf-8');
                const parsed = JSON.parse(data) as SubagentPrompt;

                if (parsed.type !== 'subagent_prompt' || parsed.to !== myName) {
                    logWarn(`[subagentIpc] 無効なプロンプト (type=${parsed.type}, to=${parsed.to})`);
                    return;
                }

                logDebug(`[subagentIpc] プロンプト受信: ${filename}`);
                onPrompt(parsed, filePath);
            } catch (err) {
                logError(`[subagentIpc] プロンプト処理エラー: ${err}`);
            }
        }, 500));
    });

    watcher.on('error', (err) => {
        logError(`[subagentIpc] プロンプト監視エラー: ${err}`);
    });

    logDebug(`[subagentIpc] プロンプト監視を開始: prefix="${prefix}"`);

    // クリーンアップ関数を返す
    return () => {
        try {
            watcher.close();
        } catch { /* ignore */ }
        for (const timer of debounceTimers.values()) {
            clearTimeout(timer);
        }
        debounceTimers.clear();
        logDebug('[subagentIpc] プロンプト監視を停止');
    };
}
