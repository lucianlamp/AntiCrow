// ---------------------------------------------------------------------------
// fileIpc.test.ts — FileIpc.extractResult テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// vscode モジュールをモック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
    },
}));

// FileIpc は静的メソッドなので直接インポート
import { FileIpc } from '../fileIpc';

describe('FileIpc.extractResult', () => {
    // ----- 既知キーからの値抽出 -----

    it('should extract "summary" key (highest priority)', () => {
        const raw = JSON.stringify({
            summary: 'This is a long enough summary text for testing purposes',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This is a long enough summary text for testing purposes',
        );
    });

    it('should extract "response" key', () => {
        const raw = JSON.stringify({
            response: 'This is a response value that is long enough',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This is a response value that is long enough',
        );
    });

    it('should extract "result" key', () => {
        const raw = JSON.stringify({
            result: 'This result string is definitely long enough to pass',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This result string is definitely long enough to pass',
        );
    });

    it('should extract "message" key', () => {
        const raw = JSON.stringify({
            message: 'This message text is sufficiently long for testing',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This message text is sufficiently long for testing',
        );
    });

    it('should prioritize summary over response', () => {
        const raw = JSON.stringify({
            response: 'This is a long response value for testing purposes',
            summary: 'This is a long summary value for testing purposes here',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This is a long summary value for testing purposes here',
        );
    });

    // ----- 短い値 vs 長い値の選択ロジック -----

    it('should use longer string value when known key is short', () => {
        const raw = JSON.stringify({
            summary: 'short',
            data: 'This unknown key has a much longer value that should be preferred',
        });
        const result = FileIpc.extractResult(raw);
        expect(result).toBe(
            'This unknown key has a much longer value that should be preferred',
        );
    });

    it('should return short known key if no longer alternatives', () => {
        const raw = JSON.stringify({
            summary: 'ok',
            count: 42,
        });
        expect(FileIpc.extractResult(raw)).toBe('ok');
    });

    // ----- フォールバック（単一文字列値） -----

    it('should fallback to single string value from unknown schema', () => {
        const raw = JSON.stringify({
            custom_field: 'This is the only string value in this object',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This is the only string value in this object',
        );
    });

    it('should return raw JSON when multiple unknown string values exist', () => {
        const raw = JSON.stringify({
            field_a: 'value a',
            field_b: 'value b',
        });
        // 複数の文字列値がある場合、raw JSON を返す
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    // ----- 非JSON入力 -----

    it('should return raw string for non-JSON input', () => {
        const raw = 'This is just plain text, not JSON';
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    it('should return raw string for markdown content', () => {
        const raw = '## Heading\n- item 1\n- item 2';
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    it('should return raw string when JSON parse fails', () => {
        const raw = '{ invalid json }}}';
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    // ----- 空入力 / エッジケース -----

    it('should return raw string for empty object', () => {
        const raw = '{}';
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    it('should return raw string for array JSON', () => {
        const raw = '[1, 2, 3]';
        expect(FileIpc.extractResult(raw)).toBe(raw);
    });

    it('should return raw string for empty input', () => {
        expect(FileIpc.extractResult('')).toBe('');
    });

    it('should handle whitespace around JSON', () => {
        const raw = '  { "summary": "This is a long enough whitespace-padded summary" }  ';
        expect(FileIpc.extractResult(raw)).toBe(
            'This is a long enough whitespace-padded summary',
        );
    });

    // ----- 数値/boolean/null 値の無視 -----

    it('should ignore non-string values', () => {
        const raw = JSON.stringify({
            count: 42,
            active: true,
            data: null,
            result: 'This is the only useful string result value here',
        });
        expect(FileIpc.extractResult(raw)).toBe(
            'This is the only useful string result value here',
        );
    });

    // ----- 複雑なネストJSON展開 -----

    it('should format complex nested JSON with summary + changes', () => {
        const raw = JSON.stringify({
            result: 'success',
            summary: 'タスク完了しました。',
            changes: {
                files_modified: ['file1.ts', 'file2.ts'],
                details: [
                    { section: 'セクション1', change: '変更内容1' },
                ],
            },
        });
        const result = FileIpc.extractResult(raw);
        expect(result).toContain('📋 概要');
        expect(result).toContain('タスク完了しました。');
        expect(result).toContain('📝 変更内容');
        expect(result).toContain('file1.ts');
        expect(result).toContain('file2.ts');
        expect(result).toContain('セクション1');
    });

    it('should format JSON with test_results and deploy', () => {
        const raw = JSON.stringify({
            summary: 'デプロイ完了',
            test_results: { typecheck: 'pass', tests: '96 passed' },
            deploy: { status: '完了', method: 'VSIX' },
        });
        const result = FileIpc.extractResult(raw);
        expect(result).toContain('🧪 テスト結果');
        expect(result).toContain('96 passed');
        expect(result).toContain('🚀 デプロイ');
        expect(result).toContain('VSIX');
    });
});

describe('FileIpc.formatJsonForDiscord', () => {
    it('should format object with summary and nested changes', () => {
        const obj = {
            summary: '変更完了',
            changes: {
                files_modified: ['a.ts', 'b.ts'],
            },
        };
        const result = FileIpc.formatJsonForDiscord(obj);
        expect(result).not.toBeNull();
        expect(result).toContain('📋 概要');
        expect(result).toContain('変更完了');
        expect(result).toContain('📝 変更内容');
        expect(result).toContain('a.ts');
    });

    it('should return null for empty object', () => {
        expect(FileIpc.formatJsonForDiscord({})).toBeNull();
    });

    it('should handle flat string-only objects', () => {
        const obj = { status: '完了', message: 'OK' };
        const result = FileIpc.formatJsonForDiscord(obj);
        expect(result).toContain('ステータス');
        expect(result).toContain('完了');
    });

    it('should handle arrays of objects', () => {
        const obj = {
            details: [
                { name: 'item1', value: '100' },
                { name: 'item2', value: '200' },
            ],
        };
        const result = FileIpc.formatJsonForDiscord(obj);
        expect(result).not.toBeNull();
        expect(result).toContain('item1');
        expect(result).toContain('item2');
    });
});
