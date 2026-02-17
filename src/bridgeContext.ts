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
    isBotOwner: boolean;
    globalStoragePath: string;
    statusBarItem: vscode.StatusBarItem;
    lockWatchTimer: NodeJS.Timeout | null;
    categoryWatchTimer: NodeJS.Timeout | null;
}
