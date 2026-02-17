// ---------------------------------------------------------------------------
// attachmentDownloader.ts — Discord 添付ファイルのダウンロード & クリーンアップ
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { Attachment, Collection } from 'discord.js';
import { logInfo, logWarn, logError, logDebug } from './logger';

/** ダウンロードされた添付ファイルの情報 */
export interface DownloadedAttachment {
    originalName: string;
    localPath: string;
    contentType: string;
    size: number;
}

// 対応する拡張子
const SUPPORTED_EXTENSIONS = new Set([
    // 画像
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    // テキスト
    '.txt', '.json', '.md', '.csv', '.ts', '.js', '.py', '.html', '.css',
    '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bat',
]);

const MAX_FILE_SIZE = 8 * 1024 * 1024;     // 8MB per file
const MAX_TOTAL_SIZE = 25 * 1024 * 1024;    // 25MB total
const CLEANUP_AGE_MS = 60 * 60 * 1000;      // 1 hour

/**
 * Discord メッセージの添付ファイルをローカルにダウンロードする。
 * @param attachments Discord.js の attachments コレクション
 * @param storageBasePath globalStorage のベースパス
 * @param requestId リクエスト固有ID（ディレクトリ名に使用）
 * @returns ダウンロードされたファイル情報の配列
 */
export async function downloadAttachments(
    attachments: Collection<string, Attachment>,
    storageBasePath: string,
    requestId: string,
): Promise<DownloadedAttachment[]> {
    if (attachments.size === 0) { return []; }

    const attachDir = path.join(storageBasePath, 'attachments', requestId);
    fs.mkdirSync(attachDir, { recursive: true });

    const results: DownloadedAttachment[] = [];
    let totalSize = 0;

    for (const [, attachment] of attachments) {
        // サイズチェック
        if (attachment.size > MAX_FILE_SIZE) {
            logWarn(`attachmentDownloader: skipping ${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(1)}MB > 8MB limit)`);
            continue;
        }
        if (totalSize + attachment.size > MAX_TOTAL_SIZE) {
            logWarn(`attachmentDownloader: skipping ${attachment.name} (total size would exceed 25MB)`);
            continue;
        }

        // 拡張子チェック
        const ext = path.extname(attachment.name || '').toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext) && !attachment.contentType?.startsWith('image/')) {
            logWarn(`attachmentDownloader: skipping ${attachment.name} (unsupported type: ${ext})`);
            continue;
        }

        try {
            // Content-Length 事前チェック（HEAD リクエスト）
            try {
                const headResp = await fetch(attachment.url, { method: 'HEAD' });
                if (headResp.ok) {
                    const contentLength = parseInt(headResp.headers.get('content-length') || '0', 10);
                    if (contentLength > MAX_FILE_SIZE) {
                        logWarn(`attachmentDownloader: skipping ${attachment.name} — Content-Length ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
                        continue;
                    }
                    if (totalSize + contentLength > MAX_TOTAL_SIZE) {
                        logWarn(`attachmentDownloader: skipping ${attachment.name} — total size would exceed ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`);
                        continue;
                    }
                }
            } catch (headErr) {
                logDebug(`attachmentDownloader: HEAD request failed for ${attachment.name}, proceeding with GET: ${headErr}`);
            }

            const response = await fetch(attachment.url);
            if (!response.ok) {
                logWarn(`attachmentDownloader: failed to fetch ${attachment.name}: ${response.status}`);
                continue;
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const safeName = sanitizeFilename(attachment.name || `file_${Date.now()}${ext}`);
            const localPath = path.join(attachDir, safeName);

            fs.writeFileSync(localPath, buffer);
            totalSize += buffer.length;

            results.push({
                originalName: attachment.name || safeName,
                localPath,
                contentType: attachment.contentType || 'application/octet-stream',
                size: buffer.length,
            });

            logInfo(`attachmentDownloader: saved ${safeName} (${(buffer.length / 1024).toFixed(1)}KB)`);
        } catch (e) {
            logError(`attachmentDownloader: error downloading ${attachment.name}`, e);
        }
    }

    return results;
}

/**
 * 指定リクエストの添付ファイルディレクトリを削除する。
 */
export function cleanupAttachments(storageBasePath: string, requestId: string): void {
    const attachDir = path.join(storageBasePath, 'attachments', requestId);
    try {
        if (fs.existsSync(attachDir)) {
            fs.rmSync(attachDir, { recursive: true, force: true });
            logDebug(`attachmentDownloader: cleaned up ${attachDir}`);
        }
    } catch (e) {
        logWarn(`attachmentDownloader: cleanup failed for ${attachDir}: ${e}`);
    }
}

/**
 * 古い添付ファイルディレクトリを一括削除する（起動時に呼ぶ）。
 * CLEANUP_AGE_MS（1時間）以上前のディレクトリを削除。
 */
export function cleanupOldAttachments(storageBasePath: string): void {
    const attachRoot = path.join(storageBasePath, 'attachments');
    if (!fs.existsSync(attachRoot)) { return; }

    const now = Date.now();
    let cleaned = 0;

    try {
        const entries = fs.readdirSync(attachRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }
            const dirPath = path.join(attachRoot, entry.name);
            try {
                const stat = fs.statSync(dirPath);
                if (now - stat.mtimeMs > CLEANUP_AGE_MS) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    cleaned++;
                }
            } catch (e) { logDebug(`cleanupOldAttachments: failed to stat dir ${entry.name}: ${e}`); }
        }
    } catch (e) {
        logWarn(`attachmentDownloader: cleanupOldAttachments error: ${e}`);
    }

    if (cleaned > 0) {
        logInfo(`attachmentDownloader: cleaned up ${cleaned} old attachment directories`);
    }
}

/** ファイル名をサニタイズ（パストラバーサル防止） */
function sanitizeFilename(name: string): string {
    return name
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\.\./g, '_')
        .substring(0, 200);
}
