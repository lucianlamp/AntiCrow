// ---------------------------------------------------------------------------
// bridgeLifecycle.ts — Bridge の起動・停止・ライフサイクル管理
// ---------------------------------------------------------------------------
// 責務:
//   1. Bridge の起動（モジュール初期化、Bot ログイン）
//   2. Bridge の停止（クリーンアップ）
//   3. Bot オーナー昇格
//   4. StatusBar 更新
//   5. 設定バリデーション
// カテゴリーアーカイブ → categoryArchiver.ts
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { Message, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { DiscordBot } from './discordBot';
import { CdpBridge } from './cdpBridge';
import { FileIpc } from './fileIpc';
import { Scheduler } from './scheduler';
import { PlanStore } from './planStore';
import { Executor } from './executor';
import { CdpPool } from './cdpPool';
import { ExecutorPool } from './executorPool';
import { TemplateStore } from './templateStore';
import { ChannelIntent, Plan } from './types';
import { logDebug, logError, logWarn } from './logger';
import { registerGuildCommands } from './slashCommands';

import { cleanupOldAttachments } from './attachmentDownloader';
import { acquireLock, releaseLock } from './botLock';
import { BridgeContext } from './bridgeContext';
import { enqueueMessage } from './messageHandler';
import { handleSlashCommand, handleButtonInteraction, handleAutocomplete, handleModalSubmit } from './slashHandler';
import { getConfig, getResponseTimeout, getTimezone, getArchiveDays, getWorkspacePaths, getClientId, getCdpPorts } from './configHelper';
import { archiveOldCategories } from './categoryArchiver';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// 設定バリデーション
// ---------------------------------------------------------------------------

function validateConfig(): void {
    const wsPaths = getWorkspacePaths();
    for (const [wsName, wsPath] of Object.entries(wsPaths)) {
        if (!fs.existsSync(wsPath)) {
            logWarn(`validateConfig: workspacePaths["${wsName}"] のパスが存在しません: "${wsPath}"`);
        }
    }
}

// ---------------------------------------------------------------------------
// Bot オーナーへの昇格（Bot 起動 + ハンドラ登録）
// ---------------------------------------------------------------------------

async function promoteToBotOwner(
    ctx: BridgeContext,
    context: vscode.ExtensionContext,
): Promise<void> {
    const config = getConfig();
    const token = await context.secrets.get('discord-bot-token');
    if (!token) {
        logError('promoteToBotOwner: token not found');
        return;
    }
    ctx.isBotOwner = true;

    // Discord Bot 初期化
    ctx.bot = new DiscordBot(token);

    ctx.bot.onMessage(async (message: Message, intent: ChannelIntent, channelName: string) => {
        await enqueueMessage(ctx, message, intent, channelName);
    });

    await ctx.bot.start();
    await ctx.bot.waitForReady();
    logDebug(`Bridge: bot ready, guilds=${ctx.bot.getFirstGuild()?.name || 'none'}`);

    // ワークスペースカテゴリー自動作成
    {
        const guild = ctx.bot.getFirstGuild();
        if (guild) {
            try {
                const instances = await CdpBridge.discoverInstances(getCdpPorts(context.globalStorageUri.fsPath));
                for (const inst of instances) {
                    const hasWorkspace = inst.title.includes(' \u2014 ') || inst.title.includes(' - ');
                    if (!hasWorkspace) {
                        logDebug(`Bridge: skipping category creation for initial screen: "${inst.title}"`);
                        continue;
                    }
                    const wsName = CdpBridge.extractWorkspaceName(inst.title);
                    if (wsName) {
                        await ctx.bot.ensureWorkspaceStructure(guild.id, wsName);
                    }
                }
                logDebug(`Bridge: workspace categories ensured for ${instances.length} instance(s)`);

                // ワークスペースパス自動保存
                const currentWsFolders = vscode.workspace.workspaceFolders;
                if (currentWsFolders && currentWsFolders.length > 0 && ctx.cdp) {
                    const wsName = ctx.cdp.getActiveWorkspaceName();
                    const wsPath = currentWsFolders[0].uri.fsPath;
                    if (wsName && wsPath) {
                        // バリデーション: 壊れたワークスペース名の保存を防止
                        const isInvalidName =
                            wsName.includes('://') ||           // URL 形式
                            wsName === 'Antigravity' ||          // 初期状態のタイトル
                            wsName.includes('workbench.html');   // 内部 URL の一部
                        if (isInvalidName) {
                            logWarn(`Bridge: skipping workspace path save — invalid workspace name: "${wsName}"`);
                        } else {
                            const wsPaths = getWorkspacePaths();
                            if (!wsPaths[wsName] || wsPaths[wsName] !== wsPath) {
                                wsPaths[wsName] = wsPath;
                                await getConfig().update('workspacePaths', wsPaths, vscode.ConfigurationTarget.Global);
                                logDebug(`Bridge: auto-saved workspace path: "${wsName}" → "${wsPath}"`);
                            }
                        }
                    }
                }
            } catch (e) {
                logWarn(`Bridge: workspace category auto-creation failed: ${e instanceof Error ? e.message : e}`);
            }

            // カテゴリーアーカイブ処理（categoryArchiver.ts に委譲）
            const archiveDays = getArchiveDays();
            if (archiveDays > 0) {
                try {
                    const archived = await archiveOldCategories(guild.id, ctx.bot, archiveDays, ctx.planStore ?? undefined);
                    if (archived > 0) {
                        logDebug(`Bridge: archived ${archived} old workspace categories (>${archiveDays} days)`);
                    }
                } catch (e) {
                    logWarn(`Bridge: category archive failed: ${e instanceof Error ? e.message : e}`);
                }
            }
        }
    }

    // スラッシュコマンド登録
    const clientId = getClientId();
    if (clientId) {
        const guild = ctx.bot.getFirstGuild();
        if (guild) {
            try {
                await registerGuildCommands(token, clientId, guild.id);
                logDebug('Bridge: slash commands registered');
            } catch (e) {
                logWarn(`Bridge: slash command registration failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // ハンドラ登録
    ctx.bot.onInteraction(async (interaction: ChatInputCommandInteraction, intent) => {
        await handleSlashCommand(ctx, interaction, intent);
    });
    ctx.bot.onButton(async (interaction: ButtonInteraction) => {
        await handleButtonInteraction(ctx, interaction);
    });
    ctx.bot.onAutocomplete(async (interaction) => {
        await handleAutocomplete(ctx, interaction);
    });
    ctx.bot.onModalSubmit(async (interaction) => {
        await handleModalSubmit(ctx, interaction);
    });

    logDebug('Bridge: Bot started (this workspace is the bot owner)');

    // -----------------------------------------------------------------
    // 定期 CDP ターゲットスキャン: 新ワークスペースのカテゴリ自動生成
    // -----------------------------------------------------------------
    const knownWorkspaces = new Set<string>();
    try {
        const initInstances = await CdpBridge.discoverInstances(getCdpPorts(context.globalStorageUri.fsPath));
        for (const inst of initInstances) {
            const wsName = CdpBridge.extractWorkspaceName(inst.title);
            if (wsName) { knownWorkspaces.add(wsName); }
        }
    } catch (e) { logDebug(`promoteToBotOwner: initial instance scan failed: ${e}`); }

    ctx.categoryWatchTimer = setInterval(async () => {
        if (!ctx.bot || !ctx.bot.isReady()) { return; }
        const guild = ctx.bot.getFirstGuild();
        if (!guild) { return; }

        try {
            const instances = await CdpBridge.discoverInstances(getCdpPorts(context.globalStorageUri.fsPath));
            for (const inst of instances) {
                const hasWorkspace = inst.title.includes(' \u2014 ') || inst.title.includes(' - ');
                if (!hasWorkspace) { continue; }
                const wsName = CdpBridge.extractWorkspaceName(inst.title);
                if (!wsName || knownWorkspaces.has(wsName)) { continue; }

                knownWorkspaces.add(wsName);
                logDebug(`Bridge: new workspace detected: "${wsName}" — creating category...`);
                await ctx.bot.ensureWorkspaceStructure(guild.id, wsName);

                const wsPaths = getWorkspacePaths();
                if (!wsPaths[wsName]) {
                    logDebug(`Bridge: workspace "${wsName}" path not yet known (will be saved when that window's extension starts)`);
                }
            }
        } catch (e) {
            logDebug(`Bridge: periodic CDP scan failed: ${e instanceof Error ? e.message : e}`);
        }
    }, 10_000);
}

// ---------------------------------------------------------------------------
// Bridge 起動
// ---------------------------------------------------------------------------

/** startBridge 再入防止フラグ */
let bridgeStarting = false;

export async function startBridge(
    ctx: BridgeContext,
    context: vscode.ExtensionContext,
): Promise<void> {
    // 再入防止: autoStart と手動 start の並行呼び出しを防ぐ
    if (bridgeStarting) {
        logDebug('startBridge: already starting, skipping duplicate call');
        return;
    }
    bridgeStarting = true;
    try {
        await startBridgeInternal(ctx, context);
    } finally {
        bridgeStarting = false;
    }
}

async function startBridgeInternal(
    ctx: BridgeContext,
    context: vscode.ExtensionContext,
): Promise<void> {
    validateConfig();

    ctx.extensionPath = context.extensionPath;

    const token = await context.secrets.get('discord-bot-token');
    if (!token) {
        throw new Error(
            'Bot Token が設定されていません。コマンドパレットで "AntiCrow: Set Bot Token" を実行してください。'
        );
    }

    if (!getConfig().get<boolean>('botToken')) {
        await getConfig().update('botToken', true, vscode.ConfigurationTarget.Global);
    }

    const timezone = getTimezone();
    const responseTimeout = getResponseTimeout();

    // PlanStore 初期化
    const storageUri = context.globalStorageUri;
    ctx.planStore = new PlanStore(storageUri);
    await ctx.planStore.init();

    // FileIpc 初期化
    ctx.fileIpc = new FileIpc(storageUri);
    await ctx.fileIpc.init();
    await ctx.fileIpc.cleanupOldFiles();
    cleanupOldAttachments(storageUri.fsPath);

    // CdpBridge 初期化
    const cdpPorts = getCdpPorts(storageUri.fsPath);
    ctx.cdp = new CdpBridge(responseTimeout, cdpPorts);

    // Executor 初期化
    ctx.executor = new Executor(ctx.cdp, ctx.fileIpc, ctx.planStore, responseTimeout, async (channelId, msg, color) => {
        if (ctx.bot) {
            await ctx.bot.sendToChannel(channelId, msg, color);
        }
    }, async (channelId) => {
        if (ctx.bot) {
            await ctx.bot.sendTypingTo(channelId);
        }
    }, context.extensionPath);

    // CdpPool 初期化
    ctx.cdpPool = new CdpPool(cdpPorts, storageUri.fsPath);

    // ExecutorPool 初期化
    ctx.executorPool = new ExecutorPool(
        ctx.cdpPool,
        ctx.fileIpc,
        ctx.planStore,
        responseTimeout,
        async (channelId, msg, color) => {
            if (ctx.bot) {
                await ctx.bot.sendToChannel(channelId, msg, color);
            }
        },
        async (channelId) => {
            if (ctx.bot) {
                await ctx.bot.sendTypingTo(channelId);
            }
        },
        context.extensionPath,
    );

    // TemplateStore 初期化
    ctx.templateStore = new TemplateStore(storageUri.fsPath);

    // Scheduler 初期化 + 計画復元
    ctx.scheduler = new Scheduler((plan: Plan) => {
        if (ctx.executorPool) {
            ctx.executorPool.enqueueScheduled(plan.workspace_name || '', plan);
        } else {
            ctx.executor!.enqueueScheduled(plan);
        }
    }, timezone);
    const restored = ctx.scheduler.restoreAll(ctx.planStore.getAll());
    logDebug(`Restored ${restored} scheduled plans`);

    // CDP 初期接続
    try {
        await ctx.cdp.connect();
        logDebug(`Bridge: CDP initial connect — active workspace: "${ctx.cdp.getActiveWorkspaceName()}"`);
    } catch (e) {
        logWarn(`Bridge: CDP initial connect failed (will retry on first message): ${e instanceof Error ? e.message : e}`);
    }

    // Bot 起動ロック
    const storagePath = storageUri.fsPath;
    ctx.globalStoragePath = storagePath;
    ctx.isBotOwner = acquireLock(storagePath);

    if (ctx.isBotOwner) {
        await promoteToBotOwner(ctx, context);
    } else {
        logDebug('Bridge: Bot startup skipped (another workspace owns the bot) — running in standby mode');

        // 二重昇格防止フラグ（promoteToBotOwner 中に次の setInterval が発火するレース対策）
        let promoting = false;
        ctx.lockWatchTimer = setInterval(async () => {
            if (ctx.isBotOwner || promoting) { return; }
            const acquired = acquireLock(ctx.globalStoragePath);
            if (acquired) {
                logDebug('Bridge: lock became available — auto-promoting to bot owner');
                promoting = true;
                if (ctx.lockWatchTimer) {
                    clearInterval(ctx.lockWatchTimer);
                    ctx.lockWatchTimer = null;
                }
                try {
                    await promoteToBotOwner(ctx, context);
                    updateStatusBar(ctx);
                } catch (e) {
                    logError('Bridge: auto-promotion failed', e);
                } finally {
                    promoting = false;
                }
            }
        }, 5_000);
    }

    // 設定変更リスナー
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antiCrow.autoOperation')) {
                const autoOp = vscode.workspace.getConfiguration('antiCrow')
                    .get<boolean>('autoOperation') ?? false;
                if (autoOp) {
                    logDebug('Bridge: autoOperation enabled — starting UI watcher');
                    ctx.executor?.startUIWatcher();
                } else {
                    logDebug('Bridge: autoOperation disabled — stopping UI watcher');
                    ctx.executor?.stopUIWatcher();
                }
            }
        })
    );

    // autoOperation が有効ならUIウォッチャーを常時起動
    const autoOpEnabled = vscode.workspace.getConfiguration('antiCrow')
        .get<boolean>('autoOperation') ?? false;
    if (autoOpEnabled) {
        ctx.executor?.startUIWatcher();
        logDebug('Bridge: UI watcher started (autoOperation enabled)');
    }

    // CDP ヘルスチェック（60秒間隔で接続状態を監視）
    ctx.healthCheckTimer = setInterval(async () => {
        if (!ctx.cdp) { return; }
        try {
            const ok = await ctx.cdp.testConnection();
            if (!ok) {
                logWarn('Bridge: health check failed — attempting reconnect (connect only, no auto-launch)');
                try {
                    await ctx.cdp.connect();
                    logDebug('Bridge: health check reconnect succeeded');
                } catch (e) {
                    logWarn(`Bridge: health check reconnect failed — ${e instanceof Error ? e.message : e}`);
                }
            }
        } catch (e) {
            logDebug(`Bridge: health check error — ${e instanceof Error ? e.message : e}`);
        }
    }, 60_000);

    updateStatusBar(ctx);
}

// ---------------------------------------------------------------------------
// Bridge 停止
// ---------------------------------------------------------------------------

export async function stopBridge(ctx: BridgeContext): Promise<void> {
    if (ctx.lockWatchTimer) {
        clearInterval(ctx.lockWatchTimer);
        ctx.lockWatchTimer = null;
    }

    if (ctx.categoryWatchTimer) {
        clearInterval(ctx.categoryWatchTimer);
        ctx.categoryWatchTimer = null;
    }

    if (ctx.healthCheckTimer) {
        clearInterval(ctx.healthCheckTimer);
        ctx.healthCheckTimer = null;
    }

    ctx.scheduler?.stopAll();

    // 実行中ジョブを先に停止（CDP 切断前にジョブ停止を保証）
    ctx.executor?.forceStop();
    ctx.executorPool?.forceStopAll();
    // UIウォッチャー停止
    ctx.executor?.stopUIWatcher();

    ctx.cdpPool?.disconnectAll();
    ctx.cdp?.fullDisconnect();

    ctx.executorPool?.clear();
    await ctx.bot?.stop();

    if (ctx.isBotOwner && ctx.globalStoragePath) {
        releaseLock(ctx.globalStoragePath);
        ctx.isBotOwner = false;
    }

    ctx.bot = null;
    ctx.cdp = null;
    ctx.cdpPool = null;
    ctx.scheduler = null;
    ctx.executor = null;
    ctx.executorPool = null;

    ctx.statusBarItem.text = '$(circle-slash) AntiCrow';
    ctx.statusBarItem.tooltip = 'AntiCrow — Stopped';
    ctx.statusBarItem.command = 'anti-crow.start';

    logDebug('Bridge stopped');
}

// ---------------------------------------------------------------------------
// StatusBar 更新
// ---------------------------------------------------------------------------

export function updateStatusBar(ctx: BridgeContext): void {
    if (ctx.isBotOwner) {
        ctx.statusBarItem.text = '$(check) AntiCrow';
        ctx.statusBarItem.tooltip = 'AntiCrow — Active (メッセージを処理中)';
    } else {
        ctx.statusBarItem.text = '$(eye) AntiCrow (Standby)';
        ctx.statusBarItem.tooltip = 'AntiCrow — Standby (別ワークスペースが Bot 管理中)';
    }
    ctx.statusBarItem.command = 'anti-crow.stop';
}
