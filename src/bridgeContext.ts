// ---------------------------------------------------------------------------
// bridgeContext.ts — 共有状態インターフェース
// ---------------------------------------------------------------------------
// extension.ts のグローバル変数を構造化し、各モジュールに注入する。
// ---------------------------------------------------------------------------

import type * as vscode from 'vscode';
import type { DiscordBot } from './discordBot';
import type { CdpBridge } from './cdpBridge';
import type { CdpPool } from './cdpPool';
import type { FileIpc } from './fileIpc';
import type { Scheduler } from './scheduler';
import type { PlanStore } from './planStore';
import type { Executor } from './executor';
import type { ExecutorPool } from './executorPool';
import type { TemplateStore } from './templateStore';

import type { SubagentManager } from './subagentManager';
import type { SubagentReceiver } from './subagentReceiver';
import type { TeamOrchestrator } from './teamOrchestrator';

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
    lockWatchTimer: NodeJS.Timeout | null;
    categoryWatchTimer: NodeJS.Timeout | null;
    healthCheckTimer: NodeJS.Timeout | null;
    cleanupTimer: NodeJS.Timeout | null;
    staleRecoveryTimer: NodeJS.Timeout | null;


    /** エージェントが実行中かどうか */
    agentRunning: boolean;
    /** サブエージェントマネージャー（メインウィンドウ側） */
    subagentManager: SubagentManager | null;
    /** サブエージェントレシーバー（サブウィンドウ側） */
    subagentReceiver: SubagentReceiver | null;
    /** チームオーケストレーター（指揮官モード） */
    teamOrchestrator: TeamOrchestrator | null;
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
