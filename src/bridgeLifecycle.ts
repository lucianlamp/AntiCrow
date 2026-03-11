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
import { logDebug, logError, logWarn, logInfo } from './logger';
import { registerGuildCommands } from './slashCommands';

import { cleanupOldAttachments } from './attachmentDownloader';
import { acquireLock, releaseLock } from './botLock';
import { BridgeContext } from './bridgeContext';
import { updateAutoAcceptStatusBar } from './extension';
import { enqueueMessage } from './messageHandler';
import { handleSlashCommand, handleButtonInteraction, handleAutocomplete, handleModalSubmit } from './slashHandler';
import { getConfig, getResponseTimeout, getTimezone, getArchiveDays, getWorkspacePaths, getClientId, getCdpPorts } from './configHelper';
import { archiveOldCategories } from './categoryArchiver';
import { getLicenseGate, getLicenseChecker } from './extension';
import type { LicenseType } from './licensing';
import { setSummarizeOps, stripMemoryTags } from './memoryStore';
import { stripSuggestionTags } from './suggestionParser';
import { UIWatcher } from './uiWatcher';
import { SubagentManager } from './subagentManager';
import { SubagentReceiver } from './subagentReceiver';
import { TeamOrchestrator } from './teamOrchestrator';
import { loadTeamConfig } from './teamConfig';
import { deployAntiCrowSkill } from './embeddedSkill';
import { t } from './i18n';
import { isAutoModeActive } from './autoModeController';
import * as fs from 'fs';

/** ワークスペース名としてカテゴリ作成すべきでない名前を判定する */
function isInvalidWorkspaceName(wsName: string): boolean {
    if (!wsName) { return true; }
    let reason = '';
    if (wsName.includes('://')) { reason = 'URL形式'; }
    else if (wsName === 'Antigravity') { reason = '初期タイトル'; }
    else if (wsName.includes('workbench.html')) { reason = '内部URL'; }
    else if (wsName.includes('Welcome')) { reason = 'Welcomeタブ'; }
    else if (wsName.includes('Settings')) { reason = '設定タブ'; }
    else if (wsName.includes('Extensions')) { reason = '拡張機能タブ'; }
    else if (/^\..*/.test(wsName)) { reason = '隠しファイル'; }
    else if (/\.[a-z]{1,5}$/i.test(wsName)) { reason = 'ファイル名'; }
    else if (wsName.length > 50) { reason = '長すぎる名前'; }
    else if (/\d+\s*(つの|個の)/.test(wsName)) { reason = 'SCMパターン(つの/個の)'; }
    else if (wsName.includes('問題')) { reason = 'SCM: 問題'; }
    else if (wsName.includes('problem')) { reason = 'SCM: problem'; }

    if (reason) {
        logDebug(`isInvalidWorkspaceName: "${wsName}" → invalid (${reason})`);
        return true;
    }
    return false;
}

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
// stale response 再送（起動時 + 定期チェック共通）
// ---------------------------------------------------------------------------

async function redeliverStaleResponses(
    ctx: BridgeContext,
    staleResponses: import('./fileIpc').StaleResponse[],
): Promise<void> {
    // オートモード中は stale response リカバリーをスキップ
    // （オートモードのレスポンス管理は autoModeContinueLoop が担当）
    if (isAutoModeActive()) {
        logDebug('Bridge: skipping stale response recovery — auto mode is active');
        return;
    }
    if (staleResponses.length === 0) { return; }
    for (const sr of staleResponses) {
        try {
            if (ctx.bot && ctx.bot.isReady()) {
                // ワークスペース名の補完: meta になければ requestId から抽出（req_{ws}_{ts}_{uuid} 形式）
                let wsName = sr.workspaceName;
                if (!wsName) {
                    const wsMatch = sr.requestId.match(/^req_([a-zA-Z][a-zA-Z0-9_-]*)_\d+_[a-f0-9]+$/);
                    if (wsMatch) {
                        wsName = wsMatch[1];
                        logDebug(`Bridge: extracted workspace from requestId: "${wsName}"`);
                    }
                }

                // 2段フォールバック: ① meta channelId → ② ワークスペース名でカテゴリ内 #agent-chat
                // ※ findFirstAgentChatChannelId（全WS横断）は使わない — 別WSへの誤送信を防止
                let targetChannelId = sr.channelId || null;
                let source = 'meta';
                if (!targetChannelId && wsName) {
                    targetChannelId = ctx.bot.findAgentChatChannelByWorkspace(wsName);
                    source = 'workspace';
                }
                if (targetChannelId) {
                    // テキスト抽出
                    let text: string;
                    if (sr.format === 'md') {
                        text = sr.content;
                    } else {
                        text = FileIpc.extractResult(sr.content);
                    }

                    // 再送メッセージにヘッダー付与（MEMORY/SUGGESTIONS タグは除去）
                    const header = t('bridge.staleHeader');
                    const cleanedText = stripSuggestionTags(stripMemoryTags(text));
                    await ctx.bot.sendToChannel(targetChannelId, header + cleanedText, 0xFFA500);
                    logDebug(`Bridge: stale response re-delivered — requestId=${sr.requestId}, channelId=${targetChannelId} (source=${source}, workspace=${wsName ?? 'none'})`);
                } else {
                    logWarn(`Bridge: stale response skipped — cannot determine target channel (requestId=${sr.requestId}, workspace=${wsName ?? 'none'}). Cleaning up to prevent re-delivery.`);
                }
            } else {
                logWarn(`Bridge: stale response found but bot not ready — requestId=${sr.requestId}, format=${sr.format}, chars=${sr.content.length}`);
            }
            // 再送成否に関わらずファイル+metaは削除（無限ループ防止）
            await ctx.fileIpc!.cleanupStaleResponse(sr.filePath, sr.metaFilePath);
        } catch (e) {
            logWarn(`Bridge: stale response re-delivery failed — requestId=${sr.requestId}: ${e instanceof Error ? e.message : e}`);
            // エラーでもファイル削除を試行
            try { await ctx.fileIpc!.cleanupStaleResponse(sr.filePath, sr.metaFilePath); } catch { /* ignore */ }
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

    // ワークスペースカテゴリー自動作成（信頼できるソースのみ使用）
    // CDPターゲットのタイトルからの推測は廃止 — SCM情報等が混入してカテゴリ増殖バグの原因になるため
    {
        const guild = ctx.bot.getFirstGuild();
        if (guild) {
            try {
                // 1. 現在のウィンドウのワークスペース名（vscode.workspace.name — 最も信頼できるソース）
                const currentWsName = vscode.workspace.name;
                if (currentWsName && !isInvalidWorkspaceName(currentWsName) && !SubagentReceiver.isSubagent(currentWsName)) {
                    await ctx.bot.ensureWorkspaceStructure(guild.id, currentWsName);
                    logDebug(`Bridge: created category for current workspace: "${currentWsName}"`);
                }

                // 2. settings.json の workspacePaths に登録済みのワークスペース
                const wsPaths = getWorkspacePaths();
                for (const wsName of Object.keys(wsPaths)) {
                    if (wsName && !isInvalidWorkspaceName(wsName) && !SubagentReceiver.isSubagent(wsName)) {
                        await ctx.bot.ensureWorkspaceStructure(guild.id, wsName);
                    }
                }
                logDebug(`Bridge: workspace categories ensured from trusted sources`);

                // ワークスペースパス自動保存（現在のワークスペースのみ）
                const currentWsFolders = vscode.workspace.workspaceFolders;
                if (currentWsFolders && currentWsFolders.length > 0 && currentWsName) {
                    const wsPath = currentWsFolders[0].uri.fsPath;
                    if (wsPath) {
                        // バリデーション: 壊れたワークスペース名の保存を防止
                        if (isInvalidWorkspaceName(currentWsName)) {
                            logWarn(`Bridge: skipping workspace path save — invalid workspace name: "${currentWsName}"`);
                        } else {
                            if (!wsPaths[currentWsName] || wsPaths[currentWsName] !== wsPath) {
                                wsPaths[currentWsName] = wsPath;
                                await getConfig().update('workspacePaths', wsPaths, vscode.ConfigurationTarget.Global);
                                logDebug(`Bridge: auto-saved workspace path: "${currentWsName}" → "${wsPath}"`);
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

    // スラッシュコマンド登録（clientId は設定値 → bot.getClientId() の順でフォールバック）
    const clientId = getClientId() || ctx.bot.getClientId() || '';
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

    // TeamOrchestrator 初期化（Bot 起動後に実行）
    // NOTE: startBridgeInternal() の SubagentManager 初期化は ctx.cdp が必要だが、
    //       cdpPool モードでは ctx.cdp が null のため SubagentManager が作られない。
    //       ここで cdpPool からデフォルト CdpBridge を取得してフォールバックする。
    if (!ctx.subagentManager && ctx.fileIpc) {
        const cdpForSubagent = ctx.cdp ?? ctx.cdpPool?.getDefault() ?? null;
        if (cdpForSubagent) {
            const subIpcDir = context.globalStorageUri.fsPath + '/ipc';
            const subRepoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            if (subRepoRoot) {
                try {
                    ctx.subagentManager = new SubagentManager(cdpForSubagent, subIpcDir, subRepoRoot);
                    ctx.subagentManager.startHealthCheck();
                    logInfo('Bridge: SubagentManager initialized (post-bot-start, via cdpPool fallback)');
                } catch (e) {
                    logWarn(`Bridge: SubagentManager initialization failed: ${e instanceof Error ? e.message : e}`);
                }
            }
        }
    }
    if (ctx.subagentManager && ctx.fileIpc && ctx.bot && !ctx.teamOrchestrator) {
        const subRepoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        if (subRepoRoot) {
            const bot = ctx.bot;
            ctx.teamOrchestrator = new TeamOrchestrator(
                ctx.subagentManager,
                ctx.fileIpc,
                async (channelId: string, content: string) => {
                    try {
                        await bot.sendToChannel(channelId, content);
                    } catch (e) {
                        logWarn(`TeamOrchestrator Discord send failed: ${e instanceof Error ? e.message : e}`);
                    }
                },
                subRepoRoot,
            );
            // スレッド操作コールバックを設定
            ctx.teamOrchestrator.setThreadOps({
                createThread: (chId, agentName, taskSummary) =>
                    bot.createSubagentThread(chId, agentName, taskSummary),
                sendToThread: (threadId, msg) =>
                    bot.sendToSubagentThread(threadId, msg),
                archiveThread: (threadId) =>
                    bot.archiveSubagentThread(threadId),
                sendTyping: (threadId) =>
                    bot.sendTypingToThread(threadId),
            });
            // ワークスペースパスリゾルバーを注入（auto-learned パスを使えるようにする）
            if (ctx.cdpPool) {
                ctx.teamOrchestrator.setWsPathResolver(() => ctx.cdpPool!.getResolvedWorkspacePaths());
            }
        }
    }

    logInfo('Bridge: Bot started (this workspace is the bot owner)');

    // -----------------------------------------------------------------
    // 定期ワークスペースカテゴリーチェック: settings.json の workspacePaths のみを信頼
    // CDPターゲットタイトルからの推測は廃止（SCM情報等が混入するため）
    // -----------------------------------------------------------------
    const knownCategories = new Set<string>();
    // 初期状態として現在のワークスペースを追加
    const initialWsName = vscode.workspace.name;
    if (initialWsName) { knownCategories.add(initialWsName); }
    const initialPaths = getWorkspacePaths();
    for (const ws of Object.keys(initialPaths)) { knownCategories.add(ws); }

    ctx.categoryWatchTimer = setInterval(async () => {
        if (!ctx.bot || !ctx.bot.isReady()) { return; }
        const guild = ctx.bot.getFirstGuild();
        if (!guild) { return; }

        try {
            const currentPaths = getWorkspacePaths();
            for (const wsName of Object.keys(currentPaths)) {
                if (!wsName || knownCategories.has(wsName)) { continue; }
                if (isInvalidWorkspaceName(wsName) || SubagentReceiver.isSubagent(wsName)) { continue; }
                knownCategories.add(wsName);
                logDebug(`Bridge: new workspace detected in settings: "${wsName}" — creating category...`);
                await ctx.bot.ensureWorkspaceStructure(guild.id, wsName);
            }
        } catch (e) {
            logDebug(`Bridge: periodic workspace check failed: ${e instanceof Error ? e.message : e}`);
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
    logInfo('Bridge: startBridgeInternal starting...');
    validateConfig();

    ctx.extensionPath = context.extensionPath;

    const token = await context.secrets.get('discord-bot-token');
    if (!token) {
        throw new Error(
            t('bridge.noToken')
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

    // 起動時 stale レスポンスリカバリー（Phase 2: Bot 初期化後に Discord 再送）
    // cleanupOldFiles より先にレスポンスを検出・保持し、後で再送する
    let pendingStaleResponses: import('./fileIpc').StaleResponse[] = [];
    try {
        pendingStaleResponses = await ctx.fileIpc.recoverStaleResponses();
        if (pendingStaleResponses.length > 0) {
            logWarn(`Bridge: found ${pendingStaleResponses.length} stale response(s) at startup — will re-deliver after bot init`);
        }
    } catch (e) {
        logWarn(`Bridge: stale response recovery failed: ${e instanceof Error ? e.message : e}`);
    }

    await ctx.fileIpc.cleanupOldFiles();
    cleanupOldAttachments(storageUri.fsPath);

    // CdpBridge 初期化
    const cdpPorts = getCdpPorts(storageUri.fsPath);
    ctx.cdp = new CdpBridge(responseTimeout, cdpPorts);

    // マルチウインドウ対応: 自ウィンドウのワークスペース名を設定して優先接続
    const currentWorkspaceName = vscode.workspace.name;
    if (currentWorkspaceName) {
        ctx.cdp.setPreferredWorkspace(currentWorkspaceName);
    }
    ctx.executor = new Executor(ctx.cdp, ctx.fileIpc, ctx.planStore, responseTimeout, async (channelId, msg, color) => {
        if (ctx.bot) {
            await ctx.bot.sendToChannel(channelId, msg, color);
        }
    }, async (channelId) => {
        if (ctx.bot) {
            await ctx.bot.sendTypingTo(channelId);
        }
    }, context.extensionPath, async (channelId, components, embed) => {
        if (ctx.bot) {
            await ctx.bot.sendComponentsToChannel(channelId, components, embed);
        }
    }, async (channelId, filePath, comment) => {
        if (ctx.bot) {
            return ctx.bot.sendFileToChannel(channelId, filePath, comment);
        }
        return { sent: false, reason: 'channel_error' as const };
    });

    // モデル名更新コールバック（レスポンスフッターに反映）
    ctx.executor.setSetModelNameFn((name) => {
        ctx.bot?.setModelName(name);
    });

    // CdpPool 初期化
    ctx.cdpPool = new CdpPool(cdpPorts, storageUri.fsPath);

    // マルチウインドウ対応: CdpPoolにも自ウィンドウのワークスペース名を設定
    if (currentWorkspaceName) {
        ctx.cdpPool.setOwnerWorkspace(currentWorkspaceName);
    }

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
        async (channelId, components, embed) => {
            if (ctx.bot) {
                await ctx.bot.sendComponentsToChannel(channelId, components, embed);
            }
        },
        async (channelId, filePath, comment) => {
            if (ctx.bot) {
                return ctx.bot.sendFileToChannel(channelId, filePath, comment);
            }
            return { sent: false, reason: 'channel_error' as const };
        },
    );

    // ExecutorPool にもモデル名更新コールバックを設定
    ctx.executorPool.setSetModelNameFn((name) => {
        ctx.bot?.setModelName(name);
    });

    // マルチウインドウ対応: ExecutorPool に自ウィンドウのワークスペース名を設定
    // → onAgentStateChange（ステータスバー更新）はこの WS の Executor にのみ適用される
    if (currentWorkspaceName) {
        ctx.executorPool.setOwnerWorkspace(currentWorkspaceName);
    }

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

    // サマライズ Ops を memoryStore に注入（CDP + FileIpc が必要）
    if (ctx.cdp && ctx.fileIpc) {
        setSummarizeOps({
            sendPrompt: async (prompt: string) => { await ctx.cdp!.sendPrompt(prompt); },
            createMarkdownRequestId: (wsName?: string) => ctx.fileIpc!.createMarkdownRequestId(wsName),
            waitForResponse: async (responsePath: string, timeoutMs: number) =>
                ctx.fileIpc!.waitForResponse(responsePath, timeoutMs),
        });
        logDebug('Bridge: summarize ops injected into memoryStore');
    }

    // SubagentManager 初期化（CDP 接続後に実行）
    if (ctx.cdp && !ctx.subagentManager) {
        const subIpcDir = storageUri.fsPath + '/ipc';
        const subRepoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        if (subRepoRoot) {
            try {
                ctx.subagentManager = new SubagentManager(ctx.cdp, subIpcDir, subRepoRoot);
                ctx.subagentManager.startHealthCheck();
                logInfo('Bridge: SubagentManager initialized');
            } catch (e) {
                logWarn(`Bridge: SubagentManager initialization failed: ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    // TeamOrchestrator 初期化（SubagentManager が利用可能な場合）
    if (ctx.subagentManager && ctx.fileIpc && ctx.bot && !ctx.teamOrchestrator) {
        const subRepoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        if (subRepoRoot) {
            const bot = ctx.bot;
            ctx.teamOrchestrator = new TeamOrchestrator(
                ctx.subagentManager,
                ctx.fileIpc,
                async (channelId: string, content: string) => {
                    try {
                        await bot.sendToChannel(channelId, content);
                    } catch (e) {
                        logWarn(`TeamOrchestrator Discord send failed: ${e instanceof Error ? e.message : e}`);
                    }
                },
                subRepoRoot,
            );
            // スレッド操作コールバックを設定
            ctx.teamOrchestrator.setThreadOps({
                createThread: (chId, agentName, taskSummary) =>
                    bot.createSubagentThread(chId, agentName, taskSummary),
                sendToThread: (threadId, msg) =>
                    bot.sendToSubagentThread(threadId, msg),
                archiveThread: (threadId) =>
                    bot.archiveSubagentThread(threadId),
                sendTyping: (threadId) =>
                    bot.sendTypingToThread(threadId),
            });
            // ワークスペースパスリゾルバーを注入（auto-learned パスを使えるようにする）
            if (ctx.cdpPool) {
                ctx.teamOrchestrator.setWsPathResolver(() => ctx.cdpPool!.getResolvedWorkspacePaths());
            }
            logInfo('Bridge: TeamOrchestrator initialized with ThreadOps');
        }
    }

    // AntiCrow スキルをワークスペースに配置（毎回上書き）
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        deployAntiCrowSkill(wsRoot);
    }

    // SubagentReceiver: Cascade 統合ハンドラを設定（startBridge 完了後に CDP/FileIpc が利用可能）
    if (ctx.subagentReceiver && ctx.cdp && ctx.fileIpc) {
        const cdp = ctx.cdp;
        const fileIpc = ctx.fileIpc;
        ctx.subagentReceiver.setHandler(async (prompt: string) => {
            const handlerStartTime = Date.now();
            logInfo(`[SubagentReceiver] ────────── プロンプト受信 ──────────`);
            logInfo(`[SubagentReceiver] プロンプト長: ${prompt.length} chars`);
            logInfo(`[SubagentReceiver] プロンプトプレビュー: ${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}`);
            try {
                // FileIpc のレスポンスパスを先に生成
                const wsName = vscode.workspace.name ?? 'subagent';
                const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                const teamConfig = repoRoot ? loadTeamConfig(repoRoot) : null;
                const timeoutMs = teamConfig?.responseTimeoutMs ?? 900_000; // デフォルト15分
                const { requestId, responsePath } = fileIpc.createMarkdownRequestId(wsName);

                // instruction.json ファイルを生成（共通ヘルパー使用）
                const ipcDir = fileIpc.getIpcDir();
                const instructionPath = require('path').join(ipcDir, `${requestId}_instruction.json`);
                const progressPath = require('path').join(ipcDir, `${requestId}_progress.json`);

                const { writeInstructionJson } = require('./instructionBuilder');
                writeInstructionJson(instructionPath, {
                    prompt,
                    responsePath,
                    progressPath,
                    workspaceName: wsName,
                });

                // プロンプトはファイル読み込み指示のみ
                const subagentPrompt =
                    `以下のファイルを view_file ツールで読み込み、その指示に従ってください。` +
                    `ファイルパス: ${instructionPath}`;

                logInfo(`[SubagentReceiver] IPC設定: requestId=${requestId}, timeout=${Math.round(timeoutMs / 1000)}秒`);
                logDebug(`[SubagentReceiver] responsePath=${responsePath}`);

                // 新しいチャットを開始してプロンプト送信
                logDebug(`[SubagentReceiver] 新しいチャットを開始中...`);
                await cdp.startNewChat();
                logDebug(`[SubagentReceiver] 新しいチャット開始完了。プロンプト送信中... (${subagentPrompt.length} chars)`);
                await cdp.sendPrompt(subagentPrompt);
                logInfo(`[SubagentReceiver] プロンプト送信完了。レスポンス待機開始 (timeout=${Math.round(timeoutMs / 1000)}秒)`);

                // FileIpc 経由でレスポンスを待つ
                const result = await fileIpc.waitForResponse(responsePath, timeoutMs);

                // レスポンス内容の検証
                const elapsedMs = Date.now() - handlerStartTime;
                if (!result || result.trim().length === 0) {
                    logWarn(`[SubagentReceiver] ⚠️ レスポンス空 (requestId=${requestId}, elapsed=${Math.round(elapsedMs / 1000)}秒)`);
                    return t('bridge.cascadeEmptyResponse');
                }

                logInfo(`[SubagentReceiver] ✅ レスポンス成功: ${result.length} chars, ${Math.round(elapsedMs / 1000)}秒 (requestId=${requestId})`);
                logDebug(`[SubagentReceiver] レスポンス先頭200文字: ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`);
                logInfo(`[SubagentReceiver] ────────── 処理完了 ──────────`);
                return result;
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                const errStack = e instanceof Error ? e.stack : undefined;
                const elapsedMs = Date.now() - handlerStartTime;
                const isTimeout = errMsg.includes('timeout') || errMsg.includes('Timeout');
                if (isTimeout) {
                    logError(`[SubagentReceiver] ❌ タイムアウト (${Math.round(elapsedMs / 1000)}秒経過): ${errMsg}`);
                    logDebug(`[SubagentReceiver] タイムアウト詳細スタック: ${errStack || 'N/A'}`);
                    return t('bridge.cascadeTimeout', errMsg);
                }
                logError(`[SubagentReceiver] ❌ エラー (${Math.round(elapsedMs / 1000)}秒経過): ${errMsg}`, e);
                logDebug(`[SubagentReceiver] エラー詳細スタック: ${errStack || 'N/A'}`);
                logInfo(`[SubagentReceiver] ────────── 処理失敗 ──────────`);
                return t('bridge.cascadeError', errMsg);
            }
        });
        logInfo('Bridge: SubagentReceiver handler updated to Cascade integration (enhanced logging)');
    }

    // ワークスペースパス自動保存（全ウィンドウ共通 — Bot Owner 以外でも実行）
    // Bot Owner の定期チェック（10秒間隔）が新しいWSを検知するために必要
    {
        const wsName = vscode.workspace.name;
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsName && wsFolders && wsFolders.length > 0) {
            const wsPath = wsFolders[0].uri.fsPath;
            if (wsPath && !isInvalidWorkspaceName(wsName)) {
                const wsPaths = getWorkspacePaths();
                if (!wsPaths[wsName] || wsPaths[wsName] !== wsPath) {
                    wsPaths[wsName] = wsPath;
                    try {
                        await getConfig().update('workspacePaths', wsPaths, vscode.ConfigurationTarget.Global);
                        logInfo(`Bridge: auto-saved workspace path (pre-lock): "${wsName}" → "${wsPath}"`);
                    } catch (e) {
                        logWarn(`Bridge: workspace path auto-save failed: ${e instanceof Error ? e.message : e}`);
                    }
                }
            } else if (wsName && isInvalidWorkspaceName(wsName)) {
                logDebug(`Bridge: skipping workspace path save — invalid name: "${wsName}"`);
            }
        }
    }

    // Bot 起動ロック
    const storagePath = storageUri.fsPath;
    ctx.globalStoragePath = storagePath;
    ctx.isBotOwner = acquireLock(storagePath);

    if (ctx.isBotOwner) {
        logInfo('Bridge: Acquired bot owner lock — promoting to Bot Owner');
        await promoteToBotOwner(ctx, context);
    } else {
        logInfo('Bridge: Bot startup skipped (another workspace owns the bot) — running in standby mode');

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

    // Phase 2: stale response を Discord に再送（初回）
    await redeliverStaleResponses(ctx, pendingStaleResponses);

    // 定期 stale response チェック（5分間隔 — 再起動後に AI が書いたレスポンスもピックアップ）
    ctx.staleRecoveryTimer = setInterval(async () => {
        if (!ctx.fileIpc || !ctx.bot || !ctx.bot.isReady()) { return; }
        // オートモード中はスキップ（autoModeContinueLoop がレスポンスを管理中）
        if (isAutoModeActive()) {
            logDebug('Bridge: skipping periodic stale check — auto mode is active');
            return;
        }
        try {
            const stale = await ctx.fileIpc.recoverStaleResponses();
            if (stale.length > 0) {
                logWarn(`Bridge: periodic stale check found ${stale.length} response(s)`);
                await redeliverStaleResponses(ctx, stale);
            }
        } catch (e) {
            logDebug(`Bridge: periodic stale recovery failed: ${e instanceof Error ? e.message : e}`);
        }
    }, 5 * 60_000);

    // 設定変更リスナー
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antiCrow.autoAccept')) {
                const autoOp = vscode.workspace.getConfiguration('antiCrow')
                    .get<boolean>('autoAccept') ?? false;
                if (autoOp) {
                    // Pro 限定: Free プランではウォッチャーを起動しない
                    const gate = getLicenseGate();
                    if (gate && !gate.isFeatureAllowed('autoAccept')) {
                        logDebug('Bridge: autoAccept enabled but blocked (Free plan)');
                        return;
                    }
                    logDebug('Bridge: autoAccept enabled — starting UI watcher');
                    const isProCheck = () => getLicenseGate()?.isFeatureAllowed('autoAccept') ?? true;
                    const onAgentStateChange = (running: boolean) => {
                        ctx.agentRunning = running;
                        if (ctx.autoAcceptStatusBarItem) {
                            updateAutoAcceptStatusBar(ctx.autoAcceptStatusBarItem, running);
                        }
                    };
                    // ExecutorPool UIWatcher: autoFollowOutput のみ（ステータスバーに影響しない）
                    ctx.executorPool?.startUIWatcherAll(isProCheck);
                    // ステータスバー専用: ctx.cdp で独立 UIWatcher を起動
                    if (!ctx.startupUIWatcher && ctx.cdp) {
                        const watcher = new UIWatcher(ctx.cdp, () => ctx.executorPool?.isAnyRunning() ?? false, isProCheck);
                        watcher.setAgentStateCallback(onAgentStateChange);
                        watcher.start();
                        ctx.startupUIWatcher = watcher;
                        logDebug('Bridge: startup UIWatcher started via config change');
                    }
                } else {
                    logDebug('Bridge: autoAccept disabled — stopping UI watcher');
                    ctx.executorPool?.stopUIWatcherAll();
                    if (ctx.startupUIWatcher) {
                        ctx.startupUIWatcher.stop();
                        ctx.startupUIWatcher = null;
                    }
                }
            }
        })
    );

    // autoAccept が有効ならUIウォッチャーを常時起動（Pro 限定）
    //
    // アーキテクチャ:
    //   - ステータスバー: ctx.cdp ベースの独立 UIWatcher が制御（確実に接続済み）
    //   - autoFollowOutput: ExecutorPool の各 UIWatcher が WS 別に独立制御
    //   - 競合なし: onAgentStateChange は独立ウォッチャーのみ、ExecutorPool には渡さない
    const autoOpEnabled = vscode.workspace.getConfiguration('antiCrow')
        .get<boolean>('autoAccept') ?? false;
    if (autoOpEnabled) {
        const gate = getLicenseGate();
        if (gate && !gate.isFeatureAllowed('autoAccept')) {
            logDebug('Bridge: autoAccept enabled but blocked at startup (Free plan)');
        } else {
            const isProCheck = () => getLicenseGate()?.isFeatureAllowed('autoAccept') ?? true;
            const onAgentStateChange = (running: boolean) => {
                ctx.agentRunning = running;
                if (ctx.autoAcceptStatusBarItem) {
                    updateAutoAcceptStatusBar(ctx.autoAcceptStatusBarItem, running);
                }
            };

            // ExecutorPool UIWatcher: autoFollowOutput のみ（ステータスバーに影響しない）
            ctx.executorPool?.startUIWatcherAll(isProCheck);

            // ステータスバー専用: ctx.cdp で独立 UIWatcher を起動
            // ctx.cdp は起動時に connect() 済みなので、CdpPool より確実に現在のウィンドウに接続されている
            if (ctx.cdp) {
                const startupWatcher = new UIWatcher(ctx.cdp, () => ctx.executorPool?.isAnyRunning() ?? false, isProCheck);
                startupWatcher.setAgentStateCallback(onAgentStateChange);
                startupWatcher.start();
                ctx.startupUIWatcher = startupWatcher;
                logDebug('Bridge: startup UIWatcher started (status bar only, using ctx.cdp)');
            }
            logDebug('Bridge: UI watcher started (autoAccept enabled)');
        }
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

    // 定期 IPC ファイルクリーンアップ（5分間隔）
    ctx.cleanupTimer = setInterval(async () => {
        if (!ctx.fileIpc) { return; }
        try {
            await ctx.fileIpc.cleanupOldFiles();
        } catch (e) {
            logDebug(`Bridge: periodic cleanup failed: ${e instanceof Error ? e.message : e}`);
        }
    }, 5 * 60_000);

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

    if (ctx.cleanupTimer) {
        clearInterval(ctx.cleanupTimer);
        ctx.cleanupTimer = null;
    }

    if (ctx.staleRecoveryTimer) {
        clearInterval(ctx.staleRecoveryTimer);
        ctx.staleRecoveryTimer = null;
    }

    ctx.scheduler?.stopAll();

    // 実行中ジョブを先に停止（CDP 切断前にジョブ停止を保証）
    ctx.executor?.forceStop();
    ctx.executorPool?.forceStopAll();
    // UIウォッチャー停止
    ctx.executorPool?.stopUIWatcherAll();
    if (ctx.startupUIWatcher) {
        ctx.startupUIWatcher.stop();
        ctx.startupUIWatcher = null;
    }

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

    // サマライズ Ops をクリア
    setSummarizeOps(null);

    // SubagentManager の破棄
    if (ctx.subagentManager) {
        try {
            await ctx.subagentManager.dispose();
        } catch (e) {
            logWarn(`Bridge: SubagentManager dispose failed: ${e instanceof Error ? e.message : e}`);
        }
        ctx.subagentManager = null;
    }

    const licenseSuffix = getLicenseSuffix();
    ctx.statusBarItem.text = `$(circle-slash) AntiCrow${licenseSuffix}`;
    ctx.statusBarItem.tooltip = t('bridge.tooltipStopped', getLicenseTooltipLine());
    ctx.statusBarItem.command = 'anti-crow.start';

    logDebug('Bridge stopped');
}

// ---------------------------------------------------------------------------
// StatusBar 更新
// ---------------------------------------------------------------------------

/** ライセンスタイプからユーザー向けプラン名を返す */
function getPlanName(type: LicenseType, trialDaysRemaining?: number): string {
    switch (type) {
        case 'monthly': return 'Pro';
        case 'lifetime': return 'Pro';
        case 'trial': {
            const days = trialDaysRemaining ?? 0;
            return days > 0 ? t('bridge.trialDaysRemaining', days) : 'Trial';
        }
        case 'free': return 'Free';
        default: return 'Free';
    }
}

/** ステータスバー text 用のライセンスサフィックスを生成（例: " [Pro]"） */
function getLicenseSuffix(): string {
    const checker = getLicenseChecker();
    if (!checker) { return ''; }
    const status = checker.getCachedStatus();
    const trialDays = checker.getTrialDaysRemaining?.() ?? undefined;
    return ` [${getPlanName(status.type, trialDays)}]`;
}

/** ステータスバー tooltip 用のライセンス情報行を生成 */
function getLicenseTooltipLine(): string {
    const checker = getLicenseChecker();
    if (!checker) { return ''; }
    const status = checker.getCachedStatus();
    const trialDays = checker.getTrialDaysRemaining?.() ?? undefined;
    const planName = getPlanName(status.type, trialDays);

    if (status.type === 'free' && status.reason === 'no_key') {
        return t('bridge.tooltipFreeUpgrade', planName);
    }
    if (status.valid) {
        const expiryText = status.expiresAt
            ? t('bridge.tooltipExpiryDate', new Date(status.expiresAt).toLocaleDateString('ja-JP'))
            : '';
        return t('bridge.tooltipPlanExpiry', planName, expiryText);
    }
    return t('bridge.tooltipLicenseIssue');
}

export function updateStatusBar(ctx: BridgeContext): void {
    const licenseSuffix = getLicenseSuffix();
    const licenseTooltip = getLicenseTooltipLine();

    if (ctx.isBotOwner) {
        ctx.statusBarItem.text = `$(check) AntiCrow${licenseSuffix}`;
        ctx.statusBarItem.tooltip = t('bridge.tooltipActive', licenseTooltip);
    } else {
        ctx.statusBarItem.text = `$(check) AntiCrow${licenseSuffix}`;
        ctx.statusBarItem.tooltip = t('bridge.tooltipStandby', licenseTooltip);
    }
    ctx.statusBarItem.command = 'anti-crow.stop';
}
