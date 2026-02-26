// ---------------------------------------------------------------------------
// configHelper.ts — 設定値の一元管理
// ---------------------------------------------------------------------------
// 責務:
//   1. 設定キー名・デフォルト値を一箇所で管理
//   2. 型安全な設定取得ヘルパーを提供
//   3. マジックナンバー散在を防止
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from './logger';
import type { WorkspaceStore } from './workspaceStore';

// ---------------------------------------------------------------------------
// デフォルト値定数
// ---------------------------------------------------------------------------



/**
 * CDP ポートとして使用してはいけないポート番号。
 * - 9222: ブラウザエージェント（Playwright 等）が使用する CDP ポート
 */
export const EXCLUDED_CDP_PORTS: ReadonlySet<number> = new Set([9222]);

/**
 * CDP ポート一覧を取得する。
 * cdp_ports/ ディレクトリのポートファイルから動的に検出する。
 * EXCLUDED_CDP_PORTS に含まれるポートは自動的に除外される。
 * 動的ポートが見つからない場合は settings の cdpPort をフォールバックに使用する。
 * 
 * @param storagePath globalStorage のパス
 */
export function getCdpPorts(storagePath: string): number[] {
    const portDir = path.join(storagePath, 'cdp_ports');
    const dynamicPorts: number[] = [];

    try {
        if (fs.existsSync(portDir)) {
            const files = fs.readdirSync(portDir);
            for (const f of files) {
                if (!f.startsWith('port_') || !f.endsWith('.txt')) { continue; }
                try {
                    const content = fs.readFileSync(path.join(portDir, f), 'utf-8').trim();
                    const port = parseInt(content, 10);
                    if (!isNaN(port) && port > 0 && port <= 65535) {
                        if (EXCLUDED_CDP_PORTS.has(port)) {
                            logWarn(`getCdpPorts: skipping excluded port ${port} from ${f} (reserved for browser agent)`);
                            continue;
                        }
                        dynamicPorts.push(port);
                        logDebug(`getCdpPorts: read dynamic port ${port} from ${f}`);
                    }
                } catch (e) { logDebug(`getCdpPorts: failed to read port file ${f}: ${e}`); }
            }

            // 古いポートファイルをクリーンアップ（プロセスが終了済みの場合）
            cleanupStalePortFiles(portDir);
        }
    } catch (e) {
        logWarn(`getCdpPorts: failed to read cdp_ports directory: ${e instanceof Error ? e.message : e}`);
    }

    if (dynamicPorts.length > 0) {
        logDebug(`getCdpPorts: using ${dynamicPorts.length} dynamic port(s)`);
        return dynamicPorts;
    }

    // フォールバック: settings の cdpPort（固定ポート）を使用
    const configuredPort = getCdpPort();
    logDebug(`getCdpPorts: no dynamic ports found, using configured cdpPort ${configuredPort}`);
    return [configuredPort];

}

/** CDP 固定ポート番号を取得する（デフォルト: 9333） */
export function getCdpPort(): number {
    return getConfig().get<number>('cdpPort') ?? 9333;
}

/** 古いポートファイルを削除（プロセスが終了済みの場合） */
function cleanupStalePortFiles(portDir: string): void {
    try {
        const files = fs.readdirSync(portDir);
        for (const f of files) {
            if (!f.startsWith('port_') || !f.endsWith('.txt')) { continue; }
            const fp = path.join(portDir, f);
            try {
                // ファイル名からPIDを抽出（port_12345.txt → 12345）
                const pidMatch = f.match(/^port_(\d+)\.txt$/);
                if (!pidMatch) {
                    // PID形式でないファイルは古い形式として削除
                    fs.unlinkSync(fp);
                    logDebug(`cleanupStalePortFiles: removed non-PID port file ${f}`);
                    continue;
                }
                const pid = parseInt(pidMatch[1], 10);
                // プロセスが存在するか確認（process.kill(pid, 0) はシグナルを送らず存在確認のみ）
                let alive = false;
                try {
                    process.kill(pid, 0);
                    alive = true;
                } catch {
                    alive = false;
                }
                if (!alive) {
                    fs.unlinkSync(fp);
                    logDebug(`cleanupStalePortFiles: removed stale port file ${f} (PID ${pid} not running)`);
                }
            } catch (e) { logDebug(`cleanupStalePortFiles: failed to process ${f}: ${e}`); }
        }
    } catch (e) { logDebug(`cleanupStalePortFiles: readdir failed: ${e}`); }
}

/** CDP レスポンスタイムアウト（ms）のデフォルト値 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1_800_000;

/** タイムゾーンのデフォルト値 */
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

/** カテゴリーアーカイブ日数のデフォルト値 */
export const DEFAULT_ARCHIVE_DAYS = 7;

// ---------------------------------------------------------------------------
// 設定取得ヘルパー
// ---------------------------------------------------------------------------

/** 設定セクション名 */
const SECTION = 'antiCrow';

/** 設定オブジェクトを取得する */
export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
}



/** CDP レスポンスタイムアウト（ms）を取得する（デフォルト: 1,800,000 = 30分） */
export function getResponseTimeout(): number {
    return getConfig().get<number>('responseTimeoutMs') || DEFAULT_RESPONSE_TIMEOUT_MS;
}

/** タイムゾーンを取得する（設定値が空の場合は OS から自動取得） */
export function getTimezone(): string {
    const configured = getConfig().get<string>('timezone') || '';
    if (configured) { return configured; }
    // OS のタイムゾーンを自動取得
    try {
        const osTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        logDebug(`getTimezone: auto-detected OS timezone: ${osTimezone}`);
        return osTimezone || DEFAULT_TIMEZONE;
    } catch {
        logWarn('getTimezone: failed to auto-detect OS timezone, using default');
        return DEFAULT_TIMEZONE;
    }
}

/** カテゴリーアーカイブ日数を取得する（デフォルト: 7） */
export function getArchiveDays(): number {
    return getConfig().get<number>('categoryArchiveDays') ?? DEFAULT_ARCHIVE_DAYS;
}

/** workspacePaths を取得する（手動設定のみ、非推奨） */
export function getWorkspacePaths(): Record<string, string> {
    return getConfig().get<Record<string, string>>('workspacePaths') || {};
}

/** 新規ワークスペース作成用ペアレントディレクトリ候補を取得する */
export function getWorkspaceParentDirs(): string[] {
    return getConfig().get<string[]>('workspaceParentDirs') || [];
}

/**
 * ワークスペース→フォルダパスのマッピングを解決する。
 * 優先順位: WorkspaceStore（自動学習）> settings.json（手動設定、非推奨）
 */
export function resolveWorkspacePaths(store?: WorkspaceStore): Record<string, string> {
    const manual = getWorkspacePaths();
    if (!store) { return manual; }
    const auto = store.getAll();
    // 自動学習データを優先し、手動設定をフォールバックとしてマージ
    return { ...manual, ...auto };
}

/** clientId を取得する */
export function getClientId(): string {
    return getConfig().get<string>('clientId') || '';
}

/** 許可ユーザーID一覧を取得する（空=全拒否） */
export function getAllowedUserIds(): string[] {
    return getConfig().get<string[]>('allowedUserIds') || [];
}

/**
 * 指定ユーザーが操作を許可されているか判定する。
 * allowedUserIds が空の場合は「誰も操作できない（全拒否）」として false を返す。
 */
export function isUserAllowed(userId: string): { allowed: boolean; reason?: string } {
    const allowedIds = getAllowedUserIds();
    if (allowedIds.length === 0) {
        return { allowed: false, reason: '許可ユーザーIDが設定されていません。Antigravity の設定で `antiCrow.allowedUserIds` にあなたの Discord ユーザーIDを追加してください。' };
    }
    if (!allowedIds.includes(userId)) {
        return { allowed: false, reason: 'このユーザーは操作を許可されていません。' };
    }
    return { allowed: true };
}

/** メッセージ最大文字数を取得する（0=無制限、デフォルト: 6000） */
export function getMaxMessageLength(): number {
    return getConfig().get<number>('maxMessageLength') ?? 6000;
}

/** 自動リトライ最大回数を取得する（デフォルト: 0 — リトライ無効） */
export function getMaxRetries(): number {
    return getConfig().get<number>('maxRetries') ?? 0;
}
