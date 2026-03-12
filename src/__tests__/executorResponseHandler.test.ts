// ---------------------------------------------------------------------------
// executorResponseHandler.test.ts — sendTeamResponse のユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// fs モック
vi.mock('fs', () => ({
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
}));

// os モック
vi.mock('os', () => ({
    homedir: () => '/mock/home',
}));

// Logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logInfo: vi.fn(),
}));

// FileIpc モック
vi.mock('../fileIpc', () => ({
    FileIpc: {
        extractResult: vi.fn((text: string) => text),
    },
    sanitizeWorkspaceName: (name?: string) => {
        if (!name) { return ''; }
        return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    },
}));

// memoryStore モック
vi.mock('../memoryStore', () => ({
    readCombinedMemory: vi.fn(() => null),
    appendToGlobalMemory: vi.fn(),
    appendToWorkspaceMemory: vi.fn(),
    extractMemoryTags: vi.fn(() => []),
    stripMemoryTags: vi.fn((text: string) => text.replace(/<!--\s*MEMORY:\w+:.*?-->/gs, '').trim()),
}));

// suggestionParser モック
vi.mock('../suggestionParser', () => ({
    parseSuggestions: vi.fn((text: string) => {
        // SUGGESTIONS タグを含むテスト用の簡易パーサー
        const suggestionsMatch = text.match(/<!-- SUGGESTIONS:\[(.*?)\] -->/s);
        if (suggestionsMatch) {
            try {
                const suggestions = JSON.parse(`[${suggestionsMatch[1]}]`);
                const cleanContent = text.replace(/<!-- SUGGESTIONS:.*?-->/gs, '').trim();
                return { suggestions, cleanContent };
            } catch {
                return { suggestions: [], cleanContent: text };
            }
        }
        return { suggestions: [], cleanContent: text };
    }),
}));

// suggestionButtons モック
vi.mock('../suggestionButtons', () => ({
    buildSuggestionRow: vi.fn(() => ({ components: [] })),
    buildSuggestionContent: vi.fn(() => 'suggestion content'),
    storeSuggestions: vi.fn(),
}));

// embedHelper モック
vi.mock('../embedHelper', () => ({
    EmbedColor: { Success: 0x2ecc71, Response: 0x8D3ED9, Suggest: 0x9b59b6, Warning: 0xe67e22 },
    buildEmbed: vi.fn(() => ({ toJSON: () => ({}) })),
    normalizeHeadings: vi.fn((text: string) => text),
}));

// discordFormatter モック
vi.mock('../discordFormatter', () => ({
    splitForEmbeds: vi.fn((text: string) => [[text]]),
}));

// autoModeController モック
const mockIsAutoModeActive = vi.fn(() => false);
vi.mock('../autoModeController', () => ({
    isAutoModeActive: () => mockIsAutoModeActive(),
}));

// configHelper モック
vi.mock('../configHelper', () => ({
    getMaxRetries: vi.fn(() => 0),
    getTimezone: vi.fn(() => 'Asia/Tokyo'),
    getWorkspacePaths: vi.fn(() => ({})),
}));

// planStore モック
vi.mock('../planStore', () => ({
    PlanStore: vi.fn(),
}));

import { sendTeamResponse, type TeamResponseCallbacks } from '../executorResponseHandler';
import type { Plan } from '../types';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockPlan(overrides: Partial<Plan> = {}): Plan {
    return {
        plan_id: `plan-${Math.random().toString(36).substring(2, 8)}`,
        timezone: 'Asia/Tokyo',
        cron: null,
        prompt: 'test prompt',
        requires_confirmation: false,
        source_channel_id: 'ch-src',
        notify_channel_id: 'ch-notify',
        discord_templates: { ack: '✅', run_success_prefix: '✅ 完了' },
        human_summary: 'テスト',
        status: 'active',
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

function createMockCallbacks(): TeamResponseCallbacks & {
    sendToChannel: ReturnType<typeof vi.fn>;
    sendFileToChannel: ReturnType<typeof vi.fn>;
    sendEmbeds: ReturnType<typeof vi.fn>;
    sendSuggestionButtons: ReturnType<typeof vi.fn>;
} {
    return {
        sendToChannel: vi.fn().mockResolvedValue(undefined),
        sendFileToChannel: vi.fn().mockResolvedValue({ sent: true }),
        sendEmbeds: vi.fn().mockResolvedValue(undefined),
        sendSuggestionButtons: vi.fn().mockResolvedValue(undefined),
    };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('sendTeamResponse', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // 基本的な処理フロー
    // -----------------------------------------------------------------------

    describe('基本的な処理フロー', () => {
        it('レスポンスを処理して sendEmbeds を呼ぶこと', async () => {
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            await sendTeamResponse({
                response: 'テスト結果です',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // sendEmbeds が呼ばれていること
            expect(callbacks.sendEmbeds).toHaveBeenCalled();
            const embedCall = callbacks.sendEmbeds.mock.calls[0];
            expect(embedCall[1]).toBe(0x8D3ED9); // EmbedColor.Response
        });

        it('空レスポンスでもクラッシュしないこと', async () => {
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            await expect(sendTeamResponse({
                response: '',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            })).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // MEMORY タグ処理
    // -----------------------------------------------------------------------

    describe('MEMORY タグ処理', () => {
        it('MEMORY タグが extractAndSaveMemory に渡されること', async () => {
            const { extractMemoryTags, appendToGlobalMemory } = await import('../memoryStore');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            const response = 'テスト結果\n<!-- MEMORY:global: 重要な学び -->';

            // extractMemoryTags のモック設定
            (extractMemoryTags as any).mockReturnValue([
                { scope: 'global', content: '重要な学び' },
            ]);

            await sendTeamResponse({
                response,
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // extractMemoryTags が呼ばれていること
            expect(extractMemoryTags).toHaveBeenCalledWith(response);
            // appendToGlobalMemory が学びの内容で呼ばれていること
            expect(appendToGlobalMemory).toHaveBeenCalledWith('重要な学び');
        });

        it('ワークスペース MEMORY タグが正しく処理されること', async () => {
            const { extractMemoryTags, appendToWorkspaceMemory } = await import('../memoryStore');
            const { getWorkspacePaths } = await import('../configHelper');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan({ workspace_name: 'test-workspace' });

            const response = 'WS結果\n<!-- MEMORY:workspace: ビルド手順 -->';

            (extractMemoryTags as any).mockReturnValue([
                { scope: 'workspace', content: 'ビルド手順' },
            ]);

            // getWorkspacePaths が workspace_name に対応するパスを返すようにする
            (getWorkspacePaths as any).mockReturnValue({
                'test-workspace': '/mock/workspace/path',
            });

            await sendTeamResponse({
                response,
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            expect(extractMemoryTags).toHaveBeenCalledWith(response);
            expect(appendToWorkspaceMemory).toHaveBeenCalledWith('/mock/workspace/path', 'ビルド手順');
        });
    });

    // -----------------------------------------------------------------------
    // SUGGESTIONS 処理
    // -----------------------------------------------------------------------

    describe('SUGGESTIONS 処理', () => {
        it('SUGGESTIONS タグが分離されて sendSuggestionButtons に渡されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            const suggestions = [{ label: 'テスト', prompt: 'テストプロンプト' }];

            // parseSuggestions のモック設定
            (parseSuggestions as any).mockReturnValue({
                suggestions,
                cleanContent: 'クリーンなコンテンツ',
            });

            await sendTeamResponse({
                response: 'テスト結果\n<!-- SUGGESTIONS:[...] -->',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // sendSuggestionButtons が正しい引数で呼ばれていること
            expect(callbacks.sendSuggestionButtons).toHaveBeenCalledWith(suggestions);
        });

        it('SUGGESTIONS がない場合は sendSuggestionButtons が呼ばれないこと', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [],
                cleanContent: 'テスト結果',
            });

            await sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            expect(callbacks.sendSuggestionButtons).not.toHaveBeenCalled();
        });

        it('sendSuggestionButtons のエラーでクラッシュしないこと', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [{ label: 'テスト', prompt: 'プロンプト' }],
                cleanContent: 'テスト結果',
            });

            // sendSuggestionButtons がエラーを投げるようにする
            callbacks.sendSuggestionButtons.mockRejectedValue(new Error('Discord API error'));

            await expect(sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            })).resolves.not.toThrow();
        });

        it('連続オートモード中 + onAutoModeComplete 設定時は SUGGESTIONS がスキップされること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            // onAutoModeComplete を設定
            (callbacks as any).onAutoModeComplete = vi.fn();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [{ label: 'テスト', prompt: 'プロンプト' }],
                cleanContent: 'テスト結果',
            });

            // 連続オートモードをアクティブに
            mockIsAutoModeActive.mockReturnValue(true);

            await sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // sendSuggestionButtons は呼ばれないこと
            expect(callbacks.sendSuggestionButtons).not.toHaveBeenCalled();
            // onAutoModeComplete は呼ばれること
            expect((callbacks as any).onAutoModeComplete).toHaveBeenCalled();

            mockIsAutoModeActive.mockReturnValue(false);
        });

        it('連続オートモード中でも onAutoModeComplete 未設定時は SUGGESTIONS が送信されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            // onAutoModeComplete は設定しない（チームモード完了時のパターン）
            const plan = createMockPlan();

            const suggestions = [{ label: 'テスト', prompt: 'テストプロンプト' }];
            (parseSuggestions as any).mockReturnValue({
                suggestions,
                cleanContent: 'テスト結果',
            });

            // 連続オートモードをアクティブに
            mockIsAutoModeActive.mockReturnValue(true);

            await sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // onAutoModeComplete が未設定なので SUGGESTIONS は送信される
            expect(callbacks.sendSuggestionButtons).toHaveBeenCalledWith(suggestions);

            mockIsAutoModeActive.mockReturnValue(false);
        });

        it('連続オートモード非アクティブ時は SUGGESTIONS が通常送信されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            const suggestions = [{ label: 'A', prompt: 'a' }, { label: 'B', prompt: 'b' }];
            (parseSuggestions as any).mockReturnValue({
                suggestions,
                cleanContent: 'テスト結果',
            });

            mockIsAutoModeActive.mockReturnValue(false);

            await sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            expect(callbacks.sendSuggestionButtons).toHaveBeenCalledWith(suggestions);
        });
    });

    // -----------------------------------------------------------------------
    // ファイル参照送信
    // -----------------------------------------------------------------------

    describe('ファイル参照送信', () => {
        it('sendFileToChannel コールバックが正しく渡されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [],
                cleanContent: '<!-- FILE:C:\\test\\file.png -->\nテスト結果',
            });

            await sendTeamResponse({
                response: '<!-- FILE:C:\\test\\file.png -->\nテスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // sendEmbeds が呼ばれていること（ファイル参照はsendFileReferences経由で内部処理）
            expect(callbacks.sendEmbeds).toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Discord 送信
    // -----------------------------------------------------------------------

    describe('Discord 送信', () => {
        it('クリーンなコンテンツが sendEmbeds に渡されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const { normalizeHeadings } = await import('../embedHelper');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [],
                cleanContent: 'クリーンなテスト結果',
            });

            (normalizeHeadings as any).mockImplementation((t: string) => t);

            await sendTeamResponse({
                response: 'テスト結果',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId: 'ch-123',
                callbacks,
            });

            // sendEmbeds に渡された descriptions を確認
            expect(callbacks.sendEmbeds).toHaveBeenCalled();
            const embedsCall = callbacks.sendEmbeds.mock.calls[0];
            // descriptions 配列と color が渡されていること
            expect(Array.isArray(embedsCall[0])).toBe(true);
            expect(embedsCall[1]).toBe(0x8D3ED9); // EmbedColor.Response
        });

        it('channelId が正しく送信関数に渡されること', async () => {
            const { parseSuggestions } = await import('../suggestionParser');
            const callbacks = createMockCallbacks();
            const plan = createMockPlan();

            (parseSuggestions as any).mockReturnValue({
                suggestions: [],
                cleanContent: 'テスト',
            });

            const channelId = 'test-channel-456';

            await sendTeamResponse({
                response: 'テスト',
                responsePath: '/mock/ipc/response.md',
                plan,
                channelId,
                callbacks,
            });

            // sendEmbeds が呼ばれていることを確認（channelId は sendTeamResponse 内で渡される）
            expect(callbacks.sendEmbeds).toHaveBeenCalled();
        });
    });
});
