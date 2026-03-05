// ---------------------------------------------------------------------------
// configHelper.ts — 設定値の一元管理
// ---------------------------------------------------------------------------
// 責務:
//   1. 設定キー名・デフォルト値を一箇所で管理
//   2. 型安全な設定取得ヘルパーを提供
//   3. マジックナンバー散在を防止
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { logDebug, logWarn } from './logger';
import type { WorkspaceStore } from './workspaceStore';
import { t } from './i18n';

// ---------------------------------------------------------------------------
// デフォルト値定数
// ---------------------------------------------------------------------------

/** CDP 固定ポート番号を取得する（デフォルト: 9333） */
export function getCdpPort(): number {
    return getConfig().get<number>('cdpPort') ?? 9333;
}

/**
 * CDP ポート一覧を取得する。
 * 設定画面の固定ポート（デフォルト 9333）を返す。
 *
 * @param _storagePath 未使用（後方互換のため引数を残す）
 */
export function getCdpPorts(_storagePath?: string): number[] {
    const port = getCdpPort();
    logDebug(`getCdpPorts: using configured cdpPort ${port}`);
    return [port];
}

/** CDP レスポンスタイムアウト（ms）のデフォルト値。0 = 無制限（stale recovery + /stop がセーフネット） */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 0;

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

/** i18n 言語設定を取得する（デフォルト: 'ja'） */
export function getLanguage(): string {
    return getConfig().get<string>('language') || 'ja';
}

/** CDP レスポンスタイムアウト（ms）を取得する（デフォルト: 0 = 無制限） */
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
        return { allowed: false, reason: t('config.noAllowedUsers') };
    }
    if (!allowedIds.includes(userId)) {
        return { allowed: false, reason: t('config.userNotAllowed') };
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


