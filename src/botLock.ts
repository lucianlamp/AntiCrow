// ---------------------------------------------------------------------------
// botLock.ts — ファイルベースの Bot 起動ロック管理
// ---------------------------------------------------------------------------
// 複数ワークスペースが同時に起動しても、Discord Bot を起動するのは
// 1 インスタンスだけに制限する。globalStorageUri 配下の `bot.active` ファイルで
// 排他制御を行う。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from './logger';

const LOCK_FILE = 'bot.active';

interface LockData {
    pid: number;
    timestamp: string;
}

/**
 * プロセスが生存しているかチェックする（Windows / POSIX 両対応）。
 */
function isProcessAlive(pid: number): boolean {
    try {
        // kill(pid, 0) はシグナルを送らずにプロセスの生存確認のみ行う
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function lockFilePath(storagePath: string): string {
    return path.join(storagePath, LOCK_FILE);
}

/**
 * Bot 起動ロックの取得を試行する。
 *
 * - ロックファイルが存在しない → PID + タイムスタンプを書き込んで true
 * - ロックファイルがあるが PID が死んでいる → 上書きして true（ステイルロック対策）
 * - ロックファイルがあり PID が生存中 → false
 */
export function acquireLock(storagePath: string): boolean {
    const fp = lockFilePath(storagePath);

    // ディレクトリが存在しなければ作成
    try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
    } catch { /* already exists */ }

    const lockData: LockData = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
    };

    // 1) 原子的にロックファイルを作成（O_CREAT | O_EXCL）
    try {
        const fd = fs.openSync(fp, 'wx');
        fs.writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf-8');
        fs.closeSync(fd);
        logDebug(`BotLock: acquired lock (PID=${process.pid})`);
        return true;
    } catch (e: unknown) {
        if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'EEXIST') {
            logWarn(`BotLock: failed to create lock file: ${e.message}`);
            return false;
        }
        // EEXIST → 既存ロックの stale チェックへ
    }

    // 2) 既存ロックの stale チェック
    try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data: LockData = JSON.parse(raw);

        if (isProcessAlive(data.pid)) {
            logDebug(`BotLock: lock held by PID ${data.pid} (alive) — skipping bot startup`);
            return false;
        }

        // stale ロック — 削除して再試行
        logWarn(`BotLock: stale lock from PID ${data.pid} (dead) — overriding`);
        fs.unlinkSync(fp);
    } catch {
        // ファイルが壊れている or 読み取り中に消えた → 削除試行
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
    }

    // 3) 再度原子的に作成（他プロセスとの競合を防ぐ）
    try {
        const fd = fs.openSync(fp, 'wx');
        fs.writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf-8');
        fs.closeSync(fd);
        logDebug(`BotLock: acquired lock after stale cleanup (PID=${process.pid})`);
        return true;
    } catch {
        logWarn('BotLock: lost race after stale cleanup — another process won');
        return false;
    }
}

/**
 * Bot 起動ロックを解放する。
 * 自プロセスが所有するロックのみ解放する。
 */
export function releaseLock(storagePath: string): void {
    const fp = lockFilePath(storagePath);

    try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data: LockData = JSON.parse(raw);

        if (data.pid !== process.pid) {
            logDebug(`BotLock: lock owned by PID ${data.pid}, not releasing (we are PID ${process.pid})`);
            return;
        }

        fs.unlinkSync(fp);
        logDebug(`BotLock: released lock (PID=${process.pid})`);
    } catch {
        // ファイルが無い or 読めない → 何もしない
        logDebug('BotLock: no lock file to release');
    }
}

