import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    splitMemoryContent,
    rebuildMemoryContent,
    trySummarizeIfNeeded,
    _resetSummarizingFlag,
    SUMMARIZE_THRESHOLD_BYTES,
    RECENT_ENTRY_COUNT,
} from '../memorySummarizer';
import type { SummarizeOps } from '../memorySummarizer';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

describe('memorySummarizer', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        _resetSummarizingFlag();
    });

    // -----------------------------------------------------------------
    // splitMemoryContent
    // -----------------------------------------------------------------
    describe('splitMemoryContent', () => {
        it('ヘッダーのみの場合は空配列を返す', () => {
            const content = '# AntiCrow Memory\n\nメモリファイルです。\n';
            const result = splitMemoryContent(content);
            expect(result.header).toContain('AntiCrow Memory');
            expect(result.oldEntries).toEqual([]);
            expect(result.recentEntries).toEqual([]);
            expect(result.existingSummary).toBeNull();
        });

        it('直近5件以下の場合はoldEntriesが空', () => {
            const entries = Array.from({ length: 3 }, (_, i) =>
                `### 2026-02-${20 + i}\nメモ ${i}`
            );
            const content = `# Header\n\n${entries.join('\n\n')}`;
            const result = splitMemoryContent(content);
            expect(result.oldEntries.length).toBe(0);
            expect(result.recentEntries.length).toBe(3);
        });

        it('6件の場合、1件がold、5件がrecent', () => {
            const entries = Array.from({ length: 6 }, (_, i) =>
                `### 2026-02-${String(10 + i).padStart(2, '0')}\nメモ ${i}\n`
            );
            const content = `# Header\n\n${entries.join('\n')}`;
            const result = splitMemoryContent(content);
            expect(result.oldEntries.length).toBe(1);
            expect(result.recentEntries.length).toBe(RECENT_ENTRY_COUNT);
        });

        it('10件の場合、5件がold、5件がrecent', () => {
            const entries = Array.from({ length: 10 }, (_, i) =>
                `### 2026-02-${String(10 + i).padStart(2, '0')}\nメモ ${i}\n`
            );
            const content = `# Header\n\n${entries.join('\n')}`;
            const result = splitMemoryContent(content);
            expect(result.oldEntries.length).toBe(5);
            expect(result.recentEntries.length).toBe(5);
        });

        it('既存の要約セクションを正しく抽出する', () => {
            const content = [
                '# Header\n',
                '## 過去の記憶（要約）',
                '- 要約テキスト1',
                '- 要約テキスト2',
                '',
                '### 2026-02-20',
                'エントリ1',
                '',
                '### 2026-02-21',
                'エントリ2',
            ].join('\n');
            const result = splitMemoryContent(content);
            expect(result.existingSummary).toContain('要約テキスト1');
            expect(result.existingSummary).toContain('要約テキスト2');
            expect(result.recentEntries.length).toBe(2);
        });
    });

    // -----------------------------------------------------------------
    // rebuildMemoryContent
    // -----------------------------------------------------------------
    describe('rebuildMemoryContent', () => {
        it('ヘッダー + 要約 + エントリを正しく結合する', () => {
            const header = '# Header';
            const summary = '- 要約1\n- 要約2';
            const recentEntries = ['### 2026-02-20\nエントリ1\n', '### 2026-02-21\nエントリ2\n'];
            const result = rebuildMemoryContent(header, summary, recentEntries);
            expect(result).toContain('# Header');
            expect(result).toContain('## 過去の記憶（要約）');
            expect(result).toContain('- 要約1');
            expect(result).toContain('### 2026-02-20');
            expect(result).toContain('### 2026-02-21');
        });

        it('エントリが空でも正しく動作する', () => {
            const result = rebuildMemoryContent('# H', '要約', []);
            expect(result).toContain('# H');
            expect(result).toContain('## 過去の記憶（要約）');
            expect(result).toContain('要約');
        });
    });

    // -----------------------------------------------------------------
    // trySummarizeIfNeeded
    // -----------------------------------------------------------------
    describe('trySummarizeIfNeeded', () => {
        it('サイズが閾値以下ならスキップする', async () => {
            vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
            const ops: SummarizeOps = {
                sendPrompt: vi.fn(),
                createMarkdownRequestId: vi.fn(),
                waitForResponse: vi.fn(),
            };
            await trySummarizeIfNeeded('/test/MEMORY.md', 'test', ops);
            expect(ops.sendPrompt).not.toHaveBeenCalled();
        });

        it('サイズが閾値超過で古いエントリがあればAntigravityに要約を依頼する', async () => {
            const entries = Array.from({ length: 8 }, (_, i) =>
                `### 2026-02-${String(10 + i).padStart(2, '0')}\nメモ ${i} の内容がここに入る\n`
            );
            const content = `# Header\n\n${entries.join('\n')}`;

            vi.mocked(fs.statSync).mockReturnValue({ size: SUMMARIZE_THRESHOLD_BYTES + 1 } as fs.Stats);
            vi.mocked(fs.readFileSync).mockReturnValue(content);
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });
            vi.mocked(fs.unlinkSync).mockImplementation(() => { });

            const ops: SummarizeOps = {
                sendPrompt: vi.fn().mockResolvedValue(undefined),
                createMarkdownRequestId: vi.fn().mockReturnValue({
                    requestId: 'test-id',
                    responsePath: '/test/req_test-id_response.md',
                }),
                waitForResponse: vi.fn().mockResolvedValue('- 要約された内容'),
            };
            await trySummarizeIfNeeded('/test/MEMORY.md', 'test', ops);
            expect(ops.sendPrompt).toHaveBeenCalledOnce();
            expect(ops.waitForResponse).toHaveBeenCalledOnce();
            // MEMORY.md が再構成されて書き込まれること
            expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
            const writtenContent = vi.mocked(fs.writeFileSync).mock.calls.find(
                call => call[0] === '/test/MEMORY.md'
            );
            expect(writtenContent).toBeDefined();
            if (writtenContent) {
                const written = writtenContent[1] as string;
                expect(written).toContain('## 過去の記憶（要約）');
                expect(written).toContain('- 要約された内容');
                // 直近5件は保持されること
                expect(written).toContain('### 2026-02-14');
                expect(written).toContain('### 2026-02-17');
            }
        });

        it('二重実行を防止する', async () => {
            vi.mocked(fs.statSync).mockReturnValue({ size: SUMMARIZE_THRESHOLD_BYTES + 1 } as fs.Stats);
            const entries = Array.from({ length: 8 }, (_, i) =>
                `### 2026-02-${String(10 + i).padStart(2, '0')}\nメモ ${i}\n`
            );
            vi.mocked(fs.readFileSync).mockReturnValue(`# Header\n\n${entries.join('\n')}`);

            // sendPrompt が解決するまで待つPromiseを作成
            let resolveSend: () => void = () => { };
            const sendPromise = new Promise<void>(resolve => { resolveSend = resolve; });

            vi.mocked(fs.writeFileSync).mockImplementation(() => { });
            vi.mocked(fs.unlinkSync).mockImplementation(() => { });

            const ops: SummarizeOps = {
                sendPrompt: vi.fn().mockReturnValue(sendPromise),
                createMarkdownRequestId: vi.fn().mockReturnValue({
                    requestId: 'test-id',
                    responsePath: '/test/req_test-id_response.md',
                }),
                waitForResponse: vi.fn().mockResolvedValue('要約'),
            };

            // 1回目: 実行開始（await しない）
            const p1 = trySummarizeIfNeeded('/test/MEMORY.md', 'test', ops);
            // 2回目: 即座に呼ぶ→二重実行防止でスキップされるはず
            const p2 = trySummarizeIfNeeded('/test/MEMORY.md', 'test', ops);
            resolveSend();
            await Promise.all([p1, p2]);
            // sendPrompt は1回だけ呼ばれること
            expect(ops.sendPrompt).toHaveBeenCalledTimes(1);
        });

        it('Antigravity の要約が失敗してもクラッシュしない', async () => {
            vi.mocked(fs.statSync).mockReturnValue({ size: SUMMARIZE_THRESHOLD_BYTES + 1 } as fs.Stats);
            const entries = Array.from({ length: 8 }, (_, i) =>
                `### 2026-02-${String(10 + i).padStart(2, '0')}\nメモ ${i}\n`
            );
            vi.mocked(fs.readFileSync).mockReturnValue(`# Header\n\n${entries.join('\n')}`);
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });
            vi.mocked(fs.unlinkSync).mockImplementation(() => { });

            const ops: SummarizeOps = {
                sendPrompt: vi.fn().mockRejectedValue(new Error('CDP connection lost')),
                createMarkdownRequestId: vi.fn().mockReturnValue({
                    requestId: 'test-id',
                    responsePath: '/test/req_test-id_response.md',
                }),
                waitForResponse: vi.fn(),
            };
            // エラーでもクラッシュしないことを確認
            await expect(trySummarizeIfNeeded('/test/MEMORY.md', 'test', ops)).resolves.toBeUndefined();
        });
    });
});
