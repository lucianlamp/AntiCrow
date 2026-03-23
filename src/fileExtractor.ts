// ---------------------------------------------------------------------------
// fileExtractor.ts — レスポンスからファイル参照を抽出するユーティリティ
// ---------------------------------------------------------------------------
// 責務:
//   1. Markdownレスポンス内のファイルパスパターンを検出
//   2. 対応拡張子のファイルのみ抽出
//   3. 送信済みファイル参照をテキストから除去
// ---------------------------------------------------------------------------

import * as path from 'path';

/** 対応するファイル拡張子（小文字） */
const SUPPORTED_EXTENSIONS = new Set([
    // 画像
    'png', 'jpg', 'jpeg', 'gif', 'webp',
    // 動画
    'mp4', 'webm', 'mov', 'avi',
    // ドキュメント
    'pdf', 'txt', 'csv', 'json', 'yaml', 'yml', 'md',
    // アーカイブ
    'zip',
]);

/** Discord のファイルサイズ上限（25MB） */
export const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

/** 抽出されたファイル参照 */
export interface FileReference {
    /** ファイルの絶対パス */
    path: string;
    /** ラベル（ある場合） */
    label?: string;
    /** 元テキスト内のマッチ文字列（除去用） */
    match: string;
}

/**
 * レスポンステキストからファイル参照を抽出する。
 *
 * 検出パターン:
 *   - `![alt](ファイルパス)` — 画像埋め込み
 *   - `[label](file:///ファイルパス)` — ファイルリンク
 *   - `<!-- FILE:ファイルパス -->` — 明示的なファイル送信タグ
 *
 * @returns 検出されたファイル参照の配列
 */
export function extractFileReferences(content: string): FileReference[] {
    const refs: FileReference[] = [];
    const seenPaths = new Set<string>();

    // パターン1: ![alt](ファイルパス) — 画像埋め込み
    // ローカルパスのみ（http:// https:// は除外）
    const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = imgPattern.exec(content)) !== null) {
        const filePath = match[2].trim();
        if (isLocalFilePath(filePath) && isSupportedExtension(filePath)) {
            const normalized = normalizePath(filePath);
            if (!seenPaths.has(normalized)) {
                seenPaths.add(normalized);
                refs.push({ path: normalized, label: match[1] || undefined, match: match[0] });
            }
        }
    }

    // パターン2: [label](file:///ファイルパス) — ファイルリンク
    const fileLinkPattern = /\[([^\]]*)\]\(file:\/\/\/([^)]+)\)/g;
    while ((match = fileLinkPattern.exec(content)) !== null) {
        const filePath = match[2].trim();
        const normalized = normalizePath(filePath);
        if (isSupportedExtension(normalized) && !seenPaths.has(normalized)) {
            seenPaths.add(normalized);
            refs.push({ path: normalized, label: match[1] || undefined, match: match[0] });
        }
    }

    // パターン3: <!-- FILE:ファイルパス --> — 明示的なファイル送信タグ
    const fileTagPattern = /<!--\s*FILE:\s*(.+?)\s*-->/g;
    while ((match = fileTagPattern.exec(content)) !== null) {
        const filePath = match[1].trim();
        const normalized = normalizePath(filePath);
        if (isSupportedExtension(normalized) && !seenPaths.has(normalized)) {
            seenPaths.add(normalized);
            refs.push({ path: normalized, match: match[0] });
        }
    }

    return refs;
}

/**
 * 送信済みファイル参照をテキストから除去する。
 * FILE タグは完全に除去し、画像埋め込みやファイルリンクはテキストラベルに変換する。
 */
export function stripFileReferences(content: string, sentPaths: Set<string>): string {
    let result = content;

    // FILE タグを除去
    result = result.replace(/<!--\s*FILE:\s*.+?\s*-->\n?/g, '');

    // 送信済みの画像埋め込みをラベルテキストに変換
    result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, filePath) => {
        const normalized = normalizePath(filePath.trim());
        if (sentPaths.has(normalized)) {
            return alt ? `📎 ${alt}` : '';
        }
        return m;
    });

    // 送信済みのファイルリンクをラベルテキストに変換
    result = result.replace(/\[([^\]]*)\]\(file:\/\/\/([^)]+)\)/g, (m, label, filePath) => {
        const normalized = normalizePath(filePath.trim());
        if (sentPaths.has(normalized)) {
            return label ? `📎 ${label}` : '';
        }
        return m;
    });

    return result;
}

/** ローカルファイルパスかどうか判定（URLを除外） */
function isLocalFilePath(p: string): boolean {
    if (p.startsWith('http://') || p.startsWith('https://')) { return false; }
    if (p.startsWith('data:')) { return false; }
    // Windows 絶対パスまたは Unix 絶対パス
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('file:///');
}

/** 対応する拡張子かどうか判定 */
function isSupportedExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    return SUPPORTED_EXTENSIONS.has(ext);
}

/** パスを正規化（file:/// プレフィックス除去、バックスラッシュ統一） */
function normalizePath(p: string): string {
    let result = p;
    if (result.startsWith('file:///')) {
        result = result.slice(8); // file:/// を除去（Windows の場合 C:/... になる）
    }
    // URI デコード
    try {
        result = decodeURIComponent(result);
    } catch { /* ignore */ }
    return result;
}
