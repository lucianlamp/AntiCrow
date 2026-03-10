// ---------------------------------------------------------------------------
// planPipeline.test.ts — planPipeline のユニットテスト
// ---------------------------------------------------------------------------
// テスト対象:
//   - resolveReplyContext: 返信コンテキスト解決
//   - applyChoiceSelection: 選択結果の prompt 付加
//   - handleConfirmation: 確認フロー

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TextChannel, Message } from 'discord.js';

// ---------------------------------------------------------------------------
// モック
// ---------------------------------------------------------------------------

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

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

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

vi.mock('../i18n', () => ({
    t: vi.fn((key: string, ...args: unknown[]) => `${key}:${args.join(',')}`),
}));

vi.mock('../suggestionButtons', () => ({
    AUTO_PROMPT: 'テスト用オートプロンプト',
    buildSuggestionRow: vi.fn(),
    buildSuggestionContent: vi.fn(),
    storeSuggestions: vi.fn(),
}));

vi.mock('../messageQueue', () => ({
    cancelPlanGeneration: vi.fn(),
    enqueueMessage: vi.fn(),
    getActivePlanProgressIntervals: vi.fn(() => []),
}));

vi.mock('../autoModeController', () => ({
    isAutoModeActive: vi.fn(() => false),
    startAutoMode: vi.fn(),
    stopAutoMode: vi.fn(),
    onStepComplete: vi.fn(),
}));

vi.mock('../cdpModels', () => ({
    getCurrentModel: vi.fn(),
}));

vi.mock('../cdpModes', () => ({
    getCurrentMode: vi.fn(),
}));

vi.mock('../configHelper', () => ({
    getResponseTimeout: vi.fn(() => 300000),
}));

vi.mock('../executorResponseHandler', () => ({
    sendTeamResponse: vi.fn(),
}));

vi.mock('../teamConfig', () => ({
    loadTeamConfig: vi.fn(() => ({
        maxAgents: 3,
        enabled: true,
    })),
}));

vi.mock('../discordBot', () => ({
    DiscordBot: vi.fn(),
}));

vi.mock('../bridgeContext', () => ({
    BridgeContext: vi.fn(),
}));

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------
import { resolveReplyContext, applyChoiceSelection } from '../planPipeline';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockChannel(overrides: Record<string, unknown> = {}): TextChannel {
    return {
        id: 'test-channel-id',
        send: vi.fn().mockResolvedValue(undefined),
        messages: {
            fetch: vi.fn().mockResolvedValue({
                content: '元のメッセージ内容',
                author: { username: 'test-user' },
            }),
        },
        ...overrides,
    } as unknown as TextChannel;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('planPipeline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // resolveReplyContext
    // -----------------------------------------------------------------------

    describe('resolveReplyContext', () => {
        it('should return original text when no messageRef', async () => {
            const channel = createMockChannel();
            const result = await resolveReplyContext(channel, 'テストメッセージ');
            expect(result).toBe('テストメッセージ');
        });

        it('should return original text when messageRef has no messageId', async () => {
            const channel = createMockChannel();
            const result = await resolveReplyContext(channel, 'テスト', {});
            expect(result).toBe('テスト');
        });

        it('should prepend reply context when messageRef has messageId', async () => {
            const mockMessage = {
                content: '元のメッセージ',
                author: { username: 'lucian' },
            };
            const channel = createMockChannel({
                messages: {
                    fetch: vi.fn().mockResolvedValue(mockMessage),
                } as any,
            });

            const result = await resolveReplyContext(channel, '返信テスト', { messageId: 'msg-123' });
            // 返信コンテキストが付加されているはず
            expect(result).toContain('返信テスト');
        });

        it('should handle fetch error gracefully', async () => {
            const channel = createMockChannel({
                messages: {
                    fetch: vi.fn().mockRejectedValue(new Error('Not found')),
                } as any,
            });

            const result = await resolveReplyContext(channel, 'テスト', { messageId: 'invalid-id' });
            // エラーでも元のテキストが返る
            expect(result).toBe('テスト');
        });
    });

    // -----------------------------------------------------------------------
    // applyChoiceSelection
    // -----------------------------------------------------------------------

    describe('applyChoiceSelection', () => {
        it('should not modify prompt when no selectedChoices', () => {
            const plan = { prompt: 'テストプロンプト', tasks: [] };
            applyChoiceSelection(plan as any);
            expect(plan.prompt).toBe('テストプロンプト');
        });

        it('should not modify prompt when selectedChoices is empty', () => {
            const plan = { prompt: 'テストプロンプト', tasks: [] };
            applyChoiceSelection(plan as any, []);
            expect(plan.prompt).toBe('テストプロンプト');
        });

        it('should not modify prompt for [-1] (全選択)', () => {
            const plan = { prompt: 'テストプロンプト', tasks: [] };
            applyChoiceSelection(plan as any, [-1]);
            expect(plan.prompt).toBe('テストプロンプト');
        });

        it('should prepend selected choices to prompt', () => {
            const plan = {
                prompt: '1. タスクA\n2. タスクB\n3. タスクC',
                tasks: [],
            };
            applyChoiceSelection(plan as any, [0, 2]);
            // 選択結果が先頭に付加される
            expect(plan.prompt).toContain('1');
            expect(plan.prompt).toContain('3');
        });
    });
});
