// ---------------------------------------------------------------------------
// botLock.ts — ファイルベースの Bot 起動ロック管理
// ---------------------------------------------------------------------------
// 複数ワークスペースが同時に起動しても、Discord Bot を起動するのは
// 1 インスタンスだけに制限する。globalStorageUri 配下の `bot.active` ファイルで
// 排他制御を行う。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn, logDebug } from './logger';

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

    // 既存ロックをチェック
    try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data: LockData = JSON.parse(raw);

        if (isProcessAlive(data.pid)) {
            logInfo(`BotLock: lock held by PID ${data.pid} (alive) — skipping bot startup`);
            return false;
        }

        // ステイルロック — 上書き
        logWarn(`BotLock: stale lock from PID ${data.pid} (dead) — overriding`);
    } catch {
        // ファイルが無い or 壊れている → 新規取得
    }

    // ロック取得
    const lockData: LockData = {
        pid: process.pid,
        timestamp: new Date().toISOString(),
    };

    try {
        fs.writeFileSync(fp, JSON.stringify(lockData, null, 2), 'utf-8');
        logInfo(`BotLock: acquired lock (PID=${process.pid})`);
        return true;
    } catch (e) {
        logWarn(`BotLock: failed to write lock file: ${e instanceof Error ? e.message : e}`);
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
        logInfo(`BotLock: released lock (PID=${process.pid})`);
    } catch {
        // ファイルが無い or 読めない → 何もしない
        logDebug('BotLock: no lock file to release');
    }
}

