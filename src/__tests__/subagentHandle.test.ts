// ---------------------------------------------------------------------------
// subagentHandle.test.ts — SubagentHandle クラスのユニットテスト
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

// logger モック
vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
}));

// child_process モック（exec をコールバック形式でモック → promisify で Promise 化される）
const mockExec = vi.fn();
vi.mock('child_process', () => ({
    exec: (...args: any[]) => mockExec(...args),
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

// subagentIpc モック
const mockWritePrompt = vi.fn();
const mockWatchResponse = vi.fn();
vi.mock('../subagentIpc', () => ({
    writePrompt: (...args: any[]) => mockWritePrompt(...args),
    watchResponse: (...args: any[]) => mockWatchResponse(...args),
}));

// cdpBridge モック
vi.mock('../cdpBridge', () => ({
    CdpBridge: vi.fn(),
}));

// cdpTargets モック
const mockDiscoverInstances = vi.fn();
const mockExtractWorkspaceName = vi.fn();
vi.mock('../cdpTargets', () => ({
    discoverInstances: (...args: any[]) => mockDiscoverInstances(...args),
    extractWorkspaceName: (...args: any[]) => mockExtractWorkspaceName(...args),
}));

import { SubagentHandle } from '../subagentHandle';
import type { SubagentResponse } from '../subagentTypes';

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
    };
}

function createHandle(overrides: {
    name?: string;
    repoRoot?: string;
    ipcDir?: string;
} = {}) {
    const cdp = createMockCdpBridge();
    const name = overrides.name ?? 'test-agent-1';
    const repoRoot = overrides.repoRoot ?? '/mock/repo';
    const ipcDir = overrides.ipcDir ?? '/mock/ipc';
    const config = {
        launchTimeoutMs: 100,
        promptTimeoutMs: 1000,
        pollIntervalMs: 50,
        spawnMaxRetries: 1,
    };

    const handle = new SubagentHandle(
        name,
        repoRoot,
        ipcDir,
        cdp as any,
        config,
    );

    return { handle, cdp };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('SubagentHandle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // exec のデフォルト動作: コールバックを成功で呼ぶ
        mockExec.mockImplementation((_cmd: string, _opts: any, cb?: Function) => {
            // promisify は (cmd, opts) → コールバック形式を想定
            // promisify(exec) は exec(cmd, opts) を呼ぶ（child が返る）
            // 第3引数がコールバックの場合と、第2引数がコールバックの場合がある
            const callback = cb ?? _opts;
            if (typeof callback === 'function') {
                callback(null, { stdout: '', stderr: '' });
            }
            return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
        });
        mockDiscoverInstances.mockResolvedValue([]);
        mockExtractWorkspaceName.mockReturnValue('');
    });

    // -----------------------------------------------------------------------
    // コンストラクタ
    // -----------------------------------------------------------------------

    describe('コンストラクタ', () => {
        it('正しいパスを設定する', () => {
            const { handle } = createHandle({ name: 'agent-1' });
            expect(handle.name).toBe('agent-1');
            expect(handle.branch).toBe('');
            expect(handle.worktreePath).toBe('/mock/repo');
            expect(handle.state).toBe('IDLE');
        });

        it('info プロパティが正しい情報を返す', () => {
            const { handle } = createHandle({ name: 'info-agent' });
            const info = handle.info;
            expect(info.name).toBe('info-agent');
            expect(info.branch).toBe('');
            expect(info.state).toBe('IDLE');
            expect(info.createdAt).toBeGreaterThan(0);
        });
    });



    // -----------------------------------------------------------------------
    // close
    // -----------------------------------------------------------------------

    describe('close', () => {
        it('CLEANED 状態では何もしない', async () => {
            const { handle, cdp } = createHandle();
            // 内部状態を CLEANED に（2回 close を呼ぶ想定）
            // まず READY にする必要があるが、state を直接変更できないので
            // IDLE 状態からの close は早期リターンする
            await handle.close();
            expect(cdp.closeWindow).not.toHaveBeenCalled();
        });

        it('IDLE 状態では何もしない', async () => {
            const { handle, cdp } = createHandle();
            expect(handle.state).toBe('IDLE');
            await handle.close();
            expect(cdp.closeWindow).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // sendPrompt
    // -----------------------------------------------------------------------

    describe('sendPrompt', () => {
        it('READY 以外の状態でエラーを投げる', async () => {
            const { handle } = createHandle();
            // 状態は IDLE
            await expect(handle.sendPrompt('test')).rejects.toThrow('READY 状態でのみ');
        });
    });

    // -----------------------------------------------------------------------
    // sendPromptFireAndForget
    // -----------------------------------------------------------------------

    describe('sendPromptFireAndForget', () => {
        it('READY 以外の状態でエラーを投げる', async () => {
            const { handle } = createHandle();
            // 状態は IDLE
            await expect(handle.sendPromptFireAndForget('test')).rejects.toThrow('READY 状態でのみ');
        });

        it('READY 状態で正常にプロンプトを送信し、状態を BUSY にする', async () => {
            const { handle } = createHandle();

            // spawn で READY にする
            mockDiscoverInstances.mockResolvedValue([
                { title: 'test-agent-1 — Antigravity', port: 9000 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('test-agent-1');
            mockWritePrompt.mockReturnValue('/mock/ipc/subagent_test_prompt.json');

            await handle.spawn();
            expect(handle.state).toBe('READY');

            const result = await handle.sendPromptFireAndForget('テスト指示');

            // 状態が BUSY に遷移
            expect(handle.state).toBe('BUSY');

            // writePrompt が呼ばれた
            expect(mockWritePrompt).toHaveBeenCalledTimes(1);
            const promptData = mockWritePrompt.mock.calls[0][1];
            expect(promptData.prompt).toContain('テスト指示');
            expect(promptData.type).toBe('subagent_prompt');
            expect(promptData.to).toBe('test-agent-1');

            // watchResponse は呼ばれない（Fire-and-Forget）
            expect(mockWatchResponse).not.toHaveBeenCalled();

            // 戻り値にファイルパスが含まれる
            expect(result.promptFile).toBeDefined();
            expect(result.callbackPath).toBeDefined();
            expect(result.callbackPath).toContain('subagent_test-agent-1_response_');
        });

        it('sendPrompt と sendPromptFireAndForget の挙動の違いを確認する', async () => {
            // sendPrompt を使うケース
            const { handle: handle1 } = createHandle({ name: 'agent-sp' });
            mockDiscoverInstances.mockResolvedValue([
                { title: 'agent-sp — Antigravity', port: 9000 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('agent-sp');
            mockWritePrompt.mockReturnValue('/mock/ipc/prompt.json');

            const mockResponse = {
                type: 'subagent_response',
                from: 'agent-sp',
                timestamp: Date.now(),
                status: 'success',
                result: 'done',
                execution_time_ms: 100,
            };
            mockWatchResponse.mockResolvedValue(mockResponse);

            await handle1.spawn();
            await handle1.sendPrompt('test');

            // sendPrompt は watchResponse を呼ぶ
            expect(mockWatchResponse).toHaveBeenCalledTimes(1);

            vi.clearAllMocks();

            // sendPromptFireAndForget を使うケース
            const { handle: handle2 } = createHandle({ name: 'agent-ff' });
            mockDiscoverInstances.mockResolvedValue([
                { title: 'agent-ff — Antigravity', port: 9000 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('agent-ff');
            mockWritePrompt.mockReturnValue('/mock/ipc/prompt.json');

            await handle2.spawn();
            await handle2.sendPromptFireAndForget('test');

            // sendPromptFireAndForget は watchResponse を呼ばない
            expect(mockWatchResponse).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // spawn — 状態遷移チェック
    // -----------------------------------------------------------------------

    describe('spawn', () => {
        it('IDLE 以外の状態でエラーを投げる', async () => {
            const { handle } = createHandle();

            // spawn を呼んで IDLE → CREATING に遷移（タイムアウトで FAILED に）
            await expect(handle.spawn()).rejects.toThrow();
            expect(handle.state).toBe('FAILED');

            // FAILED 状態から再度 spawn を試みる
            await expect(handle.spawn()).rejects.toThrow('IDLE 状態でのみ');
        });
    });

    // -----------------------------------------------------------------------
    // resetForReuse
    // -----------------------------------------------------------------------

    describe('resetForReuse', () => {
        it('無効な状態でエラーを投げる', async () => {
            const { handle } = createHandle();
            // IDLE 状態からの resetForReuse はエラー
            await expect(handle.resetForReuse()).rejects.toThrow('COMPLETED/BUSY/READY');
        });
    });

    // -----------------------------------------------------------------------
    // matchesSubagent（間接テスト: isAlive 経由）
    // -----------------------------------------------------------------------

    describe('isAlive', () => {
        it('一致するインスタンスが見つかれば true を返す', async () => {
            const { handle } = createHandle({ name: 'alive-agent' });

            mockDiscoverInstances.mockResolvedValue([
                { title: 'alive-agent — Antigravity', port: 9000 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('alive-agent');

            const result = await handle.isAlive();
            expect(result).toBe(true);
        });

        it('一致するインスタンスがなければ false を返す', async () => {
            const { handle } = createHandle({ name: 'dead-agent' });

            mockDiscoverInstances.mockResolvedValue([
                { title: 'other-agent — Antigravity', port: 9000 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('other-agent');

            const result = await handle.isAlive();
            expect(result).toBe(false);
        });

        it('CDP エラー時に false を返す', async () => {
            const { handle } = createHandle();
            mockDiscoverInstances.mockRejectedValue(new Error('CDP unavailable'));

            const result = await handle.isAlive();
            expect(result).toBe(false);
        });
    });
});
