// ---------------------------------------------------------------------------
// slashHelpers.test.ts — slashHelpers モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

// discordChannels モック
vi.mock('../discordChannels', () => ({
    resolveWorkspaceFromChannel: vi.fn(),
}));

import { resolveTargetCdp } from '../slashHelpers';
import { resolveWorkspaceFromChannel } from '../discordChannels';
import type { BridgeContext } from '../bridgeContext';

// ---------------------------------------------------------------------------
// ヘルパー: モックオブジェクト生成
// ---------------------------------------------------------------------------

/** 最小限の BridgeContext モックを生成 */
function createMockCtx(overrides: Partial<BridgeContext> = {}): BridgeContext {
    return {
        cdp: null,
        cdpPool: null,
        bot: null,
        ...overrides,
    } as unknown as BridgeContext;
}

/** チャンネル付きインタラクションモックを生成 */
function createMockInteraction(channel: unknown = null) {
    return { channel } as any;
}

/** CdpBridge モックを生成 */
function createMockCdpBridge(label: string = 'mock-cdp') {
    return { _label: label } as any;
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('slashHelpers', () => {
    const mockResolveWs = vi.mocked(resolveWorkspaceFromChannel);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -------------------------------------------------------------------
    // resolveTargetCdp
    // -------------------------------------------------------------------

    describe('resolveTargetCdp', () => {
        // ---------------------------------------------------------------
        // channel が null の場合
        // ---------------------------------------------------------------

        it('channel が null の場合、wsKey=null で ctx.cdp をそのまま返す', () => {
            const defaultCdp = createMockCdpBridge('default');
            const ctx = createMockCtx({ cdp: defaultCdp });
            const interaction = createMockInteraction(null);

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBeNull();
            expect(result.cdp).toBe(defaultCdp);
            expect(mockResolveWs).not.toHaveBeenCalled();
        });

        // ---------------------------------------------------------------
        // resolveWorkspaceFromChannel が null を返す場合
        // ---------------------------------------------------------------

        it('wsKey が null の場合（カテゴリから WS 解決できず）、ctx.cdp を返す', () => {
            const defaultCdp = createMockCdpBridge('default');
            const ctx = createMockCtx({ cdp: defaultCdp });
            const channel = { parent: { name: 'General' } };
            const interaction = createMockInteraction(channel);
            mockResolveWs.mockReturnValue(null);

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBeNull();
            expect(result.cdp).toBe(defaultCdp);
        });

        // ---------------------------------------------------------------
        // cdpPool が null の場合（シングル WS 環境）
        // ---------------------------------------------------------------

        it('cdpPool が null の場合、wsKey は解決されるが ctx.cdp にフォールバック', () => {
            const defaultCdp = createMockCdpBridge('default');
            const ctx = createMockCtx({ cdp: defaultCdp, cdpPool: null });
            const channel = { parent: { name: '🤖anti-crow' } };
            const interaction = createMockInteraction(channel);
            mockResolveWs.mockReturnValue('anti-crow');

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBe('anti-crow');
            expect(result.cdp).toBe(defaultCdp);
        });

        // ---------------------------------------------------------------
        // cdpPool があり、対象 WS の CDP がアクティブな場合
        // ---------------------------------------------------------------

        it('cdpPool で対象 WS の CDP がアクティブなら、そちらを返す', () => {
            const defaultCdp = createMockCdpBridge('default');
            const wsCdp = createMockCdpBridge('anti-crow-cdp');
            const mockPool = {
                getActive: vi.fn().mockReturnValue(wsCdp),
            };
            const ctx = createMockCtx({ cdp: defaultCdp, cdpPool: mockPool as any });
            const channel = { parent: { name: '🤖anti-crow' } };
            const interaction = createMockInteraction(channel);
            mockResolveWs.mockReturnValue('anti-crow');

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBe('anti-crow');
            expect(result.cdp).toBe(wsCdp);
            expect(mockPool.getActive).toHaveBeenCalledWith('anti-crow');
        });

        // ---------------------------------------------------------------
        // cdpPool があるが、対象 WS の CDP が非アクティブな場合
        // ---------------------------------------------------------------

        it('cdpPool で対象 WS の CDP が非アクティブなら、ctx.cdp にフォールバック', () => {
            const defaultCdp = createMockCdpBridge('default');
            const mockPool = {
                getActive: vi.fn().mockReturnValue(null),
            };
            const ctx = createMockCtx({ cdp: defaultCdp, cdpPool: mockPool as any });
            const channel = { parent: { name: '🤖anti-crow' } };
            const interaction = createMockInteraction(channel);
            mockResolveWs.mockReturnValue('anti-crow');

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBe('anti-crow');
            expect(result.cdp).toBe(defaultCdp);
            expect(mockPool.getActive).toHaveBeenCalledWith('anti-crow');
        });

        // ---------------------------------------------------------------
        // ctx.cdp も null の場合（完全未接続）
        // ---------------------------------------------------------------

        it('ctx.cdp が null の場合、cdp: null を返す', () => {
            const ctx = createMockCtx({ cdp: null, cdpPool: null });
            const interaction = createMockInteraction(null);

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBeNull();
            expect(result.cdp).toBeNull();
        });

        // ---------------------------------------------------------------
        // ButtonInteraction でも同じロジックが動く
        // ---------------------------------------------------------------

        it('ButtonInteraction でも cdpPool から正しい CDP を取得する', () => {
            const defaultCdp = createMockCdpBridge('default');
            const wsCdp = createMockCdpBridge('other-project-cdp');
            const mockPool = {
                getActive: vi.fn().mockReturnValue(wsCdp),
            };
            const ctx = createMockCtx({ cdp: defaultCdp, cdpPool: mockPool as any });
            // ButtonInteraction は customId を持つが、channel も持つ
            const channel = { parent: { name: '🤖other-project' } };
            const interaction = { channel, customId: 'model_select_0' } as any;
            mockResolveWs.mockReturnValue('other-project');

            const result = resolveTargetCdp(ctx, interaction);

            expect(result.wsKey).toBe('other-project');
            expect(result.cdp).toBe(wsCdp);
            expect(mockPool.getActive).toHaveBeenCalledWith('other-project');
        });
    });
});
