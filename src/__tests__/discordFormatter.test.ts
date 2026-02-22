// ---------------------------------------------------------------------------
// discordFormatter.test.ts — discordFormatter モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
    splitMessage,
    splitForEmbeds,
    extractTableFields,
    shouldAttachAsFile,
    textToBuffer,
    markdownToHtml,
    getDisplayWidth,
} from '../discordFormatter';

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('discordFormatter', () => {
    // -------------------------------------------------------------------
    // splitMessage
    // -------------------------------------------------------------------

    describe('splitMessage', () => {
        it('should return single chunk for short messages', () => {
            const result = splitMessage('Hello');
            expect(result).toEqual(['Hello']);
        });

        it('should split long messages at newline boundaries', () => {
            // 2000文字超のメッセージを作成
            const line = 'A'.repeat(100) + '\n';
            const longText = line.repeat(25); // 2525 文字
            const result = splitMessage(longText);
            expect(result.length).toBeGreaterThan(1);
            for (const chunk of result) {
                expect(chunk.length).toBeLessThanOrEqual(2000);
            }
        });

        it('should preserve code blocks across splits', () => {
            const codePart = '```js\n' + 'x\n'.repeat(500) + '```';
            const result = splitMessage(codePart);
            // 分割された各チャンクでコードブロックが閉じている/開いていることを確認
            for (const chunk of result) {
                const fences = (chunk.match(/```/g) || []).length;
                expect(fences % 2).toBe(0); // 偶数個
            }
        });

        it('should handle empty string', () => {
            expect(splitMessage('')).toEqual(['']);
        });
    });

    // -------------------------------------------------------------------
    // splitForEmbeds
    // -------------------------------------------------------------------

    describe('splitForEmbeds', () => {
        it('should return single group for short text', () => {
            const result = splitForEmbeds('Short text');
            expect(result).toEqual([['Short text']]);
        });

        it('should split text exceeding embed description limit', () => {
            const longText = 'X'.repeat(5000);
            const result = splitForEmbeds(longText);
            expect(result.length).toBeGreaterThanOrEqual(1);
            // すべてのチャンクが4000文字以下
            for (const group of result) {
                for (const chunk of group) {
                    expect(chunk.length).toBeLessThanOrEqual(4100); // コードブロック補完のマージン
                }
            }
        });

        it('should group chunks respecting total embed limit', () => {
            // 大量のテキストを作成
            const line = 'Y'.repeat(1000) + '\n';
            const hugeText = line.repeat(20); // 20100 文字超
            const result = splitForEmbeds(hugeText);
            expect(result.length).toBeGreaterThan(1);
        });

        it('should preserve code blocks across splits', () => {
            const code = '```python\n' + 'print("hello")\n'.repeat(300) + '```';
            const result = splitForEmbeds(code);
            for (const group of result) {
                for (const chunk of group) {
                    const fences = (chunk.match(/```/g) || []).length;
                    expect(fences % 2).toBe(0);
                }
            }
        });
    });

    // -------------------------------------------------------------------
    // extractTableFields
    // -------------------------------------------------------------------

    describe('extractTableFields', () => {
        it('should extract fields from markdown table', () => {
            const text = [
                '| 項目 | 内容 |',
                '| --- | --- |',
                '| 天気 | 晴れ |',
                '| 気温 | 10℃ |',
            ].join('\n');
            const result = extractTableFields(text);
            expect(result.fields.length).toBe(2);
            expect(result.fields[0].name).toBe('天気');
            expect(result.fields[0].value).toBe('晴れ');
            expect(result.fields[1].name).toBe('気温');
            expect(result.fields[1].value).toBe('10℃');
        });

        it('should return empty fields for text without tables', () => {
            const result = extractTableFields('Just some text\nNo tables here');
            expect(result.fields).toEqual([]);
            expect(result.description).toBe('Just some text\nNo tables here');
        });

        it('should separate description from table', () => {
            const text = 'Header text\n\n| Col1 | Col2 |\n| --- | --- |\n| A | B |\n\nFooter text';
            const result = extractTableFields(text);
            expect(result.fields.length).toBe(1);
            expect(result.description).toContain('Header text');
            expect(result.description).toContain('Footer text');
        });

        it('should handle tables with 3+ columns', () => {
            const text = [
                '| A | B | C |',
                '| --- | --- | --- |',
                '| 1 | 2 | 3 |',
            ].join('\n');
            const result = extractTableFields(text);
            expect(result.fields.length).toBe(1);
            expect(result.fields[0].name).toBe('1');
            expect(result.fields[0].value).toContain('2');
            expect(result.fields[0].value).toContain('3');
        });

        it('should set inline to true for table fields', () => {
            const text = '| K | V |\n| --- | --- |\n| key | val |\n';
            const result = extractTableFields(text);
            expect(result.fields[0].inline).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // shouldAttachAsFile / textToBuffer
    // -------------------------------------------------------------------

    describe('shouldAttachAsFile', () => {
        it('should return false for short text', () => {
            expect(shouldAttachAsFile('Hello')).toBe(false);
        });

        it('should return true for text exceeding 6000 characters', () => {
            expect(shouldAttachAsFile('X'.repeat(6001))).toBe(true);
        });

        it('should return false for exactly 6000 characters', () => {
            expect(shouldAttachAsFile('X'.repeat(6000))).toBe(false);
        });
    });

    describe('textToBuffer', () => {
        it('should convert text to UTF-8 buffer', () => {
            const buf = textToBuffer('テスト');
            expect(buf).toBeInstanceOf(Buffer);
            expect(buf.toString('utf-8')).toBe('テスト');
        });
    });

    // -------------------------------------------------------------------
    // markdownToHtml
    // -------------------------------------------------------------------

    describe('markdownToHtml', () => {
        it('should wrap output in HTML document', () => {
            const html = markdownToHtml('Hello');
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('<html');
            expect(html).toContain('</html>');
        });

        it('should convert headings', () => {
            const html = markdownToHtml('# Title');
            expect(html).toContain('<h1>');
        });

        it('should convert bold text', () => {
            const html = markdownToHtml('**bold**');
            expect(html).toContain('<strong>bold</strong>');
        });

        it('should convert code blocks', () => {
            const html = markdownToHtml('```js\nconsole.log("hi")\n```');
            expect(html).toContain('<pre>');
            expect(html).toContain('<code>');
        });

        it('should convert inline code', () => {
            const html = markdownToHtml('Use `npm test`');
            expect(html).toContain('<code class="inline">npm test</code>');
        });

        it('should convert bullet lists', () => {
            const html = markdownToHtml('- item1\n- item2');
            expect(html).toContain('<ul>');
            expect(html).toContain('<li>');
        });

        it('should convert horizontal rules', () => {
            const html = markdownToHtml('---');
            expect(html).toContain('<hr>');
        });

        it('should escape HTML entities', () => {
            const html = markdownToHtml('<script>alert("xss")</script>');
            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;script&gt;');
        });
    });

    // -------------------------------------------------------------------
    // getDisplayWidth
    // -------------------------------------------------------------------

    describe('getDisplayWidth', () => {
        it('should return 1 per ASCII character', () => {
            expect(getDisplayWidth('abc')).toBe(3);
        });

        it('should return 2 per CJK character', () => {
            expect(getDisplayWidth('日本語')).toBe(6);
        });

        it('should handle mixed content', () => {
            expect(getDisplayWidth('abc日本')).toBe(7); // 3 + 4
        });

        it('should return 0 for empty string', () => {
            expect(getDisplayWidth('')).toBe(0);
        });

        it('should count hiragana as fullwidth', () => {
            expect(getDisplayWidth('あいう')).toBe(6);
        });

        it('should count katakana as fullwidth', () => {
            expect(getDisplayWidth('アイウ')).toBe(6);
        });
    });
});
