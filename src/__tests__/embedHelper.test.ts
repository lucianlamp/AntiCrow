// ---------------------------------------------------------------------------
// embedHelper.test.ts — embedHelper モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// discord.js のモック（buildEmbed で使用）
vi.mock('discord.js', () => {
    class MockEmbedBuilder {
        private data: Record<string, unknown> = {};
        setDescription(desc: string) { this.data.description = desc; return this; }
        setColor(color: number) { this.data.color = color; return this; }
        setFooter(footer: { text: string }) { this.data.footer = footer; return this; }
        setTimestamp() { this.data.timestamp = true; return this; }
        // テスト用: 内部データを参照
        get description() { return this.data.description as string | undefined; }
        get color() { return this.data.color as number | undefined; }
    }
    return { EmbedBuilder: MockEmbedBuilder };
});

import {
    buildEmbed,
    normalizeHeadings,
    sanitizeErrorForDiscord,
    EmbedColor,
} from '../embedHelper';

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('embedHelper', () => {
    // -------------------------------------------------------------------
    // EmbedColor 定数
    // -------------------------------------------------------------------

    describe('EmbedColor', () => {
        it('should have all expected color keys', () => {
            expect(EmbedColor.Info).toBeDefined();
            expect(EmbedColor.Success).toBeDefined();
            expect(EmbedColor.Error).toBeDefined();
            expect(EmbedColor.Warning).toBeDefined();
            expect(EmbedColor.Progress).toBeDefined();
            expect(EmbedColor.Response).toBeDefined();
            expect(EmbedColor.Suggest).toBeDefined();
        });

        it('should have number values', () => {
            expect(typeof EmbedColor.Info).toBe('number');
            expect(typeof EmbedColor.Error).toBe('number');
        });
    });

    // -------------------------------------------------------------------
    // buildEmbed
    // -------------------------------------------------------------------

    describe('buildEmbed', () => {
        it('should create an EmbedBuilder with description and default color', () => {
            const embed = buildEmbed('Hello');
            expect((embed as any).description).toBe('Hello');
            expect((embed as any).color).toBe(EmbedColor.Info);
        });

        it('should use specified color', () => {
            const embed = buildEmbed('Error message', EmbedColor.Error);
            expect((embed as any).color).toBe(EmbedColor.Error);
        });

        it('should use zero-width space for empty description', () => {
            const embed = buildEmbed('');
            expect((embed as any).description).toBe('\u200b');
        });

        it('should normalize headings in description', () => {
            const embed = buildEmbed('#### Deep heading');
            expect((embed as any).description).toBe('**Deep heading**');
        });

        it('should not set footer or timestamp by default', () => {
            const embed = buildEmbed('Hello');
            expect((embed as any).data?.footer).toBeUndefined();
            expect((embed as any).data?.timestamp).toBeUndefined();
        });

        it('should set footer and timestamp when showTimestamp is true', () => {
            const embed = buildEmbed('Hello', EmbedColor.Info, true);
            expect((embed as any).data.footer).toEqual({ text: 'Antigravity Bridge' });
            expect((embed as any).data.timestamp).toBe(true);
        });

        it('should not set footer when showTimestamp is false', () => {
            const embed = buildEmbed('Hello', EmbedColor.Info, false);
            expect((embed as any).data?.footer).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // normalizeHeadings
    // -------------------------------------------------------------------

    describe('normalizeHeadings', () => {
        it('should convert #### to bold', () => {
            expect(normalizeHeadings('#### Title')).toBe('**Title**');
        });

        it('should convert ##### to bold', () => {
            expect(normalizeHeadings('##### Deep')).toBe('**Deep**');
        });

        it('should convert ###### to bold', () => {
            expect(normalizeHeadings('###### Very Deep')).toBe('**Very Deep**');
        });

        it('should not convert ### (Discord supports it)', () => {
            expect(normalizeHeadings('### Heading 3')).toBe('### Heading 3');
        });

        it('should not convert ## or #', () => {
            expect(normalizeHeadings('## Heading 2')).toBe('## Heading 2');
            expect(normalizeHeadings('# Heading 1')).toBe('# Heading 1');
        });

        it('should handle multiple headings in text', () => {
            const input = '#### First\nSome text\n##### Second';
            const expected = '**First**\nSome text\n**Second**';
            expect(normalizeHeadings(input)).toBe(expected);
        });

        it('should not modify headings not at line start', () => {
            expect(normalizeHeadings('text #### not heading')).toBe('text #### not heading');
        });

        it('should return empty string for empty input', () => {
            expect(normalizeHeadings('')).toBe('');
        });
    });

    // -------------------------------------------------------------------
    // sanitizeErrorForDiscord
    // -------------------------------------------------------------------

    describe('sanitizeErrorForDiscord', () => {
        it('should return original message for safe content', () => {
            expect(sanitizeErrorForDiscord('Something went wrong')).toBe('Something went wrong');
        });

        it('should sanitize Windows file paths', () => {
            const result = sanitizeErrorForDiscord('Error at C:\\Users\\user\\file.ts');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize Unix file paths', () => {
            const result = sanitizeErrorForDiscord('Error at /home/user/project/file.ts');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize port numbers', () => {
            const result = sanitizeErrorForDiscord('Connection failed on :9222');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize WebSocket URLs', () => {
            const result = sanitizeErrorForDiscord('ws://localhost:9222/devtools');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize localhost URLs', () => {
            const result = sanitizeErrorForDiscord('http://localhost:3000/api');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize 127.0.0.1 URLs', () => {
            const result = sanitizeErrorForDiscord('http://127.0.0.1:8080/debug');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize CDP mentions', () => {
            const result = sanitizeErrorForDiscord('CDP connection failed');
            expect(result).toContain('内部エラー');
        });

        it('should sanitize Chrome DevTools Protocol mentions', () => {
            const result = sanitizeErrorForDiscord('Chrome DevTools Protocol error');
            expect(result).toContain('内部エラー');
        });

        it('should handle empty string', () => {
            expect(sanitizeErrorForDiscord('')).toBe('');
        });
    });
});
