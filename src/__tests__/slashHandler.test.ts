// ---------------------------------------------------------------------------
// slashHandler.test.ts — parseAutoModeButtonId のユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// vscode モック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: vi.fn(),
            dispose: vi.fn(),
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
        }),
        workspaceFolders: [{ uri: { fsPath: '/default/workspace' } }],
    },
}));

// logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
}));

import { parseAutoModeButtonId } from '../slashHandler';

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('parseAutoModeButtonId', () => {
    // -------------------------------------------------------------------
    // wsKey あり: {baseId}:{wsKey} 形式
    // -------------------------------------------------------------------

    describe('wsKey ありのケース', () => {
        it('auto_stop:my-workspace → action="auto_stop", wsKey="my-workspace"', () => {
            const result = parseAutoModeButtonId('auto_stop:my-workspace');
            expect(result).toEqual({ action: 'auto_stop', wsKey: 'my-workspace' });
        });

        it('safety_approve:anti-crow → action="safety_approve", wsKey="anti-crow"', () => {
            const result = parseAutoModeButtonId('safety_approve:anti-crow');
            expect(result).toEqual({ action: 'safety_approve', wsKey: 'anti-crow' });
        });

        it('safety_skip:project-x → action="safety_skip", wsKey="project-x"', () => {
            const result = parseAutoModeButtonId('safety_skip:project-x');
            expect(result).toEqual({ action: 'safety_skip', wsKey: 'project-x' });
        });

        it('safety_stop:123 → action="safety_stop", wsKey="123"', () => {
            const result = parseAutoModeButtonId('safety_stop:123');
            expect(result).toEqual({ action: 'safety_stop', wsKey: '123' });
        });

        it('confirm_continue:my-ws → action="confirm_continue", wsKey="my-ws"', () => {
            const result = parseAutoModeButtonId('confirm_continue:my-ws');
            expect(result).toEqual({ action: 'confirm_continue', wsKey: 'my-ws' });
        });

        it('confirm_stop:my-ws → action="confirm_stop", wsKey="my-ws"', () => {
            const result = parseAutoModeButtonId('confirm_stop:my-ws');
            expect(result).toEqual({ action: 'confirm_stop', wsKey: 'my-ws' });
        });

        it('automode_stop:playground → action="automode_stop", wsKey="playground"', () => {
            const result = parseAutoModeButtonId('automode_stop:playground');
            expect(result).toEqual({ action: 'automode_stop', wsKey: 'playground' });
        });

        it('wsKey にコロンが含まれる場合、最初のコロン以降を全て wsKey として扱う', () => {
            const result = parseAutoModeButtonId('auto_stop:c:\\Users\\foo\\bar');
            expect(result).toEqual({ action: 'auto_stop', wsKey: 'c:\\Users\\foo\\bar' });
        });
    });

    // -------------------------------------------------------------------
    // wsKey なし: {baseId} のみ（後方互換）
    // -------------------------------------------------------------------

    describe('wsKey なしのケース（後方互換）', () => {
        it('auto_stop → action="auto_stop", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('auto_stop');
            expect(result).toEqual({ action: 'auto_stop' });
            expect(result?.wsKey).toBeUndefined();
        });

        it('safety_approve → action="safety_approve", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('safety_approve');
            expect(result).toEqual({ action: 'safety_approve' });
            expect(result?.wsKey).toBeUndefined();
        });

        it('confirm_continue → action="confirm_continue", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('confirm_continue');
            expect(result).toEqual({ action: 'confirm_continue' });
            expect(result?.wsKey).toBeUndefined();
        });

        it('confirm_stop → action="confirm_stop", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('confirm_stop');
            expect(result).toEqual({ action: 'confirm_stop' });
            expect(result?.wsKey).toBeUndefined();
        });

        it('automode_stop → action="automode_stop", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('automode_stop');
            expect(result).toEqual({ action: 'automode_stop' });
            expect(result?.wsKey).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // 不明な ID: undefined を返す
    // -------------------------------------------------------------------

    describe('不明なIDのケース', () => {
        it('unknown_button → undefined', () => {
            expect(parseAutoModeButtonId('unknown_button')).toBeUndefined();
        });

        it('suggest_0 → undefined（提案ボタンは別系統）', () => {
            expect(parseAutoModeButtonId('suggest_0')).toBeUndefined();
        });

        it('confirm_approve → undefined（プラン確認ボタンは別系統）', () => {
            expect(parseAutoModeButtonId('confirm_approve')).toBeUndefined();
        });

        it('empty string → undefined', () => {
            expect(parseAutoModeButtonId('')).toBeUndefined();
        });

        it('model_select_0 → undefined', () => {
            expect(parseAutoModeButtonId('model_select_0')).toBeUndefined();
        });

        it('team_on → undefined', () => {
            expect(parseAutoModeButtonId('team_on')).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // 空 wsKey: コロンの後が空の場合
    // -------------------------------------------------------------------

    describe('空wsKeyのケース', () => {
        it('safety_approve: → action="safety_approve", wsKey=undefined（空文字はundefinedに変換）', () => {
            const result = parseAutoModeButtonId('safety_approve:');
            expect(result).toEqual({ action: 'safety_approve' });
            expect(result?.wsKey).toBeUndefined();
        });

        it('auto_stop: → action="auto_stop", wsKey=undefined', () => {
            const result = parseAutoModeButtonId('auto_stop:');
            expect(result).toEqual({ action: 'auto_stop' });
            expect(result?.wsKey).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // 全ベースIDの網羅テスト
    // -------------------------------------------------------------------

    describe('全ベースID網羅', () => {
        const allBases = [
            'confirm_continue', 'confirm_stop',
            'safety_approve', 'safety_skip', 'safety_stop',
            'automode_stop', 'auto_stop',
        ];

        for (const base of allBases) {
            it(`${base} (wsKey なし) → マッチする`, () => {
                const result = parseAutoModeButtonId(base);
                expect(result).toBeDefined();
                expect(result?.action).toBe(base);
            });

            it(`${base}:test-ws (wsKey あり) → マッチする`, () => {
                const result = parseAutoModeButtonId(`${base}:test-ws`);
                expect(result).toBeDefined();
                expect(result?.action).toBe(base);
                expect(result?.wsKey).toBe('test-ws');
            });
        }
    });
});
