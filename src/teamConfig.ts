// ---------------------------------------------------------------------------
// teamConfig.ts — エージェントチーム設定ファイルの管理
// ---------------------------------------------------------------------------
// 責務:
//   1. .anticrow/team.json の読み書き
//   2. TeamConfig 型定義
//   3. デフォルト値の提供
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from './logger';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface TeamConfig {
    /** チームモードの有効/無効 */
    enabled: boolean;
    /** 最大同時サブエージェント数 */
    maxAgents: number;
    /** サブエージェントのレスポンスタイムアウト（ms） */
    responseTimeoutMs: number;
    /** 監視ポーリング間隔（ms） */
    monitorIntervalMs: number;
    /** spawn 時に自動でサブエージェントを起動するか */
    autoSpawn: boolean;
    /** 並列タスク分配を有効にするか */
    enableParallel: boolean;
}

// ---------------------------------------------------------------------------
// デフォルト値
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: TeamConfig = {
    enabled: false,
    maxAgents: 3,
    responseTimeoutMs: 900_000,   // 15分
    monitorIntervalMs: 15_000,    // 15秒
    autoSpawn: true,
    enableParallel: true,
};

const CONFIG_DIR = '.anticrow';
const CONFIG_FILE = 'team.json';

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------

/**
 * チーム設定を読み込む。ファイルが存在しなければデフォルト値を返す。
 */
export function loadTeamConfig(repoRoot: string): TeamConfig {
    const filePath = path.join(repoRoot, CONFIG_DIR, CONFIG_FILE);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            // デフォルト値とマージ（未知のフィールドは無視、欠落フィールドはデフォルトで補完）
            return {
                enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_CONFIG.enabled,
                maxAgents: typeof parsed.maxAgents === 'number' ? parsed.maxAgents : DEFAULT_CONFIG.maxAgents,
                responseTimeoutMs: typeof parsed.responseTimeoutMs === 'number' ? parsed.responseTimeoutMs : DEFAULT_CONFIG.responseTimeoutMs,
                monitorIntervalMs: typeof parsed.monitorIntervalMs === 'number' ? parsed.monitorIntervalMs : DEFAULT_CONFIG.monitorIntervalMs,
                autoSpawn: typeof parsed.autoSpawn === 'boolean' ? parsed.autoSpawn : DEFAULT_CONFIG.autoSpawn,
                enableParallel: typeof parsed.enableParallel === 'boolean' ? parsed.enableParallel : DEFAULT_CONFIG.enableParallel,
            };
        }
    } catch (e) {
        logWarn(`TeamConfig: failed to load ${filePath}: ${e instanceof Error ? e.message : e}`);
    }
    return { ...DEFAULT_CONFIG };
}

/**
 * チーム設定を書き込む。ディレクトリがなければ作成する。
 */
export function saveTeamConfig(repoRoot: string, config: TeamConfig): void {
    const dirPath = path.join(repoRoot, CONFIG_DIR);
    const filePath = path.join(dirPath, CONFIG_FILE);
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        logDebug(`TeamConfig: saved to ${filePath}`);
    } catch (e) {
        logWarn(`TeamConfig: failed to save ${filePath}: ${e instanceof Error ? e.message : e}`);
        throw e;
    }
}

/**
 * デフォルト設定のコピーを返す。
 */
export function getDefaultTeamConfig(): TeamConfig {
    return { ...DEFAULT_CONFIG };
}
