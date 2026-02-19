// ---------------------------------------------------------------------------
// logger.ts — OutputChannel ロガー + ログレベルフィルタリング
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';

/** ログレベル定義（数値が大きいほど重要） */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

let channel: vscode.OutputChannel | undefined;
let currentLevel: LogLevel = LogLevel.INFO;

export function initLogger(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('AntiCrow');
    }
    return channel;
}

/** ログレベルを設定する。設定レベル未満のメッセージは出力されない。 */
export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

/** 現在のログレベルを取得する */
export function getLogLevel(): LogLevel {
    return currentLevel;
}

function ts(): string {
    return new Date().toISOString();
}

export function logInfo(msg: string): void {
    if (currentLevel > LogLevel.INFO) { return; }
    channel?.appendLine(`[INFO  ${ts()}] ${msg}`);
}

export function logWarn(msg: string): void {
    if (currentLevel > LogLevel.WARN) { return; }
    channel?.appendLine(`[WARN  ${ts()}] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
    // ERROR は常に出力（最高レベル）
    const detail = err instanceof Error ? ` | ${err.message}` : '';
    channel?.appendLine(`[ERROR ${ts()}] ${msg}${detail}`);
}

export function logDebug(msg: string): void {
    if (currentLevel > LogLevel.DEBUG) { return; }
    channel?.appendLine(`[DEBUG ${ts()}] ${msg}`);
}

export function disposeLogger(): void {
    channel?.dispose();
    channel = undefined;
}
