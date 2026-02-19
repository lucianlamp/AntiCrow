// ---------------------------------------------------------------------------
// src/licensing/licenseChecker.ts — ライセンス有効性チェッカー
// ---------------------------------------------------------------------------
// 責務:
//   1. Convex API 経由でライセンス有効性を定期チェック
//   2. ライセンス状態のキャッシュ管理
//   3. ライセンス変更イベントの通知
// ---------------------------------------------------------------------------

import { logDebug, logWarn, logError } from '../logger';

/** ライセンスタイプ */
export type LicenseType = 'monthly' | 'annual' | 'lifetime' | 'beta';

/** ライセンスの有効性チェック結果 */
export interface LicenseStatus {
    valid: boolean;
    type: LicenseType | null;
    reason: string;
    expiresAt?: number;   // Unix timestamp (ms)
    checkedAt: number;    // Unix timestamp (ms)
}

/** ライセンス変更リスナー */
export type LicenseChangeListener = (status: LicenseStatus) => void;

/** デフォルトのチェック間隔（5分） */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** キャッシュ有効期間（1分） */
const CACHE_TTL_MS = 60 * 1000;

export class LicenseChecker {
    private convexUrl: string;
    private clerkId: string | null = null;
    private cachedStatus: LicenseStatus | null = null;
    private checkTimer: ReturnType<typeof setInterval> | null = null;
    private listeners: LicenseChangeListener[] = [];

    constructor(convexUrl: string) {
        this.convexUrl = convexUrl;
    }

    /** Clerk ユーザー ID を設定 */
    setClerkId(clerkId: string): void {
        this.clerkId = clerkId;
        this.cachedStatus = null;  // キャッシュクリア
        logDebug(`LicenseChecker: clerkId set to ${clerkId.substring(0, 8)}...`);
    }

    /** 変更リスナーを追加 */
    onChange(listener: LicenseChangeListener): void {
        this.listeners.push(listener);
    }

    /** 定期チェックを開始 */
    startAutoCheck(intervalMs: number = DEFAULT_CHECK_INTERVAL_MS): void {
        this.stopAutoCheck();
        logDebug(`LicenseChecker: starting auto-check (interval=${intervalMs}ms)`);

        // 初回即時チェック
        this.check().catch((e) => logWarn(`LicenseChecker: initial check failed: ${e}`));

        this.checkTimer = setInterval(async () => {
            try {
                await this.check();
            } catch (e) {
                logWarn(`LicenseChecker: periodic check failed: ${e}`);
            }
        }, intervalMs);
    }

    /** 定期チェックを停止 */
    stopAutoCheck(): void {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
            logDebug('LicenseChecker: auto-check stopped');
        }
    }

    /**
     * ライセンスの有効性をチェック。
     * キャッシュが有効ならキャッシュを返す。
     */
    async check(force: boolean = false): Promise<LicenseStatus> {
        // キャッシュチェック
        if (!force && this.cachedStatus) {
            const age = Date.now() - this.cachedStatus.checkedAt;
            if (age < CACHE_TTL_MS) {
                return this.cachedStatus;
            }
        }

        if (!this.clerkId) {
            const status: LicenseStatus = {
                valid: false,
                type: null,
                reason: 'not_authenticated',
                checkedAt: Date.now(),
            };
            this.updateStatus(status);
            return status;
        }

        try {
            const response = await fetch(`${this.convexUrl}/api/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: 'licenses:checkLicense',
                    args: { clerkId: this.clerkId },
                }),
            });

            if (!response.ok) {
                throw new Error(`Convex API error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json() as {
                value: {
                    valid: boolean;
                    reason: string;
                    license: {
                        type: LicenseType;
                        currentPeriodEnd?: number;
                        expiresAt?: number;
                    } | null;
                };
            };
            const data = result.value;

            const status: LicenseStatus = {
                valid: data.valid,
                type: data.license?.type ?? null,
                reason: data.reason,
                expiresAt: data.license?.currentPeriodEnd ?? data.license?.expiresAt,
                checkedAt: Date.now(),
            };

            this.updateStatus(status);
            logDebug(`LicenseChecker: check result — valid=${status.valid}, type=${status.type}, reason=${status.reason}`);
            return status;
        } catch (e) {
            logError(`LicenseChecker: check failed`, e);
            // ネットワークエラー時はキャッシュがあればそれを返す
            if (this.cachedStatus) {
                return this.cachedStatus;
            }

            const status: LicenseStatus = {
                valid: false,
                type: null,
                reason: 'check_failed',
                checkedAt: Date.now(),
            };
            this.updateStatus(status);
            return status;
        }
    }

    /** 現在のキャッシュ済みステータスを取得（チェック無し） */
    getCachedStatus(): LicenseStatus | null {
        return this.cachedStatus;
    }

    /** ステータスを更新し、変更があればリスナーに通知 */
    private updateStatus(status: LicenseStatus): void {
        const changed = !this.cachedStatus ||
            this.cachedStatus.valid !== status.valid ||
            this.cachedStatus.type !== status.type ||
            this.cachedStatus.reason !== status.reason;

        this.cachedStatus = status;

        if (changed) {
            for (const listener of this.listeners) {
                try { listener(status); } catch { /* ignore */ }
            }
        }
    }

    /** クリーンアップ */
    dispose(): void {
        this.stopAutoCheck();
        this.listeners = [];
        this.cachedStatus = null;
    }
}
