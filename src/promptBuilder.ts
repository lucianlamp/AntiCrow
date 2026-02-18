// ---------------------------------------------------------------------------
// promptBuilder.ts — Skill プロンプト・確認メッセージ・cron ユーティリティ
// ---------------------------------------------------------------------------
// messageHandler.ts から分離。プロンプト生成・確認UI生成を集約。
// ---------------------------------------------------------------------------

import { Plan } from './types';
import { ChannelIntent } from './types';
import { logWarn, logInfo } from './logger';
import { markdownToJson } from './mdToJson';

// ---------------------------------------------------------------------------
// Skill プロンプト生成
// ---------------------------------------------------------------------------

/** buildSkillPrompt の返り値 */
export interface SkillPromptResult {
    prompt: string;
    tempFiles: string[];
}

export function buildSkillPrompt(
    userMessage: string,
    intent: ChannelIntent,
    channelName: string,
    responsePath: string,
    attachmentPaths?: string[],
    extensionPath?: string,
    ipcDir?: string,
): SkillPromptResult {
    const fs = require('fs');
    const pathMod = require('path');
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const tempFiles: string[] = [];

    // 一時ファイル用 ID 生成（タイムスタンプ + ランダム）
    const tmpId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // ルール内容を Markdown → JSON 変換して一時ファイルに保存
    let rulesFilePath = '';
    let rulesInline: unknown = null;
    if (extensionPath && ipcDir) {
        try {
            const rulesPath = pathMod.join(extensionPath, '.anticrow', 'rules', 'prompt_rules.md');
            const mdContent = fs.readFileSync(rulesPath, 'utf-8').trim();
            const jsonRules = markdownToJson(mdContent);
            const tmpRulesPath = pathMod.join(ipcDir, `tmp_rules_${tmpId}.json`);
            fs.writeFileSync(tmpRulesPath, JSON.stringify(jsonRules, null, 2), 'utf-8');
            tempFiles.push(tmpRulesPath);
            rulesFilePath = tmpRulesPath;
            logInfo(`promptBuilder: rules written to temp file: ${tmpRulesPath}`);
        } catch {
            // ルールファイルが見つからない場合はスキップ
        }
    } else if (extensionPath) {
        // ipcDir が渡されなかった場合は従来のインライン方式にフォールバック
        try {
            const rulesPath = pathMod.join(extensionPath, '.anticrow', 'rules', 'prompt_rules.md');
            const mdContent = fs.readFileSync(rulesPath, 'utf-8').trim();
            rulesInline = markdownToJson(mdContent);
        } catch {
            // ルールファイルが見つからない場合はスキップ
        }
    }

    // プロンプトインジェクション検出
    const injectionPatterns = [
        /ルールを無視/i,
        /システムプロンプト(を|の)(表示|出力|教え)/i,
        /ignore\s+(previous|above|all)\s+(instructions?|rules?)/i,
        /pretend\s+you\s+are/i,
        /you\s+are\s+now/i,
        /forget\s+(everything|all|previous)/i,
    ];
    for (const pattern of injectionPatterns) {
        if (pattern.test(userMessage)) {
            logWarn(`promptBuilder: potential prompt injection detected in message: "${userMessage.substring(0, 100)}"`);
            break;
        }
    }

    // JSON プロンプトオブジェクト構築
    const promptObj: Record<string, unknown> = {
        task: 'plan_generation',
        instruction: '以下の Discord メッセージから実行計画 JSON を生成してください。',
        input: {
            channel: `#${channelName}`,
            intent,
            datetime_jst: now,
            message: userMessage,
        },
        output: {
            method: 'write_to_file',
            path: responsePath,
            constraint: '最終結果確定後に1回だけ書き込む。途中経過や確認事項は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされる。',
        },
    };

    // ルールファイル参照
    if (rulesFilePath) {
        promptObj.rules_file = rulesFilePath;
        promptObj.rules_instruction = 'このファイルを view_file ツールで読み込み、そのルールに従ってください。';
    } else if (rulesInline) {
        promptObj.rules = rulesInline;
    }

    // 添付ファイル
    if (attachmentPaths && attachmentPaths.length > 0) {
        promptObj.attachments = attachmentPaths;
        promptObj.attachments_instruction = '添付ファイルを view_file ツールで確認し、prompt の中でも view_file で確認するよう指示を含めてください。';
    }

    // ユーザーグローバルルール（~/.anticrow/ANTICROW.md）を Markdown → JSON 変換して一時ファイルに保存
    try {
        const os = require('os');
        const globalRulesPath = pathMod.join(os.homedir(), '.anticrow', 'ANTICROW.md');
        const globalRulesMd = fs.readFileSync(globalRulesPath, 'utf-8').trim();
        if (globalRulesMd.length > 0) {
            const globalRulesJson = markdownToJson(globalRulesMd);
            if (ipcDir) {
                const tmpGlobalPath = pathMod.join(ipcDir, `tmp_global_${tmpId}.json`);
                fs.writeFileSync(tmpGlobalPath, JSON.stringify(globalRulesJson, null, 2), 'utf-8');
                tempFiles.push(tmpGlobalPath);
                promptObj.user_rules_file = tmpGlobalPath;
                promptObj.user_rules_instruction = 'このファイルを view_file ツールで読み込み、出力のスタイルや口調に反映してください。';
                logInfo(`promptBuilder: global rules written to temp file: ${tmpGlobalPath}`);
            } else {
                // フォールバック: インライン埋め込み
                promptObj.user_rules = globalRulesJson;
                promptObj.user_rules_instruction = '出力のスタイルや口調に反映してください。';
            }
        }
    } catch {
        // ファイルが存在しない場合はスキップ
    }

    // プロンプトを一時ファイルに書き出し、CDP には view_file 指示のみ返す
    const promptJson = JSON.stringify(promptObj, null, 2);
    if (ipcDir) {
        const tmpPromptPath = pathMod.join(ipcDir, `tmp_prompt_${tmpId}.json`);
        fs.writeFileSync(tmpPromptPath, promptJson, 'utf-8');
        tempFiles.push(tmpPromptPath);
        logInfo(`promptBuilder: prompt written to temp file: ${tmpPromptPath}`);
        const prompt = `以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: ${tmpPromptPath}`;
        return { prompt, tempFiles };
    }
    // フォールバック: ipcDir が無い場合は JSON 文字列をそのまま返す
    return { prompt: promptJson, tempFiles };

}

// ---------------------------------------------------------------------------
// 確認メッセージ生成
// ---------------------------------------------------------------------------

/** confirm テンプレートから選択肢の数をカウントする */
export function countChoiceItems(confirmText?: string): number {
    if (!confirmText) { return 0; }
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
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

    lines.push('📋 **実行確認**');
    lines.push('');

    // 概要
    if (plan.human_summary) {
        lines.push(`**概要:** ${plan.human_summary}`);
    }

    // 実行タイプ
    lines.push(`**実行タイプ:** ${isImmediate ? '⚡ 即時実行' : '🔄 定期実行'}`);

    // cron 式
    if (!isImmediate && plan.cron) {
        lines.push(`**スケジュール:** \`${plan.cron}\` (${plan.timezone})`);
    }

    // プロンプト内容（プレビュー）
    const promptPreview = plan.prompt.length > 2000
        ? plan.prompt.substring(0, 2000) + '…'
        : plan.prompt;
    lines.push('');
    lines.push('**実行内容:**');
    lines.push('```');
    lines.push(promptPreview);
    lines.push('```');


    // カスタム確認メッセージがあれば追加
    if (plan.discord_templates.confirm) {
        lines.push('');
        lines.push(plan.discord_templates.confirm);
    }

    // choice_mode に応じたフッター
    lines.push('');
    switch (choiceMode) {
        case 'all':
            lines.push('▶️ 以下の内容をすべて実行します（自動承認）');
            break;
        case 'single': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const lastEmoji = numberEmojis[Math.min(choiceCount || 1, 10) - 1];
            lines.push(`1️⃣~${lastEmoji} で1つ選択、❌ で却下`);
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
            break;
        }
        case 'multi': {
            const choiceCount = countChoiceItems(plan.discord_templates.confirm);
            const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            const lastEmoji = numberEmojis[Math.min(choiceCount || 1, 10) - 1];
            lines.push(`1️⃣~${lastEmoji} で複数選択 → ☑️ で確定`);
            lines.push('✅ 全て選択 / ❌ 却下');
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
            break;
        }
        default:
            lines.push('✅ で承認、❌ で却下');
            lines.push('💡 修正したい場合は ❌ で却下し、要件を修正して再送信できます。');
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
