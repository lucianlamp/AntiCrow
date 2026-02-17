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
import { logInfo, logError } from './logger';

export class PlanStore {
    private plans: Map<string, Plan> = new Map();
    private filePath: string;

    constructor(storageUri: vscode.Uri) {
        this.filePath = path.join(storageUri.fsPath, 'plans.json');
    }

    /** ストレージディレクトリ＆ファイルが無ければ作る */
    async init(): Promise<void> {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(this.filePath)) {
            try {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const arr: Plan[] = JSON.parse(raw);
                for (const p of arr) {
                    this.plans.set(p.plan_id, p);
                }
                logInfo(`PlanStore: loaded ${this.plans.size} plans`);

                // 即時実行 Plan（cron=null）のクリーンアップ
                // 定期実行のみ保持する方針のため、起動時にゴミを除去
                const immediatePlanIds = arr
                    .filter(p => !p.cron)
                    .map(p => p.plan_id);
                if (immediatePlanIds.length > 0) {
                    for (const id of immediatePlanIds) {
                        this.plans.delete(id);
                    }
                    this.persist();
                    logInfo(`PlanStore: cleaned up ${immediatePlanIds.length} immediate plan(s)`);
                }
            } catch (e) {
                logError('PlanStore: failed to load plans.json', e);
            }
        }
    }

    private persist(): void {
        try {
            const arr = Array.from(this.plans.values());
            fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf-8');
        } catch (e) {
            logError('PlanStore: failed to persist', e);
        }
    }

    add(plan: Plan): void {
        this.plans.set(plan.plan_id, plan);
        this.persist();
        logInfo(`PlanStore: added plan ${plan.plan_id}`);
    }

    remove(planId: string): boolean {
        const ok = this.plans.delete(planId);
        if (ok) {
            this.persist();
            logInfo(`PlanStore: removed plan ${planId}`);
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
        logInfo('PlanStore: cleared all plans');
    }
}
