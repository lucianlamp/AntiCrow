// ---------------------------------------------------------------------------
// executorPromptBuilder.ts — プロンプト構築モジュール
// ---------------------------------------------------------------------------
// Executor から分離。プロンプトテンプレートの読み込み・展開・構築を担当。
// ---------------------------------------------------------------------------

import { Plan } from './types';
import { readCombinedMemory } from './memoryStore';
import { logDebug } from './logger';
import { getPromptRulesMd, EXECUTION_PROMPT_TEMPLATE } from './embeddedRules';
import { getTimezone, getWorkspacePaths } from './configHelper';
import { sanitizeWorkspaceName } from './fileIpc';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// プロンプトテンプレート・ルール管理
// ---------------------------------------------------------------------------

/** プロンプトテンプレートを読み込む */
export function loadPromptTemplate(): string {
    const template = EXECUTION_PROMPT_TEMPLATE;
    logDebug(`PromptBuilder: loaded embedded prompt template (${template.length} chars)`);
    return template;
}

/** プロンプトルールを読み込む（タイムゾーンを動的に埋め込む） */
export function loadPromptRules(): string {
    const rules = getPromptRulesMd(getTimezone());
    logDebug(`PromptBuilder: loaded embedded prompt rules (${rules.length} chars)`);
    return rules;
}

/** ユーザーグローバルルール（SOUL.md）を読み込む */
export function loadUserGlobalRules(): string | null {
    const homedir = os.homedir();
    const filePath = path.join(homedir, '.anticrow', 'SOUL.md');
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.trim().length > 0) {
            const rules = content.trim();
            logDebug(`PromptBuilder: loaded user global rules from ${filePath} (${rules.length} chars)`);
            return rules;
        }
    } catch {
        logDebug(`PromptBuilder: no user global rules found at ${filePath} (optional)`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// 日時文字列生成
// ---------------------------------------------------------------------------

/** 現在時刻(JST等)と曜日のコンテキスト文字列を生成 */
export function buildDatetimeString(): string {
    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const nowJst = new Date(new Date().toLocaleString('en-US', { timeZone: getTimezone() }));
    const year = nowJst.getFullYear();
    const month = nowJst.getMonth() + 1;
    const day = nowJst.getDate();
    const dow = dayNames[nowJst.getDay()];
    const hours = String(nowJst.getHours()).padStart(2, '0');
    const minutes = String(nowJst.getMinutes()).padStart(2, '0');
    return `${year}年${month}月${day}日（${dow}）${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// メモリ読み込み
// ---------------------------------------------------------------------------

/** MEMORY.md を読み込み（グローバル + ワークスペース） */
export function loadUserMemory(workspaceName?: string): string | null {
    const wsPaths = getWorkspacePaths();
    const wsPath = workspaceName ? wsPaths[workspaceName] : undefined;
    return readCombinedMemory(wsPath);
}

// ---------------------------------------------------------------------------
// プロンプト構築パラメータ
// ---------------------------------------------------------------------------

export interface PromptBuildParams {
    plan: Plan;
    responsePath: string;
    progressPath: string;
    promptTemplate: string | null;
    promptRulesContent: string | null;
    userGlobalRules: string | null;
    userMemory: string | null;
}

// ---------------------------------------------------------------------------
// プロンプト本体構築
// ---------------------------------------------------------------------------

/** 最終プロンプト文字列を構築する */
export function buildFinalPrompt(params: PromptBuildParams): string {
    const {
        plan,
        responsePath,
        progressPath,
        promptTemplate,
        promptRulesContent,
        userGlobalRules,
        userMemory,
    } = params;

    const datetimeStr = buildDatetimeString();
    const rulesInline = promptRulesContent || '';

    if (promptTemplate) {
        return buildFromTemplate(promptTemplate, datetimeStr, plan, responsePath, progressPath, rulesInline, userGlobalRules, userMemory);
    }
    return buildInlineFallback(datetimeStr, plan, responsePath, progressPath, rulesInline, userGlobalRules, userMemory);
}

/** テンプレートベースのプロンプト構築 */
function buildFromTemplate(
    template: string,
    datetimeStr: string,
    plan: Plan,
    responsePath: string,
    progressPath: string,
    rulesInline: string,
    userGlobalRules: string | null,
    userMemory: string | null,
): string {
    let expanded = template
        .replace(/\{\{datetime\}\}/g, datetimeStr)
        .replace(/\{\{user_prompt\}\}/g, plan.prompt)
        .replace(/\{\{response_path\}\}/g, responsePath)
        .replace(/\{\{progress_path\}\}/g, progressPath)
        .replace(/\{\{rules_content\}\}/g, rulesInline);

    try {
        const tplObj = JSON.parse(expanded);
        if (plan.attachment_paths && plan.attachment_paths.length > 0) {
            tplObj.attachments = plan.attachment_paths;
            tplObj.attachments_instruction = '添付ファイルを view_file ツールで確認してください。';
        }
        if (userGlobalRules) {
            tplObj.user_rules = userGlobalRules;
            tplObj.user_rules_instruction = '出力のスタイルや口調に反映してください。';
        }
        if (userMemory) {
            tplObj.memory = userMemory;
            tplObj.memory_instruction = 'これはエージェントの記憶です。過去の学びや教訓を参考にしてください。';
        }
        return JSON.stringify(tplObj, null, 2);
    } catch {
        // JSON パース失敗時はテキストとしてそのまま使用（旧 .md 互換）
        let finalPrompt = expanded;
        if (plan.attachment_paths && plan.attachment_paths.length > 0) {
            finalPrompt += `\n\n## 添付ファイル\n以下のファイルが Discord メッセージに添付されています。view_file ツールで内容を確認してください。\n\n`;
            for (const p of plan.attachment_paths) {
                finalPrompt += `- ${p}\n`;
            }
        }
        if (userGlobalRules) {
            finalPrompt += `\n\n## ユーザー設定\n${userGlobalRules}`;
        }
        if (userMemory) {
            finalPrompt += `\n\n## エージェントの記憶\n${userMemory}`;
        }
        return finalPrompt;
    }
}

/** インラインフォールバック: JSON オブジェクト形式 */
function buildInlineFallback(
    datetimeStr: string,
    plan: Plan,
    responsePath: string,
    progressPath: string,
    rulesInline: string,
    userGlobalRules: string | null,
    userMemory: string | null,
): string {
    const promptObj: Record<string, unknown> = {
        task: 'execution',
        context: { datetime_jst: datetimeStr },
        prompt: plan.prompt,
        output: {
            response_path: responsePath,
            format: 'markdown',
            constraint: 'すべての作業が完了してから write_to_file で Markdown 形式のレスポンスを1回だけ書き込む。途中経過は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされ、内容がそのまま Discord に送信される。Discord の Markdown 記法に準拠すること（**太字**, - 箇条書き, `コード` 等）。結果には何をしたか・変更内容・影響範囲・注意点などを具体的かつ詳細に記述すること。簡素すぎる報告は避ける。変更したファイル名・変更の概要・テスト結果・注意事項をすべて含めること。',
        },
        rules: rulesInline || undefined,
        progress: {
            path: progressPath,
            instruction: '進捗ファイルに JSON で進捗状況を定期的に書き込むこと（write_to_file, Overwrite: true）。処理の各段階で必ず status を更新。30秒〜1分おきに percent と status を更新する。',
            format: { status: '現在のステータス', detail: '詳細（任意）', percent: 50 },
        },
    };
    if (plan.attachment_paths && plan.attachment_paths.length > 0) {
        promptObj.attachments = plan.attachment_paths;
        promptObj.attachments_instruction = '添付ファイルを view_file ツールで確認してください。';
    }
    if (userGlobalRules) {
        promptObj.user_rules = userGlobalRules;
        promptObj.user_rules_instruction = '出力のスタイルや口調に反映してください。';
    }
    if (userMemory) {
        promptObj.memory = userMemory;
        promptObj.memory_instruction = 'これはエージェントの記憶です。過去の学びや教訓を参考にしてください。';
    }
    return JSON.stringify(promptObj, null, 2);
}

// ---------------------------------------------------------------------------
// CDP 指示文字列とテンポラリファイルの生成
// ---------------------------------------------------------------------------

export interface CdpPromptFiles {
    tmpExecPath: string;
    cdpInstruction: string;
}

/** プロンプトを一時ファイルに書き出し、CDP 用の指示文字列を返す */
export function writeTempPrompt(
    finalPrompt: string,
    responsePath: string,
    requestId: string,
    workspaceName?: string,
): CdpPromptFiles {
    const ipcDir = path.dirname(responsePath);
    const wsExecPrefix = sanitizeWorkspaceName(workspaceName);
    const tmpExecPath = wsExecPrefix
        ? path.join(ipcDir, `tmp_exec_${wsExecPrefix}_${requestId}.json`)
        : path.join(ipcDir, `tmp_exec_${requestId}.json`);
    fs.writeFileSync(tmpExecPath, finalPrompt, 'utf-8');
    logDebug(`PromptBuilder: prompt written to temp file: ${tmpExecPath}`);
    const cdpInstruction = `以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: ${tmpExecPath}`;
    return { tmpExecPath, cdpInstruction };
}
