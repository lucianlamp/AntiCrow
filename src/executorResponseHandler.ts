// ---------------------------------------------------------------------------
// executorResponseHandler.ts — レスポンス処理モジュール
// ---------------------------------------------------------------------------
// Executor から分離。レスポンス受信後のメモリ抽出、提案パース、
// ファイル参照送信、成功通知の構築を担当。
// ---------------------------------------------------------------------------

import { Plan, PlanExecution } from './types';
import { FileIpc } from './fileIpc';
import { PlanStore } from './planStore';
import { extractMemoryTags, appendToGlobalMemory, appendToWorkspaceMemory, stripMemoryTags } from './memoryStore';
import { logDebug, logError } from './logger';
import { buildEmbed, EmbedColor } from './embedHelper';
import { parseSuggestions, SuggestionItem } from './suggestionParser';
import { buildSuggestionRow, buildSuggestionContent, storeSuggestions } from './suggestionButtons';
import { getWorkspacePaths } from './configHelper';
import { t } from './i18n';
import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from 'discord.js';

// ---------------------------------------------------------------------------
// 型定義（Executor から re-export される）
// ---------------------------------------------------------------------------
export type NotifyFunc = (channelId: string, message: string, color?: number) => Promise<void>;
export type SendTypingFunc = (channelId: string) => Promise<void>;
export type PostSuggestionsFunc = (channelId: string, components: ActionRowBuilder<ButtonBuilder>[], embed?: EmbedBuilder) => Promise<void>;
export type SendFileResult = { sent: boolean; reason?: 'not_found' | 'too_large' | 'channel_error'; sizeMB?: string; fileName?: string };
export type SendFileFunc = (channelId: string, filePath: string, comment?: string) => Promise<SendFileResult>;

// ---------------------------------------------------------------------------
// レスポンスコンテンツ処理
// ---------------------------------------------------------------------------

interface ProcessedResponse {
    /** クリーンなコンテンツ（メモリタグ・提案タグ除去済み） */
    cleanContent: string;
    /** 提案リスト */
    suggestions: SuggestionItem[];

    /** 送信用テキスト（prefix 付き） */
    resultMsg: string;
}

/** レスポンスコンテンツを処理してクリーンなメッセージを生成 */
function processResponseContent(response: string, responsePath: string, plan: Plan): ProcessedResponse {
    // Markdown レスポンスはそのまま Discord に送信（JSON の場合はフォールバック展開）
    const isMarkdown = responsePath.endsWith('.md');
    const content = isMarkdown ? response.trim() : FileIpc.extractResult(response);

    // MEMORY タグを除去
    const memoryCleanContent = stripMemoryTags(content);

    // 提案タグを抽出してクリーンコンテンツを取得
    const { suggestions, cleanContent } = parseSuggestions(memoryCleanContent);

    // 成功通知（重複タイトル防止）
    const prefix = plan.discord_templates.run_success_prefix || t('response.successDefault');
    const prefixCore = prefix.replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
    const contentStart = cleanContent.substring(0, 100).replace(/[\s*]/g, '').replace(/^[^\p{L}\p{N}]+/u, '');
    const isDuplicate = prefixCore.length > 0 && contentStart.startsWith(prefixCore);
    const resultMsg = isDuplicate ? cleanContent : `${prefix}\n${cleanContent}`;

    return { cleanContent, suggestions, resultMsg };
}

// ---------------------------------------------------------------------------
// メモリ抽出・書き込み
// ---------------------------------------------------------------------------

/** レスポンスからメモリタグを抽出して MEMORY.md に書き込み */
function extractAndSaveMemory(response: string, responsePath: string, plan: Plan): void {
    const isMarkdown = responsePath.endsWith('.md');
    const content = isMarkdown ? response.trim() : FileIpc.extractResult(response);

    try {
        const memoryEntries = extractMemoryTags(content);
        if (memoryEntries.length > 0) {
            const wsPaths = getWorkspacePaths();
            const wsPath = plan.workspace_name ? wsPaths[plan.workspace_name] : undefined;
            for (const entry of memoryEntries) {
                if (entry.scope === 'global') {
                    appendToGlobalMemory(entry.content);
                    logDebug(`ResponseHandler: auto-recorded global memory (${entry.content.length} chars)`);
                } else if (entry.scope === 'workspace' && wsPath) {
                    appendToWorkspaceMemory(wsPath, entry.content);
                    logDebug(`ResponseHandler: auto-recorded workspace memory (${entry.content.length} chars)`);
                }
            }
            logDebug(`ResponseHandler: extracted ${memoryEntries.length} memory entries from response`);
        }
    } catch (e) {
        logDebug(`ResponseHandler: memory extraction failed: ${e instanceof Error ? e.message : e}`);
    }
}

// ---------------------------------------------------------------------------
// ファイル参照送信
// ---------------------------------------------------------------------------

/** レスポンス内のファイル参照を抽出して Discord に送信し、送信済み参照を除去 */
async function sendFileReferences(
    resultMsg: string,
    notifyChannel: string,
    sendFile: SendFileFunc,
    safeNotify: (channelId: string, message: string, color?: number) => Promise<void>,
): Promise<string> {
    try {
        const { extractFileReferences, stripFileReferences } = await import('./fileExtractor');
        const fileRefs = extractFileReferences(resultMsg);
        if (fileRefs.length > 0) {
            const sentPaths = new Set<string>();
            for (const ref of fileRefs) {
                try {
                    const result = await sendFile(notifyChannel, ref.path, ref.label ? `📎 ${ref.label}` : undefined);
                    if (result.sent) {
                        sentPaths.add(ref.path);
                        logDebug(`ResponseHandler: sent file ${ref.path} to channel ${notifyChannel}`);
                    } else {
                        let skipMsg: string;
                        if (result.reason === 'too_large') {
                            skipMsg = t('response.file.tooLarge', result.sizeMB || '?', result.fileName || ref.path);
                        } else if (result.reason === 'not_found') {
                            skipMsg = t('response.file.notFound', ref.path);
                        } else {
                            skipMsg = t('response.file.sendFailed', result.fileName || ref.path);
                        }
                        await safeNotify(notifyChannel, skipMsg, EmbedColor.Warning);
                        logDebug(`ResponseHandler: file send skipped (${result.reason}): ${ref.path}`);
                    }
                } catch (e) {
                    logDebug(`ResponseHandler: file send error for ${ref.path}: ${e instanceof Error ? e.message : e}`);
                }
            }
            if (sentPaths.size > 0) {
                const stripped = stripFileReferences(resultMsg, sentPaths);
                logDebug(`ResponseHandler: stripped ${sentPaths.size} file references from response text`);
                return stripped;
            }
        }
    } catch (e) {
        logDebug(`ResponseHandler: file extraction failed: ${e instanceof Error ? e.message : e}`);
    }
    return resultMsg;
}

// ---------------------------------------------------------------------------
// 提案ボタン送信
// ---------------------------------------------------------------------------

/** 提案ボタンを Discord に送信 */
export async function sendSuggestionButtons(
    suggestions: SuggestionItem[],
    notifyChannel: string,
    postSuggestions: PostSuggestionsFunc,
): Promise<void> {
    if (suggestions.length === 0) { return; }
    try {
        const row = buildSuggestionRow(suggestions);
        if (row) {
            storeSuggestions(notifyChannel, suggestions);
            const suggestionText = buildSuggestionContent(suggestions);
            const suggestionEmbed = buildEmbed(suggestionText, EmbedColor.Suggest);
            await postSuggestions(notifyChannel, [row], suggestionEmbed);
            logDebug(`ResponseHandler: sent ${suggestions.length} suggestion buttons to channel ${notifyChannel}`);
        }
    } catch (e) {
        logDebug(`ResponseHandler: failed to send suggestion buttons: ${e instanceof Error ? e.message : e}`);
    }
}

// ---------------------------------------------------------------------------
// 実行履歴記録
// ---------------------------------------------------------------------------

/** 実行履歴を PlanStore に記録（定期実行 Plan のみ） */
export function recordExecution(
    planStore: PlanStore,
    plan: Plan,
    success: boolean,
    durationMs: number,
    resultPreview: string,
): void {
    // 即時実行 Plan は PlanStore に存在しないのでスキップ
    if (!planStore.get(plan.plan_id)) {
        logDebug(`ResponseHandler: skipping execution record for plan ${plan.plan_id} (not in PlanStore)`);
        return;
    }
    try {
        const execution: PlanExecution = {
            executed_at: new Date().toISOString(),
            success,
            duration_ms: durationMs,
            result_preview: resultPreview.substring(0, 200),
        };
        const existingExecutions = plan.executions || [];
        const executions = [execution, ...existingExecutions].slice(0, 10); // 直近10件
        planStore.update(plan.plan_id, {
            last_executed_at: execution.executed_at,
            execution_count: (plan.execution_count || 0) + 1,
            executions,
        });
        logDebug(`ResponseHandler: recorded execution for plan ${plan.plan_id} (success=${success}, ${durationMs}ms)`);
    } catch (e) {
        logError('ResponseHandler: failed to record execution', e);
    }
}

// ---------------------------------------------------------------------------
// 統合レスポンス処理（通常モード・チームモード共通）
// ---------------------------------------------------------------------------

/** レスポンス送信用コールバック（通常モード・チームモード共通） */
interface ResponseCallbacks {
    /** Discord チャンネルにメッセージを送信 */
    sendToChannel: (channelId: string, message: string, color?: number) => Promise<void>;
    /** Discord チャンネルにファイルを送信 */
    sendFileToChannel: (channelId: string, filePath: string, comment?: string) => Promise<SendFileResult>;
    /** Discord チャンネルに embed 群を送信 */
    sendEmbeds: (descriptions: string[], color: number) => Promise<void>;
    /** Discord チャンネルに提案ボタンを送信 */
    sendSuggestionButtons: (suggestions: SuggestionItem[]) => Promise<void>;
    /** 連続オートモード: レスポンス処理完了時のコールバック（SUGGESTIONS + クリーンコンテンツを受け取る） */
    onAutoModeComplete?: (suggestions: SuggestionItem[], cleanContent: string) => void;
}

/** 後方互換エイリアス */
export type TeamResponseCallbacks = ResponseCallbacks;

/**
 * レスポンスを処理して Discord に送信する統合関数。
 * 通常モード（executor.ts）とチームモード（planPipeline.ts）の両方で使用。
 *
 * 1. extractAndSaveMemory — MEMORY タグ抽出・保存
 * 2. processResponseContent — stripMemoryTags → parseSuggestions → prefix 生成
 * 3. sendFileReferences — ファイル参照の送信
 * 4. Discord 送信（呼び出し側が embed 構築を担当）
 * 5. 提案ボタン送信
 *
 * @returns cleanContent — MEMORY/SUGGESTIONS 除去後のクリーンテキスト（recordExecution 用）
 */
export async function sendProcessedResponse(options: {
    /** Cascade からの生のレスポンス文字列 */
    response: string;
    /** レスポンスファイルのパス（.md or .json） */
    responsePath: string;
    /** 実行計画 */
    plan: Plan;
    /** Discord チャンネル ID */
    channelId: string;
    /** Discord 送信用コールバック */
    callbacks: ResponseCallbacks;
}): Promise<{ cleanContent: string; suggestions: SuggestionItem[] }> {
    const { response, responsePath, plan, channelId, callbacks } = options;

    // 1. MEMORY タグ抽出・保存
    extractAndSaveMemory(response, responsePath, plan);

    // 2. レスポンスコンテンツ処理（stripMemoryTags → parseSuggestions → prefix 生成）
    const { cleanContent, suggestions, resultMsg } = processResponseContent(response, responsePath, plan);

    // 3. ファイル参照送信
    const finalContent = await sendFileReferences(
        resultMsg,
        channelId,
        callbacks.sendFileToChannel,
        callbacks.sendToChannel,
    );

    // 4. Discord 送信（embed 構築は呼び出し側に委譲）
    const { normalizeHeadings } = await import('./embedHelper');
    const { splitForEmbeds } = await import('./discordFormatter');
    const normalized = normalizeHeadings(finalContent);
    const embedGroups = splitForEmbeds(normalized);
    for (const group of embedGroups) {
        await callbacks.sendEmbeds(group, EmbedColor.Response);
    }

    // 5. 提案ボタン送信
    // 連続オートモード中でも onAutoModeComplete が設定されていない場合（チームモード完了など）は送信する
    const { isAutoModeActive } = await import('./autoModeController');
    const suppressSuggestions = isAutoModeActive() && !!callbacks.onAutoModeComplete;
    if (suggestions.length > 0 && !suppressSuggestions) {
        try {
            await callbacks.sendSuggestionButtons(suggestions);
            logDebug(`ResponseHandler: sent ${suggestions.length} suggestion buttons`);
        } catch (e) {
            logDebug(`ResponseHandler: failed to send suggestion buttons: ${e instanceof Error ? e.message : e}`);
        }
    } else if (suggestions.length > 0 && suppressSuggestions) {
        logDebug(`ResponseHandler: skipping suggestion buttons (auto mode active with onAutoModeComplete)`);
    }

    // 6. 連続オートモードコールバック（SUGGESTIONS + クリーンコンテンツを通知）
    if (callbacks.onAutoModeComplete) {
        try {
            callbacks.onAutoModeComplete(suggestions, cleanContent);
            logDebug(`ResponseHandler: invoked onAutoModeComplete callback (${suggestions.length} suggestions)`);
        } catch (e) {
            logDebug(`ResponseHandler: onAutoModeComplete callback failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    logDebug(`ResponseHandler: response processing complete`);

    return { cleanContent, suggestions };
}

/** 後方互換エイリアス */
export const sendTeamResponse = sendProcessedResponse;

