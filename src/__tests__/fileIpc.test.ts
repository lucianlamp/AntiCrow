// ---------------------------------------------------------------------------
// fileIpc.test.ts — FileIpc.extractResult テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// recoverStaleResponses + cleanupOldFiles テスト
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileIpc instance methods', () => {
    let ipc: FileIpc;
    let tmpDir: string;
    let ipcDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileIpc-test-'));
        ipcDir = path.join(tmpDir, 'ipc');
        fs.mkdirSync(ipcDir, { recursive: true });
        const fakeUri = { fsPath: tmpDir } as any;
        ipc = new FileIpc(fakeUri);
        await ipc.init();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('recoverStaleResponses', () => {
        it('should detect stale JSON response files', async () => {
            const filePath = path.join(ipcDir, 'req_123456_abcdef012345_response.json');
            fs.writeFileSync(filePath, '{"summary": "test"}');

            const stale = await ipc.recoverStaleResponses();
            expect(stale).toHaveLength(1);
            expect(stale[0].requestId).toBe('req_123456_abcdef012345');
            expect(stale[0].format).toBe('json');
            expect(stale[0].content).toContain('summary');
        });

        it('should detect stale MD response files', async () => {
            const filePath = path.join(ipcDir, 'req_789012_fedcba987654_response.md');
            fs.writeFileSync(filePath, '# Test Response');

            const stale = await ipc.recoverStaleResponses();
            expect(stale).toHaveLength(1);
            expect(stale[0].format).toBe('md');
        });

        it('should skip empty stale response files', async () => {
            const filePath = path.join(ipcDir, 'req_123456_abcdef012345_response.json');
            fs.writeFileSync(filePath, '  ');

            const stale = await ipc.recoverStaleResponses();
            expect(stale).toHaveLength(0);
        });

        it('should ignore non-response files', async () => {
            fs.writeFileSync(path.join(ipcDir, 'req_123456_abcdef012345_progress.json'), '{}');
            fs.writeFileSync(path.join(ipcDir, 'tmp_prompt_123.json'), '{}');

            const stale = await ipc.recoverStaleResponses();
            expect(stale).toHaveLength(0);
        });

        it('should detect multiple stale responses', async () => {
            fs.writeFileSync(path.join(ipcDir, 'req_111_aaa_response.json'), '{"a":1}');
            fs.writeFileSync(path.join(ipcDir, 'req_222_bbb_response.md'), '# B');

            const stale = await ipc.recoverStaleResponses();
            expect(stale).toHaveLength(2);
        });
    });

    describe('cleanupStaleResponse', () => {
        it('should delete specified stale response file', async () => {
            const filePath = path.join(ipcDir, 'req_123_abc_response.json');
            fs.writeFileSync(filePath, '{}');

            await ipc.cleanupStaleResponse(filePath);
            expect(fs.existsSync(filePath)).toBe(false);
        });

        it('should not throw for missing file', async () => {
            await expect(
                ipc.cleanupStaleResponse(path.join(ipcDir, 'nonexistent.json'))
            ).resolves.toBeUndefined();
        });
    });

    describe('registerActiveRequest / unregisterActiveRequest', () => {
        it('should protect registered request files from cleanupOldFiles', async () => {
            const requestId = 'req_999999_aabbccddeeff';
            const progressFile = path.join(ipcDir, `${requestId}_progress.json`);
            const responseFile = path.join(ipcDir, `${requestId}_response.json`);

            // 古いファイルとして作成（35分前 — 30分の response 閾値を超過）
            fs.writeFileSync(progressFile, '{}');
            fs.writeFileSync(responseFile, '{}');
            const oldTime = Date.now() - 35 * 60 * 1000;
            fs.utimesSync(progressFile, new Date(oldTime), new Date(oldTime));
            fs.utimesSync(responseFile, new Date(oldTime), new Date(oldTime));

            // activeRequest として登録
            ipc.registerActiveRequest(requestId);

            await ipc.cleanupOldFiles();

            // 登録されたファイルは削除されないこと
            expect(fs.existsSync(progressFile)).toBe(true);
            expect(fs.existsSync(responseFile)).toBe(true);

            // 解除後は削除対象
            ipc.unregisterActiveRequest(requestId);
            await ipc.cleanupOldFiles();

            expect(fs.existsSync(progressFile)).toBe(false);
            expect(fs.existsSync(responseFile)).toBe(false);
        });
    });

    describe('cleanupOldFiles thresholds', () => {
        it('should delete response files only after 30 minutes', async () => {
            // 20分前のレスポンス（30分未満 → 削除されない）
            const recentResponse = path.join(ipcDir, 'req_111_aaa_response.json');
            fs.writeFileSync(recentResponse, '{}');
            const twentyMinAgo = Date.now() - 20 * 60 * 1000;
            fs.utimesSync(recentResponse, new Date(twentyMinAgo), new Date(twentyMinAgo));

            // 35分前のレスポンス（30分超 → 削除される）
            const oldResponse = path.join(ipcDir, 'req_222_bbb_response.md');
            fs.writeFileSync(oldResponse, '# old');
            const thirtyFiveMinAgo = Date.now() - 35 * 60 * 1000;
            fs.utimesSync(oldResponse, new Date(thirtyFiveMinAgo), new Date(thirtyFiveMinAgo));

            await ipc.cleanupOldFiles();

            expect(fs.existsSync(recentResponse)).toBe(true);  // 20分 < 30分閾値
            expect(fs.existsSync(oldResponse)).toBe(false);     // 35分 > 30分閾値
        });

        it('should delete progress files after 2 minutes', async () => {
            const progressFile = path.join(ipcDir, 'req_333_ccc_progress.json');
            fs.writeFileSync(progressFile, '{}');
            const threeMinAgo = Date.now() - 3 * 60 * 1000;
            fs.utimesSync(progressFile, new Date(threeMinAgo), new Date(threeMinAgo));

            await ipc.cleanupOldFiles();

            expect(fs.existsSync(progressFile)).toBe(false);
        });

        it('should delete tmp files after 5 minutes', async () => {
            const tmpFile = path.join(ipcDir, 'tmp_prompt_12345_abc.json');
            fs.writeFileSync(tmpFile, '{}');
            const sixMinAgo = Date.now() - 6 * 60 * 1000;
            fs.utimesSync(tmpFile, new Date(sixMinAgo), new Date(sixMinAgo));

            await ipc.cleanupOldFiles();

            expect(fs.existsSync(tmpFile)).toBe(false);
        });
    });
});
