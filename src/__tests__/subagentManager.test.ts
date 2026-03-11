// ---------------------------------------------------------------------------
// subagentManager.test.ts — SubagentManager クラスのユニットテスト
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

// logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

// child_process モック（exec をコールバック形式でモック → promisify で Promise 化される）
const mockExec = vi.fn((_cmd?: string, _opts?: unknown, cb?: Function) => {
    const callback = cb ?? _opts;
    if (typeof callback === 'function') {
        (callback as Function)(null, { stdout: '', stderr: '' });
    }
    return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
});
vi.mock('child_process', () => ({
    exec: (cmd: string, opts?: unknown, cb?: Function) => mockExec(cmd, opts, cb),
}));

// fs モック
vi.mock('fs', () => ({
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    watch: vi.fn(() => ({
        on: vi.fn(),
        close: vi.fn(),
    })),
}));

// cdpBridge モック
vi.mock('../cdpBridge', () => ({
    CdpBridge: vi.fn(),
}));

// cdpTargets モック
const mockDiscoverInstances = vi.fn().mockResolvedValue([]);
const mockExtractWorkspaceName = vi.fn().mockReturnValue('');
vi.mock('../cdpTargets', () => ({
    discoverInstances: (...args: unknown[]) => mockDiscoverInstances(...args),
    extractWorkspaceName: (...args: unknown[]) => mockExtractWorkspaceName(...args),
}));

// subagentIpc モック
vi.mock('../subagentIpc', () => ({
    writePrompt: vi.fn(() => '/mock/ipc/prompt.json'),
    watchResponse: vi.fn().mockResolvedValue(null),
}));

import { SubagentManager } from '../subagentManager';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockCdpBridge() {
    return {
        launchAntigravity: vi.fn().mockResolvedValue(undefined),
        closeWindow: vi.fn().mockResolvedValue(undefined),
        minimizeWindow: vi.fn().mockResolvedValue(true),
        getPorts: vi.fn(() => [9000]),
        getActiveTargetTitle: vi.fn(() => 'Test — Antigravity'),
        getActiveTargetPort: vi.fn(() => 9000),
    };
}

function createManager(overrides: {
    maxConcurrent?: number;
} = {}) {
    const cdp = createMockCdpBridge();
    const config = {
        maxConcurrent: overrides.maxConcurrent ?? 3,
        launchTimeoutMs: 100,
        promptTimeoutMs: 1000,
        pollIntervalMs: 50,
        spawnMaxRetries: 1,
        healthCheckIntervalMs: 30000,
        closeTimeoutMs: 5000,
        staggerDelayMs: 100,
        idleTtlMs: 300000,
        enableWindowReuse: true,
    };

    const manager = new SubagentManager(
        cdp as any,
        '/mock/ipc',
        '/mock/repo',
        config,
    );

    return { manager, cdp };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('SubagentManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // 初期状態
    // -----------------------------------------------------------------------

    describe('初期状態', () => {
        it('アクティブエージェント数が 0 から始まる', () => {
            const { manager } = createManager();
            expect(manager.list()).toHaveLength(0);
        });

        it('list() が空配列を返す', () => {
            const { manager } = createManager();
            expect(manager.list()).toEqual([]);
        });

        it('存在しないエージェントの getAgent() が undefined を返す', () => {
            const { manager } = createManager();
            expect(manager.getAgent('nonexistent')).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // killAll
    // -----------------------------------------------------------------------

    describe('killAll', () => {
        it('エージェントがいない場合でもエラーにならない', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            await expect(manager.killAll()).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // killAgent
    // -----------------------------------------------------------------------

    describe('killAgent', () => {
        it('存在しないエージェント名でもエラーにならない', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            await expect(manager.killAgent('ghost')).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // enableWindowReuse
    // -----------------------------------------------------------------------

    describe('enableWindowReuse', () => {
        it('設定値を返す', () => {
            const { manager } = createManager();
            expect(manager.enableWindowReuse).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // ヘルスチェック（start/stop）
    // -----------------------------------------------------------------------

    describe('ヘルスチェック', () => {
        it('startHealthCheck / stopHealthCheck がエラーなく動作する', () => {
            const { manager } = createManager();
            expect(() => manager.startHealthCheck()).not.toThrow();
            expect(() => manager.stopHealthCheck()).not.toThrow();
        });

        it('stopHealthCheck を2回呼んでもエラーにならない', () => {
            const { manager } = createManager();
            manager.startHealthCheck();
            expect(() => manager.stopHealthCheck()).not.toThrow();
            expect(() => manager.stopHealthCheck()).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // アイドルプール
    // -----------------------------------------------------------------------

    describe('アイドルプール', () => {
        it('clearIdlePool がエラーなく動作する', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            await expect(manager.clearIdlePool()).resolves.not.toThrow();
        });

        it('reclaimFromIdlePool が空配列を返す（初期状態）', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            const reclaimed = await manager.reclaimFromIdlePool();
            expect(reclaimed).toEqual([]);
        });

        it('startIdleCleanup / stopIdleCleanup がエラーなく動作する', () => {
            const { manager } = createManager();
            expect(() => manager.startIdleCleanup()).not.toThrow();
            expect(() => manager.stopIdleCleanup()).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // dispose
    // -----------------------------------------------------------------------

    describe('dispose', () => {
        it('初期状態から dispose してもエラーにならない', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            await expect(manager.dispose()).resolves.not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // setWorktreePool
    // -----------------------------------------------------------------------

    describe('setWorktreePool', () => {
        it('worktree プールを設定してもエラーにならない', () => {
            const { manager } = createManager();
            const mockPool = {
                acquire: vi.fn(),
                release: vi.fn(),
                dispose: vi.fn(),
                initialize: vi.fn(),
                getStats: vi.fn(() => ({ total: 3, available: 3, inUse: 0 })),
            };
            expect(() => manager.setWorktreePool(mockPool as any)).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // cleanupStaleAgents
    // -----------------------------------------------------------------------

    describe('cleanupStaleAgents', () => {
        it('エージェントがいない場合は 0 を返す', async () => {
            const { manager } = createManager();
            vi.useRealTimers();
            const cleaned = await manager.cleanupStaleAgents();
            expect(cleaned).toBe(0);
        });
    });
});
