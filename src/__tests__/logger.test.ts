// ---------------------------------------------------------------------------
// logger.test.ts — ログレベルフィルタリングテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vscode モジュールをモック
vi.mock('vscode', () => {
    const lines: string[] = [];
    return {
        window: {
            createOutputChannel: () => ({
                appendLine: (line: string) => lines.push(line),
                dispose: () => { lines.length = 0; },
            }),
        },
        // テスト用: 出力行にアクセス
        __test_lines: lines,
    };
});

import { initLogger, logInfo, logWarn, logError, logDebug, setLogLevel, getLogLevel, LogLevel, disposeLogger } from '../logger';
import * as vscode from 'vscode';

describe('Logger', () => {
    beforeEach(() => {
        // ログラインクリア
        (vscode as any).__test_lines.length = 0;
        setLogLevel(LogLevel.DEBUG);
        initLogger();
    });

    it('should output all levels at DEBUG', () => {
        logDebug('debug msg');
        logInfo('info msg');
        logWarn('warn msg');
        logError('error msg');

        const lines = (vscode as any).__test_lines as string[];
        expect(lines.length).toBe(4);
        expect(lines[0]).toContain('[DEBUG');
        expect(lines[1]).toContain('[INFO');
        expect(lines[2]).toContain('[WARN');
        expect(lines[3]).toContain('[ERROR');
    });

    it('should filter DEBUG when level is INFO', () => {
        setLogLevel(LogLevel.INFO);
        expect(getLogLevel()).toBe(LogLevel.INFO);

        logDebug('should not appear');
        logInfo('should appear');

        const lines = (vscode as any).__test_lines as string[];
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain('[INFO');
    });

    it('should filter DEBUG and INFO when level is WARN', () => {
        setLogLevel(LogLevel.WARN);

        logDebug('no');
        logInfo('no');
        logWarn('yes');
        logError('yes');

        const lines = (vscode as any).__test_lines as string[];
        expect(lines.length).toBe(2);
    });

    it('should always output ERROR regardless of level', () => {
        setLogLevel(LogLevel.ERROR);

        logDebug('no');
        logInfo('no');
        logWarn('no');
        logError('always');

        const lines = (vscode as any).__test_lines as string[];
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain('[ERROR');
    });

    it('should include error details when provided', () => {
        logError('test error', new Error('detail message'));

        const lines = (vscode as any).__test_lines as string[];
        expect(lines[0]).toContain('detail message');
    });

    it('should include timestamps', () => {
        logInfo('timestamp test');

        const lines = (vscode as any).__test_lines as string[];
        // ISO 8601 timestamp pattern
        expect(lines[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
});
