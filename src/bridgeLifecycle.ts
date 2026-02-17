// ---------------------------------------------------------------------------
// bridgeLifecycle.ts — Bridge の起動・停止・ライフサイクル管理
// ---------------------------------------------------------------------------
// 責務:
//   1. Bridge の起動（モジュール初期化、Bot ログイン）
//   2. Bridge の停止（クリーンアップ）
//   3. Bot オーナー昇格
//   4. カテゴリーアーカイブ
//   5. StatusBar 更新
//   6. 設定バリデーション
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
import { ChannelIntent, Plan } from './types';
import { logInfo, logError, logWarn, logDebug } from './logger';
import { registerGuildCommands } from './slashCommands';
import { ScheduleDashboardPanel } from './webviewPanel';
import { cleanupOldAttachments } from './attachmentDownloader';
import { acquireLock, releaseLock } from './botLock';
import { BridgeContext } from './bridgeContext';
import { enqueueMessage } from './messageHandler';
import { handleSlashCommand, handleButtonInteraction } from './slashHandler';
import { getConfig, getResponseTimeout, getTimezone, getArchiveDays, getWorkspacePaths, getClientId, getCdpPorts } from './configHelper';
import { snowflakeToTimestamp } from './discordUtils';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

// snowflakeToTimestamp は discordUtils.ts からインポート

/**
 * 指定日数以上使用されていないワークスペースカテゴリーを削除する。
 * - カテゴリー内チャンネルの lastMessageId から最終使用日時を判定
 * - アクティブなスケジュール（PlanStore）があるチャンネルを含むカテゴリーは保護
 * @returns 削除したカテゴリー数
 */
async function archiveOldCategories(
    guildId: string,
    botInstance: DiscordBot,
    archiveDays: number,
    planStoreInstance?: PlanStore,
): Promise<number> {
    const wsCategories = botInstance.discoverWorkspaceCategories(guildId);
    if (wsCategories.size === 0) { return 0; }

    const guild = botInstance.getFirstGuild();
    if (!guild) { return 0; }

    const thresholdMs = Date.now() - archiveDays * 24 * 60 * 60 * 1000;
    let archivedCount = 0;

    // アクティブな plan の channel ID を集める
    const activeChannelIds = new Set<string>();
    if (planStoreInstance) {
        const allPlans = planStoreInstance.getAll();
        for (const plan of allPlans) {
            if (plan.channel_id) {
                activeChannelIds.add(plan.channel_id);
            }
        }
    }

    for (const [wsName, categoryId] of wsCategories) {
        const category = guild.channels.cache.get(categoryId);
        if (!category) { continue; }

        // カテゴリー内の子チャンネルを取得
        const children = guild.channels.cache.filter(c => c.parentId === categoryId);

        // アクティブな plan チャンネルがあればスキップ
        let hasActivePlan = false;
        for (const [childId] of children) {
            if (activeChannelIds.has(childId)) {
                hasActivePlan = true;
                break;
            }
        }
        if (hasActivePlan) {
            logDebug(`archiveOldCategories: skipping "${wsName}" — has active plan channels`);
            continue;
        }

        // 最終メッセージ日時を確認
        let latestTimestamp = 0;
        for (const [, child] of children) {
            if ('lastMessageId' in child && child.lastMessageId) {
                const ts = snowflakeToTimestamp(child.lastMessageId);
                if (ts > latestTimestamp) { latestTimestamp = ts; }
            }
        }

        // メッセージがない場合はカテゴリー作成日時を使用
        if (latestTimestamp === 0 && category.createdTimestamp) {
            latestTimestamp = category.createdTimestamp;
        }

        // 閾値より古い場合は削除
        if (latestTimestamp > 0 && latestTimestamp < thresholdMs) {
            const daysAgo = Math.floor((Date.now() - latestTimestamp) / (24 * 60 * 60 * 1000));
            logInfo(`archiveOldCategories: deleting "${wsName}" (last active ${daysAgo} days ago)`);

            // 子チャンネルを先に削除
            for (const [, child] of children) {
                try {
                    if ('delete' in child && typeof child.delete === 'function') {
                        await child.delete();
                    }
                } catch (e) {
                    logWarn(`archiveOldCategories: failed to delete channel ${child.id}: ${e instanceof Error ? e.message : e}`);
                }
            }

            // カテゴリーを削除
            try {
                if ('delete' in category && typeof category.delete === 'function') {
                    await category.delete();
                }
                archivedCount++;
            } catch (e) {
                logWarn(`archiveOldCategories: failed to delete category "${wsName}": ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    return archivedCount;
}

// ---------------------------------------------------------------------------
// 設定バリデーション
// ---------------------------------------------------------------------------

/**
 * 設定値のバリデーションを行い、問題があれば警告を表示する。
 */
function validateConfig(): void {
    // workspacePaths のパス存在チェック
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
                    // 初期画面（ワークスペース未選択）はタイトルにセパレータが無い → スキップ
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

                // ワークスペースパス自動保存: 現在のワークスペースのパスを workspacePaths に保存
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

            // カテゴリーアーカイブ処理
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

    logInfo('Bridge: Bot started (this workspace is the bot owner)');

    // -----------------------------------------------------------------
    // 定期 CDP ターゲットスキャン: 新ワークスペースのカテゴリ自動生成
    // -----------------------------------------------------------------
    const knownWorkspaces = new Set<string>();
    // 起動時に検出済みのワークスペースを記録
    try {
        const initInstances = await CdpBridge.discoverInstances(getCdpPorts(context.globalStorageUri.fsPath));
        for (const inst of initInstances) {
            const wsName = CdpBridge.extractWorkspaceName(inst.title);
            if (wsName) { knownWorkspaces.add(wsName); }
        }
    } catch { /* ignore */ }

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

                // 新しいワークスペースを検出
                knownWorkspaces.add(wsName);
                logInfo(`Bridge: new workspace detected: "${wsName}" — creating category...`);
                await ctx.bot.ensureWorkspaceStructure(guild.id, wsName);

                // ワークスペースパス自動保存
                const wsPaths = getWorkspacePaths();
                if (!wsPaths[wsName]) {
                    logDebug(`Bridge: workspace "${wsName}" path not yet known (will be saved when that window\'s extension starts)`);
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
    // 設定バリデーション
    validateConfig();

    // トークン取得（SecretStorage から）
    const token = await context.secrets.get('discord-bot-token');
    if (!token) {
        throw new Error(
            'Bot Token が設定されていません。コマンドパレットで "AntiCrow: Set Bot Token" を実行してください。'
        );
    }

    // チェックボックスを同期（既存トークンがある場合）
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

    // CdpBridge 初期化（動的ポート読み取り）
    const cdpPorts = getCdpPorts(storageUri.fsPath);
    ctx.cdp = new CdpBridge(responseTimeout, cdpPorts);

    // Executor 初期化（Discord 通知関数は後で差し替え）
    ctx.executor = new Executor(ctx.cdp, ctx.fileIpc, ctx.planStore, responseTimeout, async (channelId, msg, color) => {
        if (ctx.bot) {
            await ctx.bot.sendToChannel(channelId, msg, color);
        }
    }, async (channelId) => {
        if (ctx.bot) {
            await ctx.bot.sendTypingTo(channelId);
        }
    });

    // CdpPool 初期化（ワークスペース並列処理対応）
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
    );

    // Scheduler 初期化 + 計画復元
    ctx.scheduler = new Scheduler((plan: Plan) => {
        // ExecutorPool があればワークスペース指定で enqueue、なければ従来の executor
        if (ctx.executorPool) {
            ctx.executorPool.enqueueScheduled(plan.workspace_name || '', plan);
        } else {
            ctx.executor!.enqueueScheduled(plan);
        }
    }, timezone);
    const restored = ctx.scheduler.restoreAll(ctx.planStore.getAll());
    logInfo(`Restored ${restored} scheduled plans`);

    // CDP 初期接続（アクティブワークスペースの検出）
    try {
        await ctx.cdp.connect();
        logInfo(`Bridge: CDP initial connect — active workspace: "${ctx.cdp.getActiveWorkspaceName()}"`);
    } catch (e) {
        logWarn(`Bridge: CDP initial connect failed (will retry on first message): ${e instanceof Error ? e.message : e}`);
    }

    // -----------------------------------------------------------------
    // Bot 起動ロック: 最初のワークスペースだけが Bot を起動する
    // -----------------------------------------------------------------
    const storagePath = storageUri.fsPath;
    ctx.globalStoragePath = storagePath;
    ctx.isBotOwner = acquireLock(storagePath);

    if (ctx.isBotOwner) {
        await promoteToBotOwner(ctx, context);
    } else {
        logInfo('Bridge: Bot startup skipped (another workspace owns the bot) — running in standby mode');
        // ロック監視: Bot オーナーが終了したら自動昇格

        ctx.lockWatchTimer = setInterval(async () => {
            if (ctx.isBotOwner) { return; } // 既に昇格済み
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
                    ctx.dashboardBarItem.show();
                } catch (e) {
                    logError('Bridge: auto-promotion failed', e);
                }
            }
        }, 5_000);
    }

    // StatusBar 更新
    updateStatusBar(ctx);
    if (ctx.isBotOwner) {
        ctx.dashboardBarItem.show();
    }
}

// ---------------------------------------------------------------------------
// Bridge 停止
// ---------------------------------------------------------------------------

export async function stopBridge(ctx: BridgeContext): Promise<void> {

    // ロック監視タイマーをクリーンアップ
    if (ctx.lockWatchTimer) {
        clearInterval(ctx.lockWatchTimer);
        ctx.lockWatchTimer = null;
    }

    // カテゴリ監視タイマーをクリーンアップ
    if (ctx.categoryWatchTimer) {
        clearInterval(ctx.categoryWatchTimer);
        ctx.categoryWatchTimer = null;
    }


    ctx.scheduler?.stopAll();
    ctx.cdpPool?.disconnectAll();
    ctx.cdp?.fullDisconnect();
    ctx.executorPool?.clear();
    await ctx.bot?.stop();

    // Bot オーナーならロックを解放
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

    // planStore は残す（データ保持）

    ctx.statusBarItem.text = '$(circle-slash) Discord Bridge';
    ctx.statusBarItem.tooltip = 'AntiCrow — Stopped';
    ctx.statusBarItem.command = 'anti-crow.start';
    ctx.dashboardBarItem.hide();

    logInfo('Bridge stopped');
}

// ---------------------------------------------------------------------------
// StatusBar 更新
// ---------------------------------------------------------------------------

/** StatusBar の表示を更新 */
export function updateStatusBar(ctx: BridgeContext): void {
    const port = ctx.cdp?.getActiveTargetPort();
    const title = ctx.cdp?.getActiveTargetTitle();

    if (ctx.isBotOwner) {
        ctx.statusBarItem.text = '$(check) Discord Bridge';
        const tooltipLines = ['AntiCrow — Active (メッセージを処理中)'];
        if (title) {
            tooltipLines.push(`Target: ${title}${port ? ` (port ${port})` : ''}`);
        }
        ctx.statusBarItem.tooltip = tooltipLines.join('\n');
    } else {
        ctx.statusBarItem.text = '$(eye) Discord Bridge (Standby)';
        const tooltipLines = ['AntiCrow — Standby (別ワークスペースが Bot 管理中)'];
        if (title) {
            tooltipLines.push(`CDP Target: ${title}${port ? ` (port ${port})` : ''}`);
        }
        ctx.statusBarItem.tooltip = tooltipLines.join('\n');
    }
    ctx.statusBarItem.command = 'anti-crow.stop';
}
