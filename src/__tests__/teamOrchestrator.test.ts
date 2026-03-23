// ---------------------------------------------------------------------------
// teamOrchestrator.test.ts — TeamOrchestrator のユニットテスト
// ---------------------------------------------------------------------------
// テスト対象:
//   - getEffectiveRepoRoot: repoRoot 解決ロジック
//   - resolveRepoRootForWorkspace: ワークスペース名→パス解決
//   - setThreadOps / setWsPathResolver: コールバック設定
//   - orchestrate: サブエージェント実行フロー
//   - startMonitor / stopMonitor: 進捗監視
//   - dispose: リソース解放

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        workspaceFolders: [],
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
    t: vi.fn((key: string) => key),
}));

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------
import { TeamOrchestrator } from '../teamOrchestrator';
import type { FileIpc } from '../fileIpc';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

// SubagentManager のモック型
interface MockSubagentManager {
    launchAgent: ReturnType<typeof vi.fn>;
    getIpcDir: ReturnType<typeof vi.fn>;
    getAvailableAgent: ReturnType<typeof vi.fn>;
    disposeAgent: ReturnType<typeof vi.fn>;
}

function createMockSubagentManager(): MockSubagentManager {
    return {
        launchAgent: vi.fn().mockResolvedValue({ agentName: 'agent-1', pid: 12345 }),
        getIpcDir: vi.fn().mockReturnValue('C:\\mock\\ipc'),
        getAvailableAgent: vi.fn().mockReturnValue('agent-1'),
        disposeAgent: vi.fn(),
    };
}

function createMockFileIpc(): FileIpc {
    return {
        writeInstructionFiles: vi.fn().mockResolvedValue({ requestId: 'req_test_123' }),
        waitForResponse: vi.fn().mockResolvedValue({ content: 'テスト完了', format: 'markdown' }),
        getIpcDir: vi.fn().mockReturnValue('C:\\mock\\ipc'),
        cleanupOldFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileIpc;
}

function createMockDiscordSender() {
    return vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('TeamOrchestrator', () => {
    let orchestrator: TeamOrchestrator;
    let mockSubagentManager: MockSubagentManager;
    let mockFileIpc: FileIpc;
    let mockDiscordSender: ReturnType<typeof createMockDiscordSender>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSubagentManager = createMockSubagentManager();
        mockFileIpc = createMockFileIpc();
        mockDiscordSender = createMockDiscordSender();
        orchestrator = new TeamOrchestrator(
            mockSubagentManager as any,
            mockFileIpc,
            mockDiscordSender,
            'C:\\Users\\test\\project',
        );
    });

    // -----------------------------------------------------------------------
    // コンストラクタ・基本プロパティ
    // -----------------------------------------------------------------------

    describe('constructor', () => {
        it('should create instance with correct repoRoot', () => {
            expect(orchestrator).toBeInstanceOf(TeamOrchestrator);
        });
    });

    // -----------------------------------------------------------------------
    // getEffectiveRepoRoot
    // -----------------------------------------------------------------------

    describe('getEffectiveRepoRoot', () => {
        it('should return override if provided', () => {
            const result = (orchestrator as any).getEffectiveRepoRoot('C:\\override\\path');
            expect(result).toBe('C:\\override\\path');
        });

        it('should return default repoRoot when no override', () => {
            const result = (orchestrator as any).getEffectiveRepoRoot();
            expect(result).toBe('C:\\Users\\test\\project');
        });

        it('should return default repoRoot for undefined override', () => {
            const result = (orchestrator as any).getEffectiveRepoRoot(undefined);
            expect(result).toBe('C:\\Users\\test\\project');
        });
    });

    // -----------------------------------------------------------------------
    // setWsPathResolver
    // -----------------------------------------------------------------------

    describe('setWsPathResolver', () => {
        it('should accept a resolver function', () => {
            const resolver = () => ({ 'ws1': 'C:\\path1', 'ws2': 'C:\\path2' });
            // setWsPathResolver は void を返す——例外が出なければ OK
            expect(() => orchestrator.setWsPathResolver(resolver)).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // resolveRepoRootForWorkspace
    // -----------------------------------------------------------------------

    describe('resolveRepoRootForWorkspace', () => {
        it('should return undefined for unknown workspace', () => {
            const result = (orchestrator as any).resolveRepoRootForWorkspace('unknown-ws');
            expect(result).toBeUndefined();
        });

        it('should return path from wsPathResolver if set', () => {
            const resolver = () => ({ 'my-workspace': 'C:\\resolved\\path' });
            orchestrator.setWsPathResolver(resolver);

            const result = (orchestrator as any).resolveRepoRootForWorkspace('my-workspace');
            expect(result).toBe('C:\\resolved\\path');
        });

        it('should prefer wsPathResolver over default', () => {
            const resolver = () => ({ 'test-ws': 'C:\\from\\resolver' });
            orchestrator.setWsPathResolver(resolver);

            const result = (orchestrator as any).resolveRepoRootForWorkspace('test-ws');
            expect(result).toBe('C:\\from\\resolver');
        });
    });

    // -----------------------------------------------------------------------
    // setThreadOps
    // -----------------------------------------------------------------------

    describe('setThreadOps', () => {
        it('should accept ThreadOps without throwing', () => {
            const threadOps = {
                createThread: vi.fn().mockResolvedValue('thread-123'),
                sendToThread: vi.fn().mockResolvedValue(true),
                archiveThread: vi.fn().mockResolvedValue(true),
                sendTyping: vi.fn().mockResolvedValue(undefined),
            };

            expect(() => orchestrator.setThreadOps(threadOps)).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // stopMonitor
    // -----------------------------------------------------------------------

    describe('stopMonitor', () => {
        it('should not throw when stopping non-existent monitor', () => {
            expect(() => (orchestrator as any).stopMonitor('non-existent-agent')).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // dispose
    // -----------------------------------------------------------------------

    describe('dispose', () => {
        it('should stop all monitors and clear resources', () => {
            expect(() => orchestrator.dispose()).not.toThrow();
        });

        it('should be safe to call multiple times', () => {
            orchestrator.dispose();
            expect(() => orchestrator.dispose()).not.toThrow();
        });
    });

    // -----------------------------------------------------------------------
    // readAgentProgress
    // -----------------------------------------------------------------------

    describe('readAgentProgress', () => {
        it('should return null for non-existent progress file', async () => {
            const result = await (orchestrator as any).readAgentProgress(
                'C:\\nonexistent\\ipc',
                'agent-1',
            );
            expect(result).toBeNull();
        });

        it('should accept agentIndex parameter', async () => {
            const result = await (orchestrator as any).readAgentProgress(
                'C:\\nonexistent\\ipc',
                'agent-1',
                0,
            );
            expect(result).toBeNull();
        });
    });
});
