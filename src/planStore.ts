// ---------------------------------------------------------------------------
// planStore.ts — JSON ファイルベースの Plan 永続化
// ---------------------------------------------------------------------------
// なぜ JSON か:
//   計画は通常数十件程度。SQLite はネイティブ依存で VS Code 拡張バンドルが複雑化する。
//   JSON なら fs だけで完結し、人間にも可読。
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Plan } from './types';
import { logDebug, logError } from './logger';

export class PlanStore {
    private plans: Map<string, Plan> = new Map();
    private filePath: string;
    private persistTimer: NodeJS.Timeout | null = null;
    private readonly PERSIST_DEBOUNCE_MS = 500;

    constructor(storageUri: vscode.Uri) {
        this.filePath = path.join(storageUri.fsPath, 'plans.json');
    }

    /** ストレージディレクトリ＆ファイルが無ければ作る */
    async init(): Promise<void> {
        const dir = path.dirname(this.filePath);
        try {
            await fs.promises.mkdir(dir, { recursive: true });
        } catch { /* already exists */ }

        try {
            const raw = await fs.promises.readFile(this.filePath, 'utf-8');
            const arr: Plan[] = JSON.parse(raw);
            for (const p of arr) {
                this.plans.set(p.plan_id, p);
            }
            logDebug(`PlanStore: loaded ${this.plans.size} plans`);

            // 即時実行 Plan（cron=null）のクリーンアップ
            // 定期実行のみ保持する方針のため、起動時にゴミを除去
            const immediatePlanIds = arr
                .filter(p => !p.cron)
                .map(p => p.plan_id);
            if (immediatePlanIds.length > 0) {
                for (const id of immediatePlanIds) {
                    this.plans.delete(id);
                }
                await this.persistNow();
                logDebug(`PlanStore: cleaned up ${immediatePlanIds.length} immediate plan(s)`);
            }
        } catch (e) {
            // ファイルが無い場合は正常（初回起動）
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                logError('PlanStore: failed to load plans.json', e);
            }
        }
    }

    /** デバウンス付き永続化（500ms 内の連続呼び出しをまとめる） */
    private persist(): void {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => {
            this.persistNow().catch(e => logError('PlanStore: deferred persist failed', e));
        }, this.PERSIST_DEBOUNCE_MS);
    }

    /** 即時永続化 */
    private async persistNow(): Promise<void> {
        try {
            const arr = Array.from(this.plans.values());
            await fs.promises.writeFile(this.filePath, JSON.stringify(arr, null, 2), 'utf-8');
        } catch (e) {
            logError('PlanStore: failed to persist', e);
        }
    }

    add(plan: Plan): void {
        this.plans.set(plan.plan_id, plan);
        this.persist();
        logDebug(`PlanStore: added plan ${plan.plan_id}`);
    }

    remove(planId: string): boolean {
        const ok = this.plans.delete(planId);
        if (ok) {
            this.persist();
            logDebug(`PlanStore: removed plan ${planId}`);
        }
        return ok;
    }

    get(planId: string): Plan | undefined {
        return this.plans.get(planId);
    }

    getAll(): Plan[] {
        return Array.from(this.plans.values());
    }

    getActive(): Plan[] {
        return this.getAll().filter(p => p.status === 'active');
    }

    update(planId: string, patch: Partial<Plan>): boolean {
        const existing = this.plans.get(planId);
        if (!existing) { return false; }
        Object.assign(existing, patch);
        this.plans.set(planId, existing);
        this.persist();
        return true;
    }

    clearAll(): void {
        this.plans.clear();
        this.persist();
        logDebug('PlanStore: cleared all plans');
    }
}
