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
export const FREE_DAILY_TASK_LIMIT = 20;

/** 週のタスク実行上限（Free プラン） */
export const FREE_WEEKLY_TASK_LIMIT = 100;

/** 機能制限レベル */
export type GateLevel = 'pro' | 'free';

/**
 * Pro 限定の機能名（コマンド以外の機能ゲーティング用）。
 * スラッシュコマンドではなく、拡張内部の機能を制限する。
 */
export const PRO_ONLY_FEATURES: ReadonlySet<string> = new Set([
    'autoAccept',   // 自動承認（UIダイアログ自動クリック）
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

    constructor(checker: LicenseChecker) {
        this.checker = checker;
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
     * タスク実行が可能か（Free: 1日/週の上限あり、Pro: 無制限）
     * 現在未使用だが、将来のタスク制限実装用に保持。
     */
    canExecuteTask(dailyCount: number, weeklyCount: number): boolean {
        if (this.isPro()) return true;
        return dailyCount < FREE_DAILY_TASK_LIMIT && weeklyCount < FREE_WEEKLY_TASK_LIMIT;
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
