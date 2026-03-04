/**
 * チームモード E2E テスト
 * - splitTasks / writeInstructionFiles / writeReportFile の統合テスト
 * - cancelPlanGeneration のチーム中止動作テスト
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vscode モジュールをモック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
    },
}));
import * as fs from 'fs';
import * as path from 'path';
import { loadTeamConfig } from '../teamConfig';
import type { TeamInstruction } from '../subagentTypes';

// テスト用の IPC ディレクトリ
const TEST_IPC_DIR = path.join(__dirname, '..', '..', '__test_ipc__');
const REPO_ROOT = path.join(__dirname, '..', '..');

// TeamOrchestrator のモック最小構成
// writeInstructionFiles / writeReportFile / splitTasks は副作用として fs に書き込むだけなので、
// FileIpc のモックを最小限に作って TeamOrchestrator をインスタンス化する

describe('チームモード E2E テスト', () => {

    beforeEach(() => {
        if (!fs.existsSync(TEST_IPC_DIR)) {
            fs.mkdirSync(TEST_IPC_DIR, { recursive: true });
        }
    });

    afterEach(() => {
        // テスト用 IPC ディレクトリを削除
        if (fs.existsSync(TEST_IPC_DIR)) {
            fs.rmSync(TEST_IPC_DIR, { recursive: true, force: true });
        }
    });

    // =========================================================================
    // 前提条件: team.json
    // =========================================================================
    describe('前提条件: team.json', () => {
        it('team.json が enabled: true で読み込める', () => {
            const config = loadTeamConfig(REPO_ROOT);
            if (!config.enabled) {
                // team.json が存在しない/無効な環境ではスキップ
                console.log('team.json が存在しないか enabled: false のためスキップ');
                return;
            }
            expect(config.enabled).toBe(true);
            expect(config.maxAgents).toBeGreaterThanOrEqual(1);
            expect(config.enableParallel).toBe(true);
            console.log('team.json config:', JSON.stringify(config, null, 2));
        });
    });

    // =========================================================================
    // テスト1: splitTasks
    // =========================================================================
    describe('テスト1: splitTasks', () => {
        // splitTasks はインスタンスメソッドなので、最小モックで TeamOrchestrator を構築
        let splitTasks: (prompt: string) => string[];

        beforeEach(async () => {
            // TeamOrchestrator を動的 import して splitTasks を取得
            const mod = await import('../teamOrchestrator');
            const TO = mod.TeamOrchestrator;
            // コンストラクタは fileIpc, subagentManager, bot を要求するが
            // splitTasks は this.fileIpc 等を使わないので null キャストで OK
            const instance = new TO(
                null as any,
                { getIpcDir: () => TEST_IPC_DIR } as any,
                (async () => { }) as any,
                REPO_ROOT,
            );
            splitTasks = instance.splitTasks.bind(instance);
        });

        it('番号付きリストを正しく分割する', () => {
            const prompt = '以下のタスクを実行してください:\n1. TypeScript の型チェックを実行\n2. ユニットテストを実行\n3. ビルドを実行';
            const tasks = splitTasks(prompt);
            console.log('番号付きリスト分割結果:', tasks);
            expect(tasks.length).toBeGreaterThanOrEqual(2);
        });

        it('「タスクN:」パターンを分割する', () => {
            const prompt = 'タスク1: 型チェック\nタスク2: テスト実行\nタスク3: ビルド';
            const tasks = splitTasks(prompt);
            console.log('タスクN分割結果:', tasks);
            expect(tasks.length).toBeGreaterThanOrEqual(2);
        });

        it('分割不可能なプロンプトは1件で返す', () => {
            const prompt = 'こんにちは、元気ですか？';
            const tasks = splitTasks(prompt);
            expect(tasks.length).toBe(1);
            expect(tasks[0]).toBe(prompt);
        });
    });

    // =========================================================================
    // テスト2: writeInstructionFiles
    // =========================================================================
    describe('テスト2: writeInstructionFiles', () => {
        let writeInstructionFiles: (tasks: string[], requestId: string, originalContext: string) => TeamInstruction[];

        beforeEach(async () => {
            const mod = await import('../teamOrchestrator');
            const instance = new mod.TeamOrchestrator(
                null as any,
                { getIpcDir: () => TEST_IPC_DIR } as any,
                (async () => { }) as any,
                REPO_ROOT,
            );
            writeInstructionFiles = instance.writeInstructionFiles.bind(instance);
        });

        it('正しい数の指令ファイルを生成する', () => {
            const tasks = ['型チェックを実行', 'テストを実行'];
            const requestId = 'test_req_001';
            const instructions = writeInstructionFiles(tasks, requestId, '元のリクエスト');

            expect(instructions.length).toBe(2);

            // ファイルが実際に作成されたか確認
            for (const inst of instructions) {
                const filePath = path.join(TEST_IPC_DIR, `tmp_exec_anti-crow_req_${requestId}_agent${inst.agentIndex}.json`);
                expect(fs.existsSync(filePath)).toBe(true);

                // ファイル内容を検証（tmp_exec_*.json 互換フォーマット）
                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                expect(content.task).toBe('execution');
                expect(content.prompt).toBeTruthy();
                // output.response_path は SubagentReceiver が instruction.json 内で指定するため不要（改修2）
                expect(content.progress.path).toBeTruthy();
                expect(content.context.team.totalAgents).toBe(2);
                expect(content.context.team.agentIndex).toBe(inst.agentIndex);
                console.log(`指令ファイル agent${inst.agentIndex}:`, JSON.stringify(content, null, 2));
            }
        });

        it('TeamInstruction スキーマに準拠している', () => {
            const tasks = ['タスクA'];
            const instructions = writeInstructionFiles(tasks, 'test_req_002', 'context');

            const inst = instructions[0];
            // 全フィールドが存在するか
            expect(inst).toHaveProperty('persona');
            expect(inst).toHaveProperty('agentIndex');
            expect(inst).toHaveProperty('task');
            expect(inst).toHaveProperty('response_path');
            expect(inst).toHaveProperty('progress_path');
            expect(inst).toHaveProperty('context');
            expect(inst).toHaveProperty('timestamp');
            expect(inst).toHaveProperty('requestId');
            expect(inst).toHaveProperty('totalAgents');
        });
    });

    // =========================================================================
    // テスト3: writeReportFile
    // =========================================================================
    describe('テスト3: writeReportFile', () => {
        let writeReportFile: (requestId: string, results: any[], instructions: TeamInstruction[], responsePath: string) => string;

        beforeEach(async () => {
            const mod = await import('../teamOrchestrator');
            const instance = new mod.TeamOrchestrator(
                null as any,
                { getIpcDir: () => TEST_IPC_DIR } as any,
                (async () => { }) as any,
                REPO_ROOT,
            );
            writeReportFile = instance.writeReportFile.bind(instance);
        });

        it('報告ファイルを正しく生成する', () => {
            const mockInstructions: TeamInstruction[] = [
                {
                    persona: '',
                    agentIndex: 1,
                    task: '型チェック',
                    response_path: '/tmp/resp1.md',
                    progress_path: '/tmp/prog1.json',
                    context: 'テスト',
                    timestamp: Date.now(),
                    requestId: 'test_req_003',
                    totalAgents: 2,
                },
                {
                    persona: '',
                    agentIndex: 2,
                    task: 'テスト実行',
                    response_path: '/tmp/resp2.md',
                    progress_path: '/tmp/prog2.json',
                    context: 'テスト',
                    timestamp: Date.now(),
                    requestId: 'test_req_003',
                    totalAgents: 2,
                },
            ];

            const mockResults = [
                { agentIndex: 1, agentName: 'Agent-1', success: true, response: '型チェック完了' },
                { agentIndex: 2, agentName: 'Agent-2', success: false, response: 'テスト失敗' },
            ];

            const reportPath = writeReportFile('test_req_003', mockResults, mockInstructions, '/tmp/final_response.md');

            expect(fs.existsSync(reportPath)).toBe(true);

            const content = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
            console.log('報告ファイル内容:', JSON.stringify(content, null, 2));

            // 新フォーマット（tmp_exec_*.json 互換）のフィールドを検証
            expect(content).toHaveProperty('type', 'team_report');
            expect(content).toHaveProperty('summary');
            expect(content.summary.allSucceeded).toBe(false); // 1つ失敗
            expect(content.summary.totalAgents).toBe(2);
            expect(content).toHaveProperty('reports');
            expect(content.reports.length).toBe(2);
        });
    });

    // =========================================================================
    // テスト4: cancelPlanGeneration のチーム中止
    // =========================================================================
    describe('テスト4: cancelPlanGeneration チーム中止', () => {
        it('currentTeamAbortController が messageQueue.ts に宣言されている', async () => {
            const queuePath = path.join(__dirname, '..', 'messageQueue.ts');
            const content = fs.readFileSync(queuePath, 'utf-8');
            expect(content).toContain('let currentTeamAbortController');
        });

        it('cancelPlanGeneration に チーム用 abort が含まれている', async () => {
            const queuePath = path.join(__dirname, '..', 'messageQueue.ts');
            const content = fs.readFileSync(queuePath, 'utf-8');
            expect(content).toContain('currentTeamAbortController.abort()');
        });
    });

    // =========================================================================
    // テスト5: groupTasks
    // =========================================================================
    describe('テスト5: groupTasks', () => {
        let groupTasks: (tasks: string[], maxAgents: number) => string[];

        beforeEach(async () => {
            const mod = await import('../teamOrchestrator');
            const instance = new mod.TeamOrchestrator(
                null as any,
                { getIpcDir: () => TEST_IPC_DIR } as any,
                (async () => { }) as any,
                REPO_ROOT,
            );
            groupTasks = instance.groupTasks.bind(instance);
        });

        it('タスク数 <= maxAgents の場合はそのまま返す', () => {
            const tasks = ['タスクA', 'タスクB', 'タスクC'];
            const result = groupTasks(tasks, 3);
            expect(result.length).toBe(3);
            expect(result).toEqual(tasks);
        });

        it('タスク数 > maxAgents の場合はグループ化する', () => {
            const tasks = ['タスク1', 'タスク2', 'タスク3', 'タスク4', 'タスク5', 'タスク6'];
            const result = groupTasks(tasks, 3);
            expect(result.length).toBe(3);
            // 各グループにサブタスクが含まれていることを確認
            for (const group of result) {
                expect(group).toContain('サブタスク');
            }
            console.log('groupTasks結果 (6→3):', result);
        });

        it('タスク数 > maxAgents（端数あり）の場合も正しくグループ化', () => {
            const tasks = ['A', 'B', 'C', 'D', 'E'];
            const result = groupTasks(tasks, 3);
            expect(result.length).toBe(3);
            console.log('groupTasks結果 (5→3):', result);
        });

        it('maxAgents=1 の場合は全タスクを1グループにまとめる', () => {
            const tasks = ['タスク1', 'タスク2', 'タスク3'];
            const result = groupTasks(tasks, 1);
            expect(result.length).toBe(1);
            expect(result[0]).toContain('タスク1');
            expect(result[0]).toContain('タスク3');
        });

        it('空配列を渡した場合は空配列を返す', () => {
            const result = groupTasks([], 3);
            expect(result.length).toBe(0);
        });
    });

    // =========================================================================
    // テスト6: deduplicateTasks
    // =========================================================================
    describe('テスト6: deduplicateTasks', () => {
        let deduplicateTasks: (tasks: string[]) => { tasks: string[]; removedCount: number };

        beforeEach(async () => {
            const mod = await import('../teamOrchestrator');
            const instance = new mod.TeamOrchestrator(
                null as any,
                { getIpcDir: () => TEST_IPC_DIR } as any,
                (async () => { }) as any,
                REPO_ROOT,
            );
            deduplicateTasks = instance.deduplicateTasks.bind(instance);
        });

        it('重複なしの場合はそのまま返す', () => {
            const tasks = ['型チェックを実行', 'テストを実行', 'ビルドを実行'];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(3);
            expect(result.removedCount).toBe(0);
        });

        it('完全に同じタスクは1つに統合する', () => {
            const tasks = [
                '1. subagentHandle.ts に mergeChanges() を追加する',
                '2. subagentHandle.ts に mergeChanges() を追加する',
                '3. subagentHandle.ts に mergeChanges() を追加する',
            ];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(1);
            expect(result.removedCount).toBe(2);
        });

        it('番号プレフィックスが異なるだけの同一タスクを統合する', () => {
            const tasks = [
                '## 背景\n以下を実行してください。\n\n## タスク\n1. mergeChanges を追加',
                '## 背景\n以下を実行してください。\n\n## タスク\n2. mergeChanges を追加',
            ];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(1);
            expect(result.removedCount).toBe(1);
        });

        it('異なるタスクは統合しない', () => {
            const tasks = [
                '型チェックを実行してエラーを修正する',
                'ユニットテストを追加してカバレッジを上げる',
                'デプロイスクリプトを更新する',
            ];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(3);
            expect(result.removedCount).toBe(0);
        });

        it('1件の場合はそのまま返す', () => {
            const tasks = ['単一タスク'];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(1);
            expect(result.removedCount).toBe(0);
        });

        it('空配列の場合はそのまま返す', () => {
            const result = deduplicateTasks([]);
            expect(result.tasks.length).toBe(0);
            expect(result.removedCount).toBe(0);
        });

        it('重複時はより長い記述を保持する', () => {
            const shortTask = '1. subagentHandle.ts の mergeChanges メソッドを修正する';
            const longTask = '2. subagentHandle.ts の mergeChanges メソッドを修正して改善する';
            const tasks = [shortTask, longTask];
            const result = deduplicateTasks(tasks);
            expect(result.tasks.length).toBe(1);
            expect(result.removedCount).toBe(1);
            // より長い記述が保持されている
            expect(result.tasks[0]).toBe(longTask);
        });
    });
});
