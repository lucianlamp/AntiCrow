// ---------------------------------------------------------------------------
// autoModeConfig.ts — 連続オートモードのユーザー設定永続化
// ---------------------------------------------------------------------------
// 責務:
//   1. チャンネルごとの AutoModeConfig を JSON ファイルに保存・読み込み
//   2. /auto コマンドのオプション引数パース
//   3. デフォルト設定の提供
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import type { AutoModeConfig } from './autoModeController';
import { logDebug, logError, logWarn } from './logger';

// ---------------------------------------------------------------------------
// デフォルト設定
// ---------------------------------------------------------------------------

export const AUTO_MODE_DEFAULTS: AutoModeConfig = {
    selectionMode: 'auto-delegate',
    confirmMode: 'auto',
    maxSteps: 10,
    maxDuration: 30 * 60 * 1000, // 30分 = 1800000ms
};

// ---------------------------------------------------------------------------
// 設定の値の範囲制約
// ---------------------------------------------------------------------------

/** maxSteps の最小値・最大値 */
const STEPS_MIN = 1;
const STEPS_MAX = 20;

/** maxDuration の最小値・最大値（ミリ秒） */
const DURATION_MIN = 5 * 60 * 1000;    // 5分
const DURATION_MAX = 2 * 60 * 60 * 1000; // 2時間

// ---------------------------------------------------------------------------
// 設定ディレクトリ管理
// ---------------------------------------------------------------------------

/** globalStoragePath をセットするための変数 */
let storagePath: string = '';

/**
 * globalStoragePath を設定する。
 * extension 起動時に1回だけ呼ばれる想定。
 */
export function setConfigStoragePath(globalStoragePath: string): void {
    storagePath = globalStoragePath;
    logDebug(`autoModeConfig: storagePath set to ${storagePath}`);
}

/**
 * 設定ファイルのディレクトリパスを返す。
 * 存在しなければ作成する。
 */
function getConfigDir(): string {
    if (!storagePath) {
        // フォールバック: 環境変数やデフォルトパスを使用
        const fallback = path.join(
            process.env.APPDATA || process.env.HOME || '.',
            'Antigravity', 'User', 'globalStorage',
            'lucianlamp.anti-crow',
        );
        logWarn(`autoModeConfig: storagePath not set, using fallback: ${fallback}`);
        storagePath = fallback;
    }
    const configDir = path.join(storagePath, 'auto-mode-config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
        logDebug(`autoModeConfig: created config directory: ${configDir}`);
    }
    return configDir;
}

/**
 * チャンネルごとの設定ファイルパスを返す。
 */
function getConfigFilePath(channelId: string): string {
    return path.join(getConfigDir(), `${channelId}.json`);
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * チャンネルごとの AutoModeConfig を JSON ファイルから読み込む。
 * ファイルが存在しない場合はデフォルト設定を返す。
 *
 * @param channelId Discord チャンネルID
 * @returns AutoModeConfig
 */
export function loadAutoModeConfig(channelId: string): AutoModeConfig {
    const filePath = getConfigFilePath(channelId);

    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            logDebug(`autoModeConfig: loaded config for channel ${channelId}`);

            // 保存されたデータをバリデーション付きでマージ
            return validateAndMerge(parsed);
        }
    } catch (e) {
        logError(`autoModeConfig: failed to load config for channel ${channelId}`, e);
    }

    return { ...AUTO_MODE_DEFAULTS };
}

/**
 * チャンネルごとの AutoModeConfig を JSON ファイルに保存する。
 *
 * @param channelId Discord チャンネルID
 * @param config 保存する設定
 */
export function saveAutoModeConfig(channelId: string, config: AutoModeConfig): void {
    const filePath = getConfigFilePath(channelId);

    try {
        const validated = validateAndMerge(config);
        fs.writeFileSync(filePath, JSON.stringify(validated, null, 2), 'utf-8');
        logDebug(`autoModeConfig: saved config for channel ${channelId}`);
    } catch (e) {
        logError(`autoModeConfig: failed to save config for channel ${channelId}`, e);
    }
}

/**
 * /auto コマンドのオプション引数をパースする。
 *
 * サポートするオプション:
 *   --steps N         最大ステップ数 (1-20)
 *   --confirm MODE    確認モード (auto | semi | manual)
 *   --select MODE     選択方式 (auto-delegate | first | ai-select)
 *   --duration N      最大実行時間（分単位, 5-120）
 *
 * 例: /auto --steps 10 --confirm semi --select ai-select LPをリニューアルして
 *
 * @param argsString コマンド引数の文字列（/auto より後の部分）
 * @returns { config: パースされた設定, prompt: 残りのプロンプト文字列 }
 */
export function parseAutoModeArgs(argsString: string): {
    config: Partial<AutoModeConfig>;
    prompt: string;
} {
    const config: Partial<AutoModeConfig> = {};
    let remaining = argsString.trim();

    // --steps N
    const stepsMatch = remaining.match(/--steps\s+(\d+)/);
    if (stepsMatch) {
        const steps = parseInt(stepsMatch[1], 10);
        if (steps >= STEPS_MIN && steps <= STEPS_MAX) {
            config.maxSteps = steps;
        } else {
            logWarn(`autoModeConfig: --steps ${steps} is out of range (${STEPS_MIN}-${STEPS_MAX}), ignoring`);
        }
        remaining = remaining.replace(stepsMatch[0], '');
    }

    // --confirm MODE
    const confirmMatch = remaining.match(/--confirm\s+(auto|semi|manual)/);
    if (confirmMatch) {
        config.confirmMode = confirmMatch[1] as AutoModeConfig['confirmMode'];
        remaining = remaining.replace(confirmMatch[0], '');
    }

    // --select MODE
    const selectMatch = remaining.match(/--select\s+(auto-delegate|first|ai-select)/);
    if (selectMatch) {
        config.selectionMode = selectMatch[1] as AutoModeConfig['selectionMode'];
        remaining = remaining.replace(selectMatch[0], '');
    }

    // --duration N (分単位)
    const durationMatch = remaining.match(/--duration\s+(\d+)/);
    if (durationMatch) {
        const minutes = parseInt(durationMatch[1], 10);
        const ms = minutes * 60 * 1000;
        if (ms >= DURATION_MIN && ms <= DURATION_MAX) {
            config.maxDuration = ms;
        } else {
            logWarn(`autoModeConfig: --duration ${minutes}m is out of range (5-120min), ignoring`);
        }
        remaining = remaining.replace(durationMatch[0], '');
    }

    // 残りの文字列をプロンプトとして返す（前後の空白をトリム）
    const prompt = remaining.replace(/\s+/g, ' ').trim();

    return { config, prompt };
}

/**
 * 現在の設定をDiscord表示用のテキストにフォーマットする。
 *
 * @param config AutoModeConfig
 * @returns Discord Embed に使えるフォーマットされた文字列
 */
export function formatConfigForDisplay(config: AutoModeConfig): string {
    const selectionLabels: Record<AutoModeConfig['selectionMode'], string> = {
        'auto-delegate': '🤖 AI判断 (auto-delegate)',
        'first': '1️⃣ 最初の提案を選択 (first)',
        'ai-select': '🧠 AIに選択させる (ai-select)',
    };

    const confirmLabels: Record<AutoModeConfig['confirmMode'], string> = {
        'auto': '⚡ 自動実行 (auto)',
        'semi': '🔄 偶数ステップで確認 (semi)',
        'manual': '✋ 毎ステップ確認 (manual)',
    };

    return [
        `⚙️ **連続オートモード設定**`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `📊 **最大ステップ数:** ${config.maxSteps}`,
        `⏱️ **最大実行時間:** ${Math.round(config.maxDuration / 60000)}分`,
        `🎯 **選択方式:** ${selectionLabels[config.selectionMode]}`,
        `✅ **確認モード:** ${confirmLabels[config.confirmMode]}`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * 部分的な設定値をバリデーションし、デフォルトとマージする。
 */
function validateAndMerge(partial: Partial<AutoModeConfig>): AutoModeConfig {
    const merged = { ...AUTO_MODE_DEFAULTS };

    // selectionMode
    if (partial.selectionMode) {
        const valid: AutoModeConfig['selectionMode'][] = ['auto-delegate', 'first', 'ai-select'];
        if (valid.includes(partial.selectionMode)) {
            merged.selectionMode = partial.selectionMode;
        }
    }

    // confirmMode
    if (partial.confirmMode) {
        const valid: AutoModeConfig['confirmMode'][] = ['auto', 'semi', 'manual'];
        if (valid.includes(partial.confirmMode)) {
            merged.confirmMode = partial.confirmMode;
        }
    }

    // maxSteps
    if (typeof partial.maxSteps === 'number') {
        merged.maxSteps = Math.max(STEPS_MIN, Math.min(STEPS_MAX, partial.maxSteps));
    }

    // maxDuration
    if (typeof partial.maxDuration === 'number') {
        merged.maxDuration = Math.max(DURATION_MIN, Math.min(DURATION_MAX, partial.maxDuration));
    }

    return merged;
}
