// ---------------------------------------------------------------------------
// discordFormatter.ts — Discord 長文対応（分割 & ファイル添付）
// ---------------------------------------------------------------------------

const MAX_LEN = 1990; // 2000 - マージン
const EMBED_DESC_MAX = 4000; // Embed description 上限 4096 - マージン
const EMBED_TOTAL_MAX = 5900; // メッセージあたり Embed 合計 6000 - マージン

/**
 * テキストを Discord の 2000 文字制限に合わせて分割する。
 * コードブロック (```) の途中で切れた場合は閉じ/再開を補完する。
 */
export function splitMessage(text: string): string[] {
    if (text.length <= MAX_LEN) { return [text]; }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= MAX_LEN) {
            chunks.push(remaining);
            break;
        }

        // MAX_LEN までで最後の改行を探す
        let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
        if (splitAt <= 0) { splitAt = MAX_LEN; }

        let chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt);

        // コードブロック補完: 奇数個の ``` があれば閉じる
        const fenceCount = (chunk.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) {
            chunk += '\n```';
            remaining = '```\n' + remaining;
        }

        chunks.push(chunk);
    }

    return chunks;
}

/**
 * テキストを Discord Embed 用に分割する。
 * 各チャンクは EMBED_DESC_MAX 以内（1 Embed の description 上限）。
 * さらにメッセージ合計 EMBED_TOTAL_MAX を超えないようグループ化して返す。
 * 戻り値: string[][] — 外側がメッセージ単位、内側が各 Embed の description。
 */
export function splitForEmbeds(text: string): string[][] {
    // まず EMBED_DESC_MAX ごとにチャンク分割
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= EMBED_DESC_MAX) {
            chunks.push(remaining);
            break;
        }

        let splitAt = remaining.lastIndexOf('\n', EMBED_DESC_MAX);
        if (splitAt <= 0) { splitAt = EMBED_DESC_MAX; }

        let chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt);

        // コードブロック補完
        const fenceCount = (chunk.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) {
            chunk += '\n```';
            remaining = '```\n' + remaining;
        }

        chunks.push(chunk);
    }

    // EMBED_TOTAL_MAX を超えないようにグループ化
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentTotal = 0;

    for (const chunk of chunks) {
        if (currentGroup.length > 0 && currentTotal + chunk.length > EMBED_TOTAL_MAX) {
            groups.push(currentGroup);
            currentGroup = [];
            currentTotal = 0;
        }
        currentGroup.push(chunk);
        currentTotal += chunk.length;
    }
    if (currentGroup.length > 0) {
        groups.push(currentGroup);
    }

    return groups;
}

/** Embed field データ */
export interface EmbedFieldData {
    name: string;
    value: string;
    inline?: boolean;
}

/** extractTableFields の戻り値 */
export interface ExtractedContent {
    /** テーブル以外のテキスト（description 用） */
    description: string;
    /** テーブルから抽出した fields */
    fields: EmbedFieldData[];
}

/**
 * テキストから Markdown テーブル（| ... | 形式）を検出し、
 * Embed fields に変換する。テーブル以外の部分は description として返す。
 *
 * Markdown テーブル形式:
 *   | 項目     | 内容       |
 *   | -------- | ---------- |
 *   | 天気     | 晴れ       |
 *   | 気温     | 10℃       |
 */
export function extractTableFields(text: string): ExtractedContent {
    const fields: EmbedFieldData[] = [];
    const descParts: string[] = [];

    // Markdown テーブルを検出:
    // ヘッダー行 + 区切り行(| --- |) + データ行(1行以上)
    const tableRegex = /^(\|.+\|)[ \t]*\r?\n(\|[\s\-:|]+\|)[ \t]*\r?\n((?:\|.+\|[ \t]*\r?\n?)+)/gm;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tableRegex.exec(text)) !== null) {
        const headerLine = match[1];
        // match[2] は区切り行（無視）
        const dataBlock = match[3];
        const tableStart = match.index;
        const tableEnd = match.index + match[0].length;

        // テーブル前のテキストを description に追加
        if (tableStart > lastIndex) {
            const before = text.slice(lastIndex, tableStart).trim();
            if (before.length > 0) {
                descParts.push(before);
            }
        }
        lastIndex = tableEnd;

        // ヘッダーをパース
        const headers = parseMdTableRow(headerLine);
        if (headers.length < 2) { continue; }

        // データ行をパース
        const dataLines = dataBlock.trim().split(/\r?\n/);
        for (const dataLine of dataLines) {
            const cols = parseMdTableRow(dataLine);
            if (cols.length < 2) { continue; }

            // 最初のカラムを name、残りを value に
            fields.push({
                name: cols[0] || '\u200b',
                value: cols.slice(1).join(' / ') || '\u200b',
                inline: true,
            });
        }
    }

    // テーブル後の残りテキスト
    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
        if (remaining.length > 0) {
            descParts.push(remaining);
        }
    }

    // テーブルが見つからなかった場合
    if (fields.length === 0) {
        return { description: text, fields: [] };
    }

    return {
        description: descParts.join('\n\n'),
        fields,
    };
}

/** Markdown テーブル行（| col1 | col2 |）をパースしてカラム配列を返す */
function parseMdTableRow(line: string): string[] {
    // 先頭と末尾の | を除去してから | で分割
    const trimmed = line.trim();
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
    const withoutEnd = inner.endsWith('|') ? inner.slice(0, -1) : inner;
    return withoutEnd.split('|').map(c => c.trim());
}

/**
 * 長すぎる場合はテキストファイルとして添付用 Buffer を返す。
 * 閾値: 6000文字（3 分割超）
 */
export function shouldAttachAsFile(text: string): boolean {
    return text.length > 6000;
}

export function textToBuffer(text: string): Buffer {
    return Buffer.from(text, 'utf-8');
}

/**
 * Discord 風 Markdown テキストを自己完結型 HTML に変換する。
 * ダークテーマ・レスポンシブ・CSS インライン。
 */
export function markdownToHtml(text: string): string {
    let html = escapeHtml(text);

    // コードブロック (```lang\n...\n```) → <pre><code>
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
        `<pre><code>${code.trimEnd()}</code></pre>`);

    // インラインコード (`...`) → <code>
    html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');

    // 見出し (### → h3, ## → h2, # → h1) — 行頭のみ
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 太字 (**...**) → <strong>
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // 箇条書き (- / • / * ) → <li>（連続する箇条書きを <ul> で囲む）
    html = html.replace(/^([\-•\*] .+(\n|$))+/gm, (block) => {
        const items = block.trim().split('\n').map(line =>
            `<li>${line.replace(/^[\-•\*] /, '')}</li>`).join('\n');
        return `<ul>${items}</ul>`;
    });

    // 水平線 (---) → <hr>
    html = html.replace(/^-{3,}$/gm, '<hr>');

    // 残りの改行 → <br>（ただし <pre> 内は除外するため後処理）
    // <pre>～</pre> 以外の改行を <br> に変換
    const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
    html = parts.map((part, i) => {
        if (i % 2 === 1) { return part; } // <pre> ブロック内はそのまま
        return part.replace(/\n/g, '<br>\n');
    }).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Result</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;line-height:1.7;padding:1rem;max-width:720px;margin:0 auto;font-size:14px}
h1{font-size:1.4rem;color:#58a6ff;border-bottom:1px solid #21262d;padding-bottom:.4rem;margin:.8rem 0}
h2{font-size:1.2rem;color:#58a6ff;margin:.6rem 0}
h3{font-size:1rem;color:#79c0ff;margin:.5rem 0}
strong{color:#e6edf3}
pre{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:.8rem;margin:.5rem 0;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word}
code{font-family:'Cascadia Code','Fira Code','Consolas',monospace;font-size:13px;color:#e6edf3}
code.inline{background:#21262d;padding:.15rem .35rem;border-radius:3px;font-size:.9em}
ul{margin:.4rem 0 .4rem 1.5rem}
li{margin:.15rem 0}
hr{border:none;border-top:1px solid #21262d;margin:.8rem 0}
a{color:#58a6ff}
</style>
</head>
<body>
${html}
</body>
</html>`;
}

/** HTML エスケープ */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// CJK 文字幅ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 文字が全角（表示幅 2）かどうかを判定する。
 * CJK統合漢字、ひらがな、カタカナ、全角英数・記号、CJK記号等を対象とする。
 */
function isFullWidth(cp: number): boolean {
    return (
        // CJK Unified Ideographs
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        // CJK Unified Ideographs Extension A
        (cp >= 0x3400 && cp <= 0x4DBF) ||
        // CJK Unified Ideographs Extension B
        (cp >= 0x20000 && cp <= 0x2A6DF) ||
        // CJK Compatibility Ideographs
        (cp >= 0xF900 && cp <= 0xFAFF) ||
        // Hiragana
        (cp >= 0x3040 && cp <= 0x309F) ||
        // Katakana
        (cp >= 0x30A0 && cp <= 0x30FF) ||
        // Katakana Phonetic Extensions
        (cp >= 0x31F0 && cp <= 0x31FF) ||
        // CJK Symbols and Punctuation
        (cp >= 0x3000 && cp <= 0x303F) ||
        // Fullwidth Forms (全角英数・記号)
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        // Fullwidth Forms (全角ウォン等)
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        // Hangul Syllables
        (cp >= 0xAC00 && cp <= 0xD7AF) ||
        // Hangul Jamo
        (cp >= 0x1100 && cp <= 0x11FF) ||
        // Enclosed CJK Letters
        (cp >= 0x3200 && cp <= 0x32FF) ||
        // CJK Compatibility
        (cp >= 0x3300 && cp <= 0x33FF) ||
        // Halfwidth Katakana は半角なので含めない
        // Box Drawing characters (罫線文字) — 半角扱い
        false
    );
}

/**
 * 文字列の表示幅を計算する（半角=1, 全角=2）。
 */
export function getDisplayWidth(str: string): number {
    let width = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0)!;
        width += isFullWidth(cp) ? 2 : 1;
    }
    return width;
}

/**
 * 文字列を指定の表示幅まで右側をスペースで埋める。
 */
function padRight(str: string, targetWidth: number): string {
    const currentWidth = getDisplayWidth(str);
    const padding = targetWidth - currentWidth;
    return padding > 0 ? str + ' '.repeat(padding) : str;
}



