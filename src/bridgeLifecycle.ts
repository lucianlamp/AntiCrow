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
import { logInfo, logError, logWarn, logDebug } from './logger';
import { registerGuildCommands } from './slashCommands';

import { cleanupOldAttachments } from './attachmentDownloader';
import { acquireLock, releaseLock } from './botLock';
import { BridgeContext } from './bridgeContext';
import { enqueueMessage } from './messageHandler';
import { handleSlashCommand, handleButtonInteraction, handleAutocomplete, handleModalSubmit } from './slashHandler';
import { getConfig, getResponseTimeout, getTimezone, getArchiveDays, getWorkspacePaths, getClientId, getCdpPorts } from './configHelper';
import { archiveOldCategories } from './categoryArchiver';

// ---------------------------------------------------------------------------
// 設定バリデーション
// ---------------------------------------------------------------------------

function validateConfig(): void {
    const wsPaths = getWorkspacePaths();
    const fs = require('fs') as typeof import('fs');
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
    logInfo(`Bridge: bot ready, guilds=${ctx.bot.getFirstGuild()?.name || 'none'}`);

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
                logInfo(`Bridge: workspace categories ensured for ${instances.length} instance(s)`);

                // ワークスペースパス自動保存
                const currentWsFolders = vscode.workspace.workspaceFolders;
                if (currentWsFolders && currentWsFolders.length > 0 && ctx.cdp) {
                    const wsName = ctx.cdp.getActiveWorkspaceName();
                    const wsPath = currentWsFolders[0].uri.fsPath;
                    if (wsName && wsPath) {
                        const wsPaths = getWorkspacePaths();
                        if (!wsPaths[wsName] || wsPaths[wsName] !== wsPath) {
                            wsPaths[wsName] = wsPath;
                            await getConfig().update('workspacePaths', wsPaths, vscode.ConfigurationTarget.Global);
                            logInfo(`Bridge: auto-saved workspace path: "${wsName}" → "${wsPath}"`);
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
                    const archived = await archiveOldCategories(guild.id, ctx.bot, archiveDays);
                    if (archived > 0) {
                        logInfo(`Bridge: archived ${archived} old workspace categories (>${archiveDays} days)`);
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
                logInfo('Bridge: slash commands registered');
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

    logInfo('Bridge: Bot started (this workspace is the bot owner)');

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
                logInfo(`Bridge: new workspace detected: "${wsName}" — creating category...`);
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

export async function startBridge(
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
    logInfo(`Restored ${restored} scheduled plans`);

    // CDP 初期接続
    try {
        await ctx.cdp.connect();
        logInfo(`Bridge: CDP initial connect — active workspace: "${ctx.cdp.getActiveWorkspaceName()}"`);
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
        logInfo('Bridge: Bot startup skipped (another workspace owns the bot) — running in standby mode');

        ctx.lockWatchTimer = setInterval(async () => {
            if (ctx.isBotOwner) { return; }
            const acquired = acquireLock(ctx.globalStoragePath);
            if (acquired) {
                logInfo('Bridge: lock became available — auto-promoting to bot owner');
                if (ctx.lockWatchTimer) {
                    clearInterval(ctx.lockWatchTimer);
                    ctx.lockWatchTimer = null;
                }
                try {
                    await promoteToBotOwner(ctx, context);
                    updateStatusBar(ctx);
                } catch (e) {
                    logError('Bridge: auto-promotion failed', e);
                }
            }
        }, 5_000);
    }

    // 設定変更リスナー
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antiCrow.autoClickRules')) {
                logInfo('Bridge: autoClickRules changed — reloading...');
                ctx.executor?.loadAutoClickRulesFromConfig();
                ctx.executorPool?.reloadAutoClickRules();
            }
        })
    );

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

    ctx.scheduler?.stopAll();
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

    logInfo('Bridge stopped');
}

// ---------------------------------------------------------------------------
// StatusBar 更新
// ---------------------------------------------------------------------------

export function updateStatusBar(ctx: BridgeContext): void {
    const port = ctx.cdp?.getActiveTargetPort();
    const title = ctx.cdp?.getActiveTargetTitle();

    if (ctx.isBotOwner) {
        ctx.statusBarItem.text = '$(check) AntiCrow';
        const tooltipLines = ['AntiCrow — Active (メッセージを処理中)'];
        if (title) {
            tooltipLines.push(`Target: ${title}${port ? ` (port ${port})` : ''}`);
        }
        ctx.statusBarItem.tooltip = tooltipLines.join('\n');
    } else {
        ctx.statusBarItem.text = '$(eye) AntiCrow (Standby)';
        const tooltipLines = ['AntiCrow — Standby (別ワークスペースが Bot 管理中)'];
        if (title) {
            tooltipLines.push(`CDP Target: ${title}${port ? ` (port ${port})` : ''}`);
        }
        ctx.statusBarItem.tooltip = tooltipLines.join('\n');
    }
    ctx.statusBarItem.command = 'anti-crow.stop';
}
