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
import { LicenseChecker, LicenseGate, registerLicenseCommands } from './licensing';
import { isDeveloper } from './accessControl';
import { getAllowedUserIds } from './configHelper';
import { SubagentManager } from './subagentManager';
import { SubagentReceiver } from './subagentReceiver';
import { extractWorkspaceName } from './cdpTargets';

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
    autoAcceptStatusBarItem: null,

    lockWatchTimer: null,
    categoryWatchTimer: null,
    autoAcceptWatcherTimer: null,
    startupUIWatcher: null,
    healthCheckTimer: null,
    cleanupTimer: null,
    staleRecoveryTimer: null,
    setLicenseKeyFn: null,
    getTrialDaysRemaining: null,
    agentRunning: false,
    subagentManager: null,
    subagentReceiver: null,
    teamOrchestrator: null,
};

// ライセンスモジュールのインスタンス
let licenseChecker: LicenseChecker | null = null;
let licenseGate: LicenseGate | null = null;

/** ライセンスゲートへのアクセサ（bridgeLifecycle 等から利用） */
export function getLicenseGate(): LicenseGate | null {
    return licenseGate;
}

/** ライセンスチェッカーへのアクセサ（bridgeLifecycle でライセンス表示に利用） */
export function getLicenseChecker(): LicenseChecker | null {
    return licenseChecker;
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Auto Accept ステータスバーの表示を更新（3状態）
 * - 🔴 Auto Accept — 設定OFF（停止中）
 * - 🟡 Auto Accept — 設定ON、エージェント待機中
 * - 🟢 Auto Accept — 設定ON、エージェント実行中（稼働中）
 */
export function updateAutoAcceptStatusBar(item: vscode.StatusBarItem, agentRunning = false): void {
    const enabled = vscode.workspace.getConfiguration('antiCrow')
        .get<boolean>('autoAccept') ?? false;
    if (!enabled) {
        item.text = '🔴 Auto Accept';
        item.tooltip = 'Auto Accept: 停止中（クリックで有効化）';
    } else if (agentRunning) {
        item.text = '🟢 Auto Accept';
        item.tooltip = 'Auto Accept: 稼働中（クリックで無効化）';
    } else {
        item.text = '🟡 Auto Accept';
        item.tooltip = 'Auto Accept: 待機中（クリックで無効化）';
    }
}

// =====================================================================
// activate
// =====================================================================

export async function activate(context: vscode.ExtensionContext) {
    const log = initLogger();
    logInfo('Extension activating...');

    // --- Temporary command dump for investigation ---
    try {
        const cmds = await vscode.commands.getCommands(true);
        const dumpPath = 'c:\\Users\\ysk41\\dev\\anti-crow\\scripts\\vscode_commands_dump.json';
        fs.writeFileSync(dumpPath, JSON.stringify(cmds, null, 2), 'utf-8');
        logDebug(`CDP: Dumped ${cmds.length} commands to ${dumpPath}`);
    } catch (e) {
        logDebug(`CDP: Failed to dump commands: ${e}`);
    }
    // ----------------------------------------------

    // StatusBar
    ctx.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    ctx.statusBarItem.text = '$(circle-slash) AntiCrow';
    ctx.statusBarItem.tooltip = 'AntiCrow — Stopped';
    ctx.statusBarItem.command = 'anti-crow.start';
    ctx.statusBarItem.show();
    context.subscriptions.push(ctx.statusBarItem);

    // Auto Accept ステータスバーボタン
    const autoAcceptBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    autoAcceptBar.command = 'anti-crow.toggleAutoAccept';
    ctx.autoAcceptStatusBarItem = autoAcceptBar;
    updateAutoAcceptStatusBar(autoAcceptBar);
    autoAcceptBar.show();
    context.subscriptions.push(autoAcceptBar);

    // -----------------------------------------------------------------
    // ライセンスモジュール初期化（Lemonsqueezy）
    // -----------------------------------------------------------------
    licenseChecker = new LicenseChecker();
    licenseChecker.setGlobalState(context.globalState);
    licenseGate = new LicenseGate(licenseChecker);
    // ライセンス変更時にステータスバーを再描画（LicenseStatusBar を廃止し統合）
    licenseChecker.onChange(() => {
        // updateStatusBar は bridgeLifecycle から import するが、
        // activate 時点では Bridge 未起動の可能性があるため遅延 import
        import('./bridgeLifecycle').then(({ updateStatusBar }) => {
            updateStatusBar(ctx);
        }).catch(() => { /* ignore */ });
    });

    // SecretStorage からライセンスキーを復元
    context.secrets.get('license-key').then((key) => {
        if (key) {
            licenseChecker!.setLicenseKey(key);
            licenseChecker!.startAutoCheck();
            logDebug('License: restored key from SecretStorage');
        } else {
            logDebug('License: no key found (Free plan)');
        }
    });

    registerLicenseCommands(context, licenseChecker);

    // 開発者オーバーライド: allowedUserIds に開発者IDが含まれていれば全機能解放
    const allowedIds = getAllowedUserIds();
    const hasDeveloper = allowedIds.some(id => isDeveloper(id));
    if (hasDeveloper) {
        licenseGate.setDeveloperOverride(true);
        logDebug('License: developer override enabled (developer ID detected in allowedUserIds)');
    }

    logDebug('License: module initialized (Lemonsqueezy)');

    // Discord からのライセンスキー設定コールバックを BridgeContext に登録
    ctx.setLicenseKeyFn = async (key: string) => {
        if (!licenseChecker) throw new Error('LicenseChecker not initialized');
        // SecretStorage に保存
        await context.secrets.store('license-key', key);
        await vscode.workspace.getConfiguration('antiCrow')
            .update('licenseKey', true, vscode.ConfigurationTarget.Global);
        // メモリ上のキーを更新
        licenseChecker.setLicenseKey(key);
        // 即座に検証
        const status = await licenseChecker.check(true);
        if (status.valid && status.type !== 'free') {
            licenseChecker.startAutoCheck();
        }
        return { valid: status.valid, planType: status.type };
    };

    // トライアル残り日数を取得するコールバックを BridgeContext に登録
    ctx.getTrialDaysRemaining = () => licenseChecker?.getTrialDaysRemaining();


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
    // コマンド: Toggle Auto Accept
    // -----------------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('anti-crow.toggleAutoAccept', async () => {
            const cfg = vscode.workspace.getConfiguration('antiCrow');
            const current = cfg.get<boolean>('autoAccept') ?? false;
            await cfg.update('autoAccept', !current, vscode.ConfigurationTarget.Global);
            if (ctx.autoAcceptStatusBarItem) {
                updateAutoAcceptStatusBar(ctx.autoAcceptStatusBarItem, ctx.agentRunning);
            }
            vscode.window.showInformationMessage(
                `Auto Accept: ${!current ? '🟡 有効（待機中）' : '🔴 無効'}`
            );
        })
    );

    // 設定変更時に Auto Accept ステータスバーを自動更新
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antiCrow.autoAccept') && ctx.autoAcceptStatusBarItem) {
                updateAutoAcceptStatusBar(ctx.autoAcceptStatusBarItem, ctx.agentRunning);
            }
        })
    );

    // -----------------------------------------------------------------
    // 自動起動
    // -----------------------------------------------------------------
    const config = vscode.workspace.getConfiguration('antiCrow');
    if (config.get<boolean>('autoStart')) {
        startBridge(ctx, context).catch(e => {
            logError('Auto-start failed', e);
        });
    }

    // -----------------------------------------------------------------
    // サブエージェント統合
    // -----------------------------------------------------------------
    const ipcDir = path.join(context.globalStorageUri.fsPath, 'ipc');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const repoRoot = workspaceFolders?.[0]?.uri.fsPath ?? '';
    const windowTitle = vscode.env.appName ? `${vscode.workspace.name ?? ''} - ${vscode.env.appName}` : '';
    const workspaceName = vscode.workspace.name ?? extractWorkspaceName(windowTitle);

    if (SubagentReceiver.isSubagent(workspaceName)) {
        // --- サブウィンドウ: SubagentReceiver を起動 ---
        logInfo(`[Subagent] サブウィンドウとして検出: "${workspaceName}"`);
        const receiver = new SubagentReceiver(workspaceName, ipcDir);
        // ハンドラは startBridge 完了後に bridgeLifecycle.ts で Cascade 統合ハンドラに設定される
        receiver.start();
        ctx.subagentReceiver = receiver;
        logInfo('[Subagent] SubagentReceiver 起動完了（ハンドラは startBridge 後に設定）');
    } else if (repoRoot) {
        // --- メインウィンドウ: SubagentManager を作成 ---
        logDebug(`[Subagent] メインウィンドウ: "${workspaceName}"`);
        // SubagentManager は Bridge 起動後に cdpBridge が利用可能になってから初期化
        // ここでは ctx にフラグを立てておき、startBridge 完了後に初期化する
        // → 簡易実装: CdpBridge が null でも作成可能だが、spawn 時に ensureConnected する
    }

    logInfo('Extension activated');
}

// =====================================================================
// deactivate
// =====================================================================

export async function deactivate(): Promise<void> {
    // サブエージェント停止
    if (ctx.subagentManager) {
        await ctx.subagentManager.dispose();
        ctx.subagentManager = null;
    }
    if (ctx.subagentReceiver) {
        ctx.subagentReceiver.stop();
        ctx.subagentReceiver = null;
    }

    licenseChecker?.dispose();
    licenseChecker = null;
    licenseGate = null;

    await stopBridge(ctx);
    disposeLogger();
}
