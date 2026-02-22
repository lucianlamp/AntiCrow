// ---------------------------------------------------------------------------
// discordChannels.test.ts — discordChannels モジュールのユニットテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vscode モック（logger で使用）
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
    },
}));

// logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

import {
    WORKSPACE_CATEGORY_PREFIX,
    workspaceCategoryName,
    extractWorkspaceFromCategoryName,
    resolveWorkspaceFromChannel,
} from '../discordChannels';

// discord.js の ChannelType を定義
const ChannelType = {
    GuildText: 0,
    GuildCategory: 4,
} as const;

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('discordChannels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -------------------------------------------------------------------
    // WORKSPACE_CATEGORY_PREFIX
    // -------------------------------------------------------------------

    describe('WORKSPACE_CATEGORY_PREFIX', () => {
        it('should be a non-empty string', () => {
            expect(typeof WORKSPACE_CATEGORY_PREFIX).toBe('string');
            expect(WORKSPACE_CATEGORY_PREFIX.length).toBeGreaterThan(0);
        });
    });

    // -------------------------------------------------------------------
    // workspaceCategoryName
    // -------------------------------------------------------------------

    describe('workspaceCategoryName', () => {
        it('should prepend prefix to workspace name', () => {
            const result = workspaceCategoryName('my-project');
            expect(result).toBe(`${WORKSPACE_CATEGORY_PREFIX}my-project`);
        });

        it('should handle empty workspace name', () => {
            const result = workspaceCategoryName('');
            expect(result).toBe(WORKSPACE_CATEGORY_PREFIX);
        });

        it('should handle workspace name with special characters', () => {
            const result = workspaceCategoryName('my_project-v2');
            expect(result).toBe(`${WORKSPACE_CATEGORY_PREFIX}my_project-v2`);
        });
    });

    // -------------------------------------------------------------------
    // extractWorkspaceFromCategoryName
    // -------------------------------------------------------------------

    describe('extractWorkspaceFromCategoryName', () => {
        it('should extract workspace name from valid category name', () => {
            const catName = `${WORKSPACE_CATEGORY_PREFIX}anti-crow`;
            expect(extractWorkspaceFromCategoryName(catName)).toBe('anti-crow');
        });

        it('should return null if prefix is missing', () => {
            expect(extractWorkspaceFromCategoryName('General')).toBeNull();
        });

        it('should return empty string if only prefix', () => {
            expect(extractWorkspaceFromCategoryName(WORKSPACE_CATEGORY_PREFIX)).toBe('');
        });

        it('should handle workspace names with spaces', () => {
            const catName = `${WORKSPACE_CATEGORY_PREFIX}my project`;
            expect(extractWorkspaceFromCategoryName(catName)).toBe('my project');
        });
    });

    // -------------------------------------------------------------------
    // resolveWorkspaceFromChannel
    // -------------------------------------------------------------------

    describe('resolveWorkspaceFromChannel', () => {
        it('should return workspace name for channel in workspace category', () => {
            const channel = {
                parent: {
                    type: ChannelType.GuildCategory,
                    name: `${WORKSPACE_CATEGORY_PREFIX}anti-crow`,
                },
            } as any;
            expect(resolveWorkspaceFromChannel(channel)).toBe('anti-crow');
        });

        it('should return null for channel without parent', () => {
            const channel = { parent: null } as any;
            expect(resolveWorkspaceFromChannel(channel)).toBeNull();
        });

        it('should return null for channel in non-category parent', () => {
            const channel = {
                parent: {
                    type: ChannelType.GuildText,
                    name: `${WORKSPACE_CATEGORY_PREFIX}anti-crow`,
                },
            } as any;
            expect(resolveWorkspaceFromChannel(channel)).toBeNull();
        });

        it('should return null for channel in non-workspace category', () => {
            const channel = {
                parent: {
                    type: ChannelType.GuildCategory,
                    name: 'General',
                },
            } as any;
            expect(resolveWorkspaceFromChannel(channel)).toBeNull();
        });
    });
});
