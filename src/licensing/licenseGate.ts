// ---------------------------------------------------------------------------
// src/licensing/licenseGate.ts — ライセンスによる機能制限ロジック
// ---------------------------------------------------------------------------
// 責務:
//   1. ライセンス状態に基づく機能ゲーティング
//   2. 無効時のユーザー通知
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseStatus } from './licenseChecker';
import { logInfo, logWarn } from '../logger';

/** 機能制限レベル */
export type GateLevel = 'full' | 'limited' | 'blocked';

export class LicenseGate {
    private checker: LicenseChecker;
    private lastNotifiedAt: number = 0;
    private readonly NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;  // 1時間

    constructor(checker: LicenseChecker) {
        this.checker = checker;
    }

    /**
     * 現在のライセンス状態に基づくゲートレベルを取得。
     *
     * - full: 全機能利用可能（有効なライセンスあり）
     * - limited: 一部機能制限（トライアル期間中など）
     * - blocked: 機能利用不可（ライセンスなし/期限切れ）
     */
    getGateLevel(): GateLevel {
        const status = this.checker.getCachedStatus();

        if (!status) return 'blocked';
        if (!status.valid) return 'blocked';

        // トライアル中は limited
        if (status.reason === 'trialing') return 'limited';

        // ベータアクセスも limited
        if (status.type === 'beta') return 'limited';

        return 'full';
    }

    /**
     * 操作を実行する前のゲートチェック。
     * ライセンスが無効なら false を返し、ユーザーに通知する。
     */
    async canProceed(action: string): Promise<boolean> {
        const status = await this.checker.check();

        if (status.valid) return true;

        // クールダウン中は通知しない
        const now = Date.now();
        if (now - this.lastNotifiedAt < this.NOTIFICATION_COOLDOWN_MS) {
            logWarn(`LicenseGate: blocked action "${action}" (notification suppressed)`);
            return false;
        }

        this.lastNotifiedAt = now;
        logWarn(`LicenseGate: blocked action "${action}" — reason: ${status.reason}`);

        const selection = await vscode.window.showWarningMessage(
            `AntiCrow: ライセンスが必要です（${this.getReasonText(status)}）`,
            'プランを確認',
            '後で',
        );

        if (selection === 'プランを確認') {
            vscode.env.openExternal(vscode.Uri.parse(this.getPurchaseUrl()));
        }

        return false;
    }

    /** 理由テキストをユーザーフレンドリーに変換 */
    private getReasonText(status: LicenseStatus): string {
        switch (status.reason) {
            case 'not_authenticated': return '認証が必要です';
            case 'user_not_found': return 'ユーザーが見つかりません';
            case 'no_active_license': return '有効なライセンスがありません';
            case 'check_failed': return 'ライセンス確認に失敗しました';
            default: return status.reason;
        }
    }

    /** 購入ページ URL */
    private getPurchaseUrl(): string {
        // TODO: 実際の購入ページ URL に置き換え
        return 'https://anti-crow.dev/pricing';
    }
}
