// ---------------------------------------------------------------------------
// autoModeController.ts — オートモードの心臓部
// ---------------------------------------------------------------------------
// 責務:
//   1. オートモードのライフサイクル管理（開始・停止・一時停止）
//   2. ステップループの制御（次ステップのプロンプト構築・投入）
//   3. セーフティガード（DANGEROUS_PATTERNS による事前チェック）
//   4. Discord 通知（開始・ステップ完了・セーフティ警告・終了サマリー）
//   5. Phase 2: selectionMode / confirmMode / diffSummary
// ---------------------------------------------------------------------------

import type { TextChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { SuggestionItem } from './suggestionParser';
import { AUTO_PROMPT, getAllSuggestions, storeSuggestions } from './suggestionButtons';
import { t } from './i18n';
import { buildEmbed, EmbedColor } from './embedHelper';
import { logDebug, logInfo, logError, logWarn } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { buildHistoryEntry, saveHistory } from './autoModeHistory';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** オートモードの実行状態 */
export interface AutoModeState {
    active: boolean;
    channelId: string;
    wsKey: string;
    currentStep: number;
    maxSteps: number;
    maxDuration: number;       // ミリ秒
    startedAt: number;         // Date.now()
    config: AutoModeConfig;
    history: StepResult[];
    paused: boolean;           // セーフティ一時停止
    originalPrompt: string;    // ユーザーの初期プロンプト
    autoApproveWasEnabled: boolean; // 元の autoApprove 状態を保持
    isTeamMode: boolean;       // チームモードでの実行かどうか（Phase 3）
}

/** オートモードの設定 */
export interface AutoModeConfig {
    /** 次のアクション決定方法（Phase 1: auto-delegate のみ） */
    selectionMode: 'auto-delegate' | 'first' | 'ai-select';
    /** ステップ間の確認方式（Phase 1: auto のみ） */
    confirmMode: 'auto' | 'semi' | 'manual';
    /** ループの最大反復回数（デフォルト: 5） */
    maxSteps: number;
    /** タイムアウト（デフォルト: 30分 = 1800000ms） */
    maxDuration: number;
}

/** ステップの実行結果 */
export interface StepResult {
    step: number;
    prompt: string;
    response: string;
    suggestions: SuggestionItem[];
    duration: number;          // ミリ秒
    safetyResult: SafetyCheckResult;
}

/** セーフティチェック結果 */
export interface SafetyCheckResult {
    safe: boolean;
    reason?: string;
    severity?: 'block' | 'warn';
    pattern?: string;
}

// ---------------------------------------------------------------------------
// DANGEROUS_PATTERNS — 21パターン全定義
// ---------------------------------------------------------------------------

interface DangerousPattern {
    pattern: RegExp;
    reason: string;
    severity: 'block' | 'warn';
    category: string;
}

/**
 * セーフティガード用の危険パターン一覧（21パターン）。
 * autoModeController（レイヤーA）と cdpUI（レイヤーC）の両方で使用する。
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
    // ----- ファイルシステム破壊（3パターン） -----
    {
        pattern: /rm\s+-rf|rmdir\s+\/s/i,
        reason: '再帰的ファイル削除',
        severity: 'block',
        category: 'filesystem',
    },
    {
        pattern: />\s*\/dev\/null|truncate/i,
        reason: 'ファイル内容破壊',
        severity: 'block',
        category: 'filesystem',
    },
    {
        pattern: /format\s+[a-z]:|diskpart/i,
        reason: 'ディスクフォーマット',
        severity: 'block',
        category: 'filesystem',
    },

    // ----- Git破壊操作（3パターン） -----
    {
        pattern: /git\s+reset\s+--hard/i,
        reason: 'コミット履歴の強制リセット',
        severity: 'block',
        category: 'git',
    },
    {
        pattern: /git\s+push\s+--force|git\s+push\s+-f/i,
        reason: '強制プッシュ',
        severity: 'warn',
        category: 'git',
    },
    {
        pattern: /git\s+clean\s+-fd/i,
        reason: '未追跡ファイルの強制削除',
        severity: 'warn',
        category: 'git',
    },

    // ----- DB破壊（2パターン） -----
    {
        pattern: /DROP\s+(TABLE|DATABASE)/i,
        reason: 'テーブル/DB削除',
        severity: 'block',
        category: 'database',
    },
    {
        pattern: /TRUNCATE\s+TABLE/i,
        reason: 'テーブル全件削除',
        severity: 'block',
        category: 'database',
    },

    // ----- 暗号資産保護（10パターン） -----
    {
        pattern: /private[_\s]?key|secret[_\s]?key/i,
        reason: '秘密鍵へのアクセス',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /seed[_\s]?phrase|mnemonic|recovery[_\s]?phrase/i,
        reason: 'シードフレーズへのアクセス',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /keypair.*export|export.*keypair/i,
        reason: 'キーペアのエクスポート',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /solana.*keypair|phantom.*seed|metamask.*seed|backpack.*seed/i,
        reason: 'ウォレット固有の秘密情報',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /\.json.*keypair|id\.json|devnet\.json/i,
        reason: 'Solanaキーペアファイル',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /transfer.*all|drain.*wallet|sweep.*funds/i,
        reason: '資金ドレイン',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /withdraw.*max|withdraw.*all|empty.*wallet/i,
        reason: '全額出金',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /curl.*secret|fetch.*private_key|post.*mnemonic/i,
        reason: '秘密情報の外部送信',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /\.env.*(cat|type|echo|print|log)/i,
        reason: '.envファイルの内容出力',
        severity: 'block',
        category: 'crypto',
    },
    {
        pattern: /api[_\s]?key.*(curl|fetch|post|send)/i,
        reason: 'APIキーの外部送信',
        severity: 'block',
        category: 'crypto',
    },

    // ----- プロンプトインジェクション（3パターン） -----
    {
        pattern: /ignore\s+previous|disregard\s+instructions/i,
        reason: '指示無視攻撃',
        severity: 'warn',
        category: 'injection',
    },
    {
        pattern: /system\s+prompt|you\s+are\s+now/i,
        reason: 'システムプロンプト上書き',
        severity: 'warn',
        category: 'injection',
    },
    {
        pattern: /\beval\b|exec\(|Function\(/i,
        reason: '動的コード実行',
        severity: 'block',
        category: 'injection',
    },
];

// ---------------------------------------------------------------------------
// デフォルト設定
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AutoModeConfig = {
    selectionMode: 'auto-delegate',
    confirmMode: 'auto',
    maxSteps: 5,
    maxDuration: 30 * 60 * 1000, // 30分
};

/** 類似度閾値（直前2ステップのレスポンスがこの割合以上似ていたら停止） */
const SIMILARITY_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// 状態管理（シングルトン — 同時実行は1つのみ）
// ---------------------------------------------------------------------------

let currentState: AutoModeState | null = null;

/** 一時停止中の resolve コールバック（セーフティ応答待ち） */
let pauseResolve: ((action: 'approve' | 'skip' | 'stop') => void) | null = null;

/** 確認モード一時停止中の resolve コールバック（continue/stop 応答待ち） */
let confirmResolve: ((action: 'continue' | 'stop') => void) | null = null;

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 現在のオートモード状態を取得する。
 * オートモードが非アクティブの場合は null を返す。
 */
export function getAutoModeState(): AutoModeState | null {
    return currentState;
}

/**
 * オートモードがアクティブかどうかを返す。
 */
export function isAutoModeActive(): boolean {
    return currentState?.active === true;
}

/**
 * オートモードを開始する。
 * - autoApprove を有効化
 * - Discord に開始通知
 * - 初回プロンプトを投入
 *
 * @param channel Discord テキストチャンネル
 * @param wsKey ワークスペースキー
 * @param prompt ユーザーの初期プロンプト
 * @param config オプションの設定（省略時はデフォルト）
 * @returns 投入するプロンプトテキスト（呼び出し元が planPipeline に渡す）
 */
export async function startAutoMode(
    channel: TextChannel,
    wsKey: string,
    prompt: string,
    config?: Partial<AutoModeConfig>,
    isTeamMode: boolean = false,
): Promise<string> {
    // 既にアクティブなら停止
    if (currentState?.active) {
        logWarn('autoMode: already active, stopping previous session');
        await stopAutoMode(channel, 'new_session');
    }

    const mergedConfig: AutoModeConfig = { ...DEFAULT_CONFIG, ...config };

    currentState = {
        active: true,
        channelId: channel.id,
        wsKey,
        currentStep: 0,
        maxSteps: mergedConfig.maxSteps,
        maxDuration: mergedConfig.maxDuration,
        startedAt: Date.now(),
        config: mergedConfig,
        history: [],
        paused: false,
        originalPrompt: prompt,
        autoApproveWasEnabled: false, // 実際の値は呼び出し元で設定
        isTeamMode,
    };

    logInfo(`autoMode: started — prompt="${prompt.substring(0, 50)}..." maxSteps=${mergedConfig.maxSteps} teamMode=${isTeamMode}`);

    // Discord 開始通知
    try {
        const embed = buildEmbed(
            `🚀 **オートモード開始**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `📝 **タスク:** ${prompt.substring(0, 200)}\n`
            + `⚙️ **設定:** 最大${mergedConfig.maxSteps}ステップ / ${Math.round(mergedConfig.maxDuration / 60000)}分\n`
            + `🔒 **セーフティガード:** 有効`,
            EmbedColor.Info,
            true,
        );

        const stopButton = new ButtonBuilder()
            .setCustomId('auto_stop')
            .setLabel('停止')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
        logError('autoMode: failed to send start notification', e);
    }

    // 初回プロンプトを構築
    return buildAutoPrompt(channel.id, prompt);
}

/**
 * ステップ完了時のコールバック。
 * セーフティチェック → Discord 通知 → ループ継続判定 → 次ステップ投入。
 *
 * @param channel Discord テキストチャンネル
 * @param suggestions AI から返された提案一覧
 * @param responseContent レスポンスのクリーンコンテンツ
 * @returns 次のプロンプト（null = ループ終了）
 */
export async function onStepComplete(
    channel: TextChannel,
    suggestions: SuggestionItem[],
    responseContent: string,
): Promise<string | null> {
    if (!currentState?.active) {
        logDebug('autoMode: onStepComplete called but not active');
        return null;
    }

    const stepStartTime = currentState.history.length > 0
        ? currentState.history[currentState.history.length - 1].duration
        : currentState.startedAt;

    currentState.currentStep++;
    const stepDuration = Date.now() - (currentState.startedAt + currentState.history.reduce((sum, s) => sum + s.duration, 0));

    // セーフティチェック（レイヤーA: プリフライト）
    const safetyResult = checkSafety(responseContent);

    // ステップ結果を履歴に追加
    const stepResult: StepResult = {
        step: currentState.currentStep,
        prompt: currentState.history.length > 0
            ? currentState.history[currentState.history.length - 1].prompt
            : currentState.originalPrompt,
        response: responseContent.substring(0, 500), // 最初の500文字を保存
        suggestions,
        duration: stepDuration > 0 ? stepDuration : 0,
        safetyResult,
    };
    currentState.history.push(stepResult);

    // 提案を一時ストアに保存（次ステップのプロンプト構築で使用）
    if (suggestions.length > 0) {
        storeSuggestions(currentState.channelId, suggestions);
    }

    logInfo(`autoMode: step ${currentState.currentStep}/${currentState.maxSteps} completed (${formatDuration(stepDuration)})`);

    // セーフティチェック結果の処理
    if (!safetyResult.safe) {
        if (safetyResult.severity === 'block') {
            // 一時停止 + Discord 承認待ち
            const action = await pauseForSafety(channel, safetyResult);
            if (action === 'stop') {
                await stopAutoMode(channel, 'safety_stop');
                return null;
            }
            if (action === 'skip') {
                // このステップの結果をスキップして次ステップへ
                logInfo('autoMode: safety skip — proceeding to next step');
            }
            // approve の場合はそのまま続行
        } else {
            // warn: Discord に警告表示のみ、ループは続行
            await sendSafetyWarning(channel, safetyResult);
        }
    }

    // diffSummary を取得（Phase 2: ステップ間の変更差分）
    const diffSummary = await buildDiffSummary(currentState.wsKey);

    // ステップ完了通知（diffSummary を含む）
    await sendStepCompleteNotification(channel, stepResult, suggestions, diffSummary);

    // ループ継続判定
    const continueResult = shouldContinue(responseContent);
    if (!continueResult.shouldContinue) {
        await stopAutoMode(channel, continueResult.reason);
        return null;
    }

    // Phase 2: confirmMode による確認待ち
    const { confirmMode } = currentState.config;
    if (confirmMode === 'manual' || (confirmMode === 'semi' && currentState.currentStep % 2 === 0)) {
        const confirmAction = await pauseForConfirmation(channel);
        if (confirmAction === 'stop') {
            await stopAutoMode(channel, 'confirm_stop');
            return null;
        }
        // 'continue' ならそのまま続行
    }

    // 次ステップのプロンプトを構築
    return buildAutoPrompt(currentState.channelId);
}

/**
 * オートモードを停止する。
 * 状態をリセットし、Discord に終了サマリーを通知する。
 */
export async function stopAutoMode(
    channel: TextChannel,
    reason: string = 'manual',
): Promise<void> {
    if (!currentState) {
        logDebug('autoMode: stopAutoMode called but no state');
        return;
    }

    const state = currentState;
    currentState = null;
    pauseResolve = null;

    // Phase 3: 実行履歴の保存
    try {
        const historyEntry = buildHistoryEntry(
            state.channelId,
            state.wsKey,
            state.originalPrompt,
            state.config,
            state.startedAt,
            state.history,
            reason,
        );
        saveHistory(historyEntry);
    } catch (e) {
        logError('autoMode: 履歴の保存に失敗', e);
    }

    const totalDuration = Date.now() - state.startedAt;
    const safetyCount = state.history.filter(s => !s.safetyResult.safe).length;

    logInfo(`autoMode: stopped — reason=${reason} steps=${state.currentStep} duration=${formatDuration(totalDuration)}`);

    // 終了理由の決定
    let reasonText: string;
    switch (reason) {
        case 'max_steps':
            reasonText = `最大ステップ数（${state.maxSteps}）に到達しました`;
            break;
        case 'max_duration':
            reasonText = `最大実行時間（${Math.round(state.maxDuration / 60000)}分）に到達しました`;
            break;
        case 'completed':
            reasonText = '🎉 AIが全タスク完了と判断しました';
            break;
        case 'similarity':
            reasonText = '⚠️ 直前のステップと類似した結果が検出されました（無限ループ防止）';
            break;
        case 'safety_stop':
            reasonText = '🛑 セーフティガードによりユーザーが停止しました';
            break;
        case 'confirm_stop':
            reasonText = '🛑 確認モードによりユーザーが停止しました';
            break;
        case 'new_session':
            reasonText = '新しいオートモードセッションが開始されました';
            break;
        case 'error':
            reasonText = '⚠️ エラーが発生しました';
            break;
        default:
            reasonText = 'ユーザーが手動で停止しました';
    }

    // Discord 終了サマリー通知
    try {
        const historyLines = state.history.map((s) => {
            const emoji = s.safetyResult.safe ? '✅' : '⚠️';
            const summary = s.response.substring(0, 60).replace(/\n/g, ' ');
            return `  ${s.step}. ${emoji} ${summary} (${formatDuration(s.duration)})`;
        }).join('\n');

        const embed = buildEmbed(
            `📊 **オートモード完了**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `✅ **完了ステップ:** ${state.currentStep}/${state.maxSteps}\n`
            + `⏱️ **合計時間:** ${formatDuration(totalDuration)}\n`
            + `🛡️ **セーフティ発動:** ${safetyCount}回\n\n`
            + (historyLines ? `📋 **実行履歴:**\n${historyLines}\n\n` : '')
            + reasonText,
            EmbedColor.Success,
            true,
        );

        await channel.send({ embeds: [embed] });
    } catch (e) {
        logError('autoMode: failed to send stop notification', e);
    }
}

/**
 * セーフティ一時停止からの応答を処理する。
 * slashHandler.ts のボタンハンドラから呼び出される。
 */
export function handleSafetyResponse(action: 'approve' | 'skip' | 'stop'): void {
    if (pauseResolve) {
        logInfo(`autoMode: safety response received — action=${action}`);
        pauseResolve(action);
        pauseResolve = null;
    } else {
        logWarn('autoMode: safety response received but no pause in progress');
    }
}

/**
 * Phase 2: 確認モードの応答を処理する。
 * slashHandler.ts のボタンハンドラから呼び出される。
 */
export function handleConfirmResponse(action: 'continue' | 'stop'): void {
    if (confirmResolve) {
        logInfo(`autoMode: confirm response received — action=${action}`);
        confirmResolve(action);
        confirmResolve = null;
    } else {
        logWarn('autoMode: confirm response received but no confirm pause in progress');
    }
}

/**
 * オートモードでエラーが発生した場合の処理。
 * ループを停止し、Discord に通知する。
 */
export async function handleAutoModeError(
    channel: TextChannel,
    error: unknown,
): Promise<void> {
    logError('autoMode: error occurred', error);
    await stopAutoMode(channel, 'error');
}

// ---------------------------------------------------------------------------
// プロンプト構築
// ---------------------------------------------------------------------------

/**
 * オートモード用のプロンプトを構築する。
 * Phase 2: selectionMode に応じた3分岐を実装。
 *
 * - 'auto-delegate': AUTO_PROMPT + SUGGESTIONSコンテキスト（Phase 1 デフォルト）
 * - 'first': SUGGESTIONS[0] のプロンプトをそのまま投入。なければ auto-delegate フォールバック
 * - 'ai-select': 全SUGGESTIONSをプロンプトに含め、AIに最適なものを選ばせる
 *
 * @param channelId チャンネルID（提案の取得用）
 * @param initialPrompt 初回プロンプト（省略時は AUTO_PROMPT ベース）
 * @returns 構築されたプロンプトテキスト
 */
export function buildAutoPrompt(channelId: string, initialPrompt?: string): string {
    const basePrompt = initialPrompt || AUTO_PROMPT;
    const selectionMode = currentState?.config.selectionMode ?? 'auto-delegate';

    // channelId に紐づく直前の提案を取得
    const suggestions = getAllSuggestions(channelId);

    // 初回プロンプトが明示的に指定されている場合は selectionMode を適用しない
    if (initialPrompt) {
        if (suggestions && suggestions.length > 0) {
            const suggestionContext = suggestions
                .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                .join('\n');
            return (t as any)('misc.suggest.autoPromptPrefix', suggestionContext, basePrompt);
        }
        return basePrompt;
    }

    // selectionMode に応じた分岐
    switch (selectionMode) {
        case 'first': {
            // SUGGESTIONS[0] のプロンプトをそのまま投入
            if (suggestions && suggestions.length > 0) {
                logInfo(`autoMode: selectionMode=first — using suggestion[0]: "${suggestions[0].label}"`);
                return suggestions[0].prompt;
            }
            // フォールバック: auto-delegate と同じ動作
            logInfo('autoMode: selectionMode=first — no suggestions, falling back to auto-delegate');
            return basePrompt;
        }

        case 'ai-select': {
            // 全SUGGESTIONSをプロンプトに含め、AIに選ばせる
            if (suggestions && suggestions.length > 0) {
                const suggestionContext = suggestions
                    .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                    .join('\n');
                logInfo(`autoMode: selectionMode=ai-select — ${suggestions.length} suggestions available`);
                return (t as any)('autoMode.aiSelectPrompt', suggestionContext, basePrompt);
            }
            // フォールバック: auto-delegate と同じ動作
            logInfo('autoMode: selectionMode=ai-select — no suggestions, falling back to auto-delegate');
            return basePrompt;
        }

        case 'auto-delegate':
        default: {
            // 既存の動作: AUTO_PROMPT + SUGGESTIONSコンテキスト
            if (suggestions && suggestions.length > 0) {
                const suggestionContext = suggestions
                    .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                    .join('\n');
                return (t as any)('misc.suggest.autoPromptPrefix', suggestionContext, basePrompt);
            }
            return basePrompt;
        }
    }
}

// ---------------------------------------------------------------------------
// セーフティガード
// ---------------------------------------------------------------------------

/**
 * レスポンスに対してセーフティチェックを実行する（レイヤーA: プリフライト）。
 * DANGEROUS_PATTERNS の各パターンとマッチングし、最初にヒットしたものを返す。
 */
export function checkSafety(text: string): SafetyCheckResult {
    for (const { pattern, reason, severity } of DANGEROUS_PATTERNS) {
        if (pattern.test(text)) {
            logWarn(`autoMode: safety check FAILED — pattern="${pattern.source}" reason="${reason}" severity=${severity}`);
            return { safe: false, reason, severity, pattern: pattern.source };
        }
    }
    logDebug('autoMode: safety check passed');
    return { safe: true };
}

// ---------------------------------------------------------------------------
// ループ継続判定
// ---------------------------------------------------------------------------

/**
 * ループを継続すべきかを判定する。
 * 3つのガードで無限ループを防止:
 *   1. maxSteps: ステップ数上限
 *   2. maxDuration: 時間上限
 *   3. 類似検知: 直前2ステップのレスポンスが閾値以上類似
 */
function shouldContinue(latestResponse: string): { shouldContinue: boolean; reason: string } {
    if (!currentState) {
        return { shouldContinue: false, reason: 'no_state' };
    }

    // ガード1: ステップ数上限
    if (currentState.currentStep >= currentState.maxSteps) {
        return { shouldContinue: false, reason: 'max_steps' };
    }

    // ガード2: 時間上限
    const elapsed = Date.now() - currentState.startedAt;
    if (elapsed >= currentState.maxDuration) {
        return { shouldContinue: false, reason: 'max_duration' };
    }

    // ガード3: AI が「完了」と判断したかのヒューリスティック
    const completionPhrases = [
        '全てのタスクが完了',
        'すべてのタスクが完了',
        '全てのステップが完了',
        '作業は完了',
        'all tasks completed',
        'all steps completed',
        '完了しました。追加の作業はありません',
    ];
    const lowerResponse = latestResponse.toLowerCase();
    for (const phrase of completionPhrases) {
        if (lowerResponse.includes(phrase.toLowerCase())) {
            return { shouldContinue: false, reason: 'completed' };
        }
    }

    // ガード4: 類似検知（直前2ステップ）
    if (currentState.history.length >= 2) {
        const prevResponse = currentState.history[currentState.history.length - 2].response;
        const similarity = calculateSimilarity(prevResponse, latestResponse);
        if (similarity >= SIMILARITY_THRESHOLD) {
            logWarn(`autoMode: similarity detected — ${(similarity * 100).toFixed(1)}%`);
            return { shouldContinue: false, reason: 'similarity' };
        }
    }

    return { shouldContinue: true, reason: '' };
}

/**
 * 2つのテキスト間の類似度を計算する（0〜1）。
 * 簡易的な Jaccard 類似度をトークン（単語）レベルで計算する。
 */
function calculateSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 2));
    const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 2));

    if (tokensA.size === 0 && tokensB.size === 0) return 1;
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const token of tokensA) {
        if (tokensB.has(token)) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// セーフティ一時停止
// ---------------------------------------------------------------------------

/**
 * 危険検知時にオートモードを一時停止し、Discord で承認待ちする。
 * ユーザーがボタンをクリックするまでブロックする。
 */
async function pauseForSafety(
    channel: TextChannel,
    safetyResult: SafetyCheckResult,
): Promise<'approve' | 'skip' | 'stop'> {
    if (!currentState) return 'stop';

    currentState.paused = true;
    logInfo(`autoMode: paused for safety — reason="${safetyResult.reason}"`);

    // Discord セーフティ警告通知
    try {
        const embed = buildEmbed(
            `🚨 **セーフティガード発動**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `⚠️ **危険なアクションを検知しました**\n\n`
            + `🔍 **検知内容:** ${safetyResult.reason}\n`
            + `📝 **パターン:** \`${safetyResult.pattern}\`\n\n`
            + `⏸️ オートモードを一時停止しました`,
            EmbedColor.Warning,
            true,
        );

        const approveBtn = new ButtonBuilder()
            .setCustomId('safety_approve')
            .setLabel('承認')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅');

        const skipBtn = new ButtonBuilder()
            .setCustomId('safety_skip')
            .setLabel('スキップ')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⏭️');

        const stopBtn = new ButtonBuilder()
            .setCustomId('safety_stop')
            .setLabel('停止')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🛑');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, skipBtn, stopBtn);

        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
        logError('autoMode: failed to send safety notification', e);
        currentState.paused = false;
        return 'stop';
    }

    // ユーザーの応答を Promise で待機
    return new Promise<'approve' | 'skip' | 'stop'>((resolve) => {
        pauseResolve = (action) => {
            if (currentState) {
                currentState.paused = false;
            }
            resolve(action);
        };

        // タイムアウト: 5分間応答がなければ自動停止
        setTimeout(() => {
            if (pauseResolve) {
                logWarn('autoMode: safety response timeout — auto-stopping');
                pauseResolve = null;
                if (currentState) {
                    currentState.paused = false;
                }
                resolve('stop');
            }
        }, 5 * 60 * 1000);
    });
}

// ---------------------------------------------------------------------------
// Discord 通知ヘルパー
// ---------------------------------------------------------------------------

/**
 * ステップ完了通知を Discord に送信する。
 * Phase 2: diffSummary をオプションで含める。
 */
async function sendStepCompleteNotification(
    channel: TextChannel,
    stepResult: StepResult,
    suggestions: SuggestionItem[],
    diffSummary?: string,
): Promise<void> {
    if (!currentState) return;

    const elapsed = Date.now() - currentState.startedAt;
    const progressPercent = Math.round((currentState.currentStep / currentState.maxSteps) * 100);
    const progressBar = buildProgressBar(progressPercent);

    // レスポンスの最初の1行をサマリーとして使用
    const responseSummary = stepResult.response.split('\n')[0].substring(0, 100);

    let suggestionText = '';
    if (suggestions.length > 0) {
        const lines = suggestions.map((s, i) => {
            const emojis = ['💡', '🔧', '🚀'];
            return `  ${i + 1}. ${emojis[i] || '💡'} ${s.label}`;
        });
        suggestionText = `\n\n💡 **AIが参照した提案:**\n${lines.join('\n')}`;
    }

    // Phase 2: diffSummary を通知に含める
    let diffText = '';
    if (diffSummary) {
        diffText = `\n\n📊 **変更差分:**\n\`\`\`\n${diffSummary}\`\`\``;
    }

    try {
        const embed = buildEmbed(
            `✅ **ステップ ${currentState.currentStep}/${currentState.maxSteps} 完了** (${formatDuration(stepResult.duration)})\n`
            + `━━━━━━━━━━━━━━━━━━━━\n\n`
            + `📄 ${responseSummary}`
            + suggestionText
            + diffText
            + `\n\n⏱️ **経過:** ${formatDuration(elapsed)} / ${Math.round(currentState.maxDuration / 60000)}分\n`
            + progressBar,
            EmbedColor.Progress,
        );

        const stopButton = new ButtonBuilder()
            .setCustomId('auto_stop')
            .setLabel('停止')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
        logError('autoMode: failed to send step notification', e);
        // 通知失敗でもループは続行
    }
}

/**
 * セーフティ警告（warn レベル）を Discord に送信する。
 * block とは異なり、ループは一時停止しない。
 */
async function sendSafetyWarning(
    channel: TextChannel,
    safetyResult: SafetyCheckResult,
): Promise<void> {
    try {
        const embed = buildEmbed(
            `⚠️ **セーフティ警告**\n\n`
            + `🔍 **検知内容:** ${safetyResult.reason}\n`
            + `📝 **パターン:** \`${safetyResult.pattern}\`\n\n`
            + `ℹ️ 重大度が低いため、ループは続行します。`,
            EmbedColor.Warning,
        );
        await channel.send({ embeds: [embed] });
    } catch (e) {
        logError('autoMode: failed to send safety warning', e);
    }
}

// ---------------------------------------------------------------------------
// Phase 2: 確認モード一時停止
// ---------------------------------------------------------------------------

/**
 * Phase 2: confirmMode の確認待ちでオートモードを一時停止する。
 * ユーザーが「続行」「停止」ボタンをクリックするまでブロックする。
 */
async function pauseForConfirmation(
    channel: TextChannel,
): Promise<'continue' | 'stop'> {
    if (!currentState) return 'stop';

    currentState.paused = true;
    logInfo(`autoMode: paused for confirmation — step=${currentState.currentStep} confirmMode=${currentState.config.confirmMode}`);

    // Discord 確認通知
    try {
        const embed = buildEmbed(
            (t as any)('autoMode.confirm.prompt', currentState.currentStep, currentState.maxSteps),
            EmbedColor.Info,
            true,
        );

        const continueBtn = new ButtonBuilder()
            .setCustomId('confirm_continue')
            .setLabel((t as any)('autoMode.confirm.continueBtn'))
            .setStyle(ButtonStyle.Success)
            .setEmoji('▶️');

        const stopBtn = new ButtonBuilder()
            .setCustomId('confirm_stop')
            .setLabel((t as any)('autoMode.confirm.stopBtn'))
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🛑');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(continueBtn, stopBtn);

        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
        logError('autoMode: failed to send confirmation notification', e);
        currentState.paused = false;
        return 'stop';
    }

    // ユーザーの応答を Promise で待機
    return new Promise<'continue' | 'stop'>((resolve) => {
        confirmResolve = (action) => {
            if (currentState) {
                currentState.paused = false;
            }
            resolve(action);
        };

        // タイムアウト: 10分間応答がなければ自動停止
        setTimeout(() => {
            if (confirmResolve) {
                logWarn('autoMode: confirm response timeout — auto-stopping');
                confirmResolve = null;
                if (currentState) {
                    currentState.paused = false;
                }
                resolve('stop');
            }
        }, 10 * 60 * 1000);
    });
}

// ---------------------------------------------------------------------------
// Phase 2: diffSummary — ステップ間の変更差分
// ---------------------------------------------------------------------------

/**
 * Phase 2: git diff --stat を実行してステップ間の変更差分サマリーを取得する。
 * ワークスペースのルートディレクトリで実行する。
 *
 * @param wsKey ワークスペースキー（リポジトリパスの特定に使用）
 * @returns 差分サマリー文字列（変更なし or エラー時は undefined）
 */
async function buildDiffSummary(wsKey: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync('git diff --stat HEAD', { cwd: wsKey });
        const trimmed = stdout.trim();
        if (!trimmed) {
            logDebug('autoMode: buildDiffSummary — no changes detected');
            return undefined;
        }
        logInfo(`autoMode: buildDiffSummary — ${trimmed.split('\n').length} lines`);
        return trimmed;
    } catch (e) {
        logWarn(`autoMode: buildDiffSummary failed (git diff): ${e instanceof Error ? e.message : e}`);
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/**
 * ミリ秒を人間が読みやすい形式に変換する。
 * 例: 62000 → "1分2秒"
 */
function formatDuration(ms: number): string {
    if (ms < 0) ms = 0;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
        return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}時間${remainingMinutes}分`;
}

/**
 * 進捗バーを生成する。
 * 例: 40% → "████████░░ 40%"
 */
function buildProgressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${percent}%`;
}
