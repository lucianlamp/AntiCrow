// ---------------------------------------------------------------------------
// autoModeController.test.ts — stopAutoMode のユニットテスト
// ---------------------------------------------------------------------------
// テスト対象:
//   - stopAutoMode: 提案ボタン生成ロジック、history 空/存在のエッジケース
//   - isAutoModeActive: 状態遷移テスト

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TextChannel } from 'discord.js';

// ---------------------------------------------------------------------------
// モック — vi.mock は import より先に巻き上げられる
// トップレベル変数は vi.hoisted() で宣言する
// ---------------------------------------------------------------------------

const { mockBuildSuggestionRow, mockStoreSuggestions } = vi.hoisted(() => ({
    mockBuildSuggestionRow: vi.fn(),
    mockStoreSuggestions: vi.fn(),
}));

// vscode モック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
        }),
    },
}));

// logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

// embedHelper モック
vi.mock('../embedHelper', () => ({
    EmbedColor: {
        Success: 0x2ecc71,
        Info: 0x3498db,
        Warning: 0xe67e22,
        Danger: 0xe74c3c,
        Progress: 0x3498db,
    },
    buildEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
}));

// messageQueue モック
vi.mock('../messageQueue', () => ({
    cancelPlanGeneration: vi.fn(),
}));

// suggestionButtons モック — vi.hoisted で宣言した変数を使用
vi.mock('../suggestionButtons', () => ({
    AUTO_PROMPT: 'テスト用オートプロンプト',
    buildSuggestionRow: mockBuildSuggestionRow,
    getAllSuggestions: vi.fn(() => []),
    storeSuggestions: mockStoreSuggestions,
}));

// i18n モック
vi.mock('../i18n', () => ({
    t: vi.fn((key: string) => key),
}));

// autoModeConfig モック
vi.mock('../autoModeConfig', () => ({
    AUTO_MODE_DEFAULTS: {
        selectionMode: 'ai-select',
        confirmMode: 'auto',
        maxSteps: 10,
        maxDuration: 1800000,
    },
}));

// child_process モック
vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

// util モック
vi.mock('util', () => ({
    promisify: vi.fn(() => vi.fn()),
}));

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------
import {
    startAutoMode,
    stopAutoMode,
    isAutoModeActive,
    onStepComplete,
} from '../autoModeController';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockChannel(overrides: Partial<TextChannel> = {}): TextChannel {
    return {
        id: 'test-channel-id',
        send: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as TextChannel;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('autoModeController — stopAutoMode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // currentState が null の場合（早期リターン）
    // -----------------------------------------------------------------------

    describe('currentState が null の場合', () => {
        it('should return early without sending any message', async () => {
            const channel = createMockChannel();

            // currentState が null の状態で stopAutoMode を呼ぶ
            await stopAutoMode(channel, 'manual');

            // channel.send は呼ばれないはず
            expect(channel.send).not.toHaveBeenCalled();

            // isAutoModeActive は false のまま
            expect(isAutoModeActive()).toBe(false);
        });

        it('should not call storeSuggestions or buildSuggestionRow', async () => {
            const channel = createMockChannel();

            await stopAutoMode(channel, 'manual');

            expect(mockStoreSuggestions).not.toHaveBeenCalled();
            expect(mockBuildSuggestionRow).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // history が空の場合
    // -----------------------------------------------------------------------

    describe('history が空の場合', () => {
        it('should send completion embed without suggestion buttons', async () => {
            const channel = createMockChannel();

            // startAutoMode で内部状態をセットアップ
            await startAutoMode(channel, 'test-ws', 'テストプロンプト');
            expect(isAutoModeActive()).toBe(true);

            // history が空の状態で stopAutoMode
            await stopAutoMode(channel, 'manual');

            // 状態がリセットされているはず
            expect(isAutoModeActive()).toBe(false);

            // channel.send が呼ばれている（startAutoMode + stopAutoMode で計2回）
            expect(channel.send).toHaveBeenCalledTimes(2);

            // stopAutoMode の呼び出し（2回目）を検証
            const stopCall = (channel.send as any).mock.calls[1][0];
            expect(stopCall).toHaveProperty('embeds');
            // history が空なので suggestions もない → components は空配列
            expect(stopCall.components).toEqual([]);

            // buildSuggestionRow は呼ばれない（history 空 → lastStep が null）
            expect(mockBuildSuggestionRow).not.toHaveBeenCalled();
            expect(mockStoreSuggestions).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // 各停止理由のテスト
    // -----------------------------------------------------------------------

    describe('停止理由の表示', () => {
        const testCases: Array<{ reason: string; expected: string }> = [
            { reason: 'max_steps', expected: '最大ステップ数' },
            { reason: 'completed', expected: '全タスク完了' },
            { reason: 'similarity', expected: '類似した結果' },
            { reason: 'safety_stop', expected: 'セーフティガード' },
            { reason: 'confirm_stop', expected: '確認モード' },
            { reason: 'new_session', expected: '新しい連続オートモードセッション' },
            { reason: 'error', expected: 'エラーが発生' },
            { reason: 'auto_reset', expected: '既存の連続オートモードを停止' },
            { reason: 'manual', expected: '手動で停止' },
        ];

        for (const { reason, expected } of testCases) {
            it(`should include "${expected}" for reason "${reason}"`, async () => {
                const channel = createMockChannel();

                await startAutoMode(channel, 'test-ws', 'テストプロンプト');
                vi.clearAllMocks(); // startAutoMode の send 呼び出しをリセット

                await stopAutoMode(channel, reason);

                // channel.send が呼ばれている
                expect(channel.send).toHaveBeenCalledTimes(1);

                // buildEmbed に渡されたテキストに期待する文字列が含まれている
                const { buildEmbed } = await import('../embedHelper');
                const embedCall = (buildEmbed as any).mock.calls;
                expect(embedCall.length).toBeGreaterThanOrEqual(1);

                const embedText = embedCall[embedCall.length - 1][0] as string;
                expect(embedText).toContain(expected);
            });
        }
    });

    // -----------------------------------------------------------------------
    // channel.send がエラーの場合
    // -----------------------------------------------------------------------

    describe('channel.send がエラーの場合', () => {
        it('should not throw even if channel.send fails', async () => {
            let callCount = 0;
            const channel = createMockChannel({
                send: vi.fn().mockImplementation(async () => {
                    callCount++;
                    if (callCount >= 2) {
                        throw new Error('Discord API error');
                    }
                }),
            } as any);

            await startAutoMode(channel, 'test-ws', 'テストプロンプト');

            // send が失敗しても例外を投げない
            await expect(stopAutoMode(channel, 'manual')).resolves.toBeUndefined();

            // 状態はリセットされている
            expect(isAutoModeActive()).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // isAutoModeActive の状態遷移
    // -----------------------------------------------------------------------

    describe('isAutoModeActive の状態遷移', () => {
        it('should transition from false → true → false', async () => {
            const channel = createMockChannel();

            // 初期状態：false
            expect(isAutoModeActive()).toBe(false);

            // startAutoMode 後：true
            await startAutoMode(channel, 'test-ws', 'テスト');
            expect(isAutoModeActive()).toBe(true);

            // stopAutoMode 後：false
            await stopAutoMode(channel, 'completed');
            expect(isAutoModeActive()).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 二重 stopAutoMode の安全性
    // -----------------------------------------------------------------------

    describe('二重 stopAutoMode の安全性', () => {
        it('should handle double stop gracefully', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws', 'テスト');

            // 1回目の stop
            await stopAutoMode(channel, 'manual');
            expect(isAutoModeActive()).toBe(false);

            // 2回目の stop（currentState が null）
            await stopAutoMode(channel, 'manual');
            expect(isAutoModeActive()).toBe(false);

            // send は startAutoMode(1回) + 1回目の stopAutoMode(1回) = 2回
            expect(channel.send).toHaveBeenCalledTimes(2);
        });
    });

    // -----------------------------------------------------------------------
    // cancelPlanGeneration が呼ばれること
    // -----------------------------------------------------------------------

    describe('cancelPlanGeneration の呼び出し', () => {
        it('should call cancelPlanGeneration on stop', async () => {
            const channel = createMockChannel();
            const { cancelPlanGeneration } = await import('../messageQueue');

            await startAutoMode(channel, 'test-ws', 'テスト');
            vi.clearAllMocks();

            await stopAutoMode(channel, 'manual');

            expect(cancelPlanGeneration).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // フォールバックSUGGESTIONS — 最後のステップにsuggestionsがない場合
    // -----------------------------------------------------------------------

    describe('フォールバック SUGGESTIONS', () => {
        const mockSuggestions = [
            { label: 'テスト1', description: '説明1', prompt: 'prompt1' },
            { label: 'テスト2', description: '説明2', prompt: 'prompt2' },
        ];

        it('最後のステップにsuggestionsがない場合、前のステップのsuggestionsが使われる', async () => {
            const channel = createMockChannel();
            mockBuildSuggestionRow.mockReturnValue({ type: 1, components: [] });

            await startAutoMode(channel, 'test-ws', 'テストプロンプト');

            // ステップ1: suggestionsあり
            await onStepComplete(channel, mockSuggestions, 'レスポンス1');
            // ステップ2: suggestionsなし
            await onStepComplete(channel, [], 'レスポンス2');

            vi.clearAllMocks();
            mockBuildSuggestionRow.mockReturnValue({ type: 1, components: [] });

            await stopAutoMode(channel, 'manual');

            // フォールバックでステップ1のsuggestionsが使われる
            expect(mockStoreSuggestions).toHaveBeenCalledWith(
                'test-channel-id',
                mockSuggestions,
            );
            expect(mockBuildSuggestionRow).toHaveBeenCalledWith(mockSuggestions);
        });

        it('最後のステップにsuggestionsがある場合、そのまま使われる', async () => {
            const channel = createMockChannel();
            const lastSuggestions = [
                { label: '最新', description: '最新の提案', prompt: 'latest' },
            ];
            mockBuildSuggestionRow.mockReturnValue({ type: 1, components: [] });

            await startAutoMode(channel, 'test-ws', 'テストプロンプト');

            // ステップ1: suggestionsあり
            await onStepComplete(channel, mockSuggestions, 'レスポンス1');
            // ステップ2: 別のsuggestionsあり
            await onStepComplete(channel, lastSuggestions, 'レスポンス2');

            vi.clearAllMocks();
            mockBuildSuggestionRow.mockReturnValue({ type: 1, components: [] });

            await stopAutoMode(channel, 'manual');

            // 最後のステップのsuggestionsが使われる
            expect(mockStoreSuggestions).toHaveBeenCalledWith(
                'test-channel-id',
                lastSuggestions,
            );
            expect(mockBuildSuggestionRow).toHaveBeenCalledWith(lastSuggestions);
        });

        it('全ステップにsuggestionsがない場合、ボタンは表示されない', async () => {
            const channel = createMockChannel();

            await startAutoMode(channel, 'test-ws', 'テストプロンプト');

            // ステップ1: suggestionsなし
            await onStepComplete(channel, [], 'レスポンス1');
            // ステップ2: suggestionsなし
            await onStepComplete(channel, [], 'レスポンス2');

            vi.clearAllMocks();

            await stopAutoMode(channel, 'manual');

            expect(mockStoreSuggestions).not.toHaveBeenCalled();
            expect(mockBuildSuggestionRow).not.toHaveBeenCalled();
        });
    });
});
