import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
    buildDatetimeStr,
    loadPromptResources,
    buildInstructionContent,
    writeInstructionJson,
} from '../instructionBuilder';

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------
vi.mock('fs');
vi.mock('../logger', () => ({
    logInfo: vi.fn(),
    logWarn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------
describe('instructionBuilder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // buildDatetimeStr
    // -----------------------------------------------------------------------
    describe('buildDatetimeStr', () => {
        it('JST形式の日時文字列が返ること', () => {
            const result = buildDatetimeStr();
            expect(typeof result).toBe('string');
            expect(result.length).toBeGreaterThan(0);
            // 日本語の形式で「年」「月」「日」が含まれること
            expect(result).toMatch(/\d{4}年/);
            expect(result).toMatch(/\d{1,2}月/);
            expect(result).toMatch(/\d{1,2}日/);
        });
    });

    // -----------------------------------------------------------------------
    // loadPromptResources
    // -----------------------------------------------------------------------
    describe('loadPromptResources', () => {
        it('エラー時は全て null が返ること（executorPromptBuilder が見つからなくてもクラッシュしない）', () => {
            // loadPromptResources は内部で try-catch しているので、
            // executorPromptBuilder がモックされていなくてもクラッシュしない
            const result = loadPromptResources();
            // 結果の型が正しいこと
            expect(result).toHaveProperty('rulesContent');
            expect(result).toHaveProperty('userGlobalRules');
            expect(result).toHaveProperty('userMemory');
        });
    });

    // -----------------------------------------------------------------------
    // buildInstructionContent
    // -----------------------------------------------------------------------
    describe('buildInstructionContent', () => {
        it('デフォルト値が適用されること', () => {
            const result = buildInstructionContent({
                prompt: 'テストプロンプト',
                responsePath: '/tmp/response.md',
                progressPath: '/tmp/progress.json',
            });

            // task は 'execution'
            expect(result.task).toBe('execution');
            // prompt が正しいこと
            expect(result.prompt).toBe('テストプロンプト');
            // output が生成されること
            const output = result.output as Record<string, unknown>;
            expect(output).toBeDefined();
            expect(output.response_path).toBe('/tmp/response.md');
            expect(output.format).toBe('markdown');
            // デフォルト constraint が含まれること
            expect(output.constraint).toContain('write_to_file');
            expect(output.constraint).toContain('MEMORY');
            expect(output.constraint).toContain('SUGGESTIONS');
            // progress が生成されること
            const progress = result.progress as Record<string, unknown>;
            expect(progress.path).toBe('/tmp/progress.json');
            expect(progress.instruction).toContain('進捗');
            // デフォルト execution_rules
            const rules = result.execution_rules as string[];
            expect(rules.length).toBe(3);
            expect(rules[0]).toContain('計画済み');
            expect(rules[1]).toContain('plan_generation');
            expect(rules[2]).toContain('VSIX');
        });

        it('カスタムオプションが上書きされること', () => {
            const result = buildInstructionContent({
                prompt: 'カスタム',
                responsePath: '/tmp/resp.md',
                progressPath: '/tmp/prog.json',
                format: 'json',
                constraint: 'カスタム制約テキスト',
                executionRules: ['ルール1', 'ルール2', 'ルール3'],
            });

            const output = result.output as Record<string, unknown>;
            expect(output.format).toBe('json');
            expect(output.constraint).toBe('カスタム制約テキスト');
            expect(result.execution_rules).toEqual(['ルール1', 'ルール2', 'ルール3']);
        });

        it('context がマージされること', () => {
            const result = buildInstructionContent({
                prompt: 'test',
                context: { role: 'main_agent', custom_key: 'value' },
                progressPath: '/tmp/prog.json',
            });

            const ctx = result.context as Record<string, unknown>;
            // datetime_jst が自動追加されること
            expect(ctx).toHaveProperty('datetime_jst');
            expect(typeof ctx.datetime_jst).toBe('string');
            // カスタム context がマージされること
            expect(ctx.role).toBe('main_agent');
            expect(ctx.custom_key).toBe('value');
        });

        it('responsePath 省略時は output セクションが生成されないこと', () => {
            const result = buildInstructionContent({
                prompt: 'test',
                progressPath: '/tmp/prog.json',
            });

            expect(result.output).toBeUndefined();
        });

        it('responsePath が空文字の場合も output セクションが生成されないこと', () => {
            const result = buildInstructionContent({
                prompt: 'test',
                responsePath: '',
                progressPath: '/tmp/prog.json',
            });

            expect(result.output).toBeUndefined();
        });

        it('responsePath 指定時は output セクションが正しく生成されること', () => {
            const result = buildInstructionContent({
                prompt: 'test',
                responsePath: '/tmp/resp.md',
                progressPath: '/tmp/prog.json',
            });

            expect(result.output).toBeDefined();
            const output = result.output as Record<string, unknown>;
            expect(output.response_path).toBe('/tmp/resp.md');
            expect(output.format).toBe('markdown');
            expect(typeof output.constraint).toBe('string');
        });

        it('progress セクションに正しいフォーマットが含まれること', () => {
            const result = buildInstructionContent({
                prompt: 'test',
                progressPath: '/tmp/progress.json',
            });

            const progress = result.progress as Record<string, unknown>;
            expect(progress.path).toBe('/tmp/progress.json');
            expect(typeof progress.instruction).toBe('string');
            const format = progress.format as Record<string, unknown>;
            expect(format).toHaveProperty('status');
            expect(format).toHaveProperty('detail');
            expect(format).toHaveProperty('percent');
        });
    });

    // -----------------------------------------------------------------------
    // writeInstructionJson
    // -----------------------------------------------------------------------
    describe('writeInstructionJson', () => {
        it('ファイルが正しく書き出されること', () => {
            writeInstructionJson('/tmp/instruction.json', {
                prompt: 'テスト',
                progressPath: '/tmp/prog.json',
            });

            expect(fs.writeFileSync).toHaveBeenCalledOnce();
            const [filePath, content, encoding] = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(filePath).toBe('/tmp/instruction.json');
            expect(encoding).toBe('utf-8');

            // JSON として正しくパースできること
            const parsed = JSON.parse(content as string);
            expect(parsed.task).toBe('execution');
            expect(parsed.prompt).toBe('テスト');
            expect(parsed.progress).toBeDefined();
        });

        it('buildInstructionContent の結果がそのまま JSON 化されること', () => {
            writeInstructionJson('/tmp/test.json', {
                prompt: 'カスタム',
                responsePath: '/tmp/resp.md',
                progressPath: '/tmp/prog.json',
                constraint: 'テスト制約',
            });

            const content = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
            const parsed = JSON.parse(content);
            const output = parsed.output as Record<string, unknown>;
            expect(output.constraint).toBe('テスト制約');
        });
    });
});
