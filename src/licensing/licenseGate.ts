// ---------------------------------------------------------------------------
// src/licensing/licenseGate.ts — ライセンスによる機能制限ロジック
// ---------------------------------------------------------------------------
// 責務:
//   1. ライセンス状態に基づく機能ゲーティング（Free vs Pro）
//   2. テンプレート・ワークスペース等のリソース制限
// ---------------------------------------------------------------------------

import { LicenseChecker } from './licenseChecker';
import { logInfo } from '../logger';

// -----------------------------------------------------------------------
// Free プランの制限値
// -----------------------------------------------------------------------

/** 1日のタスク実行上限（Free プラン） */
export const FREE_DAILY_TASK_LIMIT = 10;

/** 週のタスク実行上限（Free プラン） */
export const FREE_WEEKLY_TASK_LIMIT = 50;

/** 機能制限レベル */
export type GateLevel = 'pro' | 'free';

/**
 * Pro 限定の機能名（コマンド以外の機能ゲーティング用）。
 * スラッシュコマンドではなく、拡張内部の機能を制限する。
 */
export const PRO_ONLY_FEATURES: ReadonlySet<string> = new Set([
    'autoAccept',   // 自動承認（UIダイアログ自動クリック）
    'teamMode',     // チームモード（複数サブエージェント並行実行）
    'autoMode',     // オートモード（自律連続タスク実行）
    // suggestions は Free でも利用可能
]);

// -----------------------------------------------------------------------
// Lemonsqueezy URL
// -----------------------------------------------------------------------

/** 購入ページ URL（.env で設定可能） */
export const PURCHASE_URL = process.env.PURCHASE_URL || 'https://anti-crow.lemonsqueezy.com';

/** Monthly プラン専用チェックアウト URL（.env で設定可能、未設定時は PURCHASE_URL） */
export const PURCHASE_URL_MONTHLY = process.env.PURCHASE_URL_MONTHLY || PURCHASE_URL;

/** Lifetime プラン専用チェックアウト URL（.env で設定可能、未設定時は PURCHASE_URL） */
export const PURCHASE_URL_LIFETIME = process.env.PURCHASE_URL_LIFETIME || PURCHASE_URL;

export class LicenseGate {
    private checker: LicenseChecker;
    private developerOverride: boolean = false;
    private globalState: { get: (key: string) => unknown; update: (key: string, value: unknown) => Thenable<void> } | null = null;

    constructor(checker: LicenseChecker) {
        this.checker = checker;
    }

    /** globalState を設定（タスクカウンター永続化用） */
    setGlobalState(state: { get: (key: string) => unknown; update: (key: string, value: unknown) => Thenable<void> }): void {
        this.globalState = state;
    }

    /**
     * 開発者オーバーライドを設定する。
     * true にすると isPro() が常に true を返し、全ゲートがバイパスされる。
     */
    setDeveloperOverride(isDev: boolean): void {
        this.developerOverride = isDev;
    }

    // -------------------------------------------------------------------
    // ゲートレベル
    // -------------------------------------------------------------------

    /**
     * 現在のライセンス状態に基づくゲートレベルを取得。
     * - pro: 全機能利用可能（有効な月額/買い切りライセンス）
     * - free: 基本機能のみ（ライセンスなし）
     */
    getGateLevel(): GateLevel {
        return this.checker.isPro() ? 'pro' : 'free';
    }

    /** Pro レベルかどうか（開発者オーバーライド時は常に true） */
    isPro(): boolean {
        if (this.developerOverride) return true;
        return this.checker.isPro();
    }

    // -------------------------------------------------------------------
    // リソース制限チェック
    // -------------------------------------------------------------------

    /** テンプレート保存が可能か（Free/Pro ともに無制限） */
    canSaveTemplate(_currentCount: number): boolean {
        return true;
    }

    /**
     * タスク実行が可能か（Free: 1日/週の上限あり、Pro: 無制限）。
     * 内部でカウンターを自動取得する。
     */
    canExecuteTask(): boolean {
        if (this.isPro()) return true;
        const counts = this.getTaskCounts();
        return counts.daily < FREE_DAILY_TASK_LIMIT && counts.weekly < FREE_WEEKLY_TASK_LIMIT;
    }

    /**
     * 日次/週次どちらの上限に達しているかを返す。
     * 'daily' | 'weekly' | null
     */
    getExceededLimit(): 'daily' | 'weekly' | null {
        if (this.isPro()) return null;
        const counts = this.getTaskCounts();
        if (counts.daily >= FREE_DAILY_TASK_LIMIT) return 'daily';
        if (counts.weekly >= FREE_WEEKLY_TASK_LIMIT) return 'weekly';
        return null;
    }

    /**
     * タスク実行カウントを +1 する。
     * canExecuteTask() が true の場合にのみ呼ぶこと。
     */
    async incrementTaskCount(): Promise<void> {
        if (!this.globalState) return;
        const counts = this.getTaskCounts();
        counts.daily++;
        counts.weekly++;
        await this.globalState.update('antiCrow.taskCounts', {
            daily: counts.daily,
            weekly: counts.weekly,
            dailyDate: this.getTodayJST(),
            weekStart: this.getWeekStartJST(),
        });
    }

    /**
     * 現在の日次/週次カウントを取得（リセット判定含む）。
     */
    getTaskCounts(): { daily: number; weekly: number } {
        if (!this.globalState) return { daily: 0, weekly: 0 };
        const raw = this.globalState.get('antiCrow.taskCounts') as {
            daily?: number;
            weekly?: number;
            dailyDate?: string;
            weekStart?: string;
        } | undefined;

        if (!raw) return { daily: 0, weekly: 0 };

        const todayJST = this.getTodayJST();
        const weekStartJST = this.getWeekStartJST();

        // 日次リセット: JST の日付が変わったらリセット
        const daily = raw.dailyDate === todayJST ? (raw.daily ?? 0) : 0;
        // 週次リセット: JST の月曜日が変わったらリセット
        const weekly = raw.weekStart === weekStartJST ? (raw.weekly ?? 0) : 0;

        return { daily, weekly };
    }

    /** JST の今日の日付を YYYY-MM-DD で返す */
    private getTodayJST(): string {
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        return jst.toISOString().split('T')[0];
    }

    /** JST の今週月曜日の日付を YYYY-MM-DD で返す */
    private getWeekStartJST(): string {
        const now = new Date();
        const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const day = jst.getUTCDay(); // 0=Sun, 1=Mon, ...
        const diff = day === 0 ? 6 : day - 1; // 月曜からの差分
        jst.setUTCDate(jst.getUTCDate() - diff);
        return jst.toISOString().split('T')[0];
    }

    /** ワークスペース追加が可能か（Free/Pro ともに無制限） */
    canAddWorkspace(_currentCount: number): boolean {
        return true;
    }

    /** 機能が利用可能か（Pro 限定機能のチェック） */
    isFeatureAllowed(featureName: string): boolean {
        if (this.isPro()) return true;
        return !PRO_ONLY_FEATURES.has(featureName);
    }

    /** 購入ページ URL を取得 */
    getPurchaseUrl(): string {
        return PURCHASE_URL;
    }
}

