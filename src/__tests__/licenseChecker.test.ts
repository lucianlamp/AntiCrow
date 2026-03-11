// ---------------------------------------------------------------------------
// src/__tests__/licenseChecker.test.ts — LicenseChecker トライアル機能テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LicenseChecker } from '../licensing/licenseChecker';
import type { LicenseStatus } from '../licensing/licenseChecker';

// ---------------------------------------------------------------------------
// 定数（ソースの private 定数を再定義）
// ---------------------------------------------------------------------------

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;    // 14日
const DAY_MS = 24 * 60 * 60 * 1000;
const GLOBAL_STATE_TRIAL_START = 'anticrow.trialStartDate';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** globalState のモックを生成 */
function createMockGlobalState(store: Record<string, unknown> = {}) {
    return {
        get: vi.fn((key: string) => store[key]),
        update: vi.fn(async (key: string, value: unknown) => { store[key] = value; }),
    };
}

// ---------------------------------------------------------------------------
// logger のモック
// ---------------------------------------------------------------------------

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    initLogger: vi.fn(),
}));

// ---------------------------------------------------------------------------
// fetch のモック（Lemonsqueezy API）
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('LicenseChecker — トライアル機能', () => {
    let checker: LicenseChecker;
    const BASE_TIME = new Date('2026-02-21T00:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        checker = new LicenseChecker();
        mockFetch.mockReset();
    });

    afterEach(() => {
        checker.dispose();
        vi.useRealTimers();
    });

    // ===================================================================
    // initTrial — setGlobalState 経由でテスト
    // ===================================================================

    describe('initTrial（setGlobalState 経由）', () => {
        it('globalState 未設定時、トライアル開始日を記録する', async () => {
            const store: Record<string, unknown> = {};
            const gs = createMockGlobalState(store);

            checker.setGlobalState(gs);

            // setGlobalState 内で initTrial が呼ばれる（非同期）
            // 少し待ってから確認
            await vi.advanceTimersByTimeAsync(10);

            expect(gs.update).toHaveBeenCalledWith(GLOBAL_STATE_TRIAL_START, BASE_TIME);
            expect(store[GLOBAL_STATE_TRIAL_START]).toBe(BASE_TIME);
        });

        it('既にトライアル開始日が存在する場合、上書きしない', async () => {
            const existingStart = BASE_TIME - 5 * DAY_MS;
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: existingStart,
            };
            const gs = createMockGlobalState(store);

            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            // update が GLOBAL_STATE_TRIAL_START で呼ばれていないこと
            const trialCalls = gs.update.mock.calls.filter(
                (call: unknown[]) => call[0] === GLOBAL_STATE_TRIAL_START,
            );
            expect(trialCalls).toHaveLength(0);
            expect(store[GLOBAL_STATE_TRIAL_START]).toBe(existingStart);
        });

        it('globalState が null の場合、何もしない', () => {
            // setGlobalState を呼ばない場合 = globalState は null
            const remaining = checker.getTrialDaysRemaining();
            expect(remaining).toBeUndefined();
        });
    });

    // ===================================================================
    // getTrialDaysRemaining
    // ===================================================================

    describe('getTrialDaysRemaining', () => {
        it('globalState 未設定 → undefined を返す', () => {
            expect(checker.getTrialDaysRemaining()).toBeUndefined();
        });

        it('トライアル開始日未設定 → undefined を返す', () => {
            const gs = createMockGlobalState({});
            checker.setGlobalState(gs);
            // initTrial は非同期なので、まだ記録されていない状態は get が undefined を返す
            // ただし setGlobalState で initTrial が呼ばれるので、直前に get を差し替え
            // → 開始日なしの状態をテスト
            const gs2 = createMockGlobalState({});
            gs2.get.mockReturnValue(undefined);
            checker.setGlobalState(gs2);
            // getTrialDaysRemaining は同期メソッドで globalState.get を呼ぶ
            gs2.get.mockReturnValue(undefined);
            expect(checker.getTrialDaysRemaining()).toBeUndefined();
        });

        it('開始直後 → 14 を返す', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.getTrialDaysRemaining()).toBe(14);
        });

        it('7日経過 → 7 を返す', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 7 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.getTrialDaysRemaining()).toBe(7);
        });

        it('13日と1時間経過 → 1 を返す（Math.ceil で繰り上げ）', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - (13 * DAY_MS + 1 * 60 * 60 * 1000),
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.getTrialDaysRemaining()).toBe(1);
        });

        it('14日経過 → 0 を返す', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 14 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.getTrialDaysRemaining()).toBeLessThanOrEqual(0);
        });

        it('15日経過 → 負の値を返す', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 15 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.getTrialDaysRemaining()).toBeLessThan(0);
        });
    });

    // ===================================================================
    // isTrialActive
    // ===================================================================

    describe('isTrialActive', () => {
        it('開始直後 → true', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.isTrialActive()).toBe(true);
        });

        it('13日目 → true', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 13 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.isTrialActive()).toBe(true);
        });

        it('15日後 → false', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 15 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            expect(checker.isTrialActive()).toBe(false);
        });

        it('globalState 未設定 → false', () => {
            expect(checker.isTrialActive()).toBe(false);
        });
    });

    // ===================================================================
    // check() — トライアル分岐
    // ===================================================================

    describe('check() — トライアル分岐', () => {
        it('キーなし + トライアル中 → trial_active', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            const status = await checker.check();

            expect(status.valid).toBe(true);
            expect(status.type).toBe('trial');
            expect(status.reason).toBe('trial_active');
        });

        it('キーなし + トライアル期限切れ → trial_expired', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 15 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            const status = await checker.check();

            expect(status.valid).toBe(true);  // FREE_STATUS.valid は true
            expect(status.type).toBe('free');
            expect(status.reason).toBe('trial_expired');
        });

        it('キーなし + globalState 未設定 → no_key', async () => {
            // globalState を設定しない
            const status = await checker.check();

            expect(status.valid).toBe(true); // FREE_STATUS.valid は true
            expect(status.type).toBe('free');
            expect(status.reason).toBe('no_key');
        });

        it('キーなし + トライアル7日目 → trial_active（残り7日）', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 7 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            const status = await checker.check();

            expect(status.valid).toBe(true);
            expect(status.type).toBe('trial');
            expect(status.reason).toBe('trial_active');
        });

        it('キーなし + トライアル14日ちょうど → trial_expired', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 14 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            const status = await checker.check();

            expect(status.valid).toBe(true);  // FREE_STATUS.valid は true
            expect(status.type).toBe('free');
            expect(status.reason).toBe('trial_expired');
        });

        it('check() で initTrial が呼ばれトライアルが初期化される', async () => {
            const store: Record<string, unknown> = {};
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            // setGlobalState で initTrial → store にトライアル開始日が記録される
            expect(store[GLOBAL_STATE_TRIAL_START]).toBe(BASE_TIME);

            // check() を呼ぶと initTrial が再度呼ばれるが、既存のため上書きされない
            const status = await checker.check();
            expect(status.type).toBe('trial');
            expect(status.reason).toBe('trial_active');
        });
    });

    // ===================================================================
    // isPro() — トライアル対応
    // ===================================================================

    describe('isPro() — トライアル対応', () => {
        it('トライアル中 → true', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            await checker.check();
            expect(checker.isPro()).toBe(true);
        });

        it('トライアル期限切れ → false', async () => {
            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME - 15 * DAY_MS,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            await checker.check();
            expect(checker.isPro()).toBe(false);
        });

        it('初期状態（Free プラン）→ false', () => {
            expect(checker.isPro()).toBe(false);
        });

        it('有効なライセンスキー（lifetime）→ true', async () => {
            // Lemonsqueezy API のモック
            mockFetch.mockResolvedValueOnce({
                json: async () => ({
                    valid: true,
                    license_key: {
                        id: 1,
                        status: 'active',
                        key: 'test-key',
                        activation_limit: 5,
                        activation_usage: 1,
                        expires_at: null,
                    },
                    meta: {
                        store_id: 1,
                        product_id: 1,
                        product_name: 'Anti-Crow',
                        variant_id: 1,
                        variant_name: 'Lifetime',
                    },
                }),
            });

            checker.setLicenseKey('test-key-123');
            const status = await checker.check(true);

            expect(status.valid).toBe(true);
            expect(status.type).toBe('lifetime');
            expect(checker.isPro()).toBe(true);
        });
    });

    // ===================================================================
    // ステータス変更リスナー
    // ===================================================================

    describe('ステータス変更リスナー', () => {
        it('トライアル開始でリスナーが呼ばれる', async () => {
            const listener = vi.fn();
            checker.onChange(listener);

            const store: Record<string, unknown> = {
                [GLOBAL_STATE_TRIAL_START]: BASE_TIME,
            };
            const gs = createMockGlobalState(store);
            checker.setGlobalState(gs);
            await vi.advanceTimersByTimeAsync(10);

            await checker.check();

            expect(listener).toHaveBeenCalled();
            const lastCall = listener.mock.calls[listener.mock.calls.length - 1][0] as LicenseStatus;
            expect(lastCall.type).toBe('trial');
            expect(lastCall.reason).toBe('trial_active');
        });
    });
});

// =====================================================================
// Lemonsqueezy API レスポンスハンドリング
// =====================================================================

describe('LicenseChecker — Lemonsqueezy API レスポンスハンドリング', () => {
    let checker: LicenseChecker;
    const BASE_TIME = new Date('2026-02-21T00:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        checker = new LicenseChecker();
        mockFetch.mockReset();
    });

    afterEach(() => {
        checker.dispose();
        vi.useRealTimers();
    });

    it('valid: true + active ライセンス → lifetime/active', async () => {
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('test-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(true);
        expect(s.type).toBe('lifetime');
        expect(s.reason).toBe('active');
    });

    it('valid: false + expired ステータス → expired', async () => {
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: false,
                license_key: {
                    id: 1, status: 'expired', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: '2026-01-01T00:00:00Z',
                },
            }),
        });

        checker.setLicenseKey('expired-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(false);
        expect(s.type).toBe('free');
        expect(s.reason).toBe('expired');
    });

    it('valid: false + disabled ステータス → invalid_key', async () => {
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: false,
                license_key: {
                    id: 1, status: 'disabled', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
            }),
        });

        checker.setLicenseKey('disabled-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(false);
        expect(s.reason).toBe('invalid_key');
    });

    it('valid: false + license_key なし → invalid_key', async () => {
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: false,
                error: 'The license key was not found.',
            }),
        });

        checker.setLicenseKey('nonexistent-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(false);
        expect(s.reason).toBe('invalid_key');
    });

    it('fetch が例外を投げる → check_failed（キャッシュなし）', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        checker.setLicenseKey('some-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(false);
        expect(s.reason).toBe('check_failed');
    });

    it('expires_at が設定されている場合、expiresAt がパースされる', async () => {
        const expiry = '2027-01-01T00:00:00Z';
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: expiry,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('expiry-key');
        const s = await checker.check(true);
        expect(s.valid).toBe(true);
        expect(s.expiresAt).toBe(new Date(expiry).getTime());
    });

    it('instance ID がレスポンスに含まれる場合、instanceId が設定される', async () => {
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                instance: { id: 'inst-abc-123', name: 'test' },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('instance-key');
        const s = await checker.check(true);
        expect(s.instanceId).toBe('inst-abc-123');
    });
});

// =====================================================================
// オフライン猶予期間（3日間）
// =====================================================================

describe('LicenseChecker — オフライン猶予期間', () => {
    let checker: LicenseChecker;
    const BASE_TIME = new Date('2026-02-21T00:00:00Z').getTime();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const STATE_KEY = 'antiCrow.licenseCache';

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        checker = new LicenseChecker();
        mockFetch.mockReset();
    });

    afterEach(() => {
        checker.dispose();
        vi.useRealTimers();
    });

    it('オフライン + キャッシュあり + 1日以内 → offline_grace（有効維持）', async () => {
        // キャッシュに有効なライセンスが残っている状態をシミュレート
        const cachedData = {
            status: {
                valid: true, type: 'lifetime', reason: 'active',
                checkedAt: BASE_TIME - 1 * 60 * 60 * 1000, // 1時間前
            },
            lastOnlineCheck: BASE_TIME - 12 * 60 * 60 * 1000, // 12時間前
        };
        const store: Record<string, unknown> = { [STATE_KEY]: cachedData };
        const gs = createMockGlobalState(store);
        checker.setGlobalState(gs);

        // fetch が失敗（オフライン）
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        checker.setLicenseKey('cached-key');
        // キャッシュ TTL を超過させるため force=true
        const s = await checker.check(true);

        expect(s.valid).toBe(true);
        expect(s.reason).toBe('offline_grace');
    });

    it('オフライン + キャッシュあり + 3日超過 → check_failed（無効化）', async () => {
        const cachedData = {
            status: {
                valid: true, type: 'lifetime', reason: 'active',
                checkedAt: BASE_TIME - 4 * DAY_MS,
            },
            lastOnlineCheck: BASE_TIME - 4 * DAY_MS, // 4日前（猶予期間超過）
        };
        const store: Record<string, unknown> = { [STATE_KEY]: cachedData };
        const gs = createMockGlobalState(store);
        checker.setGlobalState(gs);

        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        checker.setLicenseKey('expired-cache-key');
        const s = await checker.check(true);

        expect(s.valid).toBe(false);
        expect(s.reason).toBe('check_failed');
    });

    it('オフライン + キャッシュなし → check_failed', async () => {
        // globalState なし（キャッシュなし）
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        checker.setLicenseKey('no-cache-key');
        const s = await checker.check(true);

        expect(s.valid).toBe(false);
        expect(s.reason).toBe('check_failed');
    });

    it('オフライン + キャッシュあり + 2日59時間 → offline_grace（ギリギリ有効）', async () => {
        const almostExpired = BASE_TIME - (3 * DAY_MS - 1 * 60 * 60 * 1000); // 2日23時間前
        const cachedData = {
            status: {
                valid: true, type: 'lifetime', reason: 'active',
                checkedAt: almostExpired,
            },
            lastOnlineCheck: almostExpired,
        };
        const store: Record<string, unknown> = { [STATE_KEY]: cachedData };
        const gs = createMockGlobalState(store);
        checker.setGlobalState(gs);

        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        checker.setLicenseKey('almost-expired-key');
        const s = await checker.check(true);

        expect(s.valid).toBe(true);
        expect(s.reason).toBe('offline_grace');
    });
});

// =====================================================================
// キャッシュ TTL（5分）
// =====================================================================

describe('LicenseChecker — キャッシュ TTL', () => {
    let checker: LicenseChecker;
    const BASE_TIME = new Date('2026-02-21T00:00:00Z').getTime();
    const CACHE_TTL = 5 * 60 * 1000; // 5分

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        checker = new LicenseChecker();
        mockFetch.mockReset();
    });

    afterEach(() => {
        checker.dispose();
        vi.useRealTimers();
    });

    it('TTL 以内の2回目チェック → API を呼ばずキャッシュを返す', async () => {
        // 1回目: API呼び出し
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('ttl-test-key');
        const s1 = await checker.check(true); // force=true で初回チェック
        expect(s1.valid).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // 2回目: 3分後（TTL 以内）→ API 呼ばない
        vi.advanceTimersByTime(3 * 60 * 1000);
        const s2 = await checker.check(); // force=false
        expect(s2.valid).toBe(true);
        expect(s2.type).toBe('lifetime');
        expect(mockFetch).toHaveBeenCalledTimes(1); // 追加呼び出しなし
    });

    it('TTL 超過後の2回目チェック → API を再呼び出し', async () => {
        // 1回目
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('ttl-test-key-2');
        await checker.check(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // 2回目: 6分後（TTL 超過）→ API 再呼び出し
        vi.advanceTimersByTime(6 * 60 * 1000);

        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        await checker.check(); // force=false だが TTL 超過なので API 呼び出し
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('force=true → TTL 以内でも API を呼び出す', async () => {
        // 1回目
        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        checker.setLicenseKey('force-test-key');
        await checker.check(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // 2回目: 1分後 + force=true → API 呼び出し
        vi.advanceTimersByTime(1 * 60 * 1000);

        mockFetch.mockResolvedValueOnce({
            json: async () => ({
                valid: true,
                license_key: {
                    id: 1, status: 'active', key: 'k',
                    activation_limit: 5, activation_usage: 1, expires_at: null,
                },
                meta: { store_id: 1, product_id: 1, product_name: 'Anti-Crow', variant_id: 1, variant_name: 'Lifetime' },
            }),
        });

        await checker.check(true); // force=true
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
