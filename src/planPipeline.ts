// ---------------------------------------------------------------------------
// planPipeline.ts — Plan 生成・確認・ディスパッチ処理モジュール
// ---------------------------------------------------------------------------
// 責務:
//   1. 返信コンテキスト解決
//   2. CDP 接続の取得
//   3. Plan プロンプトの生成と IPC ファイル経由の送受信
//   4. 確認フロー（choice_mode対応）
//   5. Plan の即時実行/定期登録ディスパッチ
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as vscode from 'vscode';
import { TextChannel, EmbedBuilder } from 'discord.js';
import { CdpBridge } from './cdpBridge';
import { WorkspaceConnectionError } from './cdpPool';
import { CascadePanelError } from './errors';
import { FileIpc } from './fileIpc';
import { parsePlanJson, buildPlan } from './planParser';
import { ChannelIntent, Plan } from './types';
import { logDebug, logError, logInfo, logWarn } from './logger';
import { buildEmbed, EmbedColor, sanitizeErrorForDiscord, normalizeHeadings } from './embedHelper';
import { t } from './i18n';
import { splitForEmbeds } from './discordFormatter';
import { DiscordBot } from './discordBot';
import { BridgeContext } from './bridgeContext';
import { getResponseTimeout } from './configHelper';
import { getCurrentModel } from './cdpModels';
import { getCurrentMode } from './cdpModes';
import { AUTO_PROMPT, buildSuggestionRow, buildSuggestionContent, storeSuggestions } from './suggestionButtons';
import { sendTeamResponse, TeamResponseCallbacks } from './executorResponseHandler';
import { loadTeamConfig } from './teamConfig';
import { buildPlanPrompt, buildConfirmMessage, countChoiceItems, cronToPrefix } from './promptBuilder';
import { resolveWorkspace } from './workspaceResolver';
import {
    setPlanAbortController,
    setTeamAbortController,
    getActivePlanTypingIntervals,
    getActivePlanProgressIntervals,
} from './messageQueue';

// ---------------------------------------------------------------------------
// 返信コンテキスト解決
// ---------------------------------------------------------------------------

/**
 * 返信コンテキストを取得してテキストに付加する。
 */
export async function resolveReplyContext(channel: TextChannel, text: string, messageRef?: { messageId?: string }): Promise<string> {
    if (!messageRef?.messageId) { return text; }
    try {
        const refMsg = await channel.messages.fetch(messageRef.messageId);
        if (!refMsg) { return text; }

        const refContent = refMsg.content?.trim() || '';
        const refAuthor = refMsg.author?.tag ?? t('pipeline.unknown');
        let embedText = '';
        if (refMsg.embeds && refMsg.embeds.length > 0) {
            const parts: string[] = [];
            for (const embed of refMsg.embeds) {
                if (embed.title) { parts.push(embed.title); }
                if (embed.description) { parts.push(embed.description); }
                if (embed.fields && embed.fields.length > 0) {
                    for (const field of embed.fields) {
                        parts.push(`${field.name}: ${field.value}`);
                    }
                }
            }
            embedText = parts.join('\n');
        }

        const combinedContent = [refContent, embedText].filter(Boolean).join('\n\n');
        if (combinedContent) {
            logDebug(`handleDiscordMessage: reply detected, referenced message from ${refAuthor} (content=${refContent.length} chars, embeds=${embedText.length} chars)`);
            return `## ${t('pipeline.replyHeader', refAuthor)}\n${combinedContent}\n\n## ${t('pipeline.replyInstruction')}\n${text}`;
        }
    } catch (e) {
        logWarn(`handleDiscordMessage: failed to fetch referenced message: ${e instanceof Error ? e.message : e}`);
    }
    return text;
}

// ---------------------------------------------------------------------------
// CDP 接続の取得
// ---------------------------------------------------------------------------

/**
 * CDP 接続を取得する。CdpPool 使用時は acquire、従来モードは直接接続。
 * 接続失敗時は null を返し、呼び出し元でエラー通知する。
 */
export async function acquireCdpConnection(
    ctx: BridgeContext,
    channel: TextChannel,
    wsNameFromCategory: string | undefined,
    fileIpc: FileIpc,
): Promise<{ cdp: CdpBridge; autoLaunched: boolean } | null> {
    const { cdp, cdpPool } = ctx;
    const useCdpPool = !!cdpPool;

    if (useCdpPool && cdpPool) {
        try {
            const activeCdp = await cdpPool.acquire(wsNameFromCategory || '', async (wsName) => {
                try {
                    await channel.sendTyping();
                    await channel.send({ embeds: [buildEmbed(t('pipeline.launching', wsName), EmbedColor.Info)] });
                } catch (e) { logDebug(`handleDiscordMessage: failed to react: ${e}`); }
            });
            logDebug(`handleDiscordMessage: acquired CdpBridge from pool for workspace "${wsNameFromCategory || 'default'}"`);
            return { cdp: activeCdp, autoLaunched: false };
        } catch (e) {
            logError(`handleDiscordMessage: failed to acquire CdpBridge for workspace "${wsNameFromCategory}"`, e);
            // WorkspaceConnectionError の場合はユーザーフレンドリーな userMessage を直接表示
            const displayMsg = (e instanceof WorkspaceConnectionError)
                ? e.userMessage
                : t('pipeline.connectionFailed', wsNameFromCategory || '', sanitizeErrorForDiscord(e instanceof Error ? e.message : String(e)));
            await channel.send({ embeds: [buildEmbed(`⚠️ ${displayMsg}`, EmbedColor.Warning)] });
            return null;
        }
    }

    const activeCdp = cdp!;
    if (!activeCdp.getActiveTargetTitle()) {
        try { await activeCdp.connect(); } catch (e) {
            logDebug(`handleDiscordMessage: pre-connect for instance title failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    // ワークスペースカテゴリーから自動切替（CdpPool未使用時のみ）
    if (wsNameFromCategory) {
        const result = await resolveWorkspace(activeCdp, wsNameFromCategory, channel, fileIpc);
        if (!result) { return null; }
        return { cdp: result.cdp, autoLaunched: result.autoLaunched };
    }
    return { cdp: activeCdp, autoLaunched: false };
}

// ---------------------------------------------------------------------------
// Plan 生成
// ---------------------------------------------------------------------------

/**
 * Plan プロンプトを Antigravity に送信し、JSON レスポンスをパースして Plan を返す。
 * パース失敗時は null を返す（呼び出し元でフォールバック通知する）。
 */
export async function generatePlan(
    activeCdp: CdpBridge,
    autoLaunched: boolean,
    fileIpc: FileIpc,
    channel: TextChannel,
    text: string,
    intent: ChannelIntent,
    channelName: string,
    attachmentPaths: string[] | undefined,
    extensionPath: string | undefined,
    resolvedWsPath: string | undefined,
): Promise<{ plan: Plan; guild: typeof import('discord.js').Guild.prototype | null } | null> {
    const { requestId, responsePath } = fileIpc.createRequestId();
    const wsNameForMeta = DiscordBot.resolveWorkspaceFromChannel(channel) ?? undefined;
    fileIpc.writeRequestMeta(requestId, channel.id, wsNameForMeta);
    const ipcDir = fileIpc.getIpcDir();
    const progressPath = fileIpc.createProgressPath(requestId);
    const { prompt: planPrompt, tempFiles } = buildPlanPrompt(
        text || t('pipeline.checkAttachments'), intent, channelName,
        responsePath, attachmentPaths, extensionPath, ipcDir, resolvedWsPath, progressPath,
    );
    logDebug('handleDiscordMessage: sending plan prompt via CDP...');

    // AbortController 生成（/stop でキャンセル可能にする）
    const abortController = new AbortController();
    setPlanAbortController(abortController);

    // typing indicator 開始（Set で管理し、複数並行時の上書きを防止）
    const activePlanTypingIntervals = getActivePlanTypingIntervals();
    const myTypingInterval = setInterval(async () => {
        try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }
    }, 8_000);
    activePlanTypingIntervals.add(myTypingInterval);
    try { await channel.sendTyping(); } catch (e) { logDebug(`handleDiscordMessage: sendTyping failed: ${e}`); }

    let planResponse: string;
    try {
        // CDP でプロンプト送信（自動起動直後は UI 初期化待ちのためリトライ）
        const maxRetries = autoLaunched ? 3 : 1;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    logDebug(`handleDiscordMessage: retrying sendPrompt (attempt ${attempt}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, 5_000));
                }
                await activeCdp.sendPrompt(planPrompt);
                break;
            } catch (retryErr) {
                if (retryErr instanceof CascadePanelError && attempt < maxRetries) {
                    logWarn(`handleDiscordMessage: CascadePanelError on attempt ${attempt}, will retry...`);
                    continue;
                }
                throw retryErr;
            }
        }
        logDebug('handleDiscordMessage: prompt sent, waiting for file response...');

        // 伝令完了 → 計画生成中ステータス
        try {
            await channel.send({ embeds: [buildEmbed(t('pipeline.planGenerating'), EmbedColor.Success)] });
        } catch (ackErr) {
            logDebug(`handleDiscordMessage: failed to send plan-generation ack: ${ackErr}`);
        }

        // 計画生成中の進捗報告（Set で管理し、複数並行時の上書きを防止）
        const activePlanProgressIntervals = getActivePlanProgressIntervals();
        let lastPlanProgress = '';
        const myProgressInterval = setInterval(async () => {
            try {
                const progress = await fileIpc.readProgress(progressPath);
                if (progress) {
                    const currentContent = JSON.stringify(progress);
                    if (currentContent !== lastPlanProgress) {
                        lastPlanProgress = currentContent;
                        const percentStr = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                        const detail = progress.detail ? `\n> ${progress.detail}` : '';
                        await channel.send({ embeds: [buildEmbed(`⏳ ${progress.status || t('pipeline.processing')}${percentStr}${detail}`, EmbedColor.Progress)] });
                    }
                }
            } catch { /* ignore */ }
        }, 3_000);
        activePlanProgressIntervals.add(myProgressInterval);

        const responseTimeout = getResponseTimeout();
        fileIpc.registerActiveRequest(requestId, tempFiles);
        try {
            planResponse = await fileIpc.waitForResponse(responsePath, responseTimeout, abortController.signal);
        } finally {
            fileIpc.unregisterActiveRequest(requestId, tempFiles);
            clearInterval(myProgressInterval);
            activePlanProgressIntervals.delete(myProgressInterval);
            fileIpc.cleanupProgress(progressPath).catch(() => { });
            // plan_generation レスポンスファイル + meta を即削除（stale response 誤再送防止）
            try {
                await fs.promises.unlink(responsePath);
                const metaPath = responsePath.replace(/_response\.(json|md)$/, '_meta.json');
                await fs.promises.unlink(metaPath).catch(() => { });
                logDebug(`generatePlan: cleaned up plan response: ${require('path').basename(responsePath)}`);
            } catch { /* ignore — file may already be cleaned up */ }
        }
    } finally {
        clearInterval(myTypingInterval);
        activePlanTypingIntervals.delete(myTypingInterval);
        setPlanAbortController(null);
        for (const f of tempFiles) {
            try { fs.unlinkSync(f); logDebug(`handleDiscordMessage: cleaned up temp file: ${f}`); } catch { /* ignore */ }
        }
    }
    logDebug(`handleDiscordMessage: plan response received(${planResponse.length} chars)`);

    const planOutput = parsePlanJson(planResponse);
    if (!planOutput) {
        // リトライ: JSON パース失敗時に修正指示付きで1回だけ再試行
        logWarn('handleDiscordMessage: plan JSON parse failed, attempting retry...');
        try {
            await channel.send({ embeds: [buildEmbed(t('pipeline.planRetrying'), EmbedColor.Warning)] });

            // リトライ用の新規 requestId / responsePath
            const { requestId: retryReqId, responsePath: retryResponsePath } = fileIpc.createRequestId();
            fileIpc.writeRequestMeta(retryReqId, channel.id, DiscordBot.resolveWorkspaceFromChannel(channel) ?? undefined);
            const retryProgressPath = fileIpc.createProgressPath(retryReqId);

            const retryPrompt =
                `前回の応答が JSON としてパースできませんでした。` +
                `出力は必ず JSON 形式の実行計画オブジェクトのみとしてください。` +
                `Markdown や自然文は書き込まないでください。` +
                `レスポンスファイルパス: ${retryResponsePath}`;

            await activeCdp.sendPrompt(retryPrompt);
            logDebug('handleDiscordMessage: retry prompt sent, waiting for response...');

            const retryTypingInterval = setInterval(async () => {
                try { await channel.sendTyping(); } catch { /* ignore */ }
            }, 8_000);
            try { await channel.sendTyping(); } catch { /* ignore */ }

            const responseTimeout = getResponseTimeout();
            fileIpc.registerActiveRequest(retryReqId);
            let retryResponse: string;
            try {
                retryResponse = await fileIpc.waitForResponse(retryResponsePath, responseTimeout);
            } finally {
                fileIpc.unregisterActiveRequest(retryReqId);
                clearInterval(retryTypingInterval);
                fileIpc.cleanupProgress(retryProgressPath).catch(() => { });
                try {
                    await fs.promises.unlink(retryResponsePath);
                    const metaPath = retryResponsePath.replace(/_response\.(json|md)$/, '_meta.json');
                    await fs.promises.unlink(metaPath).catch(() => { });
                } catch { /* ignore */ }
            }

            const retryPlanOutput = parsePlanJson(retryResponse);
            if (retryPlanOutput) {
                logInfo('handleDiscordMessage: retry succeeded — plan parsed on second attempt');
                const plan = buildPlan(retryPlanOutput, channel.id, channel.id);
                if (attachmentPaths && attachmentPaths.length > 0) {
                    plan.attachment_paths = attachmentPaths;
                }
                return { plan, guild: channel.guild };
            }

            logWarn('handleDiscordMessage: retry also failed — falling back to error/markdown');
        } catch (retryErr) {
            logWarn(`handleDiscordMessage: retry attempt failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
        }

        // リトライも失敗: 従来のフォールバック処理
        const trimmed = planResponse.trim();

        // 検出1: 壊れた計画JSON（plan_id や prompt を含むが不正形式）
        if (trimmed.startsWith('{') && (trimmed.includes('"plan_id"') || trimmed.includes('"prompt"'))) {
            logWarn('handleDiscordMessage: broken plan JSON detected, aborting to prevent raw JSON leak');
            await channel.send({ embeds: [buildEmbed(t('pipeline.planJsonError'), EmbedColor.Error)] });
            return null;
        }

        // 検出2: plan_generation なのに Markdown 形式で返ってきた場合
        const looksLikeMarkdown = /^(?:#|\*\*|[-•]|[✅❌🔧📋📸💡⚠️🎉])/.test(trimmed);
        if (looksLikeMarkdown) {
            logWarn(`handleDiscordMessage: plan_generation response appears to be Markdown instead of JSON (${trimmed.substring(0, 80)}...)`);
            logWarn('handleDiscordMessage: this indicates the AI returned Markdown for a plan_generation task — forwarding as-is but this should be corrected');
        } else {
            logWarn('handleDiscordMessage: plan JSON parse failed, forwarding as markdown');
        }

        const formatted = FileIpc.extractResult(planResponse);
        const content = formatted !== planResponse ? formatted : planResponse;
        const normalized = normalizeHeadings(content);
        const embedGroups = splitForEmbeds(normalized);
        for (const group of embedGroups) {
            const embeds = group.map((desc) =>
                new EmbedBuilder()
                    .setDescription(desc)
                    .setColor(EmbedColor.Info)
            );
            await channel.send({ embeds });
        }
        return null;
    }
    logDebug(`handleDiscordMessage: plan parsed — plan_id = ${planOutput.plan_id}, cron = ${planOutput.cron} `);

    const plan = buildPlan(planOutput, channel.id, channel.id);
    if (attachmentPaths && attachmentPaths.length > 0) {
        plan.attachment_paths = attachmentPaths;
    }
    return { plan, guild: channel.guild };
}

// ---------------------------------------------------------------------------
// 確認フロー
// ---------------------------------------------------------------------------

/** handleConfirmation の返り値 */
export interface ConfirmationResult {
    confirmed: boolean;
    /** single/multi で選択された番号（1-indexed）。全選択は [-1]。none/all は undefined。 */
    selectedChoices?: number[];
    /** エージェントに委任された場合 true */
    agentDelegated?: boolean;
}

/**
 * 確認フロー: choice_mode に応じてユーザーの承認を待つ。
 * 承認されたら confirmed: true と選択結果を返す。却下されたら confirmed: false。
 */
export async function handleConfirmation(
    plan: Plan,
    channel: TextChannel,
    bot: DiscordBot,
): Promise<ConfirmationResult> {
    const choiceMode = plan.choice_mode || 'none';
    const confirmMsg = buildConfirmMessage(plan);

    if (choiceMode === 'all') {
        await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Info)] });
        plan.status = 'active';
        return { confirmed: true };
    }
    if (choiceMode === 'multi') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choices = await bot.waitForMultiChoice(sentMsg, choiceCount);
        if (choices.length === 0) {
            await channel.send({ embeds: [buildEmbed(t('pipeline.rejected'), EmbedColor.Error)] });
            return { confirmed: false };
        }
        if (choices.length === 1 && choices[0] === 0) {
            await channel.send({ embeds: [buildEmbed(t('pipeline.agentDelegated'), EmbedColor.Info)] });
            return { confirmed: false, agentDelegated: true };
        }
        if (choices[0] === -1) {
            await channel.send({ embeds: [buildEmbed(t('pipeline.allSelected'), EmbedColor.Success)] });
        } else {
            await channel.send({ embeds: [buildEmbed(t('pipeline.choicesSelected', choices.join(', ')), EmbedColor.Success)] });
        }
        plan.status = 'active';
        return { confirmed: true, selectedChoices: choices };
    }
    if (choiceMode === 'single') {
        const choiceCount = countChoiceItems(plan.discord_templates.confirm);
        const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
        const choice = await bot.waitForChoice(sentMsg, choiceCount);
        if (choice === -1) {
            await channel.send({ embeds: [buildEmbed(t('pipeline.rejected'), EmbedColor.Error)] });
            return { confirmed: false };
        }
        if (choice === 0) {
            await channel.send({ embeds: [buildEmbed(t('pipeline.agentDelegated'), EmbedColor.Info)] });
            return { confirmed: false, agentDelegated: true };
        }
        await channel.send({ embeds: [buildEmbed(t('pipeline.choiceApproved', String(choice)), EmbedColor.Success)] });
        plan.status = 'active';
        return { confirmed: true, selectedChoices: [choice] };
    }
    // choiceMode === 'none'
    const sentMsg = await channel.send({ embeds: [buildEmbed(confirmMsg, EmbedColor.Warning)] });
    const confirmed = await bot.waitForConfirmation(sentMsg);
    if (!confirmed) {
        await channel.send({ embeds: [buildEmbed(t('pipeline.rejected'), EmbedColor.Error)] });
        return { confirmed: false };
    }
    plan.status = 'active';
    return { confirmed: true };
}

/**
 * 選択結果を plan.prompt の先頭に付加する。
 * single/multi の場合のみ。全選択（[-1]）の場合は修正不要。
 */
export function applyChoiceSelection(plan: Plan, selectedChoices?: number[]): void {
    if (!selectedChoices || selectedChoices.length === 0) { return; }
    // 全選択（[-1]）の場合は prompt 修正不要
    if (selectedChoices.length === 1 && selectedChoices[0] === -1) { return; }
    const choiceStr = selectedChoices.join(', ');
    plan.prompt = `${t('pipeline.choicePrefix', choiceStr)}\n\n${plan.prompt}`;
    logDebug(`messageHandler: applied choice selection [${choiceStr}] to plan prompt`);
}

// ---------------------------------------------------------------------------
// Plan ディスパッチ
// ---------------------------------------------------------------------------

/**
 * Plan を即時実行キューに追加、または定期スケジュールとして登録する。
 * チームモード有効時は teamOrchestrator 経由でサブエージェントに委譲する。
 */
export async function dispatchPlan(
    ctx: BridgeContext,
    plan: Plan,
    channel: TextChannel,
    activeCdp: CdpBridge,
    wsNameFromCategory: string | undefined,
    guild: typeof import('discord.js').Guild.prototype | null,
    isTeamMode = false,
    autoMode = false,
): Promise<void> {
    const { bot, fileIpc, planStore, executor, executorPool, scheduler } = ctx;

    if (plan.cron === null) {
        const wsNameForImmediate = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
        if (wsNameForImmediate) { plan.workspace_name = wsNameForImmediate; }
        plan.notify_channel_id = channel.id;

        // -------------------------------------------------------------------
        // オートモード: 確認ステップスキップ → 直接実行キューに追加
        // -------------------------------------------------------------------
        if (autoMode) {
            logDebug(`dispatchPlan: Auto mode — skipping confirmation, direct execution (plan=${plan.plan_id})`);
            if (executorPool) {
                await executorPool.enqueueImmediate(wsNameForImmediate || '', plan);
            } else if (executor) {
                await executor.enqueueImmediate(plan);
            }
            return;
        }

        // -------------------------------------------------------------------
        // チームモード: IPC ファイルベースのオーケストレーション
        // -------------------------------------------------------------------
        let teamModeFallback = false; // チームモード分割失敗時のフォールバックフラグ
        if (isTeamMode && ctx.teamOrchestrator) {
            logDebug(`dispatchPlan: Team mode — IPC-based orchestration (workspace=${wsNameForImmediate || 'default'})`);

            // AI 委任方式: plan.tasks の有無でチームモード使用を判断
            // plan_generation フェーズで AI が tasks 配列を出力した場合のみチームモード実行
            // tasks がない場合はメインエージェント単独実行にフォールバック
            if (plan.tasks && plan.tasks.length > 1) {
                try {
                    await channel.send({ embeds: [buildEmbed(t('pipeline.teamSplitting', String(plan.tasks.length)), EmbedColor.Info)] });
                    logDebug(`dispatchPlan: Team mode — AI provided ${plan.tasks.length} tasks`);

                    // maxAgents に従ってグループ化（WS別のrepoRootを使用）
                    const teamRepoRoot = (() => {
                        if (wsNameFromCategory) {
                            const wsPaths = ctx.cdpPool?.getResolvedWorkspacePaths() ?? {};
                            if (wsPaths[wsNameFromCategory]) { return wsPaths[wsNameFromCategory]; }
                        }
                        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    })();
                    const teamConfig = loadTeamConfig(teamRepoRoot);
                    const tasks = ctx.teamOrchestrator.groupTasks(plan.tasks, teamConfig.maxAgents);
                    logDebug(`dispatchPlan: Team mode — grouped ${plan.tasks.length} tasks into ${tasks.length} groups (maxAgents=${teamConfig.maxAgents})`);

                    const teamRequestId = `${Date.now()}`;
                    const instructions = ctx.teamOrchestrator.writeInstructionFiles(
                        tasks,
                        teamRequestId,
                        plan.prompt, // 元のユーザーリクエストをコンテキストとして渡す
                    );

                    await channel.send({ embeds: [buildEmbed(t('pipeline.taskAssigned', String(plan.tasks.length), String(tasks.length)), EmbedColor.Info)] });

                    // Phase 3~5: サブエージェント起動 → 実行 → レスポンス収集
                    const abortController = new AbortController();
                    setTeamAbortController(abortController);
                    let teamResult: Awaited<ReturnType<typeof ctx.teamOrchestrator.orchestrateTeam>> | null = null;

                    try {
                        teamResult = await ctx.teamOrchestrator.orchestrateTeam(
                            instructions,
                            channel.id,
                            wsNameForImmediate,
                            abortController.signal,
                        );

                        // Phase 5: 報告 IPC ファイルを生成 → メインエージェントに報告プロンプト送信
                        const { requestId: reportReqId, responsePath: reportResponsePath } = fileIpc!.createRequestId();
                        logDebug(`dispatchPlan: Team mode — reportReqId=${reportReqId}, reportResponsePath=${reportResponsePath}`);
                        const reportPath = ctx.teamOrchestrator.writeReportFile(
                            teamRequestId,
                            teamResult.results,
                            instructions,
                            reportResponsePath,
                        );

                        // メインエージェントに報告プロンプトを送信（ファイル読み取り方式）:
                        // 指示の詳細は report_instruction.json に含まれるため、CDP経由では短い指示のみ送信
                        const { instructionPath: reportInstructionPath, progressPath: reportProgressPath } = ctx.teamOrchestrator.writeReportInstructionFile(
                            teamRequestId,
                            reportPath,
                            reportResponsePath,
                        );
                        const reportPrompt =
                            `あなたはメインエージェントです。以下のファイルを view_file ツールで読み込み、その指示に従ってください。` +
                            `ファイルパス: ${reportInstructionPath}`;

                        logDebug(`dispatchPlan: Team mode — sending report prompt to main Cascade (${reportPrompt.length} chars)`);

                        await activeCdp.sendPrompt(reportPrompt);
                        logDebug('dispatchPlan: Team mode — report prompt sent, waiting for response...');

                        // メインエージェントの統合レポートを待機（進捗ポーリング付き）
                        const cascadeReportTimeoutMs = 300_000;
                        fileIpc!.registerActiveRequest(reportReqId);

                        // 進捗ポーリング: メインエージェントの progress.json を 3 秒間隔で監視し Discord に中継
                        let lastReportProgress = '';
                        const reportProgressInterval = setInterval(async () => {
                            try {
                                const progress = await fileIpc!.readProgress(reportProgressPath);
                                if (progress) {
                                    const currentContent = JSON.stringify(progress);
                                    if (currentContent !== lastReportProgress) {
                                        lastReportProgress = currentContent;
                                        const percentStr = progress.percent !== undefined ? ` (${progress.percent}%)` : '';
                                        const detail = progress.detail ? `\n> ${progress.detail}` : '';
                                        await channel.send({ embeds: [buildEmbed(`⏳ ${progress.status || t('pipeline.integrating')}${percentStr}${detail}`, EmbedColor.Progress)] });
                                    }
                                }
                            } catch { /* ignore */ }
                        }, 3_000);

                        // 8秒間隔のタイピングインジケーター（メインチャット）
                        const reportTypingInterval = setInterval(async () => {
                            try { await channel.sendTyping(); } catch (e) { logDebug(`dispatchPlan: report sendTyping failed: ${e}`); }
                        }, 8_000);
                        try { await channel.sendTyping(); } catch (e) { logDebug(`dispatchPlan: report sendTyping failed: ${e}`); }

                        try {
                            const cascadeResponse = await fileIpc!.waitForResponse(reportResponsePath, cascadeReportTimeoutMs);
                            logDebug(`dispatchPlan: Team mode — received Cascade integrated report (${cascadeResponse.length} chars)`);

                            // 統合レポートを処理して Discord に送信（通常モードと同じパイプライン）
                            const teamCallbacks: TeamResponseCallbacks = {
                                sendToChannel: async (channelId, message, color) => {
                                    await bot!.sendToChannel(channelId, message, color);
                                },
                                sendFileToChannel: async (channelId, filePath, comment) => {
                                    return bot!.sendFileToChannel(channelId, filePath, comment);
                                },
                                sendEmbeds: async (descriptions, color) => {
                                    const embeds = descriptions.map((desc) =>
                                        new EmbedBuilder()
                                            .setDescription(desc)
                                            .setColor(color)
                                    );
                                    await channel.send({ embeds });
                                },
                                sendSuggestionButtons: async (suggestions) => {
                                    const row = buildSuggestionRow(suggestions);
                                    if (row) {
                                        storeSuggestions(channel.id, suggestions);
                                        const suggestionText = buildSuggestionContent(suggestions);
                                        const suggestionEmbed = buildEmbed(suggestionText, EmbedColor.Suggest);
                                        await bot!.sendComponentsToChannel(channel.id, [row], suggestionEmbed);
                                    }
                                },
                            };
                            await sendTeamResponse({
                                response: cascadeResponse,
                                responsePath: reportResponsePath,
                                plan,
                                channelId: channel.id,
                                callbacks: teamCallbacks,
                            });
                            logInfo('dispatchPlan: Team mode — integrated report sent to Discord ✅');
                        } finally {
                            clearInterval(reportProgressInterval);
                            clearInterval(reportTypingInterval);
                            fileIpc!.cleanupProgress(reportProgressPath).catch(() => { });
                            fileIpc!.unregisterActiveRequest(reportReqId);
                        }
                    } catch (cascadeErr) {
                        // Cascade 送信/待機に失敗した場合はフォールバック: 個別結果を直接送信
                        logWarn(`dispatchPlan: Team mode — failed to get integrated report, falling back: ${cascadeErr instanceof Error ? cascadeErr.message : cascadeErr}`);
                        await channel.send({ embeds: [buildEmbed(t('pipeline.reportFailed'), EmbedColor.Warning)] });

                        // フォールバック: 各サブエージェントの結果を個別に送信
                        if (teamResult) {
                            for (const result of teamResult.results) {
                                const statusEmoji = result.success ? '✅' : '❌';
                                const resultPreview = result.response.substring(0, 500) + (result.response.length > 500 ? '...' : '');
                                const normalized = normalizeHeadings(`${statusEmoji} **${result.agentName}**\n${resultPreview}`);
                                const embedGroups = splitForEmbeds(normalized);
                                for (const group of embedGroups) {
                                    const embeds = group.map((desc) =>
                                        new EmbedBuilder()
                                            .setDescription(desc)
                                            .setColor(result.success ? EmbedColor.Success : EmbedColor.Error)
                                    );
                                    await channel.send({ embeds });
                                }
                            }
                        }
                    } finally {
                        setTeamAbortController(null);
                    }
                    return;
                } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    logError(`dispatchPlan: Team orchestration failed: ${errMsg}`, e);
                    await channel.send({ embeds: [buildEmbed(t('pipeline.teamError', sanitizeErrorForDiscord(errMsg)), EmbedColor.Error)] });
                    teamModeFallback = true;
                }
            } else {
                // plan.tasks がない → AI がチームモード不要と判断
                logDebug('dispatchPlan: Team mode — no plan.tasks provided by AI, falling back to normal mode');
                await channel.send({ embeds: [buildEmbed(t('pipeline.normalMode'), EmbedColor.Info)] });
                teamModeFallback = true;
            }

            if (!teamModeFallback) {
                return;
            }
            logDebug('dispatchPlan: Team mode fallback — continuing to normal mode execution');
        }

        // -------------------------------------------------------------------
        // 通常モード: executor / executorPool 経由
        // -------------------------------------------------------------------
        logDebug(`handleDiscordMessage: enqueueing immediate execution for plan ${plan.plan_id} (not persisted, workspace=${wsNameForImmediate || 'default'})`);
        if (executorPool) {
            await executorPool.enqueueImmediate(wsNameForImmediate || '', plan);
        } else if (executor) {
            await executor.enqueueImmediate(plan);
        }
    } else {
        logDebug(`handleDiscordMessage: registering scheduled plan ${plan.plan_id} with cron = ${plan.cron} `);
        if (guild && bot) {
            const prefix = cronToPrefix(plan.cron!);
            const baseName = plan.human_summary || plan.plan_id;
            const chName = `${prefix} ${baseName} `;
            const wsName = wsNameFromCategory || activeCdp.getActiveWorkspaceName() || undefined;
            if (wsName) { plan.workspace_name = wsName; }
            const planChannelId = await bot.createPlanChannel(guild.id, chName, wsName);
            if (planChannelId) {
                plan.channel_id = planChannelId;
                plan.notify_channel_id = planChannelId;
                logDebug(`handleDiscordMessage: created plan channel ${planChannelId} for plan ${plan.plan_id} (workspace=${wsName || 'default'})`);
            }
        }

        planStore!.add(plan);
        scheduler!.register(plan);
        const channelMention = plan.channel_id ? `<#${plan.channel_id}> ` : '#schedule';
        await channel.send({ embeds: [buildEmbed(t('pipeline.scheduled', plan.cron || '', plan.timezone, channelMention), EmbedColor.Success)] });
    }
}
