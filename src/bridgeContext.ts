// ---------------------------------------------------------------------------
// bridgeContext.ts — 共有状態インターフェース
// ---------------------------------------------------------------------------
// extension.ts のグローバル変数を構造化し、各モジュールに注入する。
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { DiscordBot } from './discordBot';
import { CdpBridge } from './cdpBridge';
import { CdpPool } from './cdpPool';
import { FileIpc } from './fileIpc';
import { Scheduler } from './scheduler';
import { PlanStore } from './planStore';
import { Executor } from './executor';
import { ExecutorPool } from './executorPool';
import { TemplateStore } from './templateStore';
import { UIWatcher } from './uiWatcher';
import { SubagentManager } from './subagentManager';
import { SubagentReceiver } from './subagentReceiver';

/** 全モジュールが共有する Bridge の実行時状態 */
export interface BridgeContext {
    bot: DiscordBot | null;
    cdp: CdpBridge | null;
    cdpPool: CdpPool | null;
    fileIpc: FileIpc | null;
    scheduler: Scheduler | null;
    planStore: PlanStore | null;
    executor: Executor | null;
    executorPool: ExecutorPool | null;
    templateStore: TemplateStore | null;
    isBotOwner: boolean;
    globalStoragePath: string;
    extensionPath: string;
    statusBarItem: vscode.StatusBarItem;
    autoAcceptStatusBarItem: vscode.StatusBarItem | null;
    lockWatchTimer: NodeJS.Timeout | null;
    categoryWatchTimer: NodeJS.Timeout | null;
    autoAcceptWatcherTimer: NodeJS.Timeout | null;
    healthCheckTimer: NodeJS.Timeout | null;
    cleanupTimer: NodeJS.Timeout | null;
    staleRecoveryTimer: NodeJS.Timeout | null;
    /** ステータスバー専用 UIWatcher（ctx.cdp を使用。ExecutorPool の UIWatcher とは独立） */
    startupUIWatcher: UIWatcher | null;
    /** Discord からライセンスキーを設定するためのコールバック（SecretStorage + LicenseChecker を橋渡し） */
    setLicenseKeyFn: ((key: string) => Promise<{ valid: boolean; planType: string }>) | null;
    /** トライアル残り日数を取得するコールバック */
    getTrialDaysRemaining: (() => number | undefined) | null;
    /** エージェントが実行中かどうか（UIWatcher が isAgentRunning で検出） */
    agentRunning: boolean;
    /** サブエージェントマネージャー（メインウィンドウ側） */
    subagentManager: SubagentManager | null;
    /** サブエージェントレシーバー（サブウィンドウ側） */
    subagentReceiver: SubagentReceiver | null;
}

/** startBridge 完了後の状態。主要フィールドが non-null であることを型レベルで保証 */
export type InitializedContext = BridgeContext & {
    bot: DiscordBot;
    cdp: CdpBridge;
    cdpPool: CdpPool;
    fileIpc: FileIpc;
    planStore: PlanStore;
    executor: Executor;
    executorPool: ExecutorPool;
};

/** ctx が初期化済みかどうかを判定するタイプガード */
export function isInitialized(ctx: BridgeContext): ctx is InitializedContext {
    return (
        ctx.bot !== null &&
        ctx.cdp !== null &&
        ctx.cdpPool !== null &&
        ctx.fileIpc !== null &&
        ctx.planStore !== null &&
        ctx.executor !== null &&
        ctx.executorPool !== null
    );
}
