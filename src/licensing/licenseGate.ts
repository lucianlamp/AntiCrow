// ---------------------------------------------------------------------------
// src/licensing/licenseGate.ts — ライセンスによる機能制限ロジック
// ---------------------------------------------------------------------------
// 責務:
//   1. ライセンス状態に基づく機能ゲーティング（Free vs Pro）
//   2. 無効時のユーザー通知
//   3. テンプレート・ワークスペース等のリソース制限
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseStatus } from './licenseChecker';
import { logInfo, logWarn } from '../logger';

// -----------------------------------------------------------------------
// Free プランの制限値
// -----------------------------------------------------------------------

/** ワークスペース数上限（Free プラン） */
export const FREE_WORKSPACE_LIMIT = 1;

/** 1日のタスク実行上限（Free プラン） */
export const FREE_DAILY_TASK_LIMIT = 20;

/** 週のタスク実行上限（Free プラン） */
export const FREE_WEEKLY_TASK_LIMIT = 100;

/** 機能制限レベル */
export type GateLevel = 'pro' | 'free';

/**
 * Pro 限定のスラッシュコマンド名。
 * これらのコマンドはライセンスが Pro でないと使えない。
 */
export const PRO_ONLY_COMMANDS: ReadonlySet<string> = new Set([
    // 現在は全コマンド Free で利用可能
    // 'workspaces' は Free でも1個まで使える
]);

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
    private lastNotifiedAt: number = 0;
    private readonly NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;  // 1時間
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

    /** タスク実行が可能か（Free: 1日/週の上限あり、Pro: 無制限） */
    canExecuteTask(dailyCount: number, weeklyCount: number): boolean {
        if (this.isPro()) return true;
        return dailyCount < FREE_DAILY_TASK_LIMIT && weeklyCount < FREE_WEEKLY_TASK_LIMIT;
    }

    /** ワークスペース追加が可能か（Free: 上限あり、Pro: 無制限） */
    canAddWorkspace(currentCount: number): boolean {
        if (this.isPro()) return true;
        return currentCount < FREE_WORKSPACE_LIMIT;
    }

    /** コマンドが実行可能か（Pro 限定コマンドのチェック） */
    isCommandAllowed(commandName: string): boolean {
        if (this.isPro()) return true;
        return !PRO_ONLY_COMMANDS.has(commandName);
    }

    /** 機能が利用可能か（Pro 限定機能のチェック） */
    isFeatureAllowed(featureName: string): boolean {
        if (this.isPro()) return true;
        return !PRO_ONLY_FEATURES.has(featureName);
    }

    // -------------------------------------------------------------------
    // ゲートキーピング
    // -------------------------------------------------------------------

    /**
     * 操作を実行する前のゲートチェック（VS Code 内通知版）。
     * ライセンスが不十分なら false を返し、ユーザーに通知する。
     */
    async canProceed(action: string): Promise<boolean> {
        if (this.isPro()) return true;

        // Free プランの場合、基本操作は許可
        const status = this.checker.getCachedStatus();
        if (status.type === 'free' && status.reason === 'no_key') {
            // キー未設定の Free ユーザーも基本操作は利用可能
            return true;
        }

        // 期限切れ等で blocking
        if (!status.valid && status.reason !== 'no_key') {
            return this.showUpgradeNotification(action, status);
        }

        return true;
    }

    /**
     * Pro 限定操作のゲートチェック。
     * Free プランでは常にブロック。
     */
    async requirePro(action: string): Promise<boolean> {
        if (this.isPro()) return true;
        return this.showUpgradeNotification(action, this.checker.getCachedStatus());
    }

    // -------------------------------------------------------------------
    // 通知
    // -------------------------------------------------------------------

    /** アップグレード通知を表示（クールダウンあり） */
    private async showUpgradeNotification(action: string, status: LicenseStatus): Promise<boolean> {
        const now = Date.now();
        if (now - this.lastNotifiedAt < this.NOTIFICATION_COOLDOWN_MS) {
            logWarn(`LicenseGate: blocked action "${action}" (notification suppressed)`);
            return false;
        }

        this.lastNotifiedAt = now;
        logWarn(`LicenseGate: blocked action "${action}" — reason: ${status.reason}`);

        const selection = await vscode.window.showWarningMessage(
            `AntiCrow: この機能には Pro ライセンスが必要です（${action}）`,
            'Pro にアップグレード',
            '後で',
        );

        if (selection === 'Pro にアップグレード') {
            vscode.env.openExternal(vscode.Uri.parse(PURCHASE_URL));
        }

        return false;
    }

    /** 購入ページ URL を取得 */
    getPurchaseUrl(): string {
        return PURCHASE_URL;
    }
}
