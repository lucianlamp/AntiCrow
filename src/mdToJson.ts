// ---------------------------------------------------------------------------
// mdToJson.ts — Markdown → JSON 変換ユーティリティ
// ---------------------------------------------------------------------------
// prompt_rules.md や ANTICROW.md などの Markdown ルールファイルを
// JSON オブジェクトに変換し、改行に依存しない構造化データとして
// プロンプトに埋め込むために使用する。
// ---------------------------------------------------------------------------

/**
 * Markdown テキストを構造化 JSON オブジェクトに変換する。
 *
 * 対応する Markdown 要素:
 * - `# 見出し1` → トップレベルセクション
 * - `## 見出し2` → セクション内のサブセクション
 * - `- リスト項目` → 配列要素
 * - `1. 番号リスト` → 配列要素
 * - ` ```json ... ``` ` → JSON オブジェクトとしてパース
 * - 通常テキスト → 文字列値
 */
export function markdownToJson(markdown: string): Record<string, unknown> {
    const lines = markdown.split(/\r?\n/);
    const result: Record<string, unknown> = {};

    let currentH1 = '';
    let currentH2 = '';
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockLines: string[] = [];
    let currentList: string[] | null = null;
    let currentTextLines: string[] = [];

    const flushText = () => {
        const text = currentTextLines.map(l => l.trim()).filter(l => l.length > 0).join(' ');
        if (text.length > 0 && currentH1) {
            const target = getTarget(result, currentH1, currentH2);
            if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
                const obj = target as Record<string, unknown>;
                if (!obj['_text']) {
                    obj['_text'] = text;
                } else {
                    obj['_text'] = (obj['_text'] as string) + ' ' + text;
                }
            }
        }
        currentTextLines = [];
    };

    const flushList = () => {
        if (currentList && currentList.length > 0 && currentH1) {
            const target = getTarget(result, currentH1, currentH2);
            if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
                const obj = target as Record<string, unknown>;
                if (!obj['_items']) {
                    obj['_items'] = currentList;
                } else {
                    (obj['_items'] as string[]).push(...currentList);
                }
            }
        }
        currentList = null;
    };

    for (const line of lines) {
        const trimmed = line.trim();

        // コードブロックの開始/終了
        if (trimmed.startsWith('```')) {
            if (!inCodeBlock) {
                flushText();
                flushList();
                inCodeBlock = true;
                codeBlockLang = trimmed.slice(3).trim().toLowerCase();
                codeBlockLines = [];
            } else {
                // コードブロック終了 → JSON としてパースを試みる
                const codeContent = codeBlockLines.join('\n');
                if (currentH1) {
                    const target = getTarget(result, currentH1, currentH2);
                    if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
                        const obj = target as Record<string, unknown>;
                        if (codeBlockLang === 'json') {
                            try {
                                obj['_schema'] = JSON.parse(codeContent);
                            } catch {
                                obj['_code'] = codeContent;
                            }
                        } else {
                            obj['_code'] = codeContent;
                        }
                    }
                }
                inCodeBlock = false;
                codeBlockLang = '';
                codeBlockLines = [];
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockLines.push(line);
            continue;
        }

        // H1 見出し
        if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
            flushText();
            flushList();
            currentH1 = normalizeKey(trimmed.slice(2).trim());
            currentH2 = '';
            if (!result[currentH1]) {
                result[currentH1] = {};
            }
            continue;
        }

        // H2 見出し
        if (trimmed.startsWith('## ')) {
            flushText();
            flushList();
            currentH2 = normalizeKey(trimmed.slice(3).trim());
            if (currentH1 && result[currentH1] && typeof result[currentH1] === 'object') {
                const h1Obj = result[currentH1] as Record<string, unknown>;
                if (!h1Obj[currentH2]) {
                    h1Obj[currentH2] = {};
                }
            }
            continue;
        }

        // リスト項目 (- or *)
        if (/^[-*]\s+/.test(trimmed)) {
            flushText();
            if (!currentList) { currentList = []; }
            currentList.push(trimmed.replace(/^[-*]\s+/, ''));
            continue;
        }

        // 番号付きリスト (1. 2. etc)
        if (/^\d+\.\s+/.test(trimmed)) {
            flushText();
            if (!currentList) { currentList = []; }
            currentList.push(trimmed.replace(/^\d+\.\s+/, ''));
            continue;
        }

        // 空行
        if (trimmed === '') {
            flushList();
            continue;
        }

        // 通常テキスト
        flushList();
        currentTextLines.push(trimmed);
    }

    // 残りをフラッシュ
    flushText();
    flushList();

    return simplify(result);
}

// ---------------------------------------------------------------------------
// ヘルパー関数
// ---------------------------------------------------------------------------

/** セクションキーを正規化する（空白をアンダースコアに変換等） */
function normalizeKey(heading: string): string {
    return heading
        .replace(/[（(].*?[）)]/g, '')  // 括弧内を除去
        .trim()
        .replace(/\s+/g, '_');
}

/** 現在のセクション対象オブジェクトを取得する */
function getTarget(
    root: Record<string, unknown>,
    h1: string,
    h2: string,
): Record<string, unknown> | null {
    if (!h1 || !root[h1]) { return null; }
    const h1Obj = root[h1] as Record<string, unknown>;
    if (h2 && h1Obj[h2]) {
        return h1Obj[h2] as Record<string, unknown>;
    }
    return h1Obj;
}

/**
 * JSON 構造を簡略化する。
 * - _items のみのオブジェクト → 配列に置換
 * - _text のみのオブジェクト → 文字列に置換
 * - 単一キーのネストを再帰的に簡略化
 */
function simplify(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const inner = value as Record<string, unknown>;
            const keys = Object.keys(inner);

            // _items のみ → 配列に
            if (keys.length === 1 && keys[0] === '_items') {
                result[key] = inner['_items'];
                continue;
            }
            // _text のみ → 文字列に
            if (keys.length === 1 && keys[0] === '_text') {
                result[key] = inner['_text'];
                continue;
            }
            // 再帰的に簡略化
            result[key] = simplify(inner);
        } else {
            result[key] = value;
        }
    }
    return result;
}
