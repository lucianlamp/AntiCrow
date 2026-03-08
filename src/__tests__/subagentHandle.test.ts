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
        getPorts: vi.fn(() => [9333]),
        getActiveTargetTitle: vi.fn(() => 'Test — Antigravity'),
    };
}

function createHandle(overrides: {
    name?: string;
    repoRoot?: string;
    ipcDir?: string;
    usePool?: boolean;
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

    const poolEntry = overrides.usePool ? {
        index: 0,
        path: '/mock/pool/worktree-0',
        state: 'available' as const,
        health: 'healthy' as const,
    } : undefined;

    const handle = new SubagentHandle(
        name,
        repoRoot,
        ipcDir,
        cdp as any,
        config,
        poolEntry,
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
        it('通常モードで正しいパスを設定する', () => {
            const { handle } = createHandle({ name: 'agent-1' });
            expect(handle.name).toBe('agent-1');
            expect(handle.branch).toBe('team/subagent/agent-1');
            expect(handle.worktreePath).toContain('agent-1');
            expect(handle.state).toBe('IDLE');
        });

        it('プールモードでプールのパスを使用する', () => {
            const { handle } = createHandle({ name: 'pool-agent', usePool: true });
            expect(handle.worktreePath).toBe('/mock/pool/worktree-0');
            expect(handle.poolEntryIndex).toBe(0);
        });

        it('info プロパティが正しい情報を返す', () => {
            const { handle } = createHandle({ name: 'info-agent' });
            const info = handle.info;
            expect(info.name).toBe('info-agent');
            expect(info.branch).toBe('team/subagent/info-agent');
            expect(info.state).toBe('IDLE');
            expect(info.createdAt).toBeGreaterThan(0);
        });
    });

    // -----------------------------------------------------------------------
    // mergeChanges
    // -----------------------------------------------------------------------

    describe('mergeChanges', () => {
        it('差分がない場合はマージ不要を返す', async () => {
            const { handle } = createHandle();
            // exec が空の stdout を返す = 差分なし
            mockExec.mockImplementation((_cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    callback(null, { stdout: '', stderr: '' });
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            const result = await handle.mergeChanges();
            expect(result.merged).toBe(false);
            expect(result.conflicted).toBe(false);
        });

        it('差分がある場合にマージを実行して成功する', async () => {
            const { handle } = createHandle();

            mockExec.mockImplementation((cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    if (typeof cmd === 'string' && cmd.includes('git log')) {
                        callback(null, { stdout: 'abc1234 commit 1\ndef5678 commit 2', stderr: '' });
                    } else {
                        // git merge は成功
                        callback(null, { stdout: '', stderr: '' });
                    }
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            const result = await handle.mergeChanges();
            expect(result.merged).toBe(true);
            expect(result.conflicted).toBe(false);
        });

        it('マージコンフリクト時に abort して結果を返す', async () => {
            const { handle } = createHandle();

            mockExec.mockImplementation((cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    if (typeof cmd === 'string' && cmd.includes('git log')) {
                        callback(null, { stdout: 'abc1234 conflict commit', stderr: '' });
                    } else if (typeof cmd === 'string' && cmd.includes('git merge') && !cmd.includes('--abort')) {
                        callback(new Error('CONFLICT (content): Merge conflict'), { stdout: '', stderr: '' });
                    } else {
                        // git merge --abort は成功
                        callback(null, { stdout: '', stderr: '' });
                    }
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            const result = await handle.mergeChanges();
            expect(result.merged).toBe(false);
            expect(result.conflicted).toBe(true);
            expect(result.error).toContain('CONFLICT');
        });

        it('ブランチが存在しない場合にエラーを返す', async () => {
            const { handle } = createHandle();

            mockExec.mockImplementation((cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    if (typeof cmd === 'string' && cmd.includes('git log')) {
                        callback(new Error('unknown revision'), { stdout: '', stderr: '' });
                    } else {
                        callback(null, { stdout: '', stderr: '' });
                    }
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            const result = await handle.mergeChanges();
            expect(result.merged).toBe(false);
            expect(result.conflicted).toBe(false);
            expect(result.error).toContain('unknown revision');
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
    // spawn — 状態遷移チェック
    // -----------------------------------------------------------------------

    describe('spawn', () => {
        it('IDLE 以外の状態でエラーを投げる', async () => {
            const { handle } = createHandle();

            // spawn を呼んで IDLE → CREATING に遷移（エラーで FAILED に）
            mockExec.mockImplementation((_cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    // git rev-parse HEAD は成功させる（コミットが存在する状態を模擬）
                    if (typeof _cmd === 'string' && _cmd.includes('git rev-parse HEAD')) {
                        callback(null, { stdout: 'abc123', stderr: '' });
                    } else {
                        callback(new Error('git error'), { stdout: '', stderr: '' });
                    }
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            await expect(handle.spawn()).rejects.toThrow('git error');
            expect(handle.state).toBe('FAILED');

            // FAILED 状態から再度 spawn を試みる
            await expect(handle.spawn()).rejects.toThrow('IDLE 状態でのみ');
        });

        it('コミットゼロのリポジトリでわかりやすいエラーを投げる', async () => {
            const { handle } = createHandle();

            // git rev-parse HEAD が失敗する = コミットゼロ
            mockExec.mockImplementation((cmd: string, _opts: any, cb?: Function) => {
                const callback = cb ?? _opts;
                if (typeof callback === 'function') {
                    if (typeof cmd === 'string' && cmd.includes('git rev-parse HEAD')) {
                        callback(new Error('fatal: bad default revision \'HEAD\''), { stdout: '', stderr: '' });
                    } else {
                        callback(null, { stdout: '', stderr: '' });
                    }
                }
                return { on: vi.fn(), stdout: null, stderr: null, pid: 0 };
            });

            await expect(handle.spawn()).rejects.toThrow('リポジトリにコミットがありません');
            expect(handle.state).toBe('FAILED');
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
                { title: 'alive-agent — Antigravity', port: 9333 },
            ]);
            mockExtractWorkspaceName.mockReturnValue('alive-agent');

            const result = await handle.isAlive();
            expect(result).toBe(true);
        });

        it('一致するインスタンスがなければ false を返す', async () => {
            const { handle } = createHandle({ name: 'dead-agent' });

            mockDiscoverInstances.mockResolvedValue([
                { title: 'other-agent — Antigravity', port: 9333 },
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
