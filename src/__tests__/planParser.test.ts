// ---------------------------------------------------------------------------
// planParser.test.ts — parseSkillJson / buildPlan テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// planParser → logger → vscode の依存解決のため vscode をモック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
}));

import { parseSkillJson, buildPlan } from '../planParser';

describe('parseSkillJson', () => {
    it('should parse valid JSON', () => {
        const raw = JSON.stringify({
            plan_id: 'test-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'do something',
            requires_confirmation: false,
            discord_templates: { ack: '✅ OK' },
            human_summary: 'テスト実行',
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.plan_id).toBe('test-001');
        expect(result!.timezone).toBe('Asia/Tokyo');
        expect(result!.cron).toBe('now');
        expect(result!.prompt).toBe('do something');
        expect(result!.requires_confirmation).toBe(false);
        expect(result!.discord_templates.ack).toBe('✅ OK');
        expect(result!.human_summary).toBe('テスト実行');
    });

    it('should handle code-fenced JSON', () => {
        const raw = '```json\n' + JSON.stringify({
            plan_id: 'fenced-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test',
            requires_confirmation: false,
            discord_templates: { ack: 'ok' },
        }) + '\n```';
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.plan_id).toBe('fenced-001');
    });

    it('should handle nested plan objects', () => {
        const raw = JSON.stringify({
            reply: 'Here is your plan:',
            plan: {
                plan_id: 'nested-001',
                timezone: 'Asia/Tokyo',
                cron: '0 9 * * *',
                prompt: 'daily report',
                requires_confirmation: true,
                discord_templates: { ack: '📋 Plan created' },
            },
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.plan_id).toBe('nested-001');
        expect(result!.requires_confirmation).toBe(true);
    });

    it('should return null for missing plan_id', () => {
        const raw = JSON.stringify({
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test',
            requires_confirmation: false,
            discord_templates: { ack: 'ok' },
        });
        expect(parseSkillJson(raw)).toBeNull();
    });

    it('should return null for missing prompt', () => {
        const raw = JSON.stringify({
            plan_id: 'missing-prompt',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            requires_confirmation: false,
            discord_templates: { ack: 'ok' },
        });
        expect(parseSkillJson(raw)).toBeNull();
    });

    it('should return null for missing discord_templates', () => {
        const raw = JSON.stringify({
            plan_id: 'no-templates',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test',
            requires_confirmation: false,
        });
        expect(parseSkillJson(raw)).toBeNull();
    });

    it('should return null for invalid JSON', () => {
        expect(parseSkillJson('not valid json')).toBeNull();
    });

    it('should return null for non-object JSON', () => {
        expect(parseSkillJson('"hello"')).toBeNull();
        expect(parseSkillJson('42')).toBeNull();
        expect(parseSkillJson('null')).toBeNull();
    });

    it('should parse optional fields', () => {
        const raw = JSON.stringify({
            plan_id: 'optional-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test',
            requires_confirmation: false,
            discord_templates: {
                ack: 'ack',
                confirm: 'confirm?',
                run_start: 'starting...',
                run_success_prefix: '✅ Done',
                run_error: '❌ Failed',
            },
            human_summary: '要約テスト',
            attachment_paths: ['/tmp/file.txt'],
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.discord_templates.confirm).toBe('confirm?');
        expect(result!.discord_templates.run_start).toBe('starting...');
        expect(result!.discord_templates.run_success_prefix).toBe('✅ Done');
        expect(result!.discord_templates.run_error).toBe('❌ Failed');
        expect(result!.attachment_paths).toEqual(['/tmp/file.txt']);
    });

    // ----- ack null/省略/空文字対応テスト -----

    it('should parse when ack is null', () => {
        const raw = JSON.stringify({
            plan_id: 'ack-null-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test null ack',
            requires_confirmation: false,
            discord_templates: { ack: null, run_error: '❌ Error' },
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.discord_templates.ack).toBeUndefined();
        expect(result!.discord_templates.run_error).toBe('❌ Error');
    });

    it('should parse when ack is omitted', () => {
        const raw = JSON.stringify({
            plan_id: 'ack-omit-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test omitted ack',
            requires_confirmation: false,
            discord_templates: { run_start: '🔨 Starting' },
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.discord_templates.ack).toBeUndefined();
    });

    it('should parse when ack is empty string', () => {
        const raw = JSON.stringify({
            plan_id: 'ack-empty-001',
            timezone: 'Asia/Tokyo',
            cron: 'now',
            prompt: 'test empty ack',
            requires_confirmation: false,
            discord_templates: { ack: '' },
        });
        const result = parseSkillJson(raw);
        expect(result).not.toBeNull();
        expect(result!.discord_templates.ack).toBe('');
    });
});

describe('buildPlan', () => {
    const baseSkill = {
        plan_id: 'build-001',
        timezone: 'Asia/Tokyo',
        cron: 'now',
        prompt: 'do stuff',
        requires_confirmation: false,
        discord_templates: { ack: '✅' },
        human_summary: '実行テスト',
    };

    it('should build immediate plan with null cron', () => {
        const plan = buildPlan(baseSkill, 'ch-src', 'ch-notify');
        expect(plan.cron).toBeNull(); // 'now' → null
        expect(plan.status).toBe('active');
        expect(plan.source_channel_id).toBe('ch-src');
        expect(plan.notify_channel_id).toBe('ch-notify');
        expect(plan.timezone).toBe('Asia/Tokyo');
        expect(plan.created_at).toBeTruthy();
    });

    it('should build scheduled plan preserving cron', () => {
        const scheduled = { ...baseSkill, cron: '0 9 * * *' };
        const plan = buildPlan(scheduled, 'ch-src', 'ch-notify');
        expect(plan.cron).toBe('0 9 * * *');
    });

    it('should set pending_confirmation for confirmation required', () => {
        const confirming = { ...baseSkill, requires_confirmation: true };
        const plan = buildPlan(confirming, 'ch-src', 'ch-notify');
        expect(plan.status).toBe('pending_confirmation');
    });

    it('should treat empty cron as immediate', () => {
        const empty = { ...baseSkill, cron: '' };
        const plan = buildPlan(empty, 'ch-src', 'ch-notify');
        expect(plan.cron).toBeNull();
    });

    it('should treat "immediate" cron as immediate', () => {
        const immediate = { ...baseSkill, cron: 'immediate' };
        const plan = buildPlan(immediate, 'ch-src', 'ch-notify');
        expect(plan.cron).toBeNull();
    });

    it('should default timezone to Asia/Tokyo', () => {
        const noTz = { ...baseSkill, timezone: '' };
        const plan = buildPlan(noTz, 'ch-src', 'ch-notify');
        expect(plan.timezone).toBe('Asia/Tokyo');
    });
});
