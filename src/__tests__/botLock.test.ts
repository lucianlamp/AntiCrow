// ---------------------------------------------------------------------------
// botLock.test.ts — Bot起動ロック管理テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { acquireLock, releaseLock } from '../botLock';

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

// テスト用の一時ディレクトリ
const TEST_DIR = path.join(__dirname, '__botlock_test_tmp__');

function cleanTestDir(): void {
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
}

describe('botLock', () => {
    beforeEach(() => {
        cleanTestDir();
        fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
        cleanTestDir();
    });

    // ----- acquireLock -----

    describe('acquireLock', () => {
        it('should acquire lock when no lock file exists', () => {
            const result = acquireLock(TEST_DIR);
            expect(result).toBe(true);

            // ロックファイルが作成されたことを確認
            const lockPath = path.join(TEST_DIR, 'bot.active');
            expect(fs.existsSync(lockPath)).toBe(true);

            // ロックデータが正しいことを確認
            const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
            expect(data.pid).toBe(process.pid);
            expect(data.timestamp).toBeTruthy();
        });

        it('should not acquire lock when held by alive process (self)', () => {
            // 最初のロック取得
            const first = acquireLock(TEST_DIR);
            expect(first).toBe(true);

            // 同じプロセスからの再取得は失敗
            const second = acquireLock(TEST_DIR);
            expect(second).toBe(false);
        });

        it('should override stale lock from dead process', () => {
            // 存在しない PID でロックファイルを事前に作成
            const lockPath = path.join(TEST_DIR, 'bot.active');
            const staleLock = { pid: 999999999, timestamp: new Date().toISOString() };
            fs.writeFileSync(lockPath, JSON.stringify(staleLock, null, 2), 'utf-8');

            // stale ロックを上書きして取得できること
            const result = acquireLock(TEST_DIR);
            expect(result).toBe(true);

            // 新しい PID で上書きされたことを確認
            const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
            expect(data.pid).toBe(process.pid);
        });

        it('should handle corrupted lock file', () => {
            // 壊れたロックファイル
            const lockPath = path.join(TEST_DIR, 'bot.active');
            fs.writeFileSync(lockPath, 'not valid json!!!', 'utf-8');

            // 壊れたファイルを無視して取得できること
            const result = acquireLock(TEST_DIR);
            expect(result).toBe(true);
        });

        it('should create storage directory if it does not exist', () => {
            const nestedDir = path.join(TEST_DIR, 'nested', 'deep');
            const result = acquireLock(nestedDir);
            expect(result).toBe(true);
            expect(fs.existsSync(path.join(nestedDir, 'bot.active'))).toBe(true);
        });
    });

    // ----- releaseLock -----

    describe('releaseLock', () => {
        it('should release own lock', () => {
            acquireLock(TEST_DIR);
            const lockPath = path.join(TEST_DIR, 'bot.active');
            expect(fs.existsSync(lockPath)).toBe(true);

            releaseLock(TEST_DIR);
            expect(fs.existsSync(lockPath)).toBe(false);
        });

        it('should not release lock owned by different PID', () => {
            // 別の PID でロックファイルを作成
            const lockPath = path.join(TEST_DIR, 'bot.active');
            const otherLock = { pid: 12345, timestamp: new Date().toISOString() };
            fs.writeFileSync(lockPath, JSON.stringify(otherLock, null, 2), 'utf-8');

            releaseLock(TEST_DIR);

            // ロックファイルが残っていること
            expect(fs.existsSync(lockPath)).toBe(true);
        });

        it('should handle missing lock file gracefully', () => {
            // ロックファイルが存在しない場合でもエラーにならない
            expect(() => releaseLock(TEST_DIR)).not.toThrow();
        });
    });
});
