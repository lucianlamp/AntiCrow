// ---------------------------------------------------------------------------
// discordFormatter.test.ts — メッセージフォーマットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { splitMessage, splitForEmbeds, extractTableFields, markdownToHtml, getDisplayWidth } from '../discordFormatter';

describe('splitMessage', () => {
    it('should return single chunk for short message', () => {
        const result = splitMessage('Hello, world!');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Hello, world!');
    });

    it('should split at newlines for long messages', () => {
        const line = 'A'.repeat(100) + '\n';
        const longMsg = line.repeat(50); // 5050 chars
        const result = splitMessage(longMsg);
        expect(result.length).toBeGreaterThan(1);
        for (const chunk of result) {
            expect(chunk.length).toBeLessThanOrEqual(2000);
        }
    });

    it('should not break within code blocks', () => {
        const msg = 'before\n```typescript\nconst x = 1;\nconst y = 2;\n```\nafter';
        const result = splitMessage(msg);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('```typescript');
    });
});

describe('splitForEmbeds', () => {
    it('should return groups of chunks for long text', () => {
        const longText = 'Line\n'.repeat(2000); // large text
        const groups = splitForEmbeds(longText);
        // Should return string[][] — at least 1 group
        expect(groups.length).toBeGreaterThan(0);
        // Each group is an array of strings
        for (const group of groups) {
            expect(Array.isArray(group)).toBe(true);
            for (const chunk of group) {
                expect(typeof chunk).toBe('string');
            }
        }
    });

    it('should return single group with single chunk for short text', () => {
        const groups = splitForEmbeds('short text');
        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(1);
        expect(groups[0][0]).toBe('short text');
    });
});

describe('extractTableFields', () => {
    it('should extract Markdown table into fields', () => {
        const markdown = [
            '| 項目 | 内容 |',
            '| ---- | ---- |',
            '| 天気 | 晴れ |',
            '| 気温 | 20℃ |',
        ].join('\n');

        const result = extractTableFields(markdown);
        expect(result.fields.length).toBeGreaterThan(0);
        // ヘッダー行ではなくデータ行が fields になる
        expect(result.fields[0].name).toBe('天気');
        expect(result.fields[0].value).toBe('晴れ');
    });

    it('should return empty fields for text without tables', () => {
        const result = extractTableFields('No tables here');
        expect(result.fields).toHaveLength(0);
        expect(result.description).toBe('No tables here');
    });

    it('should preserve non-table text in description', () => {
        const text = 'Before table\n| A | B |\n| - | - |\n| 1 | 2 |\nAfter table';
        const result = extractTableFields(text);
        expect(result.fields.length).toBeGreaterThan(0);
        expect(result.description).toContain('Before table');
        expect(result.description).toContain('After table');
    });
});

describe('markdownToHtml', () => {
    it('should convert bold markdown to HTML', () => {
        const html = markdownToHtml('**bold text**');
        expect(html).toContain('<strong>');
        expect(html).toContain('bold text');
    });

    it('should convert headers to HTML', () => {
        const html = markdownToHtml('# Header 1\n## Header 2');
        expect(html).toContain('<h1>');
        expect(html).toContain('<h2>');
    });

    it('should convert code blocks', () => {
        const html = markdownToHtml('```js\nconst x = 1;\n```');
        expect(html).toContain('<code>');
    });

    it('should include basic HTML structure', () => {
        const html = markdownToHtml('test');
        expect(html).toContain('<html');
        expect(html).toContain('</html>');
    });
});

describe('getDisplayWidth', () => {
    it('should count ASCII chars as width 1', () => {
        expect(getDisplayWidth('hello')).toBe(5);
    });

    it('should count CJK chars as width 2', () => {
        expect(getDisplayWidth('漢字')).toBe(4);
    });

    it('should handle mixed ASCII and CJK', () => {
        expect(getDisplayWidth('Hi漢字')).toBe(6);
    });
});
