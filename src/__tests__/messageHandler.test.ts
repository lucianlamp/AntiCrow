// ---------------------------------------------------------------------------
// messageHandler.test.ts — detectModelChangeRequest のテスト
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

import { detectModelChangeRequest } from '../messageHandler';

// ---------------------------------------------------------------------------
// detectModelChangeRequest
// ---------------------------------------------------------------------------

describe('detectModelChangeRequest', () => {
    // --- 日本語パターン ---
    describe('日本語パターン', () => {
        it('「モデルをGeminiに変えて」で Gemini を検出', () => {
            const result = detectModelChangeRequest('モデルをGeminiに変えて');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Gemini');
        });

        it('「モデルをClaude 3.5 Sonnetに切り替えて」で Claude 3.5 Sonnet を検出', () => {
            const result = detectModelChangeRequest('モデルをClaude 3.5 Sonnetに切り替えて');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Claude 3.5 Sonnet');
        });

        it('「GPT-4oに変えて」で GPT-4o を検出', () => {
            const result = detectModelChangeRequest('GPT-4oに変えて');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('GPT-4o');
        });

        it('「モデル変更: Gemini 2.0 Flash」で Gemini 2.0 Flash を検出', () => {
            const result = detectModelChangeRequest('モデル変更: Gemini 2.0 Flash');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Gemini 2.0 Flash');
        });

        it('「Claudeへモデルを変えて」で Claude を検出', () => {
            const result = detectModelChangeRequest('Claudeへモデルを変えて');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Claude');
        });

        it('「モデルスイッチ：GPT-4」で GPT-4 を検出', () => {
            const result = detectModelChangeRequest('モデルスイッチ：GPT-4');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('GPT-4');
        });
    });

    // --- 英語パターン ---
    describe('英語パターン', () => {
        it('"switch model to GPT-4o" で GPT-4o を検出', () => {
            const result = detectModelChangeRequest('switch model to GPT-4o');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('GPT-4o');
        });

        it('"change model to Claude" で Claude を検出', () => {
            const result = detectModelChangeRequest('change model to Claude');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Claude');
        });

        it('"use Gemini 2.0 Flash" で Gemini 2.0 Flash を検出', () => {
            const result = detectModelChangeRequest('use Gemini 2.0 Flash');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('Gemini 2.0 Flash');
        });

        it('"set model GPT-4" で GPT-4 を検出', () => {
            const result = detectModelChangeRequest('set model GPT-4');
            expect(result).not.toBeNull();
            expect(result!.targetModel).toBe('GPT-4');
        });
    });

    // --- マッチしないパターン ---
    describe('マッチしないパターン', () => {
        it('通常のメッセージはnull', () => {
            expect(detectModelChangeRequest('おはよう')).toBeNull();
        });

        it('空文字はnull', () => {
            expect(detectModelChangeRequest('')).toBeNull();
        });

        it('長すぎるメッセージはnull', () => {
            const longText = 'モデルを' + 'A'.repeat(100) + 'に変えて';
            expect(detectModelChangeRequest(longText)).toBeNull();
        });

        it('天気を聞くメッセージはnull', () => {
            expect(detectModelChangeRequest('今日の天気を教えて')).toBeNull();
        });

        it('モデルという単語だけではマッチしない', () => {
            expect(detectModelChangeRequest('モデル')).toBeNull();
        });
    });
});
