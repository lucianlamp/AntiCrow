// ---------------------------------------------------------------------------
// subagentReceiver.ts — サブウィンドウ側のプロンプト受信ロジック
// ---------------------------------------------------------------------------
// 設計書: docs/subagent-communication-design.md v1.1 §13.1
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn, logError } from './logger';
import { SubagentPrompt, SubagentResponse } from './subagentTypes';
import { watchPrompts, writeResponse, validateIpcPath } from './subagentIpc';

/**
 * サブエージェント側で動作するプロンプト受信クラス。
 * メインエージェントからのプロンプトを fs.watch() で検知し、
 * コールバックを呼び出してレスポンスを返す。
 */
export class SubagentReceiver {
    private stopWatcher: (() => void) | null = null;
    private myName: string;
    private ipcDir: string;
    private handler: ((prompt: string) => Promise<string>) | null = null;

    constructor(myName: string, ipcDir: string) {
        this.myName = myName;
        this.ipcDir = ipcDir;
    }

    /**
     * プロンプト受信ハンドラを設定する。
     * ハンドラはプロンプト文字列を受け取り、結果文字列を返す。
     */
    setHandler(handler: (prompt: string) => Promise<string>): void {
        this.handler = handler;
    }

    /**
     * プロンプト監視を開始する。
     */
    start(): void {
        if (this.stopWatcher) {
            logWarn('[SubagentReceiver] 既に監視中です');
            return;
        }

        logDebug(`[SubagentReceiver] 監視開始: myName="${this.myName}"`);

        this.stopWatcher = watchPrompts(
            this.ipcDir,
            this.myName,
            (prompt, filePath) => this.handlePrompt(prompt, filePath),
        );
    }

    /**
     * プロンプト監視を停止する。
     */
    stop(): void {
        if (this.stopWatcher) {
            this.stopWatcher();
            this.stopWatcher = null;
            logDebug('[SubagentReceiver] 監視停止');
        }
    }

    /**
     * 自分がサブエージェントとして動作中かどうかを判定する。
     * ワークスペース名に "-subagent-" が含まれていればサブエージェント。
     */
    static isSubagent(workspaceName: string): boolean {
        return workspaceName.includes('-subagent-');
    }

    // -----------------------------------------------------------------------
    // 内部処理
    // -----------------------------------------------------------------------

    private async handlePrompt(prompt: SubagentPrompt, filePath: string): Promise<void> {
        const startTime = Date.now();
        logDebug(`[SubagentReceiver] ────── プロンプト処理開始 ──────`);
        logDebug(`[SubagentReceiver] from=${prompt.from}, to=${prompt.to}, callback=${path.basename(prompt.callback_path)}`);
        logDebug(`[SubagentReceiver] prompt(150chars)="${prompt.prompt.substring(0, 150)}${prompt.prompt.length > 150 ? '...' : ''}"`);
        logDebug(`[SubagentReceiver] timeout_ms=${prompt.timeout_ms}, handler=${this.handler ? 'set' : 'null'}`);

        let response: SubagentResponse;

        try {
            // ハンドラ未設定の場合、startBridge 完了を待機（最大30秒）
            if (!this.handler) {
                logWarn(`[SubagentReceiver] ⚠️ ハンドラ未設定 — startBridge 完了を待機中 (最大30秒)...`);
                const maxWaitMs = 30_000;
                const pollMs = 1_000;
                const waitStart = Date.now();
                while (!this.handler && Date.now() - waitStart < maxWaitMs) {
                    await new Promise(r => setTimeout(r, pollMs));
                }
                if (!this.handler) {
                    throw new Error(`ハンドラが${maxWaitMs / 1000}秒待機後も設定されていません。startBridge が完了していない可能性があります。`);
                }
                logDebug(`[SubagentReceiver] ✅ ハンドラ設定を確認 (${Date.now() - waitStart}ms 待機)`);
            }

            logDebug(`[SubagentReceiver] ハンドラ呼び出し開始...`);
            const result = await this.handler(prompt.prompt);

            const executionTimeMs = Date.now() - startTime;
            logDebug(`[SubagentReceiver] ✅ プロンプト処理成功: from=${prompt.from}, result=${result.length} chars, elapsed=${Math.round(executionTimeMs / 1000)}秒`);
            response = {
                type: 'subagent_response',
                from: this.myName,
                timestamp: Date.now(),
                status: 'success',
                result,
                execution_time_ms: executionTimeMs,
            };
        } catch (err) {
            const executionTimeMs = Date.now() - startTime;
            logError(`[SubagentReceiver] ❌ プロンプト処理エラー (elapsed=${Math.round(executionTimeMs / 1000)}秒): ${err}`);
            response = {
                type: 'subagent_response',
                from: this.myName,
                timestamp: Date.now(),
                status: 'error',
                result: '',
                execution_time_ms: executionTimeMs,
                error: String(err),
            };
        }

        // レスポンスを callback_path に書き込み
        logDebug(`[SubagentReceiver] レスポンス書き込み開始: status=${response.status}, callback=${prompt.callback_path}`);
        try {
            if (!validateIpcPath(prompt.callback_path, this.ipcDir)) {
                logError(`[SubagentReceiver] パストラバーサル検出: ${prompt.callback_path}`);
                return;
            }
            writeResponse(prompt.callback_path, response, this.ipcDir);
            // 書き込み後の存在確認
            const written = fs.existsSync(prompt.callback_path);
            logDebug(`[SubagentReceiver] レスポンス書き込み完了: status=${response.status}, path=${path.basename(prompt.callback_path)}, exists=${written}, size=${written ? fs.statSync(prompt.callback_path).size : 0}`);
        } catch (err) {
            logError(`[SubagentReceiver] レスポンス書き込みエラー: ${err}`);
        }

        // 処理済みプロンプトファイルを削除
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logDebug(`[SubagentReceiver] プロンプトファイル削除: ${path.basename(filePath)}`);
            }
        } catch (err) {
            logWarn(`[SubagentReceiver] プロンプトファイル削除失敗: ${err}`);
        }
        logDebug(`[SubagentReceiver] ────── 処理完了 ──────`);
    }
}
