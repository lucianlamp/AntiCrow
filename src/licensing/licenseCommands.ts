// ---------------------------------------------------------------------------
// src/licensing/licenseCommands.ts — ライセンス管理用 VS Code コマンド
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseType } from './licenseChecker';
import { PURCHASE_URL } from './licenseGate';
import { openLicenseWebview } from './licenseWebview';
import { logDebug, logError } from '../logger';

/**
 * ライセンス関連の VS Code コマンドを登録する。
 */
export function registerLicenseCommands(
    context: vscode.ExtensionContext,
    checker: LicenseChecker,
): void {
    // ライセンス情報表示
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licenseInfo', async () => {
            try {
                const status = await checker.check(true);

                if (status.valid && status.type !== 'free') {
                    const planName = getPlanDisplayName(status.type);
                    const expiryText = status.expiresAt
                        ? `\n有効期限: ${new Date(status.expiresAt).toLocaleDateString('ja-JP')}`
                        : '';

                    await vscode.window.showInformationMessage(
                        `AntiCrow ライセンス: ${planName}${expiryText}`,
                        'OK',
                    );
                } else {
                    const selection = await vscode.window.showWarningMessage(
                        `AntiCrow: ${getReasonText(status.reason)}\n月額$5/買い切り$50 で全機能が使えます！`,
                        'Pro にアップグレード',
                        'ライセンスキーを入力',
                        'キャンセル',
                    );

                    if (selection === 'Pro にアップグレード') {
                        openLicenseWebview(context, checker);
                    } else if (selection === 'ライセンスキーを入力') {
                        vscode.commands.executeCommand('anti-crow.setLicenseKey');
                    }
                }
            } catch (e) {
                logError('licenseInfo command error', e);
                vscode.window.showErrorMessage('ライセンス情報の取得に失敗しました');
            }
        }),
    );

    // ライセンスキー入力
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.setLicenseKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Lemonsqueezy のライセンスキーを入力してください',
                placeHolder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
                password: false,
                ignoreFocusOut: true,
            });

            if (!key) return;

            // SecretStorage に保存
            await context.secrets.store('license-key', key.trim());

            // 設定にもフラグを立てる（SecretStorage は同期されないため存在フラグのみ）
            await vscode.workspace.getConfiguration('antiCrow')
                .update('licenseKey', true, vscode.ConfigurationTarget.Global);

            checker.setLicenseKey(key.trim());
            logDebug('License: key set');

            // 即座に検証
            const status = await checker.check(true);
            if (status.valid && status.type !== 'free') {
                vscode.window.showInformationMessage(
                    `✅ AntiCrow: ライセンス認証成功！ プラン: ${getPlanDisplayName(status.type)}`,
                );
                checker.startAutoCheck();
            } else {
                const selection = await vscode.window.showWarningMessage(
                    `AntiCrow: ライセンスキーが無効です。正しいキーを入力してください。`,
                    '購入ページを開く',
                    'キャンセル',
                );
                if (selection === '購入ページを開く') {
                    openLicenseWebview(context, checker);
                }
            }
        }),
    );

    // 購入・ライセンス認証 WebView を開く
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licensePurchase', () => {
            openLicenseWebview(context, checker);
        }),
    );

    // ライセンスキー削除（ログアウト）
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licenseLogout', async () => {
            await context.secrets.delete('license-key');
            await vscode.workspace.getConfiguration('antiCrow')
                .update('licenseKey', undefined, vscode.ConfigurationTarget.Global);
            checker.setLicenseKey('');
            await checker.check(true);
            logDebug('License: key removed');
            vscode.window.showInformationMessage('AntiCrow: ライセンスキーを削除しました（Free プランに戻りました）');
        }),
    );
}

function getPlanDisplayName(type: LicenseType | null): string {
    switch (type) {
        case 'monthly': return 'Pro（月額 $5）';
        case 'lifetime': return 'Pro（永久ライセンス）';
        case 'free': return 'Free';
        default: return 'Free';
    }
}

function getReasonText(reason: string): string {
    switch (reason) {
        case 'no_key': return '現在 Free プランです';
        case 'expired': return 'ライセンスの期限が切れました';
        case 'invalid_key': return 'ライセンスキーが無効です';
        case 'check_failed': return 'ライセンス確認に失敗しました';
        case 'offline_grace': return 'オフライン猶予期間中です';
        default: return reason;
    }
}
