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
import { initLogger, logInfo, logError, disposeLogger } from './logger';
import { ScheduleDashboardPanel } from './webviewPanel';
import { BridgeContext } from './bridgeContext';
import { startBridge, stopBridge, updateStatusBar } from './bridgeLifecycle';
import { checkAndOfferShortcut, createDesktopShortcut } from './shortcutInstaller';

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
    isBotOwner: false,
    globalStoragePath: '',
    statusBarItem: undefined!,
    dashboardBarItem: undefined!,
    lockWatchTimer: null,
    categoryWatchTimer: null,
};

// =====================================================================
// activate
// =====================================================================

export function activate(context: vscode.ExtensionContext) {
    const log = initLogger();
    logInfo('Extension activating...');

    // StatusBar
    ctx.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    ctx.statusBarItem.text = '$(circle-slash) Discord Bridge';
    ctx.statusBarItem.tooltip = 'AntiCrow — Stopped';
    ctx.statusBarItem.command = 'anti-crow.start';
    ctx.statusBarItem.show();
    context.subscriptions.push(ctx.statusBarItem);

    // Dashboard StatusBar (Bridge 起動中のみ表示)
    ctx.dashboardBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    ctx.dashboardBarItem.text = '$(calendar) Schedules';
    ctx.dashboardBarItem.tooltip = 'スケジュール管理ダッシュボードを開く';
    ctx.dashboardBarItem.command = 'anti-crow.openDashboard';
    context.subscriptions.push(ctx.dashboardBarItem);

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
                logInfo('Token saved to SecretStorage');
            }
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Start
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.start', async () => {
            if (ctx.bot && ctx.bot.isReady()) {
                vscode.window.showInformationMessage('Discord Bridge は既に稼働中です。');
                return;
            }

            try {
                await startBridge(ctx, context);
                vscode.window.showInformationMessage('✅ AntiCrow を開始しました。');
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`起動失敗: ${msg}`);
                logError('Start failed', e);
            }
        })
    );

    // -----------------------------------------------------------------
    // コマンド: Stop
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.stop', async () => {
            await stopBridge(ctx);
            vscode.window.showInformationMessage('Discord Bridge を停止しました。');
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
    // コマンド: Open Schedule Dashboard
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.openDashboard', () => {
            if (!ctx.planStore || !ctx.scheduler) {
                vscode.window.showWarningMessage('Bridge が起動していません。');
                return;
            }
            ScheduleDashboardPanel.createOrShow(context.extensionUri, ctx.planStore, ctx.scheduler, async (channelId, newName) => {
                if (ctx.bot) { await ctx.bot.renamePlanChannel(channelId, newName); }
            });
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
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`ショートカット作成に失敗: ${msg}`);
                logError('createShortcut command failed', e);
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
    await stopBridge(ctx);
    disposeLogger();
}
