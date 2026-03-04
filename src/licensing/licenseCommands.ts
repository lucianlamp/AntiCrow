// ---------------------------------------------------------------------------
// src/licensing/licenseCommands.ts — ライセンス管理用 VS Code コマンド
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseType } from './licenseChecker';
import { PURCHASE_URL } from './licenseGate';
import { openLicenseWebview } from './licenseWebview';
import { logDebug, logError } from '../logger';
import { t } from '../i18n';

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
                        ? t('license.info.expiry', new Date(status.expiresAt).toLocaleDateString('ja-JP'))
                        : '';

                    await vscode.window.showInformationMessage(
                        t('license.info.message', planName, expiryText),
                        'OK',
                    );
                } else {
                    const selection = await vscode.window.showWarningMessage(
                        t('license.info.freeWarning', getReasonText(status.reason)),
                        t('license.info.upgrade'),
                        t('license.info.inputKey'),
                        t('license.info.cancel'),
                    );

                    if (selection === t('license.info.upgrade')) {
                        openLicenseWebview(context, checker);
                    } else if (selection === t('license.info.inputKey')) {
                        vscode.commands.executeCommand('anti-crow.setLicenseKey');
                    }
                }
            } catch (e) {
                logError('licenseInfo command error', e);
                vscode.window.showErrorMessage(t('license.info.fetchError'));
            }
        }),
    );

    // ライセンスキー入力
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.setLicenseKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: t('license.key.prompt'),
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
                    t('license.key.success', getPlanDisplayName(status.type)),
                );
                checker.startAutoCheck();
            } else {
                const selection = await vscode.window.showWarningMessage(
                    t('license.key.invalid'),
                    t('license.key.openPurchase'),
                    t('license.info.cancel'),
                );
                if (selection === t('license.key.openPurchase')) {
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
            vscode.window.showInformationMessage(t('license.logout'));
        }),
    );
}

function getPlanDisplayName(type: LicenseType | null): string {
    switch (type) {
        case 'monthly': return t('license.plan.monthly');
        case 'lifetime': return t('license.plan.lifetime');
        case 'free': return t('license.plan.free');
        default: return t('license.plan.free');
    }
}

function getReasonText(reason: string): string {
    switch (reason) {
        case 'no_key': return t('license.reason.noKey');
        case 'expired': return t('license.reason.expired');
        case 'invalid_key': return t('license.reason.invalidKey');
        case 'check_failed': return t('license.reason.checkFailed');
        case 'offline_grace': return t('license.reason.offlineGrace');
        default: return reason;
    }
}
