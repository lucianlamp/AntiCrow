// ---------------------------------------------------------------------------
// src/licensing/licenseCommands.ts — ライセンス管理用 VS Code コマンド
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker, LicenseType } from './licenseChecker';
import { logDebug, logError } from '../logger';

/** Checkout URL を生成するためのベース URL */
const CHECKOUT_BASE_URL = 'https://anti-crow.dev';

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

                if (status.valid) {
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
                        `AntiCrow: ${getReasonText(status.reason)}`,
                        'プランを確認',
                        'ログイン',
                        'キャンセル',
                    );

                    if (selection === 'プランを確認') {
                        vscode.env.openExternal(vscode.Uri.parse(`${CHECKOUT_BASE_URL}/pricing`));
                    } else if (selection === 'ログイン') {
                        vscode.commands.executeCommand('anti-crow.licenseLogin');
                    }
                }
            } catch (e) {
                logError('licenseInfo command error', e);
                vscode.window.showErrorMessage('ライセンス情報の取得に失敗しました');
            }
        }),
    );

    // ライセンスログイン
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licenseLogin', async () => {
            const clerkId = await vscode.window.showInputBox({
                prompt: 'Clerk ユーザー ID を入力してください',
                placeHolder: 'user_xxxxxxxxxxxxxxxx',
                password: false,
            });

            if (!clerkId || !clerkId.startsWith('user_')) {
                vscode.window.showWarningMessage('有効な Clerk ユーザー ID を入力してください（user_ で始まる）');
                return;
            }

            // SecretStorage に保存
            await context.secrets.store('clerk-user-id', clerkId);
            checker.setClerkId(clerkId);
            logDebug(`License: Clerk ID set — ${clerkId.substring(0, 12)}...`);

            // 即座にチェック
            const status = await checker.check(true);
            if (status.valid) {
                vscode.window.showInformationMessage(
                    `AntiCrow: ライセンス認証成功！プラン: ${getPlanDisplayName(status.type)}`,
                );
            } else {
                const selection = await vscode.window.showWarningMessage(
                    `AntiCrow: 有効なライセンスが見つかりません。プランを購入しますか？`,
                    'プランを確認',
                    'キャンセル',
                );
                if (selection === 'プランを確認') {
                    vscode.env.openExternal(vscode.Uri.parse(`${CHECKOUT_BASE_URL}/pricing`));
                }
            }
        }),
    );

    // 購入ページを開く
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licensePurchase', async () => {
            const plans = [
                { label: '$(calendar) Monthly — 月額プラン', url: `${CHECKOUT_BASE_URL}/checkout/monthly` },
                { label: '$(star-full) Annual — 年額プラン（お得！）', url: `${CHECKOUT_BASE_URL}/checkout/annual` },
                { label: '$(infinity) Lifetime — 買い切りプラン', url: `${CHECKOUT_BASE_URL}/checkout/lifetime` },
            ];

            const selected = await vscode.window.showQuickPick(plans, {
                placeHolder: '購入するプランを選択してください',
            });

            if (selected) {
                vscode.env.openExternal(vscode.Uri.parse(selected.url));
            }
        }),
    );

    // ライセンスログアウト
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.licenseLogout', async () => {
            await context.secrets.delete('clerk-user-id');
            checker.setClerkId('');
            await checker.check(true);
            logDebug('License: logged out');
            vscode.window.showInformationMessage('AntiCrow: ライセンスからログアウトしました');
        }),
    );
}

function getPlanDisplayName(type: LicenseType | null): string {
    switch (type) {
        case 'monthly': return 'Monthly（月額）';
        case 'annual': return 'Annual（年額）';
        case 'lifetime': return 'Lifetime（買い切り）';
        case 'beta': return 'Beta Access（ベータ）';
        default: return 'Free';
    }
}

function getReasonText(reason: string): string {
    switch (reason) {
        case 'not_authenticated': return 'ログインが必要です';
        case 'user_not_found': return 'ユーザーが見つかりません。先にサインアップしてください。';
        case 'no_active_license': return '有効なライセンスがありません';
        case 'check_failed': return 'ライセンス確認に失敗しました（ネットワークエラー）';
        default: return reason;
    }
}
