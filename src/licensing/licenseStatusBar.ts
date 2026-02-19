// ---------------------------------------------------------------------------
// src/licensing/licenseStatusBar.ts — ステータスバーにライセンス状態表示
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseStatus, LicenseType } from './licenseChecker';
import { logDebug } from '../logger';

export class LicenseStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private checker: LicenseChecker;

    constructor(checker: LicenseChecker) {
        this.checker = checker;
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            90,
        );
        this.statusBarItem.command = 'anti-crow.licenseInfo';

        // ライセンス変更時に更新
        this.checker.onChange((status) => this.update(status));

        // 初期表示
        this.update(this.checker.getCachedStatus());
        this.statusBarItem.show();
    }

    /** ステータスバーを更新 */
    private update(status: LicenseStatus | null): void {
        if (!status) {
            this.statusBarItem.text = '$(key) AntiCrow: 未認証';
            this.statusBarItem.tooltip = 'AntiCrow — ライセンス未確認\nクリックして詳細を表示';
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        if (status.valid) {
            const planName = this.getPlanName(status.type);
            const expiryText = status.expiresAt
                ? ` (${new Date(status.expiresAt).toLocaleDateString('ja-JP')} まで)`
                : '';

            this.statusBarItem.text = `$(check) AntiCrow: ${planName}`;
            this.statusBarItem.tooltip = `AntiCrow — ${planName}${expiryText}\nクリックして詳細を表示`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = '$(warning) AntiCrow: ライセンス無効';
            this.statusBarItem.tooltip = `AntiCrow — ライセンスが必要です\nクリックしてプランを確認`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                'statusBarItem.warningBackground',
            );
        }

        logDebug(`LicenseStatusBar: updated — valid=${status.valid}, type=${status.type}`);
    }

    /** プランタイプをユーザーフレンドリー名に変換 */
    private getPlanName(type: LicenseType | null): string {
        switch (type) {
            case 'monthly': return 'Monthly';
            case 'annual': return 'Annual';
            case 'lifetime': return 'Lifetime';
            case 'beta': return 'Beta';
            default: return 'Free';
        }
    }

    /** クリーンアップ */
    dispose(): void {
        this.statusBarItem.dispose();
    }
}
