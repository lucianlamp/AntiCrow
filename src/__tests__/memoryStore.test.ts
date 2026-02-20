// ---------------------------------------------------------------------------
// memoryStore.test.ts — MEMORY タグ抽出・除去・アーカイブテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

import {
    extractMemoryTags,
    stripMemoryTags,
    archiveMemoryFile,
    MAX_MEMORY_SIZE_BYTES,
    MemoryEntry,
} from '../memoryStore';

// ---------------------------------------------------------------------------
// extractMemoryTags
// ---------------------------------------------------------------------------

describe('extractMemoryTags', () => {
    it('should extract global memory tag', () => {
        const text = 'Some response\n<!-- MEMORY:global: TypeScript の設定で strict を有効にする -->';
        const result = extractMemoryTags(text);
        expect(result).toHaveLength(1);
        expect(result[0].scope).toBe('global');
        expect(result[0].content).toBe('TypeScript の設定で strict を有効にする');
    });

    it('should extract workspace memory tag', () => {
        const text = '結果報告\n<!-- MEMORY:workspace: ビルド時に --legacy-peer-deps が必要 -->';
        const result = extractMemoryTags(text);
        expect(result).toHaveLength(1);
        expect(result[0].scope).toBe('workspace');
        expect(result[0].content).toBe('ビルド時に --legacy-peer-deps が必要');
    });

    it('should extract multiple tags (up to 3)', () => {
        const text = [
            '結果',
            '<!-- MEMORY:global: 学び1 -->',
            '<!-- MEMORY:workspace: 学び2 -->',
            '<!-- MEMORY:global: 学び3 -->',
        ].join('\n');
        const result = extractMemoryTags(text);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ scope: 'global', content: '学び1' });
        expect(result[1]).toEqual({ scope: 'workspace', content: '学び2' });
        expect(result[2]).toEqual({ scope: 'global', content: '学び3' });
    });

    it('should limit extraction to 3 entries', () => {
        const text = [
            '<!-- MEMORY:global: 1 -->',
            '<!-- MEMORY:global: 2 -->',
            '<!-- MEMORY:global: 3 -->',
            '<!-- MEMORY:global: 4 -->',
        ].join('\n');
        const result = extractMemoryTags(text);
        expect(result).toHaveLength(3);
        expect(result[2].content).toBe('3');
    });

    it('should return empty array for text without tags', () => {
        const text = 'No memory tags here';
        expect(extractMemoryTags(text)).toHaveLength(0);
    });

    it('should return empty array for empty string', () => {
        expect(extractMemoryTags('')).toHaveLength(0);
    });

    it('should handle tags with extra whitespace', () => {
        const text = '<!--   MEMORY:global:   spaced content   -->';
        const result = extractMemoryTags(text);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('spaced content');
    });
});

// ---------------------------------------------------------------------------
// stripMemoryTags
// ---------------------------------------------------------------------------

describe('stripMemoryTags', () => {
    it('should remove global memory tags', () => {
        const text = 'Hello\n<!-- MEMORY:global: some memory -->\nWorld';
        expect(stripMemoryTags(text)).toBe('Hello\n\nWorld');
    });

    it('should remove workspace memory tags', () => {
        const text = 'Hello\n<!-- MEMORY:workspace: some memory -->';
        expect(stripMemoryTags(text)).toBe('Hello');
    });

    it('should remove multiple tags', () => {
        const text = 'Result\n<!-- MEMORY:global: a -->\n<!-- MEMORY:workspace: b -->';
        const result = stripMemoryTags(text);
        expect(result).not.toContain('MEMORY');
        expect(result).toContain('Result');
    });

    it('should return unchanged text when no tags present', () => {
        const text = 'No tags here';
        expect(stripMemoryTags(text)).toBe('No tags here');
    });

    it('should handle empty string', () => {
        expect(stripMemoryTags('')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// archiveMemoryFile
// ---------------------------------------------------------------------------

describe('archiveMemoryFile', () => {
    const tmpDir = path.join(os.tmpdir(), 'anticrow-test-' + Date.now());
    const memoryPath = path.join(tmpDir, 'MEMORY.md');

    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        // クリーンアップ
        try {
            const files = fs.readdirSync(tmpDir);
            for (const f of files) {
                fs.unlinkSync(path.join(tmpDir, f));
            }
            fs.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    });

    it('should archive old entries and keep recent ones', () => {
        const header = '# Memory\n\n---\n';
        const entries = [];
        for (let i = 1; i <= 4; i++) {
            entries.push(`### 2026-01-0${i}\n- Entry ${i}\n`);
        }
        fs.writeFileSync(memoryPath, header + entries.join('\n'), 'utf-8');

        archiveMemoryFile(memoryPath, 'test');

        // メインファイルには後半のエントリだけ残る
        const remaining = fs.readFileSync(memoryPath, 'utf-8');
        expect(remaining).toContain('# Memory');
        expect(remaining).toContain('Entry 3');
        expect(remaining).toContain('Entry 4');
        expect(remaining).not.toContain('Entry 1');
        expect(remaining).not.toContain('Entry 2');

        // アーカイブファイルが作成される
        const archiveFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('MEMORY_archive_'));
        expect(archiveFiles).toHaveLength(1);
        const archiveContent = fs.readFileSync(path.join(tmpDir, archiveFiles[0]), 'utf-8');
        expect(archiveContent).toContain('Entry 1');
        expect(archiveContent).toContain('Entry 2');
    });

    it('should not archive when fewer than 2 entries', () => {
        const content = '# Memory\n\n### 2026-01-01\n- Only one\n';
        fs.writeFileSync(memoryPath, content, 'utf-8');

        archiveMemoryFile(memoryPath, 'test');

        // 変更なし
        const remaining = fs.readFileSync(memoryPath, 'utf-8');
        expect(remaining).toBe(content);

        // アーカイブファイルは作成されない
        const archiveFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('MEMORY_archive_'));
        expect(archiveFiles).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// MAX_MEMORY_SIZE_BYTES
// ---------------------------------------------------------------------------

describe('MAX_MEMORY_SIZE_BYTES', () => {
    it('should be 50KB', () => {
        expect(MAX_MEMORY_SIZE_BYTES).toBe(50 * 1024);
    });
});
