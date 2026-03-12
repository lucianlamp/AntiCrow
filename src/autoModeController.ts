// ---------------------------------------------------------------------------
// autoModeController.ts — 連続オートの心臓部
// ---------------------------------------------------------------------------
// 責務:
//   1. 連続オートのライフサイクル管理（開始・停止・一時停止）
//   2. ステップループの制御（次ステップのプロンプト構築・投入）
//   3. セーフティガード（DANGEROUS_PATTERNS による事前チェック）
//   4. Discord 通知（開始・ステップ完了・セーフティ警告・終了サマリー）
//   5. Phase 2: selectionMode / confirmMode / diffSummary
// ---------------------------------------------------------------------------

import type { TextChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { SuggestionItem } from './suggestionParser';
import { AUTO_PROMPT, buildSuggestionRow, getAllSuggestions, storeSuggestions } from './suggestionButtons';
import { t } from './i18n';
import { buildEmbed, EmbedColor } from './embedHelper';
import { logDebug, logInfo, logError, logWarn } from './logger';
import { cancelPlanGeneration } from './messageQueue';
import { promisify } from 'util';
import { exec } from 'child_process';
import { AUTO_MODE_DEFAULTS } from './autoModeConfig';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** 連続オートの実行状態 */
interface AutoModeState {
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
    totalPausedMs: number;     // 一時停止の累積時間（ms）
    originalPrompt: string;    // ユーザーの初期プロンプト
    isTeamMode: boolean;       // チームモードでの実行かどうか（Phase 3）
}

/** 連続オートの設定 */
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
interface StepResult {
    step: number;
    prompt: string;
    response: string;
    suggestions: SuggestionItem[];
    duration: number;          // ミリ秒
    safetyResult: SafetyCheckResult;
}

/** セーフティチェック結果 */
interface SafetyCheckResult {
    safe: boolean;
    reason?: string;
    severity?: 'block' | 'warn';
    pattern?: string;
    matchedLine?: string;  // マッチした行のテキスト（操作対象の特定用）
}

// ---------------------------------------------------------------------------
// DANGEROUS_PATTERNS — 21パターン全定義
// ---------------------------------------------------------------------------

interface DangerousPattern {
    pattern: RegExp;
    reason: string;
    severity: 'block' | 'warn';
    category: string;
    allowPatterns?: RegExp[];  // これにマッチする場合はセーフ判定（除外リスト）
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
        allowPatterns: [
            /rm\s+-rf\s+(?:\.?\/?)?(node_modules|dist|build|\.cache|\.next|\.nuxt|coverage|__pycache__|tmp|\.turbo)\b/i,
        ],
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
        allowPatterns: [
            /git\s+clean\s+-fd\s*$/i,
        ],
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
// デフォルト設定（autoModeConfig.ts の AUTO_MODE_DEFAULTS を使用）
// ---------------------------------------------------------------------------

/** 類似度閾値（直前2ステップのレスポンスがこの割合以上似ていたら停止） */
const SIMILARITY_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// 状態管理（WS別Map — 複数WSで同時実行可能）
// ---------------------------------------------------------------------------

/** WS別の連続オート状態 */
const stateMap = new Map<string, AutoModeState>();

/** WS別のセーフティ一時停止 resolve コールバック */
const pauseResolveMap = new Map<string, (action: 'approve' | 'skip' | 'stop') => void>();

/** WS別の確認モード一時停止 resolve コールバック */
const confirmResolveMap = new Map<string, (action: 'continue' | 'stop') => void>();

/**
 * 後方互換用ヘルパー: wsKey 省略時にアクティブな最初の状態を取得する。
 * wsKey 指定時はそのWSの状態を返す。
 */
function resolveState(wsKey?: string): AutoModeState | null {
    if (wsKey) {
        return stateMap.get(wsKey) ?? null;
    }
    // 省略時: 最初にアクティブなものを返す
    for (const state of stateMap.values()) {
        if (state.active) return state;
    }
    return null;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 現在の連続オート状態を取得する。
 * @param wsKey 省略時は最初にアクティブなWSの状態を返す
 */
function getAutoModeState(wsKey?: string): AutoModeState | null {
    return resolveState(wsKey);
}

/**
 * 連続オートがアクティブかどうかを返す。
 * @param wsKey 省略時はいずれかのWSがアクティブなら true
 */
export function isAutoModeActive(wsKey?: string): boolean {
    if (wsKey) {
        return stateMap.get(wsKey)?.active === true;
    }
    for (const state of stateMap.values()) {
        if (state.active) return true;
    }
    return false;
}

/**
 * 連続オートを開始する。
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
    // 同じWSで既にアクティブなら停止
    if (stateMap.get(wsKey)?.active) {
        logWarn(`autoMode: already active for wsKey=${wsKey}, stopping previous session`);
        await stopAutoMode(channel, 'new_session', wsKey);
    }

    const mergedConfig: AutoModeConfig = { ...AUTO_MODE_DEFAULTS, ...config };

    const newState: AutoModeState = {
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
        totalPausedMs: 0,
        originalPrompt: prompt,
        isTeamMode,
    };
    stateMap.set(wsKey, newState);

    logInfo(`autoMode: started — prompt="${prompt.substring(0, 50)}..." maxSteps=${mergedConfig.maxSteps} teamMode=${isTeamMode}`);

    // Discord 開始通知
    try {
        const embed = buildEmbed(
            `🚀 **連続オート開始**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `📝 **タスク:** ${prompt.substring(0, 200)}\n`
            + `⚙️ **設定:** 最大${mergedConfig.maxSteps}ステップ / ${Math.round(mergedConfig.maxDuration / 60000)}分\n`
            + `🔒 **セーフティガード:** 有効`,
            EmbedColor.Info,
            true,
        );

        const stopButton = new ButtonBuilder()
            .setCustomId('auto_stop')
            .setLabel('停止')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
        logError('autoMode: failed to send start notification', e);
    }

    // 初回プロンプトを構築
    return buildAutoPrompt(channel.id, prompt, wsKey);
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
    wsKey?: string,
): Promise<string | null> {
    const currentState = resolveState(wsKey);
    if (!currentState?.active) {
        logDebug('autoMode: onStepComplete called but not active');
        return null;
    }

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
            const action = await pauseForSafety(channel, safetyResult, currentState.wsKey);
            if (action === 'stop') {
                await stopAutoMode(channel, 'safety_stop', currentState.wsKey);
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
    await sendStepCompleteNotification(channel, stepResult, suggestions, diffSummary, currentState.wsKey);

    // ループ継続判定
    const continueResult = shouldContinue(responseContent, currentState);
    if (!continueResult.shouldContinue) {
        await stopAutoMode(channel, continueResult.reason, currentState.wsKey);
        return null;
    }

    // Phase 2: confirmMode による確認待ち
    const { confirmMode } = currentState.config;
    if (confirmMode === 'manual' || (confirmMode === 'semi' && currentState.currentStep % 2 === 0)) {
        const confirmAction = await pauseForConfirmation(channel, currentState.wsKey);
        if (confirmAction === 'stop') {
            await stopAutoMode(channel, 'confirm_stop', currentState.wsKey);
            return null;
        }
        // 'continue' ならそのまま続行
    }

    // 次ステップのプロンプトを構築
    return buildAutoPrompt(currentState.channelId, undefined, currentState.wsKey);
}

/**
 * 連続オートを停止する。
 * 状態をリセットし、Discord に終了サマリーを通知する。
 */
export async function stopAutoMode(
    channel: TextChannel,
    reason: string = 'manual',
    wsKey?: string,
): Promise<void> {
    // wsKey指定時はそのWSのみ、省略時は全WSを停止
    if (wsKey) {
        const state = stateMap.get(wsKey);
        if (!state) {
            logDebug(`autoMode: stopAutoMode called but no state for wsKey=${wsKey}`);
            return;
        }
        cancelPlanGeneration();
        stateMap.delete(wsKey);
        pauseResolveMap.delete(wsKey);
        confirmResolveMap.delete(wsKey);
        await sendStopSummary(channel, state, reason);
        return;
    }

    // wsKey省略: 全WSの停止（後方互換）
    if (stateMap.size === 0) {
        logDebug('autoMode: stopAutoMode called but no state');
        return;
    }

    cancelPlanGeneration();

    // 全WSを停止
    const allStates = Array.from(stateMap.entries());
    stateMap.clear();
    pauseResolveMap.clear();
    confirmResolveMap.clear();

    // 最後のstateでサマリーを送信（後方互換のため1回だけ）
    const [, state] = allStates[allStates.length - 1];
    await sendStopSummary(channel, state, reason);
}

/**
 * 終了サマリーをDiscordに送信する（内部ヘルパー）。
 */
async function sendStopSummary(
    channel: TextChannel,
    state: AutoModeState,
    reason: string,
): Promise<void> {
    const totalDuration = Date.now() - state.startedAt;
    const safetyCount = state.history.filter(s => !s.safetyResult.safe).length;

    logInfo(`autoMode: stopped — reason=${reason} wsKey=${state.wsKey} steps=${state.currentStep} duration=${formatDuration(totalDuration)} paused=${formatDuration(state.totalPausedMs)}`);

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
            reasonText = '新しい連続オートセッションが開始されました';
            break;
        case 'error':
            reasonText = '⚠️ エラーが発生しました';
            break;
        case 'auto_reset':
            reasonText = '⚠️ 新しい計画の実行に伴い、既存の連続オートを停止しました';
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
            `📊 **連続オート完了**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `✅ **完了ステップ:** ${state.currentStep}/${state.maxSteps}\n`
            + `⏱️ **合計時間:** ${formatDuration(totalDuration)}${state.totalPausedMs > 0 ? ` (⏸️ 一時停止: ${formatDuration(state.totalPausedMs)})` : ''}\n`
            + `🛡️ **セーフティ発動:** ${safetyCount}回\n\n`
            + (historyLines ? `📋 **実行履歴:**\n${historyLines}\n\n` : '')
            + reasonText,
            EmbedColor.Success,
            true,
        );

        // 最後のステップの提案ボタンを追加（完了後の次アクション提案）
        // 最後のステップに suggestions がない場合、history を逆順に遡ってフォールバック
        let finalSuggestions: SuggestionItem[] = [];
        for (let i = state.history.length - 1; i >= 0; i--) {
            if (state.history[i].suggestions.length > 0) {
                finalSuggestions = state.history[i].suggestions;
                if (i < state.history.length - 1) {
                    logDebug(`autoMode: stopAutoMode — fallback suggestions from step ${i + 1} (last step had none)`);
                }
                break;
            }
        }
        const components: ActionRowBuilder<ButtonBuilder>[] = [];
        if (finalSuggestions.length > 0) {
            storeSuggestions(state.channelId, finalSuggestions);
            const suggestionRow = buildSuggestionRow(finalSuggestions);
            if (suggestionRow) {
                components.push(suggestionRow);
            }
        }

        await channel.send({ embeds: [embed], components });
    } catch (e) {
        logError('autoMode: failed to send stop notification', e);
    }
}

/**
 * セーフティ一時停止からの応答を処理する。
 * slashHandler.ts のボタンハンドラから呼び出される。
 */
export function handleSafetyResponse(action: 'approve' | 'skip' | 'stop', wsKey?: string): void {
    // wsKey指定時はそのWSのみ、省略時は最初に見つかったものを処理（後方互換）
    if (wsKey) {
        const resolve = pauseResolveMap.get(wsKey);
        if (resolve) {
            logInfo(`autoMode: safety response received — action=${action} wsKey=${wsKey}`);
            resolve(action);
            pauseResolveMap.delete(wsKey);
        } else {
            logWarn(`autoMode: safety response received but no pause for wsKey=${wsKey}`);
        }
    } else {
        // 後方互換: 最初のエントリを処理
        const firstEntry = pauseResolveMap.entries().next();
        if (!firstEntry.done) {
            const [key, resolve] = firstEntry.value;
            logInfo(`autoMode: safety response received — action=${action} (fallback wsKey=${key})`);
            resolve(action);
            pauseResolveMap.delete(key);
        } else {
            logWarn('autoMode: safety response received but no pause in progress');
        }
    }
}

/**
 * Phase 2: 確認モードの応答を処理する。
 * slashHandler.ts のボタンハンドラから呼び出される。
 */
export function handleConfirmResponse(action: 'continue' | 'stop', wsKey?: string): void {
    if (wsKey) {
        const resolve = confirmResolveMap.get(wsKey);
        if (resolve) {
            logInfo(`autoMode: confirm response received — action=${action} wsKey=${wsKey}`);
            resolve(action);
            confirmResolveMap.delete(wsKey);
        } else {
            logWarn(`autoMode: confirm response received but no confirm pause for wsKey=${wsKey}`);
        }
    } else {
        const firstEntry = confirmResolveMap.entries().next();
        if (!firstEntry.done) {
            const [key, resolve] = firstEntry.value;
            logInfo(`autoMode: confirm response received — action=${action} (fallback wsKey=${key})`);
            resolve(action);
            confirmResolveMap.delete(key);
        } else {
            logWarn('autoMode: confirm response received but no confirm pause in progress');
        }
    }
}

/**
 * 連続オートでエラーが発生した場合の処理。
 * ループを停止し、Discord に通知する。
 */
export async function handleAutoModeError(
    channel: TextChannel,
    error: unknown,
    wsKey?: string,
): Promise<void> {
    logError('autoMode: error occurred', error);
    await stopAutoMode(channel, 'error', wsKey);
}

// ---------------------------------------------------------------------------
// プロンプト構築
// ---------------------------------------------------------------------------

/**
 * SUGGESTIONS が空の場合に使用するAI判断プロンプトを構築する。
 * originalPrompt と直前のステップ結果を参照して、ゴールに向けた
 * 次のアクションを自動的に判断するよう指示するプロンプトを生成する。
 *
 * @param fallbackPrompt SUGGESTIONS がない場合のフォールバックプロンプト
 * @returns AI判断プロンプト
 */
function buildAutonomousPrompt(fallbackPrompt: string, wsKey?: string): string {
    const currentState = resolveState(wsKey);
    if (!currentState) {
        return fallbackPrompt;
    }

    const { originalPrompt, history } = currentState;

    // 直前のステップ結果サマリーを取得
    const lastStep = history.length > 0 ? history[history.length - 1] : null;
    const lastStepSummary = lastStep
        ? lastStep.response.substring(0, 500)
        : '（まだステップが実行されていません）';

    const autonomousPrompt = [
        '以下のタスクの続きを自動的に実行してください。',
        '',
        '【元のタスク目標】',
        originalPrompt,
        '',
        '【直前のステップの結果サマリー】',
        lastStepSummary,
        '',
        '【指示】',
        '- 元のタスク目標に向けて、残りの作業を洗い出してください',
        '- 次に実行すべきアクションを決定し、実行してください',
        '- 完了したと判断した場合は、その旨を報告してください',
        '- チームモードが有効な場合は、tasks 配列で並列実行可能なタスクを分割してください',
    ].join('\n');

    logInfo(`autoMode: buildAutonomousPrompt — using originalPrompt + lastStep summary (step ${currentState.currentStep})`);

    return autonomousPrompt;
}

/**
 * 連続オート用のプロンプトを構築する。
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
function buildAutoPrompt(channelId: string, initialPrompt?: string, wsKey?: string): string {
    const currentState = resolveState(wsKey);
    const basePrompt = initialPrompt || AUTO_PROMPT;
    const selectionMode = currentState?.config.selectionMode ?? 'auto-delegate';

    // channelId に紐づく直前の提案を取得
    const suggestions = getAllSuggestions(channelId);

    let result: string;

    // 初回プロンプトが明示的に指定されている場合は selectionMode を適用しない
    if (initialPrompt) {
        if (suggestions && suggestions.length > 0) {
            const suggestionContext = suggestions
                .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                .join('\n');
            result = (t as any)('misc.suggest.autoPromptPrefix', suggestionContext, basePrompt);
        } else {
            result = buildAutonomousPrompt(basePrompt, wsKey);
        }
    } else {
        // selectionMode に応じた分岐
        switch (selectionMode) {
            case 'first': {
                // SUGGESTIONS[0] のプロンプトをそのまま投入
                if (suggestions && suggestions.length > 0) {
                    logInfo(`autoMode: selectionMode=first — using suggestion[0]: "${suggestions[0].label}"`);
                    result = suggestions[0].prompt;
                } else {
                    // フォールバック: AI判断プロンプト
                    logInfo('autoMode: selectionMode=first — no suggestions, falling back to autonomous prompt');
                    result = buildAutonomousPrompt(basePrompt, wsKey);
                }
                break;
            }

            case 'ai-select': {
                // 全SUGGESTIONSをプロンプトに含め、AIに選ばせる
                if (suggestions && suggestions.length > 0) {
                    const suggestionContext = suggestions
                        .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                        .join('\n');
                    logInfo(`autoMode: selectionMode=ai-select — ${suggestions.length} suggestions available`);
                    result = (t as any)('autoMode.aiSelectPrompt', suggestionContext, basePrompt);
                } else {
                    // フォールバック: AI判断プロンプト
                    logInfo('autoMode: selectionMode=ai-select — no suggestions, falling back to autonomous prompt');
                    result = buildAutonomousPrompt(basePrompt, wsKey);
                }
                break;
            }

            case 'auto-delegate':
            default: {
                // 既存の動作: AUTO_PROMPT + SUGGESTIONSコンテキスト
                if (suggestions && suggestions.length > 0) {
                    const suggestionContext = suggestions
                        .map((s, i) => `${i + 1}. ${s.label}: ${s.prompt}`)
                        .join('\n');
                    result = (t as any)('misc.suggest.autoPromptPrefix', suggestionContext, basePrompt);
                } else {
                    result = buildAutonomousPrompt(basePrompt, wsKey);
                }
                break;
            }
        }
    }

    // チームモード時: プロンプト末尾にチーム活用の指示を追加
    if (currentState?.isTeamMode) {
        result += `\n\nエージェントチームモードが有効です。タスクを分割して並列実行できる場合は、\`tasks\` 配列を使ってチームで分担してください。同じファイルを複数タスクで修正しないこと。`;
        logDebug('autoMode: buildAutoPrompt — team mode instruction appended');
    }

    return result;
}

// ---------------------------------------------------------------------------
// セーフティガード
// ---------------------------------------------------------------------------

/**
 * レスポンスに対してセーフティチェックを実行する（レイヤーA: プリフライト）。
 * DANGEROUS_PATTERNS の各パターンとマッチングし、最初にヒットしたものを返す。
 * マッチした行のテキストを matchedLine として返し、操作対象の特定に使用する。
 */
function checkSafety(text: string): SafetyCheckResult {
    const lines = text.split('\n');
    for (const { pattern, reason, severity, allowPatterns } of DANGEROUS_PATTERNS) {
        // 行単位でマッチングし、マッチした行のコンテキストを抽出
        let lineMatched = false;
        for (const line of lines) {
            if (pattern.test(line)) {
                // allowPatterns チェック: セーフリストにマッチすればスキップ
                if (allowPatterns?.some(ap => ap.test(line))) {
                    logDebug(`autoMode: safety allow-listed — pattern="${pattern.source}" line="${line.trim().substring(0, 80)}"`);
                    lineMatched = true;
                    continue;
                }
                const matchedLine = line.trim().substring(0, 200);
                logWarn(`autoMode: safety check FAILED — pattern="${pattern.source}" reason="${reason}" severity=${severity} matched="${matchedLine.substring(0, 80)}"`);
                return { safe: false, reason, severity, pattern: pattern.source, matchedLine };
            }
        }
        if (lineMatched) continue;  // 行単位で全てallow-listedなら次のパターンへ
        // フォールバック: 行分割でマッチしない場合（改行なしテキスト等）
        if (pattern.test(text)) {
            const match = pattern.exec(text);
            const matchIdx = match?.index ?? 0;
            const start = Math.max(0, matchIdx - 50);
            const end = Math.min(text.length, matchIdx + 150);
            const matchedLine = text.substring(start, end).replace(/\n/g, ' ').trim();
            logWarn(`autoMode: safety check FAILED (fallback) — pattern="${pattern.source}" reason="${reason}" severity=${severity}`);
            return { safe: false, reason, severity, pattern: pattern.source, matchedLine };
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
function shouldContinue(latestResponse: string, currentState: AutoModeState): { shouldContinue: boolean; reason: string } {
    // ガード1: ステップ数上限
    if (currentState.currentStep >= currentState.maxSteps) {
        return { shouldContinue: false, reason: 'max_steps' };
    }

    // ガード2: 時間上限（一時停止中の待機時間は除外する）
    const elapsed = Date.now() - currentState.startedAt - currentState.totalPausedMs;
    if (elapsed >= currentState.maxDuration) {
        return { shouldContinue: false, reason: 'max_duration' };
    }

    // ガード3: AI が「完了」と判断したかのヒューリスティック
    // 初回ステップ（step < 2）では完了判定をスキップ（誤検知防止）
    // サブエージェントの個別タスク報告に「完了」系フレーズが含まれやすく、
    // 初回レスポンスで早期終了する False Positive を防止するため最低2ステップは実行する
    if (currentState.currentStep >= 2) {
        // 完了フレーズは「全タスク完了」を明確に示す完全な文のみ
        // 短い部分一致（「作業は完了」等）は誤検知しやすいため除外
        const completionPhrases = [
            '全てのタスクが完了しました',
            'すべてのタスクが完了しました',
            '全てのステップが完了しました',
            'すべてのステップが完了しました',
            '全タスク完了しました',
            'all tasks have been completed',
            'all steps have been completed',
            '完了しました。追加の作業はありません',
            '追加の作業は不要です',
            'これ以上の作業はありません',
        ];

        // レスポンスから振り返り・コードブロック・引用を除去してクリーンテキストを生成
        let cleanedResponse = latestResponse;
        // コードブロック除去（```...```）
        cleanedResponse = cleanedResponse.replace(/```[\s\S]*?```/g, '');
        // 振り返りセクション除去（## 振り返り / ## 💭 以降の行）
        cleanedResponse = cleanedResponse.replace(/^##\s*(振り返り|💭)[\s\S]*?(?=^##\s|$)/gm, '');
        // 引用ブロック除去（> で始まる行）
        cleanedResponse = cleanedResponse.replace(/^>.*$/gm, '');
        // MEMORY/SUGGESTIONS コメント除去
        cleanedResponse = cleanedResponse.replace(/<!--[\s\S]*?-->/g, '');

        const lowerResponse = cleanedResponse.toLowerCase();
        for (const phrase of completionPhrases) {
            if (lowerResponse.includes(phrase.toLowerCase())) {
                logInfo(`autoMode: completion phrase detected — "${phrase}"`);
                return { shouldContinue: false, reason: 'completed' };
            }
        }
    } else {
        logDebug(`autoMode: skipping completion phrase check (step ${currentState.currentStep} < 2)`);
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
 * 危険検知時に連続オートを一時停止し、Discord で承認待ちする。
 * ユーザーがボタンをクリックするまでブロックする。
 */
async function pauseForSafety(
    channel: TextChannel,
    safetyResult: SafetyCheckResult,
    wsKey?: string,
): Promise<'approve' | 'skip' | 'stop'> {
    const currentState = resolveState(wsKey);
    if (!currentState) return 'stop';

    currentState.paused = true;
    logInfo(`autoMode: paused for safety — reason="${safetyResult.reason}" wsKey=${wsKey ?? '(none)'}`);

    // Discord セーフティ警告通知
    try {
        const matchedLineText = safetyResult.matchedLine
            ? `📄 **対象:** \`${safetyResult.matchedLine.substring(0, 150)}\`\n\n`
            : '';
        const embed = buildEmbed(
            `🚨 **セーフティガード発動**\n━━━━━━━━━━━━━━━━━━━━\n\n`
            + `⚠️ **危険なアクションを検知しました**\n\n`
            + `🔍 **検知内容:** ${safetyResult.reason}\n`
            + `📝 **パターン:** \`${safetyResult.pattern}\`\n`
            + matchedLineText
            + `⏸️ 連続オートを一時停止しました`,
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

    // ユーザーの応答を Promise で待機（一時停止時間を計測）
    const pauseStartMs = Date.now();
    const effectiveWsKey = wsKey ?? currentState.wsKey;
    return new Promise<'approve' | 'skip' | 'stop'>((resolve) => {
        pauseResolveMap.set(effectiveWsKey, (action) => {
            const state = resolveState(effectiveWsKey);
            if (state) {
                state.paused = false;
                state.totalPausedMs += Date.now() - pauseStartMs;
            }
            resolve(action);
        });

        // タイムアウト: 5分間応答がなければ自動停止
        setTimeout(() => {
            if (pauseResolveMap.has(effectiveWsKey)) {
                logWarn('autoMode: safety response timeout — auto-stopping');
                pauseResolveMap.delete(effectiveWsKey);
                const state = resolveState(effectiveWsKey);
                if (state) {
                    state.paused = false;
                    state.totalPausedMs += Date.now() - pauseStartMs;
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
    wsKey?: string,
): Promise<void> {
    const currentState = resolveState(wsKey);
    if (!currentState) return;

    const elapsed = Date.now() - currentState.startedAt - currentState.totalPausedMs;
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
            .setStyle(ButtonStyle.Danger);

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
        const matchedLineText = safetyResult.matchedLine
            ? `📄 **対象:** \`${safetyResult.matchedLine.substring(0, 150)}\`\n\n`
            : '';
        const embed = buildEmbed(
            `⚠️ **セーフティ警告**\n\n`
            + `🔍 **検知内容:** ${safetyResult.reason}\n`
            + `📝 **パターン:** \`${safetyResult.pattern}\`\n`
            + matchedLineText
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
 * Phase 2: confirmMode の確認待ちで連続オートを一時停止する。
 * ユーザーが「続行」「停止」ボタンをクリックするまでブロックする。
 */
async function pauseForConfirmation(
    channel: TextChannel,
    wsKey?: string,
): Promise<'continue' | 'stop'> {
    const currentState = resolveState(wsKey);
    if (!currentState) return 'stop';

    currentState.paused = true;
    logInfo(`autoMode: paused for confirmation — step=${currentState.currentStep} confirmMode=${currentState.config.confirmMode} wsKey=${wsKey ?? '(none)'}`);

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

    // ユーザーの応答を Promise で待機（一時停止時間を計測）
    const pauseStartMs = Date.now();
    const effectiveWsKey = wsKey ?? currentState.wsKey;
    return new Promise<'continue' | 'stop'>((resolve) => {
        confirmResolveMap.set(effectiveWsKey, (action) => {
            const state = resolveState(effectiveWsKey);
            if (state) {
                state.paused = false;
                state.totalPausedMs += Date.now() - pauseStartMs;
            }
            resolve(action);
        });

        // タイムアウト: 10分間応答がなければ自動停止
        setTimeout(() => {
            if (confirmResolveMap.has(effectiveWsKey)) {
                logWarn('autoMode: confirm response timeout — auto-stopping');
                confirmResolveMap.delete(effectiveWsKey);
                const state = resolveState(effectiveWsKey);
                if (state) {
                    state.paused = false;
                    state.totalPausedMs += Date.now() - pauseStartMs;
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
