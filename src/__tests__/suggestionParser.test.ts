import { describe, it, expect, vi, beforeEach } from 'vitest';

// logger モック（logDebug, logWarn を抑制）
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logWarn: vi.fn(),
}));

import { parseSuggestions, stripSuggestionTags } from '../suggestionParser';

// ---------------------------------------------------------------------------
// parseSuggestions テスト
// ---------------------------------------------------------------------------

describe('parseSuggestions', () => {

    // ===================== タグなし =====================

    it('タグなし → 空配列 + body はそのまま', () => {
        const md = '# こんにちは\nテスト結果です。';
        const result = parseSuggestions(md);
        expect(result.suggestions).toEqual([]);
        expect(result.cleanContent).toBe(md);
    });

    it('空文字列 → 空配列 + cleanContent は空', () => {
        const result = parseSuggestions('');
        expect(result.suggestions).toEqual([]);
        expect(result.cleanContent).toBe('');
    });

    // ===================== description なし =====================

    it('description なし — label/prompt のみの JSON を正常パース', () => {
        const md = [
            '# レスポンス',
            '',
            '作業が完了しました。',
            '',
            '<!-- SUGGESTIONS:[{"label":"テスト実行","prompt":"npx vitest run"},{"label":"デプロイ","prompt":"デプロイしてください"}] -->',
        ].join('\n');

        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(2);
        expect(result.suggestions[0]).toEqual({ label: 'テスト実行', prompt: 'npx vitest run' });
        expect(result.suggestions[1]).toEqual({ label: 'デプロイ', prompt: 'デプロイしてください' });
        // description なしのアイテムに description プロパティが存在しない
        expect(result.suggestions[0]).not.toHaveProperty('description');
    });

    // ===================== description あり =====================

    it('description あり — description が正しく保持される', () => {
        const md = [
            '完了なのだ！',
            '<!-- SUGGESTIONS:[{"label":"確認する","description":"動作確認を実行","prompt":"動作確認してください"}] -->',
        ].join('\n');

        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0]).toEqual({
            label: '確認する',
            description: '動作確認を実行',
            prompt: '動作確認してください',
        });
    });

    it('description 混在 — 一部のみ description あり', () => {
        const md = [
            'テスト',
            '<!-- SUGGESTIONS:[',
            '  {"label":"A","description":"説明A","prompt":"do A"},',
            '  {"label":"B","prompt":"do B"}',
            '] -->',
        ].join('\n');

        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(2);
        expect(result.suggestions[0].description).toBe('説明A');
        expect(result.suggestions[1]).not.toHaveProperty('description');
    });

    // ===================== 不正 JSON =====================

    it('不正 JSON — 壊れた JSON はエラーにならず空配列を返す', () => {
        const md = '本文\n<!-- SUGGESTIONS:[{broken json}] -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toEqual([]);
        // cleanContent にはタグが除去された状態
        expect(result.cleanContent).toBe('本文');
    });

    it('JSON が配列でない場合 → 空配列', () => {
        const md = '本文\n<!-- SUGGESTIONS:{"label":"A","prompt":"a"} -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toEqual([]);
    });

    it('label が欠けている不正アイテムはフィルタされる', () => {
        const md = '本文\n<!-- SUGGESTIONS:[{"prompt":"only prompt"},{"label":"OK","prompt":"ok"}] -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].label).toBe('OK');
    });

    it('prompt が欠けている不正アイテムはフィルタされる', () => {
        const md = '本文\n<!-- SUGGESTIONS:[{"label":"no prompt"},{"label":"OK","prompt":"ok"}] -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].label).toBe('OK');
    });

    it('null アイテムはフィルタされる', () => {
        const md = '本文\n<!-- SUGGESTIONS:[null,{"label":"OK","prompt":"ok"}] -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(1);
    });

    // ===================== 最大数超過 =====================

    it('MAX_SUGGESTIONS（3）を超えるアイテム → 先頭3個のみ返す', () => {
        const items = [
            { label: 'A', prompt: 'a' },
            { label: 'B', prompt: 'b' },
            { label: 'C', prompt: 'c' },
            { label: 'D', prompt: 'd' },
            { label: 'E', prompt: 'e' },
        ];
        const md = `本文\n<!-- SUGGESTIONS:${JSON.stringify(items)} -->`;
        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(3);
        expect(result.suggestions.map(s => s.label)).toEqual(['A', 'B', 'C']);
    });

    // ===================== タグ除去 =====================

    it('SUGGESTIONS タグが cleanContent から除去される', () => {
        const md = '前の文章\n\n<!-- SUGGESTIONS:[{"label":"A","prompt":"a"}] -->\n\n後の文章';
        const result = parseSuggestions(md);
        expect(result.cleanContent).not.toContain('SUGGESTIONS');
        expect(result.cleanContent).not.toContain('<!--');
        expect(result.cleanContent).toContain('前の文章');
        expect(result.cleanContent).toContain('後の文章');
    });

    it('末尾のタグも正しく除去される', () => {
        const md = '本文\n<!-- SUGGESTIONS:[{"label":"A","prompt":"a"}] -->';
        const result = parseSuggestions(md);
        expect(result.cleanContent).toBe('本文');
    });

    // ===================== ラベル長制限 =====================

    it('長いラベルは72文字に切り詰められる', () => {
        const longLabel = 'あ'.repeat(100);
        const md = `本文\n<!-- SUGGESTIONS:[{"label":"${longLabel}","prompt":"p"}] -->`;
        const result = parseSuggestions(md);
        expect(result.suggestions[0].label).toHaveLength(72);
    });

    // ===================== SUGGESTIONS タグの余白バリエーション =====================

    it('SUGGESTIONS: の前後に空白がある場合も正しくパースされる', () => {
        const md = '本文\n<!--   SUGGESTIONS:   [{"label":"A","prompt":"a"}]   -->';
        const result = parseSuggestions(md);
        expect(result.suggestions).toHaveLength(1);
        expect(result.suggestions[0].label).toBe('A');
    });
});

// ---------------------------------------------------------------------------
// stripSuggestionTags テスト
// ---------------------------------------------------------------------------

describe('stripSuggestionTags', () => {
    it('SUGGESTIONS タグを除去してトリムする', () => {
        const md = '本文\n<!-- SUGGESTIONS:[{"label":"A","prompt":"a"}] -->';
        const result = stripSuggestionTags(md);
        expect(result).toBe('本文');
    });

    it('タグなし → そのまま返す', () => {
        const md = '本文のみ';
        const result = stripSuggestionTags(md);
        expect(result).toBe('本文のみ');
    });
});
