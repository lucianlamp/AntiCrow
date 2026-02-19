// ---------------------------------------------------------------------------
// scheduler.ts — node-cron ラッパー（JST タイムゾーン対応）
// ---------------------------------------------------------------------------
// なぜ node-cron か:
//   - 軽量（依存ゼロ）
//   - 標準5項目 CRON + timezone オプション
//   - validate() で事前チェック可能
//   - VS Code 拡張内での動作実績あり
// ---------------------------------------------------------------------------

import * as cron from 'node-cron';
import { Plan } from './types';
import { logInfo, logWarn, logError } from './logger';
import { getTimezone } from './configHelper';

type ScheduleCallback = (plan: Plan) => void;

interface ScheduledTask {
    plan: Plan;
    task: cron.ScheduledTask;
}

export class Scheduler {
    private tasks = new Map<string, ScheduledTask>();
    private callback: ScheduleCallback;
    private timezone: string;

    constructor(callback: ScheduleCallback, timezone: string = getTimezone()) {
        this.callback = callback;
        this.timezone = timezone;
    }

    /** CRON 式が有効かチェック */
    static isValidCron(expr: string): boolean {
        return cron.validate(expr);
    }

    /** 計画を登録する */
    register(plan: Plan): boolean {
        if (!plan.cron) {
            logWarn(`Scheduler: plan ${plan.plan_id} has no cron — skipping`);
            return false;
        }

        if (!Scheduler.isValidCron(plan.cron)) {
            logError(`Scheduler: invalid cron "${plan.cron}" for plan ${plan.plan_id}`);
            return false;
        }

        // 既存タスクがあれば停止
        this.unregister(plan.plan_id);

        try {
            const task = cron.schedule(plan.cron, () => {
                logInfo(`Scheduler: triggering plan ${plan.plan_id}`);
                this.callback(plan);
            }, {
                timezone: this.timezone,
            });

            this.tasks.set(plan.plan_id, { plan, task });
            logInfo(`Scheduler: registered plan ${plan.plan_id} — cron: "${plan.cron}" tz: ${this.timezone}`);
            return true;
        } catch (e) {
            logError(`Scheduler: failed to register plan ${plan.plan_id}`, e);
            return false;
        }
    }

    /** 計画を解除する */
    unregister(planId: string): void {
        const entry = this.tasks.get(planId);
        if (entry) {
            entry.task.stop();
            this.tasks.delete(planId);
            logInfo(`Scheduler: unregistered plan ${planId}`);
        }
    }

    /** 登録中のすべての計画を取得 */
    getRegisteredPlanIds(): string[] {
        return Array.from(this.tasks.keys());
    }

    /** すべてのタスクを停止 */
    stopAll(): void {
        for (const [id, entry] of this.tasks) {
            entry.task.stop();
            logInfo(`Scheduler: stopped task ${id}`);
        }
        this.tasks.clear();
    }

    /** PlanStore から全 active 計画をロードして再登録 */
    restoreAll(plans: Plan[]): number {
        let count = 0;
        for (const plan of plans) {
            if (plan.status === 'active' && plan.cron) {
                if (this.register(plan)) { count++; }
            }
        }
        logInfo(`Scheduler: restored ${count} plans`);
        return count;
    }
}
