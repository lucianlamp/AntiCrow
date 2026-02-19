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
    // コマンド: Test Antigravity Commands (CDP不要化検証)
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.dumpCommands', async () => {
            const results: string[] = [];
            results.push('=== Antigravity Command Test Results ===');
            results.push(`Time: ${new Date().toISOString()}`);
            results.push('');

            // --- Test 1: sendTextToChat ---
            results.push('--- Test 1: antigravity.sendTextToChat ---');
            try {
                // まず引数なしで呼んでみる（引数の形式を探る）
                const r1 = await vscode.commands.executeCommand('antigravity.sendTextToChat', 'Hello from AntiCrow test! This is a CDP-free test message.');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r1)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // 少し待機
            await new Promise(r => setTimeout(r, 2000));

            // --- Test 2: startNewConversation ---
            results.push('--- Test 2: antigravity.startNewConversation ---');
            try {
                const r2 = await vscode.commands.executeCommand('antigravity.startNewConversation');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r2)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            await new Promise(r => setTimeout(r, 1000));

            // --- Test 3: sendTextToChat (新会話で) ---
            results.push('--- Test 3: antigravity.sendTextToChat (after new conversation) ---');
            try {
                const r3 = await vscode.commands.executeCommand('antigravity.sendTextToChat', 'Second test message in new conversation.');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r3)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 4: agent.acceptAgentStep ---
            results.push('--- Test 4: antigravity.agent.acceptAgentStep ---');
            try {
                const r4 = await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r4)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 5: terminalCommand.accept (正しいコマンド名) ---
            results.push('--- Test 5: antigravity.terminalCommand.accept ---');
            try {
                const r5 = await vscode.commands.executeCommand('antigravity.terminalCommand.accept');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r5)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 6: command.accept ---
            results.push('--- Test 6: antigravity.command.accept ---');
            try {
                const r6 = await vscode.commands.executeCommand('antigravity.command.accept');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r6)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 7: acceptCompletion ---
            results.push('--- Test 7: antigravity.acceptCompletion ---');
            try {
                const r7 = await vscode.commands.executeCommand('antigravity.acceptCompletion');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r7)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 8: executeCascadeAction ---
            results.push('--- Test 8: antigravity.executeCascadeAction ---');
            try {
                const r8 = await vscode.commands.executeCommand('antigravity.executeCascadeAction');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r8)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 9: sendChatActionMessage ---
            results.push('--- Test 9: antigravity.sendChatActionMessage ---');
            try {
                const r9 = await vscode.commands.executeCommand('antigravity.sendChatActionMessage', 'test action');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r9)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // --- Test 10: openAgent ---
            results.push('--- Test 10: antigravity.openAgent ---');
            try {
                const r10 = await vscode.commands.executeCommand('antigravity.openAgent');
                results.push(`  Result: SUCCESS (return=${JSON.stringify(r10)})`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push(`  Result: ERROR — ${msg}`);
            }

            // 結果出力
            results.push('');
            results.push('=== Test Complete ===');
            const output = results.join('\n');
            logInfo(`TestCommands:\n${output}`);

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
