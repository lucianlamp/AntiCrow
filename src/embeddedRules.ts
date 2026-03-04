/**
 * 埋め込みルール・テンプレート
 * 
 * .anticrow/ フォルダを廃止し、ルール・テンプレートの内容を
 * バンドル内に埋め込むことで改ざんを防止する。
 * 
 * i18n 対応: 言語別のルール・メッセージは src/i18n/ に定義。
 */

import { t, getLocalizedPromptRules } from './i18n';

/**
 * タイムゾーンプレースホルダーを実際の値で置換したプロンプトルールを返す。
 * 言語設定に応じたローカライズ済みルールを使用する。
 */
export function getPromptRulesMd(timezone: string): string {
  return getLocalizedPromptRules().replace(/\{\{TIMEZONE\}\}/g, timezone);
}

/** 実行プロンプトテンプレート（旧 .anticrow/templates/execution_prompt.json） */
export function getExecutionPromptTemplate(): string {
  return JSON.stringify({
    task: 'execution',
    context: {
      datetime_jst: '{{datetime}}',
    },
    prompt: '{{user_prompt}}',
    output: {
      response_path: '{{response_path}}',
      format: 'markdown',
      constraint: t('template.constraint'),
    },
    rules: '{{rules_content}}',
    progress: {
      path: '{{progress_path}}',
      instruction: t('template.progress.instruction'),
      format: {
        status: t('template.progress.status'),
        detail: t('template.progress.detail'),
        percent: 50,
      },
    },
  }, null, 4);
}

/**
 * 後方互換: 既存コードが EXECUTION_PROMPT_TEMPLATE 定数を参照している場合のフォールバック。
 * 新規コードは getExecutionPromptTemplate() 関数を使用すること。
 */
export const EXECUTION_PROMPT_TEMPLATE = getExecutionPromptTemplate();
