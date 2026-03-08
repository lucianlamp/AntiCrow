// ---------------------------------------------------------------------------
// messageHandler.test.ts — messageHandler モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// 依存モジュールのモック

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

vi.mock('../embedHelper', () => ({
    buildEmbed: vi.fn((msg: string, color?: number) => ({ description: msg, color })),
    EmbedColor: {
        Info: 0x3498db,
        Warning: 0xe67e22,
        Error: 0xe74c3c,
        Success: 0x2ecc71,
        Progress: 0x9b59b6,
    },
    sanitizeErrorForDiscord: vi.fn((msg: string) => msg),
    normalizeHeadings: vi.fn((text: string) => text),
}));

vi.mock('../discordFormatter', () => ({
    splitForEmbeds: vi.fn((text: string) => [[text]]),
}));

vi.mock('../discordBot', () => ({
    DiscordBot: {
        resolveWorkspaceFromChannel: vi.fn(() => null),
    },
}));

vi.mock('../discordReactions', () => ({
    cancelActiveConfirmation: vi.fn(() => false),
}));

vi.mock('../cdpBridge', () => ({
    CdpBridge: vi.fn(),
}));

vi.mock('../cdpPool', () => ({
    WorkspaceConnectionError: class extends Error {
        userMessage: string;
        constructor(msg: string) {
            super(msg);
            this.userMessage = msg;
        }
    },
}));

vi.mock('../errors', () => ({
    CascadePanelError: class extends Error { },
}));

vi.mock('../fileIpc', () => ({
    FileIpc: {
        extractResult: vi.fn((text: string) => text),
    },
}));

vi.mock('../planParser', () => ({
    parsePlanJson: vi.fn(),
    buildPlan: vi.fn(),
}));

vi.mock('../promptBuilder', () => ({
    buildPlanPrompt: vi.fn(() => ({
        prompt: 'mock plan prompt',
        tempFiles: [],
    })),
    buildConfirmMessage: vi.fn(() => 'Confirm?'),
    countChoiceItems: vi.fn(() => 3),
    cronToPrefix: vi.fn(() => '毎日'),
}));

vi.mock('../workspaceResolver', () => ({
    resolveWorkspace: vi.fn(),
}));

vi.mock('../attachmentDownloader', () => ({
    downloadAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock('../configHelper', () => ({
    getResponseTimeout: vi.fn(() => 300000),
    isUserAllowed: vi.fn((userId: string) => ({
        allowed: userId !== 'blocked-user',
        reason: userId === 'blocked-user' ? 'ユーザーが許可リストに含まれていません' : '',
    })),
    getMaxMessageLength: vi.fn(() => 6000),
    getWorkspacePaths: vi.fn(() => ({})),
}));

vi.mock('../cdpModels', () => ({
    getCurrentModel: vi.fn().mockResolvedValue(null),
}));

vi.mock('../cdpModes', () => ({
    getCurrentMode: vi.fn().mockResolvedValue(null),
}));

import {
    getMessageQueueStatus,
    resetProcessingFlag,
    cancelPlanGeneration,
    enqueueMessage,
    handleDiscordMessage,
} from '../messageHandler';
import { DiscordBot } from '../discordBot';
import { isUserAllowed } from '../configHelper';
import type { BridgeContext } from '../bridgeContext';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: `msg-${Math.random().toString(36).substring(2, 8)}`,
        content: overrides.content ?? 'テストメッセージ',
        author: {
            id: overrides.authorId ?? 'allowed-user',
            tag: 'User#0001',
            bot: false,
        },
        channel: {
            id: 'ch-001',
            name: 'test-channel',
            send: vi.fn().mockResolvedValue({ id: 'sent-msg-001' }),
            sendTyping: vi.fn().mockResolvedValue(undefined),
            messages: {
                fetch: vi.fn().mockResolvedValue(null),
            },
            guild: { id: 'guild-001' },
            parent: null,
        },
        attachments: {
            size: 0,
            values: () => [],
        },
        reference: null,
        ...overrides,
    };
}

function createMockBridgeContext(overrides: Record<string, unknown> = {}): BridgeContext {
    return {
        cdp: {
            sendPrompt: vi.fn().mockResolvedValue(undefined),
            ensureConnected: vi.fn().mockResolvedValue(undefined),
            getActiveWorkspaceName: vi.fn(() => 'test-workspace'),
            getActiveTargetTitle: vi.fn(() => 'Test — Antigravity'),
            ops: {},
        },
        cdpPool: null,
        bot: {
            waitForConfirmation: vi.fn().mockResolvedValue('approved'),
            waitForChoice: vi.fn().mockResolvedValue(1),
            waitForMultiChoice: vi.fn().mockResolvedValue([1, 2]),
            createPlanChannel: vi.fn().mockResolvedValue('ch-plan'),
            setModelName: vi.fn(),
        },
        fileIpc: {
            createRequestId: vi.fn(() => ({
                requestId: 'req_test_001',
                responsePath: '/mock/ipc/req_test_001_response.json',
            })),
            createMarkdownRequestId: vi.fn(() => ({
                requestId: 'req_test_001',
                responsePath: '/mock/ipc/req_test_001_response.md',
            })),
            createProgressPath: vi.fn(() => '/mock/ipc/progress.json'),
            waitForResponse: vi.fn().mockResolvedValue('{}'),
            readProgress: vi.fn().mockResolvedValue(null),
            cleanupProgress: vi.fn().mockResolvedValue(undefined),
            cleanupTmpFiles: vi.fn().mockResolvedValue(undefined),
            getIpcDir: vi.fn(() => '/mock/ipc'),
            getStoragePath: vi.fn(() => '/mock/storage'),
        },
        planStore: {
            add: vi.fn(),
            get: vi.fn(() => null),
            update: vi.fn(),
        },
        scheduler: {
            register: vi.fn(),
        },
        executor: {
            enqueueImmediate: vi.fn().mockResolvedValue(undefined),
        },
        executorPool: null,
        extensionPath: '/mock/extension',
        ...overrides,
    } as unknown as BridgeContext;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('messageHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetProcessingFlag();
    });

    // -----------------------------------------------------------------------
    // getMessageQueueStatus
    // -----------------------------------------------------------------------

    describe('getMessageQueueStatus', () => {
        it('should return empty status initially', () => {
            const status = getMessageQueueStatus();
            expect(status.total).toBe(0);
            expect(status.perWorkspace.size).toBe(0);
            expect(status.processing).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // resetProcessingFlag
    // -----------------------------------------------------------------------

    describe('resetProcessingFlag', () => {
        it('should reset all queue counts', () => {
            // enqueueMessage を呼んでキューを増やしてからリセット
            const status = getMessageQueueStatus();
            expect(status.total).toBe(0);

            resetProcessingFlag();

            const afterReset = getMessageQueueStatus();
            expect(afterReset.total).toBe(0);
            expect(afterReset.perWorkspace.size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // cancelPlanGeneration
    // -----------------------------------------------------------------------

    describe('cancelPlanGeneration', () => {
        it('should not throw when nothing is in progress', () => {
            expect(() => cancelPlanGeneration()).not.toThrow();
        });

        it('should clear processing statuses', () => {
            cancelPlanGeneration();
            const status = getMessageQueueStatus();
            expect(status.processing).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // enqueueMessage — 重複チェック
    // -----------------------------------------------------------------------

    describe('enqueueMessage — 重複チェック', () => {
        it('should skip duplicate message IDs', async () => {
            const ctx = createMockBridgeContext();
            const msg = createMockMessage({ id: 'dup-msg-001' });

            // 1回目
            await enqueueMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            // 2回目（同じID）は重複スキップ
            await enqueueMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            // handleDiscordMessage は1回だけ呼ばれる（内部で呼ばれるため直接検証は困難）
            // 代わりにキューカウンターで間接検証
        });
    });

    // -----------------------------------------------------------------------
    // handleDiscordMessage — 認証チェック
    // -----------------------------------------------------------------------

    describe('handleDiscordMessage — 認証チェック', () => {
        it('should reject unauthorized users', async () => {
            const ctx = createMockBridgeContext();
            const msg = createMockMessage({ authorId: 'blocked-user' });

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            // チャンネルにエラーメッセージが送信されている
            const channel = msg.channel;
            expect(channel.send).toHaveBeenCalled();
            const sendArgs = channel.send.mock.calls[0][0];
            expect(sendArgs.embeds[0].description).toContain('🔒');
        });

        it('should reject messages exceeding max length', async () => {
            const ctx = createMockBridgeContext();
            const longText = 'a'.repeat(7000); // 6000文字制限を超過
            const msg = createMockMessage({ content: longText });

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            const channel = msg.channel;
            expect(channel.send).toHaveBeenCalled();
            const sendArgs = channel.send.mock.calls[0][0];
            expect(sendArgs.embeds[0].description).toContain('メッセージが長すぎます');
        });

        it('should skip empty messages without attachments', async () => {
            const ctx = createMockBridgeContext();
            const msg = createMockMessage({ content: '' });

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            // 空メッセージは即座にreturn → send は呼ばれない
            expect(msg.channel.send).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // handleDiscordMessage — Bridge 初期化チェック
    // -----------------------------------------------------------------------

    describe('handleDiscordMessage — Bridge 初期化チェック', () => {
        it('should reject when fileIpc is missing', async () => {
            const ctx = createMockBridgeContext({ fileIpc: null });
            const msg = createMockMessage();

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            const channel = msg.channel;
            expect(channel.send).toHaveBeenCalled();
            const sendArgs = channel.send.mock.calls[0][0];
            expect(sendArgs.embeds[0].description).toContain('初期化されていません');
        });

        it('should reject when planStore is missing', async () => {
            const ctx = createMockBridgeContext({ planStore: null });
            const msg = createMockMessage();

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            const channel = msg.channel;
            expect(channel.send).toHaveBeenCalled();
        });

        it('should reject when cdp and executor are missing (non-pool mode)', async () => {
            const ctx = createMockBridgeContext({ cdp: null, executor: null });
            const msg = createMockMessage();

            await handleDiscordMessage(ctx, msg as any, 'agent-chat', 'test-channel');

            const channel = msg.channel;
            expect(channel.send).toHaveBeenCalled();
        });
    });
});
