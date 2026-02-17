// ---------------------------------------------------------------------------
// modeDetection.test.ts — detectModeChangeRequest のテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

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

import { detectModeChangeRequest } from '../messageHandler';

// ---------------------------------------------------------------------------
// detectModeChangeRequest
// ---------------------------------------------------------------------------

describe('detectModeChangeRequest', () => {
    // --- 日本語パターン ---
    describe('日本語パターン', () => {
        it('「モードをPlanningに変えて」で Planning を検出', () => {
            const result = detectModeChangeRequest('モードをPlanningに変えて');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Planning');
        });

        it('「モードをFastに切り替えて」で Fast を検出', () => {
            const result = detectModeChangeRequest('モードをFastに切り替えて');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Fast');
        });

        it('「Planningモードにして」で Planning を検出', () => {
            const result = detectModeChangeRequest('Planningモードにして');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Planning');
        });

        it('「Fastモードに変えて」で Fast を検出', () => {
            const result = detectModeChangeRequest('Fastモードに変えて');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Fast');
        });

        it('「モード変更: Planning」で Planning を検出', () => {
            const result = detectModeChangeRequest('モード変更: Planning');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Planning');
        });

        it('「モード切替：Fast」で Fast を検出', () => {
            const result = detectModeChangeRequest('モード切替：Fast');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Fast');
        });
    });

    // --- 英語パターン ---
    describe('英語パターン', () => {
        it('"switch mode to fast" で fast を検出', () => {
            const result = detectModeChangeRequest('switch mode to fast');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('fast');
        });

        it('"change mode to Planning" で Planning を検出', () => {
            const result = detectModeChangeRequest('change mode to Planning');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Planning');
        });

        it('"use planning mode" で planning を検出', () => {
            const result = detectModeChangeRequest('use planning mode');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('planning');
        });

        it('"set mode Fast" で Fast を検出', () => {
            const result = detectModeChangeRequest('set mode Fast');
            expect(result).not.toBeNull();
            expect(result!.targetMode).toBe('Fast');
        });
    });

    // --- マッチしないパターン ---
    describe('マッチしないパターン', () => {
        it('通常のメッセージはnull', () => {
            expect(detectModeChangeRequest('おはよう')).toBeNull();
        });

        it('空文字はnull', () => {
            expect(detectModeChangeRequest('')).toBeNull();
        });

        it('長すぎるメッセージはnull', () => {
            const longText = 'モードを' + 'A'.repeat(100) + 'に変えて';
            expect(detectModeChangeRequest(longText)).toBeNull();
        });

        it('天気を聞くメッセージはnull', () => {
            expect(detectModeChangeRequest('今日の天気を教えて')).toBeNull();
        });

        it('モードという単語だけではマッチしない', () => {
            expect(detectModeChangeRequest('モード')).toBeNull();
        });

        it('モデル変更はマッチしない', () => {
            expect(detectModeChangeRequest('モデルをGeminiに変えて')).toBeNull();
        });
    });
});
