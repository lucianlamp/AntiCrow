// ---------------------------------------------------------------------------
// planParser.ts — Plan JSON/YAML バリデーション & Plan 構築
// ---------------------------------------------------------------------------

import { parse as parseYaml } from 'yaml';
import { Plan, PlanOutput, DiscordTemplates, PlanStatus, ChoiceMode } from './types';
import { logWarn, logDebug } from './logger';
import { getTimezone } from './configHelper';

/**
 * Plan が返した JSON/YAML 文字列をパースし、バリデーションする。
 * JSON パース失敗時は YAML パースにフォールバックする。
 * Zod は依存を増やすので手動バリデーション（計画スキーマは固定なので十分）。
 */
export function parsePlanJson(raw: string): PlanOutput | null {
    let obj: unknown;
    try {
        // Plan が ```json ... ``` で囲って返す可能性に備える
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        obj = JSON.parse(cleaned);
    } catch {
        // JSON パース失敗 → YAML としてパースを試行
        try {
            const yamlCleaned = raw.replace(/^```(?:ya?ml)?\s*/i, '').replace(/\s*```$/i, '').trim();
            obj = parseYaml(yamlCleaned);
            if (typeof obj === 'object' && obj !== null) {
                logDebug('planParser: JSON parse failed, YAML parse succeeded');
            } else {
                // YAML パース成功だがオブジェクトでない（文字列や数値など）
                logWarn('planParser: YAML parsed but result is not an object');
                return null;
            }
        } catch {
            logWarn('planParser: both JSON and YAML parse failed');
            return null;
        }
    }

    if (typeof obj !== 'object' || obj === null) { return null; }

    // レスポンスが {"reply":"...", "plan": {...}} 形式の場合、plan を取り出す
    let o = obj as Record<string, unknown>;
    if ('plan' in o && typeof o.plan === 'object' && o.plan !== null) {
        o = o.plan as Record<string, unknown>;
    }

    // 必須フィールドチェック
    if (typeof o.plan_id !== 'string' || !o.plan_id) { return null; }
    // requires_confirmation が欠落している場合は false をデフォルト値として使用
    const requiresConfirmation = typeof o.requires_confirmation === 'boolean' ? o.requires_confirmation : false;

    // discord_templates の堅牢なパースとフォールバック
    const dt = o.discord_templates;
    const dtObj = (typeof dt === 'object' && dt !== null) ? dt as Record<string, unknown> : {};
    const templates: DiscordTemplates = {
        ack: typeof dtObj.ack === 'string' ? dtObj.ack : '✅ 計画を受け付けました。',
        confirm: typeof dtObj.confirm === 'string' ? dtObj.confirm : '以下の計画を実行しますか？',
        run_start: typeof dtObj.run_start === 'string' ? dtObj.run_start : '🚀 実行を開始します...',
        run_success_prefix: typeof dtObj.run_success_prefix === 'string' ? dtObj.run_success_prefix : '✅ 実行完了:\n',
        run_error: typeof dtObj.run_error === 'string' ? dtObj.run_error : '❌ エラーが発生しました:\n',
    };

    // choice_mode（オプション）
    const validChoiceModes: ChoiceMode[] = ['none', 'single', 'multi', 'all'];
    const choiceMode = typeof o.choice_mode === 'string' && validChoiceModes.includes(o.choice_mode as ChoiceMode)
        ? o.choice_mode as ChoiceMode
        : undefined;

    return {
        plan_id: o.plan_id as string,
        timezone: typeof o.timezone === 'string' ? o.timezone : getTimezone(), // デフォルトフォールバック
        cron: typeof o.cron === 'string' ? o.cron : '', // デフォルトで即時実行
        prompt: typeof o.prompt === 'string' ? o.prompt : '指示が欠落しています。再試行してください。', // デフォルトフォールバック
        requires_confirmation: requiresConfirmation,
        choice_mode: choiceMode,
        discord_templates: templates,
        human_summary: typeof o.human_summary === 'string' ? o.human_summary : undefined,
        action_summary: typeof o.action_summary === 'string' ? o.action_summary : undefined,
        execution_summary: typeof o.execution_summary === 'string' ? o.execution_summary : undefined,
        prompt_summary: typeof o.prompt_summary === 'string' ? o.prompt_summary : undefined,
        attachment_paths: Array.isArray(o.attachment_paths) ? o.attachment_paths as string[] : undefined,
        tasks: Array.isArray(o.tasks) ? (o.tasks as string[]) : undefined,
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
 * PlanOutput + メタデータ → 完全な Plan を組み立てる
 */
export function buildPlan(
    output: PlanOutput,
    sourceChannelId: string,
    notifyChannelId: string,
): Plan {
    const isImmediate = !output.cron || output.cron === '' || output.cron === 'now' || output.cron === 'immediate';

    const status: PlanStatus = output.requires_confirmation
        ? 'pending_confirmation'
        : 'active';

    return {
        plan_id: output.plan_id,
        timezone: output.timezone || getTimezone(),
        cron: isImmediate ? null : output.cron,
        prompt: output.prompt,
        requires_confirmation: output.requires_confirmation,
        choice_mode: output.choice_mode,
        source_channel_id: sourceChannelId,
        notify_channel_id: notifyChannelId,
        discord_templates: output.discord_templates,
        human_summary: truncateSummary(output.human_summary),
        action_summary: output.action_summary,
        execution_summary: output.execution_summary,
        prompt_summary: output.prompt_summary,
        attachment_paths: output.attachment_paths,
        tasks: output.tasks,
        status,
        created_at: new Date().toISOString(),
    };
}

