// ---------------------------------------------------------------------------
// planParser.ts — Skill JSON バリデーション & Plan 構築
// ---------------------------------------------------------------------------

import { Plan, SkillOutput, DiscordTemplates, PlanStatus, ChoiceMode } from './types';
import { logWarn } from './logger';

/**
 * Skill が返した JSON 文字列をパースし、バリデーションする。
 * Zod は依存を増やすので手動バリデーション（計画スキーマは固定なので十分）。
 */
export function parseSkillJson(raw: string): SkillOutput | null {
    let obj: unknown;
    try {
        // Skill が ```json ... ``` で囲って返す可能性に備える
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        obj = JSON.parse(cleaned);
    } catch {
        logWarn('planParser: JSON parse failed');
        return null;
    }

    if (typeof obj !== 'object' || obj === null) { return null; }

    // レスポンスが {"reply":"...", "plan": {...}} 形式の場合、plan を取り出す
    let o = obj as Record<string, unknown>;
    if ('plan' in o && typeof o.plan === 'object' && o.plan !== null) {
        o = o.plan as Record<string, unknown>;
    }

    // 必須フィールドチェック
    if (typeof o.plan_id !== 'string' || !o.plan_id) { return null; }
    if (typeof o.timezone !== 'string') { return null; }
    if (typeof o.cron !== 'string') { return null; }
    if (typeof o.prompt !== 'string' || !o.prompt) { return null; }
    if (typeof o.requires_confirmation !== 'boolean') { return null; }

    // discord_templates
    const dt = o.discord_templates;
    if (typeof dt !== 'object' || dt === null) { return null; }
    const dtObj = dt as Record<string, unknown>;
    if (typeof dtObj.ack !== 'string') { return null; }

    const templates: DiscordTemplates = {
        ack: dtObj.ack as string,
        confirm: typeof dtObj.confirm === 'string' ? dtObj.confirm : undefined,
        run_start: typeof dtObj.run_start === 'string' ? dtObj.run_start : undefined,
        run_success_prefix: typeof dtObj.run_success_prefix === 'string' ? dtObj.run_success_prefix : undefined,
        run_error: typeof dtObj.run_error === 'string' ? dtObj.run_error : undefined,
    };

    // choice_mode（オプション）
    const validChoiceModes: ChoiceMode[] = ['none', 'single', 'multi', 'all'];
    const choiceMode = typeof o.choice_mode === 'string' && validChoiceModes.includes(o.choice_mode as ChoiceMode)
        ? o.choice_mode as ChoiceMode
        : undefined;

    return {
        plan_id: o.plan_id as string,
        timezone: o.timezone as string,
        cron: o.cron as string,
        prompt: o.prompt as string,
        requires_confirmation: o.requires_confirmation as boolean,
        choice_mode: choiceMode,
        discord_templates: templates,
        human_summary: typeof o.human_summary === 'string' ? o.human_summary : undefined,
        attachment_paths: Array.isArray(o.attachment_paths) ? o.attachment_paths as string[] : undefined,
    };
}

/**
 * human_summary を maxLen 文字以内に省略する。
 * 日本語の助詞・区切り文字で自然に切れるポイントを探す。
 */
function truncateSummary(text: string | undefined, maxLen: number = 15): string | undefined {
    if (!text || text.length <= maxLen) { return text; }

    const breakChars = ['　', ' ', 'を', 'に', 'で', 'の', 'へ', 'と', 'が', 'は', 'も', 'や', '、', '。'];
    const searchStart = Math.max(Math.floor(maxLen * 0.5), 1);

    for (let i = maxLen - 1; i >= searchStart; i--) {
        if (breakChars.includes(text[i])) {
            return text.substring(0, i + 1).trimEnd();
        }
    }
    return text.substring(0, maxLen);
}

/**
 * SkillOutput + メタデータ → 完全な Plan を組み立てる
 */
export function buildPlan(
    skill: SkillOutput,
    sourceChannelId: string,
    notifyChannelId: string,
): Plan {
    const isImmediate = !skill.cron || skill.cron === '' || skill.cron === 'now' || skill.cron === 'immediate';

    const status: PlanStatus = skill.requires_confirmation
        ? 'pending_confirmation'
        : 'active';

    return {
        plan_id: skill.plan_id,
        timezone: skill.timezone || 'Asia/Tokyo',
        cron: isImmediate ? null : skill.cron,
        prompt: skill.prompt,
        requires_confirmation: skill.requires_confirmation,
        choice_mode: skill.choice_mode,
        source_channel_id: sourceChannelId,
        notify_channel_id: notifyChannelId,
        discord_templates: skill.discord_templates,
        human_summary: truncateSummary(skill.human_summary),
        attachment_paths: skill.attachment_paths,
        status,
        created_at: new Date().toISOString(),
    };
}

