// ---------------------------------------------------------------------------
// src/licensing/licenseChecker.ts — Lemonsqueezy ライセンス検証
// ---------------------------------------------------------------------------
// 責務:
//   1. Lemonsqueezy API 経由でライセンスキーの有効性を検証
//   2. ライセンス状態のキャッシュ管理（globalState 永続化）
//   3. オフライン猶予期間（3日間）の管理
//   4. 定期再検証（24時間ごと）
//   5. ライセンス変更イベントの通知
// ---------------------------------------------------------------------------

import { logDebug, logWarn, logError } from '../logger';

// -----------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------

/** ライセンスタイプ（Lemonsqueezy プラン） */
export type LicenseType = 'lifetime' | 'trial' | 'free';

/** ライセンス有効性の理由 */
export type LicenseReason =
    | 'active'           // 有効なライセンス
    | 'expired'          // 期限切れ
    | 'no_key'           // キー未設定
    | 'invalid_key'      // 無効なキー
    | 'check_failed'     // チェック失敗（ネットワークエラー等）
    | 'offline_grace'    // オフライン猶予期間中
    | 'trial_active'     // Proトライアル期間中
    | 'trial_expired';   // トライアル期限切れ

/** ライセンスの有効性チェック結果 */
export interface LicenseStatus {
    valid: boolean;
    type: LicenseType;
    reason: LicenseReason;
    expiresAt?: number;      // Unix timestamp (ms) — サブスクの場合
    checkedAt: number;       // Unix timestamp (ms)
    instanceId?: string;     // Lemonsqueezy インスタンス ID
}

/** キャッシュデータ（globalState に永続化） */
export interface LicenseCache {
    status: LicenseStatus;
    lastOnlineCheck: number;    // 最後にオンラインで検証成功した時刻
}

/** ライセンス変更リスナー */
export type LicenseChangeListener = (status: LicenseStatus) => void;

// -----------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------

/** 環境変数 URL を検証（HTTPS 強制 + ドメインホワイトリスト） */
function validateEnvUrl(envValue: string | undefined, defaultUrl: string, allowedDomains: string[]): string {
    if (!envValue) return defaultUrl;
    try {
        const parsed = new URL(envValue);
        if (parsed.protocol !== 'https:') {
            logWarn(`[Security] URL must use HTTPS, falling back to default: ${defaultUrl}`);
            return defaultUrl;
        }
        const isAllowed = allowedDomains.some(domain =>
            parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
        );
        if (!isAllowed) {
            logWarn(`[Security] URL domain not in whitelist (${parsed.hostname}), falling back to default: ${defaultUrl}`);
            return defaultUrl;
        }
        return envValue;
    } catch {
        logWarn(`[Security] Invalid URL format, falling back to default: ${defaultUrl}`);
        return defaultUrl;
    }
}

/** Lemonsqueezy API ベース URL（.env で設定可能、HTTPS + ドメイン検証付き） */
const LEMON_API_BASE = validateEnvUrl(process.env.LEMON_API_BASE, 'https://api.lemonsqueezy.com', ['lemonsqueezy.com']);

/** デフォルトのチェック間隔（24時間） */
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** キャッシュ有効期間（5分 — 短時間の連続チェックを抑制） */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** オフライン猶予期間（3日間） */
const OFFLINE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/** Proトライアル期間（14日間） */
const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

/** globalState のキー */
const STATE_KEY = 'antiCrow.licenseCache';
const GLOBAL_STATE_TRIAL_START = 'anticrow.trialStartDate';

// -----------------------------------------------------------------------
// Free プランのデフォルト状態
// -----------------------------------------------------------------------

const FREE_STATUS: LicenseStatus = {
    valid: true,
    type: 'free',
    reason: 'no_key',
    checkedAt: Date.now(),
};

// -----------------------------------------------------------------------
// LicenseChecker
// -----------------------------------------------------------------------

export class LicenseChecker {
    private licenseKey: string = '';
    private cachedStatus: LicenseStatus = { ...FREE_STATUS };
    private checkTimer: ReturnType<typeof setInterval> | null = null;
    private listeners: LicenseChangeListener[] = [];
    private globalState: { get: (key: string) => unknown; update: (key: string, value: unknown) => Thenable<void> } | null = null;

    constructor() {
        // globalState は後から設定可能
    }

    // -------------------------------------------------------------------
    // 初期化
    // -------------------------------------------------------------------

    /** globalState を設定（キャッシュ永続化用） */
    setGlobalState(state: { get: (key: string) => unknown; update: (key: string, value: unknown) => Thenable<void> }): void {
        this.globalState = state;
        this.restoreCache();
        // トライアル開始日を初期化（初回のみ記録）
        this.initTrial().catch(e => logError('initTrial failed', e));
    }

    /** ライセンスキーを設定 */
    setLicenseKey(key: string): void {
        const changed = this.licenseKey !== key;
        this.licenseKey = key.trim();
        if (changed) {
            this.cachedStatus = { ...FREE_STATUS, checkedAt: Date.now() };
            logDebug(`LicenseChecker: license key ${key ? 'set' : 'cleared'}`);
        }
    }

    /** 現在のライセンスキーを取得 */
    getLicenseKey(): string {
        return this.licenseKey;
    }

    // -------------------------------------------------------------------
    // リスナー
    // -------------------------------------------------------------------

    /** 変更リスナーを追加 */
    onChange(listener: LicenseChangeListener): void {
        this.listeners.push(listener);
    }

    // -------------------------------------------------------------------
    // 定期チェック
    // -------------------------------------------------------------------

    /** 定期チェックを開始（デフォルト: 24時間） */
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

    // -------------------------------------------------------------------
    // ライセンス検証
    // -------------------------------------------------------------------

    /**
     * ライセンスの有効性をチェック。
     * キャッシュが有効ならキャッシュを返す（force=true で強制再検証）。
     */
    async check(force: boolean = false): Promise<LicenseStatus> {
        // キー未設定 → トライアルまたは Free プラン
        if (!this.licenseKey) {
            // トライアル初期化（初回のみ記録）
            await this.initTrial();

            const trialRemaining = this.getTrialDaysRemaining();
            if (trialRemaining !== undefined && trialRemaining > 0) {
                // Proトライアル期間中 → Pro 機能有効
                const trialStatus: LicenseStatus = {
                    valid: true,
                    type: 'trial',
                    reason: 'trial_active',
                    checkedAt: Date.now(),
                };
                this.updateStatus(trialStatus);
                return trialStatus;
            }

            // トライアル期限切れ or globalState 未設定
            const freeStatus: LicenseStatus = {
                ...FREE_STATUS,
                reason: trialRemaining !== undefined ? 'trial_expired' : 'no_key',
                checkedAt: Date.now(),
            };
            this.updateStatus(freeStatus);
            return freeStatus;
        }

        // キャッシュチェック（force でなければ）
        if (!force && this.cachedStatus.reason !== 'no_key') {
            const age = Date.now() - this.cachedStatus.checkedAt;
            if (age < CACHE_TTL_MS) {
                return this.cachedStatus;
            }
        }

        try {
            const status = await this.validateWithLemonsqueezy();
            this.updateStatus(status);
            await this.persistCache(status, Date.now());
            logDebug(`LicenseChecker: check result — valid=${status.valid}, type=${status.type}, reason=${status.reason}`);
            return status;
        } catch (e) {
            logError('LicenseChecker: check failed', e);
            return this.handleOfflineGrace();
        }
    }

    /** 現在のキャッシュ済みステータスを取得（チェック無し） */
    getCachedStatus(): LicenseStatus {
        return this.cachedStatus;
    }

    /** Pro ライセンスかどうか（lifetime or trial で valid） */
    isPro(): boolean {
        const s = this.cachedStatus;
        return s.valid && (s.type === 'lifetime' || s.type === 'trial');
    }

    // -------------------------------------------------------------------
    // トライアル管理
    // -------------------------------------------------------------------

    /** トライアル開始日を記録（初回のみ） */
    private async initTrial(): Promise<void> {
        if (!this.globalState) return;
        const existing = this.globalState.get(GLOBAL_STATE_TRIAL_START) as number | undefined;
        if (!existing) {
            await this.globalState.update(GLOBAL_STATE_TRIAL_START, Date.now());
            logDebug('LicenseChecker: trial started');
        }
    }

    /** トライアル残り日数を取得（undefined = globalState 未設定） */
    getTrialDaysRemaining(): number | undefined {
        if (!this.globalState) return undefined;
        const startDate = this.globalState.get(GLOBAL_STATE_TRIAL_START) as number | undefined;
        if (!startDate) return undefined;
        const elapsed = Date.now() - startDate;
        const remaining = Math.ceil((TRIAL_DURATION_MS - elapsed) / (24 * 60 * 60 * 1000));
        return remaining;
    }

    /** トライアルが有効かどうか */
    isTrialActive(): boolean {
        const remaining = this.getTrialDaysRemaining();
        return remaining !== undefined && remaining > 0;
    }

    // -------------------------------------------------------------------
    // Lemonsqueezy API
    // -------------------------------------------------------------------

    /**
     * Lemonsqueezy の POST /v1/licenses/validate でキーを検証。
     */
    private async validateWithLemonsqueezy(): Promise<LicenseStatus> {
        const response = await fetch(`${LEMON_API_BASE}/v1/licenses/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ license_key: this.licenseKey }),
        });

        const data = await response.json() as {
            valid: boolean;
            error?: string;
            license_key?: {
                id: number;
                status: string;          // 'active' | 'inactive' | 'expired' | 'disabled'
                key: string;
                activation_limit: number;
                activation_usage: number;
                expires_at: string | null;
            };
            instance?: {
                id: string;
                name: string;
            };
            meta?: {
                store_id: number;
                product_id: number;
                product_name: string;
                variant_id: number;
                variant_name: string;
            };
        };

        if (!data.valid || !data.license_key) {
            return {
                valid: false,
                type: 'free',
                reason: data.license_key?.status === 'expired' ? 'expired' : 'invalid_key',
                checkedAt: Date.now(),
            };
        }

        // プランタイプは常に lifetime（月額プラン廃止済み）
        const type: LicenseType = 'lifetime';

        const expiresAt = data.license_key.expires_at
            ? new Date(data.license_key.expires_at).getTime()
            : undefined;

        return {
            valid: true,
            type,
            reason: 'active',
            expiresAt,
            checkedAt: Date.now(),
            instanceId: data.instance?.id,
        };
    }

    // -------------------------------------------------------------------
    // オフライン猶予期間
    // -------------------------------------------------------------------

    /**
     * ネットワークエラー時のオフライン猶予期間処理。
     * 最後のオンライン検証から3日以内ならキャッシュを有効とみなす。
     */
    private handleOfflineGrace(): LicenseStatus {
        const cache = this.getPersistedCache();
        if (cache && cache.status.valid) {
            const elapsed = Date.now() - cache.lastOnlineCheck;
            if (elapsed < OFFLINE_GRACE_PERIOD_MS) {
                logWarn(`LicenseChecker: offline grace period — ${Math.floor(elapsed / 3600000)}h elapsed`);
                const status: LicenseStatus = {
                    ...cache.status,
                    reason: 'offline_grace',
                    checkedAt: Date.now(),
                };
                this.updateStatus(status);
                return status;
            }
        }

        // 猶予期間超過 or キャッシュなし
        const status: LicenseStatus = {
            valid: false,
            type: 'free',
            reason: 'check_failed',
            checkedAt: Date.now(),
        };
        this.updateStatus(status);
        return status;
    }

    // -------------------------------------------------------------------
    // キャッシュ永続化
    // -------------------------------------------------------------------

    /** globalState からキャッシュを復元 */
    private restoreCache(): void {
        const cache = this.getPersistedCache();
        if (cache) {
            this.cachedStatus = cache.status;
            logDebug(`LicenseChecker: restored cache — valid=${cache.status.valid}, type=${cache.status.type}`);
        }
    }

    /** globalState からキャッシュを読み取り */
    private getPersistedCache(): LicenseCache | null {
        if (!this.globalState) return null;
        try {
            const raw = this.globalState.get(STATE_KEY);
            if (raw && typeof raw === 'object') {
                return raw as LicenseCache;
            }
        } catch { /* ignore */ }
        return null;
    }

    /** globalState にキャッシュを保存 */
    private async persistCache(status: LicenseStatus, lastOnlineCheck: number): Promise<void> {
        if (!this.globalState) return;
        try {
            await this.globalState.update(STATE_KEY, { status, lastOnlineCheck } as LicenseCache);
        } catch (e) {
            logWarn(`LicenseChecker: failed to persist cache: ${e}`);
        }
    }

    // -------------------------------------------------------------------
    // ステータス更新 & 通知
    // -------------------------------------------------------------------

    /** ステータスを更新し、変更があればリスナーに通知 */
    private updateStatus(status: LicenseStatus): void {
        const changed = this.cachedStatus.valid !== status.valid ||
            this.cachedStatus.type !== status.type ||
            this.cachedStatus.reason !== status.reason;

        this.cachedStatus = status;

        if (changed) {
            for (const listener of this.listeners) {
                try { listener(status); } catch { /* ignore */ }
            }
        }
    }

    // -------------------------------------------------------------------
    // クリーンアップ
    // -------------------------------------------------------------------

    /** クリーンアップ */
    dispose(): void {
        this.stopAutoCheck();
        this.listeners = [];
    }
}
