import { describe, it, expect, vi } from 'vitest';

// discord.js のモック（suggestionButtons.ts が import するため）
vi.mock('discord.js', () => {
    class MockActionRowBuilder {
        components: unknown[] = [];
        addComponents(...args: unknown[]) { this.components.push(...args); return this; }
    }
    class MockButtonBuilder {
        setCustomId() { return this; }
        setLabel() { return this; }
        setStyle() { return this; }
        setEmoji() { return this; }
    }
    return {
        ActionRowBuilder: MockActionRowBuilder,
        ButtonBuilder: MockButtonBuilder,
        ButtonStyle: { Secondary: 2 },
    };
});

import { buildSuggestionContent, buildSuggestionRow, SUGGEST_BUTTON_PREFIX, storeSuggestions, getSuggestion } from '../suggestionButtons';
import type { SuggestionItem } from '../suggestionParser';

// ---------------------------------------------------------------------------
// buildSuggestionContent テスト
// ---------------------------------------------------------------------------

describe('buildSuggestionContent', () => {
    it('空配列 → デフォルト見出しのみ返す', () => {
        const result = buildSuggestionContent([]);
        expect(result).toBe('💡 **次のアクション提案**');
    });

    it('description なし（全アイテム） → デフォルト見出しのみ返す', () => {
        const items: SuggestionItem[] = [
            { label: 'テストA', prompt: 'do A' },
            { label: 'テストB', prompt: 'do B' },
        ];
        const result = buildSuggestionContent(items);
        expect(result).toBe('💡 **次のアクション提案**');
    });

    it('description あり（全アイテム） → 絵文字付きリストで表示', () => {
        const items: SuggestionItem[] = [
            { label: 'アクションA', prompt: 'do A', description: 'Aの詳細説明' },
            { label: 'アクションB', prompt: 'do B', description: 'Bの詳細説明' },
            { label: 'アクションC', prompt: 'do C', description: 'Cの詳細説明' },
        ];
        const result = buildSuggestionContent(items);

        // 見出し行
        expect(result).toContain('💡 **次のアクション提案**');

        // 各行に正しい絵文字・ラベル・description が含まれる
        expect(result).toContain('💡 **アクションA** — Aの詳細説明');
        expect(result).toContain('🔧 **アクションB** — Bの詳細説明');
        expect(result).toContain('🚀 **アクションC** — Cの詳細説明');
    });

    it('description 混在 → description がないアイテムは label をフォールバック', () => {
        const items: SuggestionItem[] = [
            { label: 'アクション1', prompt: 'do 1', description: '詳細あり' },
            { label: 'アクション2', prompt: 'do 2' },
            { label: 'アクション3', prompt: 'do 3', description: '詳細あり3' },
        ];
        const result = buildSuggestionContent(items);

        // description がある → リスト表示モード
        expect(result).toContain('💡 **次のアクション提案**');

        // description ありのアイテム
        expect(result).toContain('💡 **アクション1** — 詳細あり');
        expect(result).toContain('🚀 **アクション3** — 詳細あり3');

        // description なしのアイテム → label がフォールバック
        expect(result).toContain('🔧 **アクション2** — アクション2');
    });

    it('3個を超えるアイテム → 最大3個まで表示', () => {
        const items: SuggestionItem[] = [
            { label: 'A', prompt: 'a', description: 'desc A' },
            { label: 'B', prompt: 'b', description: 'desc B' },
            { label: 'C', prompt: 'c', description: 'desc C' },
            { label: 'D', prompt: 'd', description: 'desc D' },
        ];
        const result = buildSuggestionContent(items);

        // 4番目は表示されない
        expect(result).toContain('💡 **A** — desc A');
        expect(result).toContain('🔧 **B** — desc B');
        expect(result).toContain('🚀 **C** — desc C');
        expect(result).not.toContain('D');
    });

    it('1個だけ description あり → リスト表示モード', () => {
        const items: SuggestionItem[] = [
            { label: 'ソロ', prompt: 'solo', description: 'ひとつだけ' },
        ];
        const result = buildSuggestionContent(items);

        expect(result).toContain('💡 **次のアクション提案**');
        expect(result).toContain('💡 **ソロ** — ひとつだけ');
    });
});

// ---------------------------------------------------------------------------
// buildSuggestionRow テスト
// ---------------------------------------------------------------------------

describe('buildSuggestionRow', () => {
    it('空配列 → null を返す', () => {
        const result = buildSuggestionRow([]);
        expect(result).toBeNull();
    });

    it('アイテムあり → ActionRowBuilder を返す', () => {
        const items: SuggestionItem[] = [
            { label: 'テスト', prompt: 'test prompt' },
        ];
        const result = buildSuggestionRow(items);
        expect(result).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// storeSuggestions / getSuggestion テスト
// ---------------------------------------------------------------------------

describe('storeSuggestions / getSuggestion', () => {
    it('保存した提案を取得できる', () => {
        const items: SuggestionItem[] = [
            { label: 'A', prompt: 'prompt A' },
            { label: 'B', prompt: 'prompt B' },
        ];
        storeSuggestions('ch-test', items);

        expect(getSuggestion('ch-test', 0)).toEqual({ label: 'A', prompt: 'prompt A' });
        expect(getSuggestion('ch-test', 1)).toEqual({ label: 'B', prompt: 'prompt B' });
    });

    it('存在しないチャンネル → null', () => {
        expect(getSuggestion('nonexistent', 0)).toBeNull();
    });

    it('範囲外のインデックス → null', () => {
        storeSuggestions('ch-test2', [{ label: 'A', prompt: 'a' }]);
        expect(getSuggestion('ch-test2', 5)).toBeNull();
    });

    it('上書き: 新しい提案が来ると古いものは消える', () => {
        storeSuggestions('ch-overwrite', [{ label: 'old', prompt: 'old prompt' }]);
        storeSuggestions('ch-overwrite', [{ label: 'new', prompt: 'new prompt' }]);

        expect(getSuggestion('ch-overwrite', 0)?.label).toBe('new');
    });
});

// ---------------------------------------------------------------------------
// SUGGEST_BUTTON_PREFIX テスト
// ---------------------------------------------------------------------------

describe('SUGGEST_BUTTON_PREFIX', () => {
    it('正しいプレフィックス値を持つ', () => {
        expect(SUGGEST_BUTTON_PREFIX).toBe('suggest_');
    });
});
