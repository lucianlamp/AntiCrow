// ---------------------------------------------------------------------------
// subagentIpc.test.ts — subagentIpc のユニットテスト
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

import * as fs from 'fs';
import * as path from 'path';
import {
    validateIpcPath,
    validateAgentName,
    writePrompt,
    writeResponse,
    watchResponse,
} from '../subagentIpc';
import type { SubagentPrompt, SubagentResponse } from '../subagentTypes';

// ---------------------------------------------------------------------------
// validateIpcPath
// ---------------------------------------------------------------------------

describe('validateIpcPath', () => {
    it('ipcDir 内のパスを許可する', () => {
        const ipcDir = path.resolve('/mock/ipc');
        const filePath = path.join(ipcDir, 'test.json');
        expect(validateIpcPath(filePath, ipcDir)).toBe(true);
    });

    it('ipcDir 自体を許可する', () => {
        const ipcDir = path.resolve('/mock/ipc');
        expect(validateIpcPath(ipcDir, ipcDir)).toBe(true);
    });

    it('ipcDir の外のパスを拒否する', () => {
        const ipcDir = path.resolve('/mock/ipc');
        const filePath = path.resolve('/mock/other/test.json');
        expect(validateIpcPath(filePath, ipcDir)).toBe(false);
    });

    it('パストラバーサル攻撃を拒否する', () => {
        const ipcDir = path.resolve('/mock/ipc');
        const filePath = path.join(ipcDir, '..', 'etc', 'passwd');
        expect(validateIpcPath(filePath, ipcDir)).toBe(false);
    });

    it('ipcDir のプレフィックスだけ一致するパスを拒否する', () => {
        const ipcDir = path.resolve('/mock/ipc');
        // /mock/ipc-other/test.json は ipcDir 外
        const filePath = path.resolve('/mock/ipc-other/test.json');
        expect(validateIpcPath(filePath, ipcDir)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// validateAgentName
// ---------------------------------------------------------------------------

describe('validateAgentName', () => {
    it('英数字・ハイフン・アンダースコアを許可する', () => {
        expect(validateAgentName('agent-1')).toBe(true);
        expect(validateAgentName('agent_2')).toBe(true);
        expect(validateAgentName('AgentTest123')).toBe(true);
    });

    it('空文字を拒否する', () => {
        expect(validateAgentName('')).toBe(false);
    });

    it('65文字以上を拒否する', () => {
        expect(validateAgentName('a'.repeat(64))).toBe(true);
        expect(validateAgentName('a'.repeat(65))).toBe(false);
    });

    it('特殊文字を拒否する', () => {
        expect(validateAgentName('agent/1')).toBe(false);
        expect(validateAgentName('agent 1')).toBe(false);
        expect(validateAgentName('agent.1')).toBe(false);
        expect(validateAgentName('../etc')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// writePrompt
// ---------------------------------------------------------------------------

describe('writePrompt', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipc-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('正常なプロンプトを書き込める', () => {
        const prompt: SubagentPrompt = {
            type: 'subagent_prompt',
            from: 'main-agent',
            to: 'agent-1',
            timestamp: 1234567890,
            prompt: 'テストタスク',
            timeout_ms: 300000,
            callback_path: path.join(tmpDir, 'response.json'),
        };

        const result = writePrompt(tmpDir, prompt);
        expect(fs.existsSync(result)).toBe(true);

        const written = JSON.parse(fs.readFileSync(result, 'utf-8'));
        expect(written.type).toBe('subagent_prompt');
        expect(written.to).toBe('agent-1');
        expect(written.prompt).toBe('テストタスク');
    });

    it('ファイル名に to と timestamp が含まれる', () => {
        const prompt: SubagentPrompt = {
            type: 'subagent_prompt',
            from: 'main',
            to: 'worker-1',
            timestamp: 9876543210,
            prompt: 'task',
            timeout_ms: 5000,
            callback_path: path.join(tmpDir, 'cb.json'),
        };

        const result = writePrompt(tmpDir, prompt);
        const basename = path.basename(result);
        expect(basename).toContain('worker-1');
        expect(basename).toContain('9876543210');
    });

    it('無効なエージェント名でエラーを投げる', () => {
        const prompt: SubagentPrompt = {
            type: 'subagent_prompt',
            from: 'main',
            to: '../bad-name',
            timestamp: 1234,
            prompt: 'task',
            timeout_ms: 5000,
            callback_path: path.join(tmpDir, 'cb.json'),
        };

        expect(() => writePrompt(tmpDir, prompt)).toThrow('無効なエージェント名');
    });

    it('存在しないディレクトリを自動作成する', () => {
        const subDir = path.join(tmpDir, 'nested', 'ipc');
        const prompt: SubagentPrompt = {
            type: 'subagent_prompt',
            from: 'main',
            to: 'agent-1',
            timestamp: 1111,
            prompt: 'task',
            timeout_ms: 5000,
            callback_path: path.join(subDir, 'cb.json'),
        };

        const result = writePrompt(subDir, prompt);
        expect(fs.existsSync(result)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// writeResponse
// ---------------------------------------------------------------------------

describe('writeResponse', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipc-resp-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('正常なレスポンスを書き込める', () => {
        const callbackPath = path.join(tmpDir, 'response.json');
        const response: SubagentResponse = {
            type: 'subagent_response',
            from: 'agent-1',
            timestamp: Date.now(),
            status: 'success',
            result: 'テスト完了',
            execution_time_ms: 1000,
        };

        writeResponse(callbackPath, response, tmpDir);
        expect(fs.existsSync(callbackPath)).toBe(true);

        const written = JSON.parse(fs.readFileSync(callbackPath, 'utf-8'));
        expect(written.type).toBe('subagent_response');
        expect(written.status).toBe('success');
    });

    it('ipcDir 外へのパスでエラーを投げる', () => {
        const callbackPath = path.resolve('/other/dir/response.json');
        const response: SubagentResponse = {
            type: 'subagent_response',
            from: 'agent-1',
            timestamp: Date.now(),
            status: 'success',
            result: 'ok',
            execution_time_ms: 100,
        };

        expect(() => writeResponse(callbackPath, response, tmpDir)).toThrow('パストラバーサル検出');
    });
});

// ---------------------------------------------------------------------------
// watchResponse
// ---------------------------------------------------------------------------

describe('watchResponse', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipc-watch-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('レスポンスファイルを検知して返す', async () => {
        const callbackPath = path.join(tmpDir, 'response_test.json');
        const response: SubagentResponse = {
            type: 'subagent_response',
            from: 'agent-1',
            timestamp: Date.now(),
            status: 'success',
            result: '結果テスト',
            execution_time_ms: 500,
        };

        // 少し遅延してファイルを書き込む
        setTimeout(() => {
            fs.writeFileSync(callbackPath, JSON.stringify(response), 'utf-8');
        }, 200);

        const result = await watchResponse(callbackPath, 5000, 100);
        expect(result).not.toBeNull();
        expect(result!.status).toBe('success');
        expect(result!.result).toBe('結果テスト');
    });

    it('既にファイルが存在する場合に即座に返す', async () => {
        const callbackPath = path.join(tmpDir, 'existing_response.json');
        const response: SubagentResponse = {
            type: 'subagent_response',
            from: 'agent-1',
            timestamp: Date.now(),
            status: 'success',
            result: '既存',
            execution_time_ms: 100,
        };

        // 先にファイルを作成
        fs.writeFileSync(callbackPath, JSON.stringify(response), 'utf-8');

        const start = Date.now();
        const result = await watchResponse(callbackPath, 5000, 100);
        const elapsed = Date.now() - start;

        expect(result).not.toBeNull();
        expect(result!.result).toBe('既存');
        // 初回チェックで見つかるのですぐに返るはず
        expect(elapsed).toBeLessThan(2000);
    });

    it('タイムアウト時に null を返す', async () => {
        const callbackPath = path.join(tmpDir, 'never_response.json');

        const result = await watchResponse(callbackPath, 500, 100);
        expect(result).toBeNull();
    });

    it('type が subagent_response でないファイルを無視する', async () => {
        const callbackPath = path.join(tmpDir, 'bad_type.json');

        // type が違うファイル
        fs.writeFileSync(callbackPath, JSON.stringify({
            type: 'other_type',
            status: 'success',
        }), 'utf-8');

        const result = await watchResponse(callbackPath, 500, 100);
        expect(result).toBeNull();
    });

    it('不正な JSON を無視してタイムアウトする', async () => {
        const callbackPath = path.join(tmpDir, 'bad_json.json');

        fs.writeFileSync(callbackPath, '{invalid json!!!', 'utf-8');

        const result = await watchResponse(callbackPath, 500, 100);
        expect(result).toBeNull();
    });
});
