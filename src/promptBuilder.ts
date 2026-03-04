// ---------------------------------------------------------------------------
// promptBuilder.ts — Plan プロンプト・確認メッセージ・cron ユーティリティ
// ---------------------------------------------------------------------------
// messageHandler.ts から分離。プロンプト生成・確認UI生成を集約。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Plan } from './types';
import { ChannelIntent } from './types';
import { logWarn, logDebug } from './logger';
import { markdownToJson } from './mdToJson';
import { getPromptRulesMd } from './embeddedRules';
import { getTimezone } from './configHelper';
import { readCombinedMemory } from './memoryStore';
import { sanitizeWorkspaceName } from './fileIpc';
import { t } from './i18n';

// ---------------------------------------------------------------------------
// Plan プロンプト生成
// ---------------------------------------------------------------------------

/** buildPlanPrompt の返り値 */
export interface PlanPromptResult {
    prompt: string;
    tempFiles: string[];
}

export function buildPlanPrompt(
    userMessage: string,
    intent: ChannelIntent,
    channelName: string,
    responsePath: string,
    attachmentPaths?: string[],
    extensionPath?: string,
    ipcDir?: string,
    workspacePath?: string,
    progressPath?: string,
): PlanPromptResult {
    const now = new Date().toLocaleString('ja-JP', { timeZone: getTimezone() });
    const tempFiles: string[] = [];

    // 一時ファイル用 ID 生成（ワークスペースプレフィックス + タイムスタンプ + ランダム）
    const wsPrefix = sanitizeWorkspaceName(workspacePath ? path.basename(workspacePath) : undefined);
    const tmpId = wsPrefix
        ? `${wsPrefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
        : `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // ルール内容を埋め込み定数から Markdown → JSON 変換して一時ファイルに保存
    let rulesFilePath = '';
    let rulesInline: unknown = null;
    const jsonRules = markdownToJson(getPromptRulesMd(getTimezone()));
    if (ipcDir) {
        try {
            const tmpRulesPath = path.join(ipcDir, `tmp_rules_${tmpId}.json`);
            fs.writeFileSync(tmpRulesPath, JSON.stringify(jsonRules, null, 2), 'utf-8');
            tempFiles.push(tmpRulesPath);
            rulesFilePath = tmpRulesPath;
            logDebug(`promptBuilder: rules written to temp file: ${tmpRulesPath}`);
        } catch (e) {
            logDebug(`promptBuilder: failed to write rules temp file: ${e instanceof Error ? e.message : e}`);
        }
    } else {
        // ipcDir が渡されなかった場合は従来のインライン方式にフォールバック
        rulesInline = jsonRules;
    }

    // プロンプトインジェクション検出
    const injectionPatterns: { pattern: RegExp; label: string }[] = [
        // 日本語パターン
        { pattern: /ルールを無視/i, label: 'rule_ignore_ja' },
        { pattern: /システムプロンプト(を|の)(表示|出力|教え)/i, label: 'system_prompt_leak_ja' },
        { pattern: /指示を変更/i, label: 'instruction_change_ja' },
        { pattern: /プロンプトを見せて/i, label: 'prompt_reveal_ja' },
        { pattern: /制限を解除/i, label: 'restriction_remove_ja' },
        { pattern: /設定を(リセット|初期化)/i, label: 'config_reset_ja' },
        // 英語パターン
        { pattern: /ignore\s+(previous|above|all)\s+(instructions?|rules?)/i, label: 'ignore_instructions' },
        { pattern: /pretend\s+you\s+are/i, label: 'pretend_identity' },
        { pattern: /you\s+are\s+now/i, label: 'identity_override' },
        { pattern: /forget\s+(everything|all|previous)/i, label: 'forget_context' },
        { pattern: /do\s+not\s+follow\s+(any|the|your)/i, label: 'do_not_follow' },
        { pattern: /act\s+as\s+(a|an|if)/i, label: 'act_as' },
        { pattern: /behave\s+as/i, label: 'behave_as' },
        { pattern: /(override|bypass)\s+(the\s+)?(rules?|instructions?|filters?|restrictions?)/i, label: 'override_bypass' },
        { pattern: /(reveal|show\s+me)\s+(your|the)\s+(system|internal|hidden)/i, label: 'reveal_internal' },
        { pattern: /\[system\]/i, label: 'format_injection_bracket' },
        { pattern: /<system>/i, label: 'format_injection_tag' },
        { pattern: /do\s+anything\s+i\s+(say|ask|tell)/i, label: 'unrestricted_obey' },
    ];
    const detectedInjections: string[] = [];
    for (const { pattern, label } of injectionPatterns) {
        if (pattern.test(userMessage)) {
            detectedInjections.push(label);
        }
    }
    if (detectedInjections.length > 0) {
        logWarn(`promptBuilder: potential prompt injection detected (${detectedInjections.join(', ')}) in message: "${userMessage.substring(0, 100)}"`);
    }

    // JSON プロンプトオブジェクト構築
    const promptObj: Record<string, unknown> = {
        task: 'plan_generation',
        instruction: t('prompt.instruction'),
        input: {
            channel: `#${channelName}`,
            intent,
            datetime_jst: now,
            message: userMessage,
        },
        output: {
            method: 'write_to_file',
            path: responsePath,
            constraint: t('prompt.output.constraint'),
        },
    };

    // インジェクション警告をプロンプトに付加（AI側でも認識可能にする）
    if (detectedInjections.length > 0) {
        promptObj.injection_warning = {
            detected_patterns: detectedInjections,
            instruction: t('prompt.injection_warning.instruction'),
        };
    }

    // ルールファイル参照
    if (rulesFilePath) {
        promptObj.rules_file = rulesFilePath;
        promptObj.rules_instruction = t('prompt.rules_instruction');
    } else if (rulesInline) {
        promptObj.rules = rulesInline;
    }

    // 添付ファイル
    if (attachmentPaths && attachmentPaths.length > 0) {
        promptObj.attachments = attachmentPaths;
        promptObj.attachments_instruction = t('prompt.attachments_instruction');
    }

    // ユーザーグローバルルール（~/.anticrow/SOUL.md）を Markdown → JSON 変換して一時ファイルに保存
    try {
        const globalRulesPath = path.join(os.homedir(), '.anticrow', 'SOUL.md');
        const globalRulesMd = fs.readFileSync(globalRulesPath, 'utf-8').trim();
        if (globalRulesMd.length > 0) {
            const globalRulesJson = markdownToJson(globalRulesMd);
            if (ipcDir) {
                const tmpGlobalPath = path.join(ipcDir, `tmp_global_${tmpId}.json`);
                fs.writeFileSync(tmpGlobalPath, JSON.stringify(globalRulesJson, null, 2), 'utf-8');
                tempFiles.push(tmpGlobalPath);
                promptObj.user_rules_file = tmpGlobalPath;
                promptObj.user_rules_instruction = t('prompt.user_rules_instruction.file');
                logDebug(`promptBuilder: global rules written to temp file: ${tmpGlobalPath}`);
            } else {
                // フォールバック: インライン埋め込み
                promptObj.user_rules = globalRulesJson;
                promptObj.user_rules_instruction = t('prompt.user_rules_instruction.inline');
            }
        }
    } catch (e) {
        logDebug(`promptBuilder: global rules file (~/.anticrow/SOUL.md) not found: ${e instanceof Error ? e.message : e}`);
    }

    // MEMORY.md（グローバル + ワークスペース）を読み込んでプロンプトに注入
    const combinedMemory = readCombinedMemory(workspacePath);
    if (combinedMemory) {
        promptObj.memory = combinedMemory;
        promptObj.memory_instruction = t('prompt.memory_instruction');
        logDebug(`promptBuilder: injected combined memory (${combinedMemory.length} chars)`);
    }

    // 進捗報告パス（計画生成中もリアルタイム進捗通知を行う）
    if (progressPath) {
        promptObj.progress = {
            path: progressPath,
            instruction: t('prompt.progress.instruction'),
            format: {
                status: t('prompt.progress.status'),
                detail: t('prompt.progress.detail'),
                percent: 50,
            },
        };
    }

    // プロンプトを一時ファイルに書き出し、CDP には view_file 指示のみ返す
    const promptJson = JSON.stringify(promptObj, null, 2);
    if (ipcDir) {
        const tmpPromptPath = path.join(ipcDir, `tmp_prompt_${tmpId}.json`);
        fs.writeFileSync(tmpPromptPath, promptJson, 'utf-8');
        tempFiles.push(tmpPromptPath);
        logDebug(`promptBuilder: prompt written to temp file: ${tmpPromptPath}`);
        const prompt = t('prompt.view_file_instruction', tmpPromptPath);
        return { prompt, tempFiles };
    }
    // フォールバック: ipcDir が無い場合は JSON 文字列をそのまま返す
    return { prompt: promptJson, tempFiles };

}

// ---------------------------------------------------------------------------
// 確認メッセージ生成
// ---------------------------------------------------------------------------

/** confirm テンプレートから選択肢の数をカウントする（最大3） */
export function countChoiceItems(confirmText?: string): number {
    if (!confirmText) { return 0; }
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣'];
    let emojiCount = 0;
    for (const emoji of numberEmojis) {
        if (confirmText.includes(emoji)) { emojiCount++; }
    }
    return emojiCount;
}

export function buildConfirmMessage(plan: Plan): string {
    const isImmediate = plan.cron === null;
    const choiceMode = plan.choice_mode || 'none';
    const lines: string[] = [];

    lines.push(t('confirm.title'));
    lines.push('');

    // 概要
    if (plan.human_summary) {
        lines.push(t('confirm.summary', plan.human_summary));
    }

    // 実行タイプ
    lines.push(t('confirm.type', isImmediate ? t('confirm.type.immediate') : t('confirm.type.scheduled')));

    // cron 式
    if (!isImmediate && plan.cron) {
        lines.push(t('confirm.schedule', plan.cron, plan.timezone));
    }

    // 実行内容（prompt_summary がある場合は要約、ない場合はプロンプト全文）
    lines.push('');
    lines.push(t('confirm.content'));
    if (plan.prompt_summary) {
        // 要約をブロック引用で表示（読みやすい形式）
        const summaryLines = plan.prompt_summary.split('\n');
        for (const sl of summaryLines) {
            lines.push(`> ${sl}`);
        }
    } else {
        // フォールバック: プロンプト全文をコードブロックで表示
        const promptPreview = plan.prompt.length > 2000
            ? plan.prompt.substring(0, 2000) + '…'
            : plan.prompt;
        lines.push('```');
        lines.push(promptPreview);
        lines.push('```');
    }


    // カスタム確認メッセージがあれば追加
    if (plan.discord_templates.confirm) {
        lines.push('');
        lines.push(plan.discord_templates.confirm);
    }

    // choice_mode に応じたフッター
    lines.push('');
    switch (choiceMode) {
        case 'all':
            lines.push(t('confirm.choice.all'));
            break;
        case 'single': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            lines.push(t('confirm.choice.single', String(Math.min(choiceCount || 1, 10))));
            lines.push(t('confirm.choice.single.hint'));
            break;
        }
        case 'multi': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            lines.push(t('confirm.choice.multi', String(Math.min(choiceCount || 1, 10))));
            lines.push(t('confirm.choice.multi.actions'));
            lines.push(t('confirm.choice.multi.hint'));
            break;
        }
        default:
            lines.push(t('confirm.choice.default.hint'));
            break;
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// cron プレフィックス生成
// ---------------------------------------------------------------------------

// cron 式から人間が読めるプレフィックスを生成する。
// 例: "star/5 * * * *" → "[5m]", "0 * * * *" → "[1h]", "0 0 * * *" → "[daily]"
export function cronToPrefix(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) { return '[cron]'; }
    const [minute, hour, dom, , dow] = parts;

    // */N * * * * → [Nm]
    const everyMinMatch = minute.match(/^\*\/(\d+)$/);
    if (everyMinMatch && hour === '*') {
        return `[${everyMinMatch[1]}m]`;
    }

    // 0 */N * * * → [Nh]
    const everyHourMatch = hour.match(/^\*\/(\d+)$/);
    if (minute === '0' && everyHourMatch) {
        return `[${everyHourMatch[1]}h]`;
    }

    // 0 * * * * → [1h]
    if (minute === '0' && hour === '*') {
        return '[1h]';
    }

    // 0 0 1 * * → [monthly]
    if (minute === '0' && hour === '0' && dom === '1') {
        return '[monthly]';
    }

    // 0 0 * * N → [weekly]
    if (minute === '0' && hour === '0' && dom === '*' && dow !== '*') {
        return '[weekly]';
    }

    // 0 0 * * * → [daily]
    if (minute === '0' && hour === '0' && dom === '*' && dow === '*') {
        return '[daily]';
    }

    // 0 N * * * (特定時刻、毎日) → [daily]
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && dow === '*') {
        return '[daily]';
    }

    return '[cron]';
}
