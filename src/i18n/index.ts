/**
 * i18n モジュール — 言語切替ロジックと t() ヘルパー
 *
 * getLanguage() で VS Code 設定 antiCrow.language から言語を取得し、
 * 対応するメッセージを返す。デフォルトは 'ja'。
 */

import { messages as jaMessages, type MessageKey } from './ja';
import { messages as enMessages } from './en';
import PROMPT_RULES_MD from '../assets/prompt_rules.md';

// ---------------------------------------------------------------------------
// 言語定義
// ---------------------------------------------------------------------------

export type Language = 'ja' | 'en';

// メッセージの値は string もしくは string[] (dayNames 等)
type MessageMap = Record<string, string | readonly string[]>;

const messagesMap: Record<Language, MessageMap> = {
    ja: jaMessages,
    en: enMessages,
};

// ---------------------------------------------------------------------------
// 現在の言語を取得（メインプロセス等の環境によって取得元が異なる）
// ---------------------------------------------------------------------------

/**
 * 現在の言語設定を取得する。
 * configHelper の循環参照を避けるため、require で遅延読み込みする。
 */
function getCurrentLanguage(): Language {
    try {
        const { getLanguage } = require('../configHelper');
        return getLanguage() as Language;
    } catch {
        return 'ja';
    }
}

// ---------------------------------------------------------------------------
// t() ヘルパー — メッセージキーからローカライズ文字列を取得
// ---------------------------------------------------------------------------

/**
 * メッセージキーに対応するローカライズ文字列を返す。
 * プレースホルダー {0}, {1}, ... や {name} を引数で置換できる。
 *
 * @example
 * t('confirm.title')                    // "📋 **実行確認**"
 * t('confirm.summary', '概要テキスト')    // "**概要:** 概要テキスト"
 * t('prompt.view_file_instruction', '/path/to/file')  // "以下のファイルを..."
 */
export function t(key: MessageKey, ...args: (string | number)[]): string {
    const lang = getCurrentLanguage();
    const msgs = messagesMap[lang] || messagesMap.ja;
    const value = msgs[key];

    if (value === undefined) {
        // フォールバック: 日本語からも取得できなければキーをそのまま返す
        const fallback = jaMessages[key];
        if (fallback === undefined) { return key; }
        if (typeof fallback === 'string') {
            return replacePlaceholders(fallback, args);
        }
        return String(fallback);
    }

    if (typeof value === 'string') {
        return replacePlaceholders(value, args);
    }

    // 配列の場合はそのまま返す（呼び出し側でキャストして使用）
    return value as unknown as string;
}

/**
 * 配列型のメッセージキーに対応するローカライズ配列を返す。
 */
export function tArray(key: MessageKey): string[] {
    const lang = getCurrentLanguage();
    const msgs = messagesMap[lang] || messagesMap.ja;
    const value = msgs[key];

    if (Array.isArray(value)) {
        return value as unknown as string[];
    }
    // フォールバック
    const fallback = jaMessages[key];
    if (Array.isArray(fallback)) {
        return fallback as unknown as string[];
    }
    return [];
}

/**
 * PROMPT_RULES_MD 全文を返す。
 * (現在は英ポータルでの運用に基づき、全言語共通で English 版のルールを返す)
 */
export function getLocalizedPromptRules(): string {
    return PROMPT_RULES_MD;
}

// ---------------------------------------------------------------------------
// プレースホルダー置換ユーティリティ
// ---------------------------------------------------------------------------

function replacePlaceholders(template: string, args: (string | number)[]): string {
    if (args.length === 0) { return template; }
    let result = template;
    for (let i = 0; i < args.length; i++) {
        result = result.replace(new RegExp(`\\{${i}\\}`, 'g'), String(args[i]));
    }
    return result;
}

// 型情報の再エクスポート
export type { MessageKey };
