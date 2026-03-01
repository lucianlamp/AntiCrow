// ---------------------------------------------------------------------------
// suggestionParser.ts — レスポンスからインテリジェント提案を抽出
// ---------------------------------------------------------------------------
// 責務:
//   1. レスポンス Markdown から <!-- SUGGESTIONS:... --> タグを抽出
//   2. JSON パース → SuggestionItem[] に変換
//   3. 提案タグをレスポンス本文から除去
// ---------------------------------------------------------------------------

import { logDebug, logWarn } from './logger';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** 個別の提案アイテム */
export interface SuggestionItem {
    /** ボタンに表示する短いラベル（80文字以内推奨） */
    label: string;
    /** 実行するプロンプト */
    prompt: string;
    /** ボタンの説明テキスト（optional — Discord メッセージに表示） */
    description?: string;
}

/** パース結果 */
export interface SuggestionParseResult {
    /** 提案一覧（0〜3個） */
    suggestions: SuggestionItem[];
    /** 提案タグを除去したクリーンなコンテンツ */
    cleanContent: string;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 提案タグの正規表現（最初の1つをキャプチャ用） */
const SUGGESTION_TAG_RE = /<!--\s*SUGGESTIONS:\s*([\s\S]*?)\s*-->/;

/** 提案タグの正規表現（全マッチ除去用 — グローバルフラグ付き） */
const SUGGESTION_TAG_RE_G = /<!--\s*SUGGESTIONS:\s*[\s\S]*?\s*-->/g;

/** ボタンラベルの最大長（Discord Button label 上限は 80） */
const MAX_LABEL_LENGTH = 72;

/** 最大提案数 */
const MAX_SUGGESTIONS = 3;

// ---------------------------------------------------------------------------
// パーサー
// ---------------------------------------------------------------------------

/**
 * レスポンスから提案タグを抽出してパースする。
 * 提案が見つからない場合でもエラーにならず空配列を返す。
 */
export function parseSuggestions(content: string): SuggestionParseResult {
    const match = content.match(SUGGESTION_TAG_RE);
    if (!match) {
        return { suggestions: [], cleanContent: content };
    }

    const jsonStr = match[1].trim();
    // グローバルフラグ付き正規表現で全てのSUGGESTIONSタグを除去
    // （LLMが複数回タグを出力するケースへの対応）
    const cleanContent = content.replace(SUGGESTION_TAG_RE_G, '').trim();

    try {
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) {
            logWarn('suggestionParser: parsed value is not an array');
            return { suggestions: [], cleanContent };
        }

        const suggestions: SuggestionItem[] = parsed
            .filter((item: unknown): item is { label: string; prompt: string } => {
                if (typeof item !== 'object' || item === null) return false;
                const obj = item as Record<string, unknown>;
                return typeof obj.label === 'string' && typeof obj.prompt === 'string';
            })
            .slice(0, MAX_SUGGESTIONS)
            .map(item => ({
                label: item.label.slice(0, MAX_LABEL_LENGTH),
                prompt: item.prompt,
                ...(typeof (item as Record<string, unknown>).description === 'string'
                    ? { description: (item as Record<string, unknown>).description as string }
                    : {}),
            }));

        logDebug(`suggestionParser: extracted ${suggestions.length} suggestions`);
        return { suggestions, cleanContent };
    } catch (e) {
        logWarn(`suggestionParser: failed to parse suggestions JSON: ${e instanceof Error ? e.message : e}`);
        return { suggestions: [], cleanContent };
    }
}

/**
 * レスポンスから提案タグのみを除去する。
 * parseSuggestions の cleanContent と同等。
 */
export function stripSuggestionTags(content: string): string {
    return content.replace(SUGGESTION_TAG_RE_G, '').trim();
}
