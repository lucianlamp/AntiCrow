// ---------------------------------------------------------------------------
// promptBuilder.ts — Skill プロンプト・確認メッセージ・cron ユーティリティ
// ---------------------------------------------------------------------------
// messageHandler.ts から分離。プロンプト生成・確認UI生成を集約。
// ---------------------------------------------------------------------------

import { Plan } from './types';
import { ChannelIntent } from './types';
import { logWarn, logInfo } from './logger';

// ---------------------------------------------------------------------------
// Skill プロンプト生成
// ---------------------------------------------------------------------------

export function buildSkillPrompt(
    userMessage: string,
    intent: ChannelIntent,
    channelName: string,
    responsePath: string,
    attachmentPaths?: string[],
    extensionPath?: string,
): string {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    // ルール内容をインライン展開用に読み込み
    let rulesContent = '';
    if (extensionPath) {
        try {
            const fs = require('fs');
            const path = require('path');
            const rulesPath = path.join(extensionPath, '.anticrow', 'rules', 'prompt_rules.md');
            rulesContent = fs.readFileSync(rulesPath, 'utf-8').trim();
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

    let prompt = `以下の Discord メッセージから実行計画 JSON を生成してください。

## 入力

- チャンネル: #${channelName}
- Intent: ${intent}
- 現在時刻(JST): ${now}
- メッセージ:
--- ユーザーメッセージ開始 ---
${userMessage}
--- ユーザーメッセージ終了 ---

${rulesContent}

## 重要: 出力方法

結果の JSON を以下のファイルパスに write_to_file ツールで書き込んでください。
チャットにも結果を出力してください。
ファイルパス: ${responsePath}`;

    // 添付ファイルがある場合、プロンプトに追記
    if (attachmentPaths && attachmentPaths.length > 0) {
        prompt += `\n\n## 添付ファイル\n以下のファイルが Discord メッセージに添付されています。\nprompt の中で view_file ツールで内容を確認するよう指示を含めてください。\n\n`;
        for (const p of attachmentPaths) {
            prompt += `- ${p}\n`;
        }
    }

    // ユーザーグローバルルール（~/.anticrow/ANTICROW.md）を注入
    try {
        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const globalRulesPath = path.join(os.homedir(), '.anticrow', 'ANTICROW.md');
        const globalRules = fs.readFileSync(globalRulesPath, 'utf-8').trim();
        if (globalRules.length > 0) {
            prompt += `\n\n## ユーザー設定\n以下はユーザーが設定したグローバルルールです。出力のスタイルや口調に反映してください。\n\n${globalRules}`;
        }
    } catch {
        // ファイルが存在しない場合はスキップ
    }

    return prompt;

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
    const promptPreview = plan.prompt.length > 300
        ? plan.prompt.substring(0, 300) + '…'
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
