// ---------------------------------------------------------------------------
// extension.ts — VS Code 拡張エントリポイント（全モジュールの接続点）
// ---------------------------------------------------------------------------
// 責務:
//   1. VS Code ライフサイクル管理 (activate / deactivate)
//   2. コマンド登録
//   3. BridgeContext の構築と各モジュールへの橋渡し
//   4. StatusBar 表示
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { PlanStore } from './planStore';
import { Scheduler } from './scheduler';
import { initLogger, logInfo, logDebug, logError, disposeLogger } from './logger';

import { BridgeContext } from './bridgeContext';
import { startBridge, stopBridge, updateStatusBar } from './bridgeLifecycle';
import { checkAndOfferShortcut, createDesktopShortcut } from './shortcutInstaller';
import { LicenseChecker, LicenseGate, LicenseStatusBar, registerLicenseCommands } from './licensing';

// ---------------------------------------------------------------------------
// グローバル BridgeContext
// ---------------------------------------------------------------------------

const ctx: BridgeContext = {
    bot: null,
    cdp: null,
    cdpPool: null,
    fileIpc: null,
    scheduler: null,
    planStore: null,
    executor: null,
    executorPool: null,
    templateStore: null,
    isBotOwner: false,
    globalStoragePath: '',
    extensionPath: '',
    statusBarItem: undefined!,

    lockWatchTimer: null,
    categoryWatchTimer: null,
    autoOperationWatcherTimer: null,
    healthCheckTimer: null,
};

// ライセンスモジュールのインスタンス
let licenseChecker: LicenseChecker | null = null;
let licenseGate: LicenseGate | null = null;
let licenseStatusBar: LicenseStatusBar | null = null;

// =====================================================================
// activate
// =====================================================================

export function activate(context: vscode.ExtensionContext) {
    const log = initLogger();
    logInfo('Extension activating...');

    // StatusBar
    ctx.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    ctx.statusBarItem.text = '$(circle-slash) AntiCrow';
    ctx.statusBarItem.tooltip = 'AntiCrow — Stopped';
    ctx.statusBarItem.command = 'anti-crow.start';
    ctx.statusBarItem.show();
    context.subscriptions.push(ctx.statusBarItem);

    // -----------------------------------------------------------------
    // ライセンスモジュール初期化
    // -----------------------------------------------------------------
    const convexUrl = vscode.workspace.getConfiguration('antiCrow').get<string>('convexUrl') || '';
    if (convexUrl) {
        licenseChecker = new LicenseChecker(convexUrl);
        licenseGate = new LicenseGate(licenseChecker);
        licenseStatusBar = new LicenseStatusBar(licenseChecker);
        context.subscriptions.push({ dispose: () => licenseStatusBar?.dispose() });

        // Clerk ID を SecretStorage から復元
        context.secrets.get('clerk-user-id').then((clerkId) => {
            if (clerkId) {
                licenseChecker!.setClerkId(clerkId);
                licenseChecker!.startAutoCheck();
                logDebug(`License: restored Clerk ID from SecretStorage`);
            }
        });

        registerLicenseCommands(context, licenseChecker);
        logDebug(`License: module initialized`);
    } else {
        logDebug('License: skipped (convexUrl not configured)');
    }



    // -----------------------------------------------------------------
    // コマンド: Set Bot Token
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.setToken', async () => {
            const token = await vscode.window.showInputBox({
                prompt: 'Discord Bot Token を入力してください',
                password: true,
                ignoreFocusOut: true,
            });
            if (token) {
                await context.secrets.store('discord-bot-token', token);
                await vscode.workspace.getConfiguration('antiCrow').update('botToken', true, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('🔐 Bot Token を SecretStorage に保存しました。');
                logDebug('Token saved to SecretStorage');

                // autoStart 有効かつ未起動なら自動的に Bridge を開始
                const cfg = vscode.workspace.getConfiguration('antiCrow');
                if (cfg.get<boolean>('autoStart') && (!ctx.bot || !ctx.bot.isReady())) {
                    startBridge(ctx, context).catch(e => {
                        logError('Auto-start after token set failed', e);
                    });
                }
            }
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Start
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.start', async () => {
            if (ctx.bot && ctx.bot.isReady()) {
                vscode.window.showInformationMessage('AntiCrow は既に稼働中です。');
                return;
            }

            try {
                await startBridge(ctx, context);
                vscode.window.showInformationMessage('✅ AntiCrow を開始しました。');
            } catch (e) {
                logError('Start failed', e);
                vscode.window.showErrorMessage('起動に失敗しました。Output パネルでログを確認してください。');
            }
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Stop
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.stop', async () => {
            await stopBridge(ctx);
            vscode.window.showInformationMessage('AntiCrow を停止しました。');
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Show Plans
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.showPlans', async () => {
            if (!ctx.planStore) {
                vscode.window.showWarningMessage('Bridge が起動していません。');
                return;
            }
            const plans = ctx.planStore.getAll();
            if (plans.length === 0) {
                vscode.window.showInformationMessage('登録された計画はありません。');
                return;
            }

            const lines = plans.map(p => {
                const cronStr = p.cron || '(即時)';
                return `[${p.status}] ${p.plan_id} — ${cronStr} — ${p.human_summary || p.prompt.substring(0, 50)}`;
            });

            const doc = await vscode.workspace.openTextDocument({
                content: `=== AntiCrow — Plans ===\n\n${lines.join('\n')}`,
                language: 'text',
            });
            await vscode.window.showTextDocument(doc);
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Clear Plans
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.clearPlans', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'すべての計画を削除しますか？この操作は取り消せません。',
                { modal: true },
                'はい'
            );
            if (confirm === 'はい') {
                ctx.scheduler?.stopAll();
                ctx.planStore?.clearAll();
                vscode.window.showInformationMessage('すべての計画を削除しました。');
            }
        })
    );


    // -----------------------------------------------------------------
    // コマンド: Dump Antigravity Commands (診断用)
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.dumpCommands', async () => {
            const allCommands = await vscode.commands.getCommands(true);
            const agCmds = allCommands.filter(c => c.startsWith('antigravity.')).sort();

            const output = [
                `=== Antigravity Commands (${agCmds.length} found, total: ${allCommands.length}) ===`,
                `Time: ${new Date().toISOString()}`,
                '',
                ...agCmds,
            ].join('\n');

            logDebug(`DumpCommands:\n${output}`);

            const doc = await vscode.workspace.openTextDocument({
                content: output,
                language: 'text',
            });
            await vscode.window.showTextDocument(doc);
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Create Desktop Shortcut
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.createShortcut', () => {
            try {
                createDesktopShortcut(context.extensionPath);
                vscode.window.showInformationMessage('✅ デスクトップにショートカットを作成しました。');
            } catch (e) {
                logError('createShortcut command failed', e);
                vscode.window.showErrorMessage('ショートカット作成に失敗しました。Output パネルでログを確認してください。');
            }
        })
    );

    // -----------------------------------------------------------------
    // 初回起動: ショートカット設置の提案
    // -----------------------------------------------------------------
    checkAndOfferShortcut(context).catch(e => {
        logError('Shortcut offer check failed', e);
    });

    // -----------------------------------------------------------------
    // 自動起動
    // -----------------------------------------------------------------
    const config = vscode.workspace.getConfiguration('antiCrow');
    if (config.get<boolean>('autoStart')) {
        startBridge(ctx, context).catch(e => {
            logError('Auto-start failed', e);
        });
    }

    logInfo('Extension activated');
}

// =====================================================================
// deactivate
// =====================================================================

export async function deactivate(): Promise<void> {
    licenseChecker?.dispose();
    licenseStatusBar?.dispose();
    licenseChecker = null;
    licenseGate = null;
    licenseStatusBar = null;

    await stopBridge(ctx);
    disposeLogger();
}
