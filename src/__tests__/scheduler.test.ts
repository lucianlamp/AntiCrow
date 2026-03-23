// ---------------------------------------------------------------------------
// scheduler.test.ts — スケジューラテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vscode モジュールをモック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
    },
}));

import { Scheduler } from '../scheduler';
import { Plan } from '../types';

/** テスト用の最小 Plan を生成 */
function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
        plan_id: 'test-plan-001',
        timezone: 'Asia/Tokyo',
        cron: '0 9 * * *', // 毎日9時
        prompt: 'test prompt',
        requires_confirmation: false,
        choice_mode: 'none' as const,
        status: 'active' as const,
        source_channel_id: 'src-ch-001',
        discord_templates: {
            ack: 'ack',
        },
        notify_channel_id: 'ch-001',
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

describe('Scheduler', () => {
    let scheduler: Scheduler;
    let callbackMock: (plan: Plan) => void;

    beforeEach(() => {
        callbackMock = vi.fn();
        scheduler = new Scheduler(callbackMock, 'Asia/Tokyo');
    });

    afterEach(() => {
        scheduler.stopAll();
    });

    // ----- isValidCron -----

    describe('isValidCron', () => {
        it('should accept valid 5-part cron expression', () => {
            expect(Scheduler.isValidCron('0 9 * * *')).toBe(true);
            expect(Scheduler.isValidCron('*/5 * * * *')).toBe(true);
            expect(Scheduler.isValidCron('0 0 1 1 *')).toBe(true);
        });

        it('should reject invalid cron expression', () => {
            expect(Scheduler.isValidCron('invalid')).toBe(false);
            expect(Scheduler.isValidCron('')).toBe(false);
            expect(Scheduler.isValidCron('0 0')).toBe(false);
        });
    });

    // ----- register -----

    describe('register', () => {
        it('should register a plan with valid cron', () => {
            const plan = makePlan();
            const result = scheduler.register(plan);
            expect(result).toBe(true);
            expect(scheduler.getRegisteredPlanIds()).toContain('test-plan-001');
        });

        it('should reject plan without cron', () => {
            const plan = makePlan({ cron: undefined });
            const result = scheduler.register(plan);
            expect(result).toBe(false);
        });

        it('should reject plan with invalid cron', () => {
            const plan = makePlan({ cron: 'not-a-cron' });
            const result = scheduler.register(plan);
            expect(result).toBe(false);
        });

        it('should replace existing registration for same plan_id', () => {
            const plan1 = makePlan({ cron: '0 9 * * *' });
            const plan2 = makePlan({ cron: '0 18 * * *' });
            scheduler.register(plan1);
            scheduler.register(plan2);
            // 同じ ID なので1つだけ登録されている
            expect(scheduler.getRegisteredPlanIds().length).toBe(1);
        });
    });

    // ----- unregister -----

    describe('unregister', () => {
        it('should unregister an existing plan', () => {
            scheduler.register(makePlan());
            scheduler.unregister('test-plan-001');
            expect(scheduler.getRegisteredPlanIds()).not.toContain('test-plan-001');
        });

        it('should not throw when unregistering non-existent plan', () => {
            expect(() => scheduler.unregister('ghost')).not.toThrow();
        });
    });

    // ----- stopAll -----

    describe('stopAll', () => {
        it('should stop all registered tasks', () => {
            scheduler.register(makePlan({ plan_id: 'a', cron: '0 9 * * *' }));
            scheduler.register(makePlan({ plan_id: 'b', cron: '0 18 * * *' }));
            expect(scheduler.getRegisteredPlanIds().length).toBe(2);

            scheduler.stopAll();
            expect(scheduler.getRegisteredPlanIds().length).toBe(0);
        });
    });

    // ----- restoreAll -----

    describe('restoreAll', () => {
        it('should restore only active plans with cron', () => {
            const plans: Plan[] = [
                makePlan({ plan_id: 'active-1', status: 'active', cron: '0 9 * * *' }),
                makePlan({ plan_id: 'active-2', status: 'active', cron: '0 18 * * *' }),
                makePlan({ plan_id: 'done', status: 'completed', cron: '0 12 * * *' }),
                makePlan({ plan_id: 'nocron', status: 'active', cron: undefined }),
            ];
            const count = scheduler.restoreAll(plans);
            expect(count).toBe(2);
            expect(scheduler.getRegisteredPlanIds()).toContain('active-1');
            expect(scheduler.getRegisteredPlanIds()).toContain('active-2');
        });

        it('should return 0 for empty plan list', () => {
            expect(scheduler.restoreAll([])).toBe(0);
        });
    });

    // ----- getRegisteredPlanIds -----

    describe('getRegisteredPlanIds', () => {
        it('should return empty array when no plans registered', () => {
            expect(scheduler.getRegisteredPlanIds()).toEqual([]);
        });

        it('should return all registered plan IDs', () => {
            scheduler.register(makePlan({ plan_id: 'x' }));
            scheduler.register(makePlan({ plan_id: 'y' }));
            const ids = scheduler.getRegisteredPlanIds().sort();
            expect(ids).toEqual(['x', 'y']);
        });
    });
});
