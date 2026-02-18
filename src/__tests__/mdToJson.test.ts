// ---------------------------------------------------------------------------
// mdToJson.test.ts — mdToJson モジュールのテスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { markdownToJson } from '../mdToJson';

// ---------------------------------------------------------------------------
// 基本的な変換テスト
// ---------------------------------------------------------------------------

describe('markdownToJson', () => {
    it('should convert H1 heading to top-level key', () => {
        const md = '# タイトル\nテスト内容';
        const result = markdownToJson(md);
        expect(result).toHaveProperty('タイトル');
    });

    it('should convert H2 heading to nested key under H1', () => {
        const md = '# セクション\n## サブセクション\nテスト内容';
        const result = markdownToJson(md);
        expect(result).toHaveProperty('セクション');
        const section = result['セクション'] as Record<string, unknown>;
        expect(section).toHaveProperty('サブセクション');
    });

    it('should convert unordered list to array', () => {
        const md = '# リスト\n- 項目1\n- 項目2\n- 項目3';
        const result = markdownToJson(md);
        const section = result['リスト'] as string[];
        expect(Array.isArray(section)).toBe(true);
        expect(section).toContain('項目1');
        expect(section).toContain('項目2');
        expect(section).toContain('項目3');
    });

    it('should convert ordered list to array', () => {
        const md = '# ルール\n1. ルール1\n2. ルール2';
        const result = markdownToJson(md);
        const section = result['ルール'] as string[];
        expect(Array.isArray(section)).toBe(true);
        expect(section).toHaveLength(2);
    });

    it('should parse JSON code block as object', () => {
        const md = '# スキーマ\n```json\n{"key": "value"}\n```';
        const result = markdownToJson(md);
        const section = result['スキーマ'] as Record<string, unknown>;
        expect(section).toHaveProperty('_schema');
        expect((section['_schema'] as Record<string, unknown>)['key']).toBe('value');
    });

    it('should preserve non-JSON code block as string', () => {
        const md = '# コード\n```typescript\nconst x = 1;\n```';
        const result = markdownToJson(md);
        const section = result['コード'] as Record<string, unknown>;
        expect(section).toHaveProperty('_code');
    });

    it('should handle plain text as _text', () => {
        const md = '# セクション\nこれはテキストです';
        const result = markdownToJson(md);
        expect(result['セクション']).toBe('これはテキストです');
    });

    it('should return empty object for empty input', () => {
        const result = markdownToJson('');
        expect(result).toEqual({});
    });

    it('should handle markdown without headings', () => {
        const md = 'テキストだけ';
        const result = markdownToJson(md);
        expect(result).toEqual({});
    });

    // ---------------------------------------------------------------------------
    // prompt_rules.md の実際の内容でのテスト
    // ---------------------------------------------------------------------------

    it('should correctly convert prompt_rules.md structure', () => {
        const md = `# Anti-Crow プロンプトルール

## 出力スキーマ

以下の JSON スキーマで実行計画を出力してください：

\`\`\`json
{"plan_id": "string", "timezone": "Asia/Tokyo"}
\`\`\`

## ルール

1. timezone は必ず "Asia/Tokyo"
2. cron は5項目標準

## choice_mode_の使い方

- "none": 選択肢なし
- "single": 1つだけ選択
- "all": 全て実行`;

        const result = markdownToJson(md);
        const root = result['Anti-Crow_プロンプトルール'] as Record<string, unknown>;

        // H2 セクションが存在すること
        expect(root).toHaveProperty('出力スキーマ');
        expect(root).toHaveProperty('ルール');
        expect(root).toHaveProperty('choice_mode_の使い方');

        // ルールが配列であること
        const rules = root['ルール'] as string[];
        expect(Array.isArray(rules)).toBe(true);
        expect(rules).toHaveLength(2);

        // choice_mode が配列であること
        const choiceMode = root['choice_mode_の使い方'] as string[];
        expect(Array.isArray(choiceMode)).toBe(true);
        expect(choiceMode).toHaveLength(3);

        // 出力スキーマに JSON が含まれること
        const schema = root['出力スキーマ'] as Record<string, unknown>;
        expect(schema).toHaveProperty('_schema');
    });

    it('should produce valid JSON.stringify output', () => {
        const md = '# テスト\n## サブ\n- 項目1\n- 項目2';
        const result = markdownToJson(md);
        const jsonStr = JSON.stringify(result, null, 2);
        expect(() => JSON.parse(jsonStr)).not.toThrow();
    });
});
