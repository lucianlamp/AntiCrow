// ---------------------------------------------------------------------------
// executor.test.ts — Executor クラスのユニットテスト
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

// fs モック
vi.mock('fs', () => ({
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => false),
}));

// os モック
vi.mock('os', () => ({
    homedir: () => '/mock/home',
}));

// 依存モジュールのモック
vi.mock('../cdpBridge', () => ({
    CdpBridge: vi.fn(),
}));

vi.mock('../fileIpc', () => ({
    FileIpc: {
        extractResult: vi.fn((text: string) => text),
    },
}));

vi.mock('../planStore', () => ({
    PlanStore: vi.fn(),
}));

vi.mock('../embeddedRules', () => ({
    EXECUTION_PROMPT_TEMPLATE: '{"task":"execution","prompt":"{{user_prompt}}","output":{"response_path":"{{response_path}}"},"progress":{"path":"{{progress_path}}"},"rules":"{{rules_content}}"}',
    getPromptRulesMd: vi.fn(() => 'mock rules'),
}));

vi.mock('../memoryStore', () => ({
    readCombinedMemory: vi.fn(() => null),
    appendToGlobalMemory: vi.fn(),
    appendToWorkspaceMemory: vi.fn(),
    extractMemoryTags: vi.fn(() => []),
    stripMemoryTags: vi.fn((text: string) => text),
}));

vi.mock('../suggestionParser', () => ({
    parseSuggestions: vi.fn((text: string) => ({ suggestions: [], cleanContent: text })),
}));

vi.mock('../suggestionButtons', () => ({
    buildSuggestionRow: vi.fn(),
    storeSuggestions: vi.fn(),
}));

vi.mock('../uiWatcher', () => {
    class MockUIWatcher {
        start = vi.fn();
        stop = vi.fn();
    }
    return {
        UIWatcher: MockUIWatcher,
        DEFAULT_AUTO_CLICK_RULES: [],
    };
});

vi.mock('../configHelper', () => ({
    getMaxRetries: vi.fn(() => 0),
    getTimezone: vi.fn(() => 'Asia/Tokyo'),
    getWorkspacePaths: vi.fn(() => ({})),
}));

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

vi.mock('../errors', () => ({
    CdpConnectionError: class CdpConnectionError extends Error { },
    IpcTimeoutError: class IpcTimeoutError extends Error { },
}));

vi.mock('../anticrowCustomizer', () => ({
    updateAnticrowMd: vi.fn(),
    getAnticrowMdPath: vi.fn(() => '/mock/.anticrow/anticrow.md'),
}));

vi.mock('../embedHelper', () => ({
    EmbedColor: { Progress: 0x3498db, Response: 0x2ecc71 },
}));

import { Executor } from '../executor';
import type { Plan, ExecutionJob } from '../types';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function createMockPlan(overrides: Partial<Plan> = {}): Plan {
    return {
        plan_id: `plan-${Math.random().toString(36).substring(2, 8)}`,
        timezone: 'Asia/Tokyo',
        cron: null,
        prompt: 'do stuff',
        requires_confirmation: false,
        source_channel_id: 'ch-src',
        notify_channel_id: 'ch-notify',
        discord_templates: { ack: '✅', run_error: '❌ Error' },
        human_summary: 'テスト',
        status: 'active',
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

function createMockCdp() {
    return {
        sendPrompt: vi.fn().mockResolvedValue(undefined),
        ensureConnected: vi.fn().mockResolvedValue(undefined),
        getActiveWorkspaceName: vi.fn(() => 'test-workspace'),
        getActiveTargetTitle: vi.fn(() => 'Test — Antigravity'),
        getActiveTargetPort: vi.fn(() => 9222),
        getPorts: vi.fn(() => [9222]),
        switchTarget: vi.fn().mockResolvedValue(undefined),
        ops: {},
        autoFollowOutput: vi.fn().mockResolvedValue(undefined),
    };
}

function createMockFileIpc() {
    return {
        createMarkdownRequestId: vi.fn(() => ({
            requestId: 'req_test_123',
            responsePath: '/mock/ipc/req_test_123_response.md',
        })),
        createProgressPath: vi.fn(() => '/mock/ipc/req_test_123_progress.json'),
        createRequestId: vi.fn(() => ({
            requestId: 'req_test_123',
            responsePath: '/mock/ipc/req_test_123_response.json',
        })),
        waitForResponse: vi.fn().mockResolvedValue('test result'),
        readProgress: vi.fn().mockResolvedValue(null),
        cleanupProgress: vi.fn().mockResolvedValue(undefined),
        cleanupTmpFiles: vi.fn().mockResolvedValue(undefined),
        getIpcDir: vi.fn(() => '/mock/ipc'),
        getStoragePath: vi.fn(() => '/mock/storage'),
    };
}

function createMockPlanStore() {
    const store = new Map<string, Plan>();
    return {
        get: vi.fn((id: string) => store.get(id) ?? null),
        add: vi.fn((plan: Plan) => store.set(plan.plan_id, plan)),
        update: vi.fn(),
        _store: store,
    };
}

function createExecutor(overrides: Record<string, unknown> = {}) {
    const cdp = createMockCdp();
    const fileIpc = createMockFileIpc();
    const planStore = createMockPlanStore();
    const notifyDiscord = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const postSuggestions = vi.fn().mockResolvedValue(undefined);

    const executor = new Executor(
        cdp as any,
        fileIpc as any,
        planStore as any,
        300_000,
        notifyDiscord,
        sendTyping,
        '/mock/extension',
        postSuggestions,
    );

    return { executor, cdp, fileIpc, planStore, notifyDiscord, sendTyping, postSuggestions, ...overrides };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('Executor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // -----------------------------------------------------------------------
    // 初期状態
    // -----------------------------------------------------------------------

    describe('初期状態', () => {
        it('should start with running = false', () => {
            const { executor } = createExecutor();
            expect(executor.isRunning()).toBe(false);
        });

        it('should start with empty queue', () => {
            const { executor } = createExecutor();
            expect(executor.queueLength()).toBe(0);
        });

        it('should start with null queue info', () => {
            const { executor } = createExecutor();
            const info = executor.getQueueInfo();
            expect(info.current).toBeNull();
            expect(info.pending).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // enqueue: 重複防止
    // -----------------------------------------------------------------------

    describe('enqueue — 重複防止', () => {
        it('should skip duplicate plan_id already in queue (pending)', async () => {
            const { executor, fileIpc } = createExecutor();
            // waitForResponse を永遠に待たせて processQueue を止める
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const planA = createMockPlan({ plan_id: 'blocker' });
            const planB = createMockPlan({ plan_id: 'dup-001' });

            // 1つ目のジョブでprocessQueueをブロック
            executor.enqueue({ plan: planA, triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));

            // 2つ目をキューに追加（pending状態）
            executor.enqueue({ plan: planB, triggerType: 'immediate' });
            expect(executor.queueLength()).toBe(1);

            // 同じplan_idの3つ目はスキップされる
            executor.enqueue({ plan: { ...planB }, triggerType: 'immediate' });
            expect(executor.queueLength()).toBe(1); // 増えていない

            // クリーンアップ
            executor.forceReset();
        });
    });

    // -----------------------------------------------------------------------
    // enqueueImmediate / enqueueScheduled
    // -----------------------------------------------------------------------

    describe('enqueueImmediate / enqueueScheduled', () => {
        it('enqueueImmediate should set triggerType to immediate', async () => {
            const { executor, fileIpc } = createExecutor();
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const plan = createMockPlan();
            executor.enqueueImmediate(plan);

            // processQueue が動き出して currentJob が設定される
            await new Promise(r => setTimeout(r, 10));
            const info = executor.getQueueInfo();
            expect(info.current).not.toBeNull();
            expect(info.current!.plan.plan_id).toBe(plan.plan_id);

            executor.forceReset();
        });
    });

    // -----------------------------------------------------------------------
    // cancelJob
    // -----------------------------------------------------------------------

    describe('cancelJob', () => {
        it('should remove a pending job from the queue', async () => {
            const { executor, fileIpc } = createExecutor();
            // 最初のジョブで processQueue をブロック
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const plan1 = createMockPlan({ plan_id: 'first' });
            const plan2 = createMockPlan({ plan_id: 'second' });
            const plan3 = createMockPlan({ plan_id: 'third' });

            executor.enqueue({ plan: plan1, triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));

            executor.enqueue({ plan: plan2, triggerType: 'immediate' });
            executor.enqueue({ plan: plan3, triggerType: 'immediate' });

            expect(executor.queueLength()).toBe(2);

            // plan2 をキューから削除
            const removed = executor.cancelJob('second');
            expect(removed).toBe(true);
            expect(executor.queueLength()).toBe(1);

            // 存在しないplan_idの削除は false
            expect(executor.cancelJob('nonexistent')).toBe(false);

            executor.forceReset();
        });
    });

    // -----------------------------------------------------------------------
    // getQueueInfo
    // -----------------------------------------------------------------------

    describe('getQueueInfo', () => {
        it('should return current job and pending list', async () => {
            const { executor, fileIpc } = createExecutor();
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const plan1 = createMockPlan({ plan_id: 'running', human_summary: 'Running' });
            const plan2 = createMockPlan({ plan_id: 'pending-1', human_summary: 'Pending 1' });

            executor.enqueue({ plan: plan1, triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));
            executor.enqueue({ plan: plan2, triggerType: 'immediate' });

            const info = executor.getQueueInfo();
            expect(info.current).not.toBeNull();
            expect(info.current!.plan.plan_id).toBe('running');
            expect(info.current!.startTime).toBeGreaterThan(0);
            expect(info.pending).toHaveLength(1);
            expect(info.pending[0].plan_id).toBe('pending-1');

            executor.forceReset();
        });
    });

    // -----------------------------------------------------------------------
    // forceReset
    // -----------------------------------------------------------------------

    describe('forceReset', () => {
        it('should clear running and queue state', async () => {
            const { executor, fileIpc } = createExecutor();
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const plan1 = createMockPlan({ plan_id: 'reset-1' });
            const plan2 = createMockPlan({ plan_id: 'reset-2' });
            executor.enqueue({ plan: plan1, triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));
            executor.enqueue({ plan: plan2, triggerType: 'immediate' });

            expect(executor.queueLength()).toBe(1); // plan2 is pending

            executor.forceReset();

            expect(executor.isRunning()).toBe(false);
            expect(executor.queueLength()).toBe(0);
            // pending queue が空になったことを確認
            expect(executor.getQueueInfo().pending).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // forceStop
    // -----------------------------------------------------------------------

    describe('forceStop', () => {
        it('should stop current job but preserve queue', async () => {
            const { executor, fileIpc } = createExecutor();
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            const plan1 = createMockPlan({ plan_id: 'active' });
            const plan2 = createMockPlan({ plan_id: 'queued' });

            executor.enqueue({ plan: plan1, triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));
            executor.enqueue({ plan: plan2, triggerType: 'immediate' });

            expect(executor.queueLength()).toBe(1); // plan2 is pending

            executor.forceStop();

            expect(executor.isRunning()).toBe(false);
            // forceStop preserves the queue
            expect(executor.queueLength()).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // isRunning / queueLength
    // -----------------------------------------------------------------------

    describe('isRunning / queueLength', () => {
        it('isRunning should be false before any enqueue', () => {
            const { executor } = createExecutor();
            expect(executor.isRunning()).toBe(false);
        });

        it('queueLength should count pending jobs only (not current)', async () => {
            const { executor, fileIpc } = createExecutor();
            fileIpc.waitForResponse.mockImplementation(() => new Promise(() => { }));

            executor.enqueue({ plan: createMockPlan({ plan_id: 'a' }), triggerType: 'immediate' });
            await new Promise(r => setTimeout(r, 10));
            executor.enqueue({ plan: createMockPlan({ plan_id: 'b' }), triggerType: 'immediate' });
            executor.enqueue({ plan: createMockPlan({ plan_id: 'c' }), triggerType: 'immediate' });

            // 'a' is current, 'b' and 'c' are pending
            expect(executor.queueLength()).toBe(2);

            executor.forceReset();
        });
    });

    // -----------------------------------------------------------------------
    // processQueue — 直列実行
    // -----------------------------------------------------------------------

    describe('processQueue — 直列実行', () => {
        it('should process jobs sequentially and call notifyDiscord on completion', async () => {
            const { executor, notifyDiscord, fileIpc, cdp } = createExecutor();
            const plan = createMockPlan({ plan_id: 'seq-001' });

            // waitForResponse を即座に解決
            fileIpc.waitForResponse.mockResolvedValue('Test result OK');

            await executor.enqueueImmediate(plan);

            // notifyDiscord が呼ばれているはず（run_start + 伝令完了 + 成功通知）
            expect(notifyDiscord).toHaveBeenCalled();
            expect(cdp.sendPrompt).toHaveBeenCalled();
        });

        it('should process multiple jobs in FIFO order', async () => {
            const { executor, fileIpc } = createExecutor();
            const order: string[] = [];

            fileIpc.waitForResponse.mockImplementation(async () => {
                // waitForResponse の呼び出し順で実行順序を記録
                const callCount = fileIpc.waitForResponse.mock.calls.length;
                order.push(`job-${callCount}`);
                return 'OK';
            });

            const plan1 = createMockPlan({ plan_id: 'fifo-1' });
            const plan2 = createMockPlan({ plan_id: 'fifo-2' });

            // 直列実行なので、plan1完了後にplan2が実行される
            await Promise.all([
                executor.enqueueImmediate(plan1),
                executor.enqueueImmediate(plan2),
            ]);

            expect(order).toEqual(['job-1', 'job-2']);
        });
    });

    // -----------------------------------------------------------------------
    // executeJob — エラーハンドリング
    // -----------------------------------------------------------------------

    describe('executeJob — エラーハンドリング', () => {
        it('should notify on error and not crash', async () => {
            const { executor, notifyDiscord, fileIpc, cdp } = createExecutor();
            const plan = createMockPlan({ plan_id: 'err-001' });

            // sendPrompt でエラーを投げる
            cdp.sendPrompt.mockRejectedValue(new Error('CDP connection failed'));

            await executor.enqueueImmediate(plan);

            // エラー通知が送信されているはず
            const errorCalls = notifyDiscord.mock.calls.filter(
                (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('❌'));
            expect(errorCalls.length).toBeGreaterThanOrEqual(1);
        });

        it('should handle IPC timeout without retry', async () => {
            const { executor, notifyDiscord, fileIpc } = createExecutor();
            const plan = createMockPlan({ plan_id: 'timeout-001' });

            // IpcTimeoutError をインポートしてモック
            const { IpcTimeoutError } = await import('../errors');
            fileIpc.waitForResponse.mockRejectedValue(new IpcTimeoutError('Timed out'));

            await executor.enqueueImmediate(plan);

            // タイムアウト通知が送信されている
            const timeoutCalls = notifyDiscord.mock.calls.filter(
                (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('⏱️'));
            expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
        });
    });

    // -----------------------------------------------------------------------
    // UIWatcher 委譲
    // -----------------------------------------------------------------------

    describe('UIWatcher 委譲', () => {
        it('startUIWatcher should not throw', () => {
            const { executor } = createExecutor();
            expect(() => executor.startUIWatcher()).not.toThrow();
        });

        it('stopUIWatcher should not throw even when not started', () => {
            const { executor } = createExecutor();
            expect(() => executor.stopUIWatcher()).not.toThrow();
        });

        it('startUIWatcher twice should stop previous watcher', () => {
            const { executor } = createExecutor();
            executor.startUIWatcher();
            expect(() => executor.startUIWatcher()).not.toThrow();
            executor.stopUIWatcher();
        });
    });
});
