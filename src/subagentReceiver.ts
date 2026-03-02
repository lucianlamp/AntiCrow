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
        logDebug(`[SubagentReceiver] プロンプト処理開始: from=${prompt.from}`);

        let response: SubagentResponse;

        try {
            if (!this.handler) {
                throw new Error('ハンドラが設定されていません');
            }

            const result = await this.handler(prompt.prompt);

            response = {
                type: 'subagent_response',
                from: this.myName,
                timestamp: Date.now(),
                status: 'success',
                result,
                execution_time_ms: Date.now() - startTime,
            };
        } catch (err) {
            logError(`[SubagentReceiver] プロンプト処理エラー: ${err}`);
            response = {
                type: 'subagent_response',
                from: this.myName,
                timestamp: Date.now(),
                status: 'error',
                result: '',
                execution_time_ms: Date.now() - startTime,
                error: String(err),
            };
        }

        // レスポンスを callback_path に書き込み
        try {
            if (!validateIpcPath(prompt.callback_path, this.ipcDir)) {
                logError(`[SubagentReceiver] パストラバーサル検出: ${prompt.callback_path}`);
                return;
            }
            writeResponse(prompt.callback_path, response, this.ipcDir);
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
    }
}
