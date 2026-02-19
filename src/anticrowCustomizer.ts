// ---------------------------------------------------------------------------
// anticrowCustomizer.ts — ANTICROW.md カスタマイズモジュール
// ---------------------------------------------------------------------------
// ユーザーがカスタマイズ設定ファイル（ANTICROW.md）を安全に更新するための機能。

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logDebug, logWarn, logError } from './logger';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** ANTICROW.md のパス（ホームディレクトリ配下） */
const ANTICROW_DIR = path.join(os.homedir(), '.anticrow');
const ANTICROW_MD_PATH = path.join(ANTICROW_DIR, 'ANTICROW.md');
const ANTICROW_BACKUP_PATH = path.join(ANTICROW_DIR, 'ANTICROW.md.bak');

/** 最大ファイルサイズ（10KB） */
const MAX_FILE_SIZE_BYTES = 10 * 1024;

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * ANTICROW.md の内容を読み取る。
 * ファイルが存在しない場合は null を返す。
 */
export function readAnticrowMd(): string | null {
    try {
        if (!fs.existsSync(ANTICROW_MD_PATH)) {
            return null;
        }
        return fs.readFileSync(ANTICROW_MD_PATH, 'utf-8');
    } catch (e) {
        logError('anticrowCustomizer: failed to read customization file', e);
        return null;
    }
}

/**
 * ANTICROW.md を更新する。
 * - 書き込み前にバックアップを作成
 * - ディレクトリが存在しない場合は自動作成
 * - 最大サイズ制限のバリデーション
 */
export function updateAnticrowMd(
    content: string,
    mode: 'merge' | 'overwrite',
): { success: boolean; backupPath?: string; error?: string } {
    try {
        // サイズバリデーション
        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (contentBytes > MAX_FILE_SIZE_BYTES) {
            return {
                success: false,
                error: `カスタマイズファイルのサイズ上限（${MAX_FILE_SIZE_BYTES / 1024}KB）を超えています。内容を短縮してください。`,
            };
        }

        // ディレクトリ作成
        if (!fs.existsSync(ANTICROW_DIR)) {
            fs.mkdirSync(ANTICROW_DIR, { recursive: true });
            logDebug(`anticrowCustomizer: created directory ${ANTICROW_DIR}`);
        }

        // 既存ファイルのバックアップ
        let backupPath: string | undefined;
        if (fs.existsSync(ANTICROW_MD_PATH)) {
            fs.copyFileSync(ANTICROW_MD_PATH, ANTICROW_BACKUP_PATH);
            backupPath = ANTICROW_BACKUP_PATH;
            logDebug('anticrowCustomizer: backup created');
        }

        // 内容を決定
        let finalContent: string;
        if (mode === 'merge' && fs.existsSync(ANTICROW_MD_PATH)) {
            const existing = fs.readFileSync(ANTICROW_MD_PATH, 'utf-8');
            finalContent = existing + '\n\n' + content;
            // マージ後のサイズチェック
            if (Buffer.byteLength(finalContent, 'utf-8') > MAX_FILE_SIZE_BYTES) {
                return {
                    success: false,
                    error: `マージ後のサイズが上限（${MAX_FILE_SIZE_BYTES / 1024}KB）を超えてしまいます。上書きモードを使用するか、内容を短縮してください。`,
                };
            }
        } else {
            finalContent = content;
        }

        // 書き込み
        fs.writeFileSync(ANTICROW_MD_PATH, finalContent, 'utf-8');
        logDebug(`anticrowCustomizer: file updated (mode=${mode}, ${Buffer.byteLength(finalContent, 'utf-8')} bytes)`);

        return { success: true, backupPath };
    } catch (e) {
        logError('anticrowCustomizer: failed to update customization file', e);
        return {
            success: false,
            error: 'カスタマイズファイルの更新に失敗しました。',
        };
    }
}

/**
 * ANTICROW.md の特定セクションを更新する。
 * セクションは Markdown の見出し（## セクション名）で識別する。
 * セクションが存在しない場合は末尾に追加する。
 */
export function updateSection(
    sectionName: string,
    content: string,
): { success: boolean; error?: string } {
    try {
        const existing = readAnticrowMd() || '';
        const sectionHeader = `## ${sectionName}`;
        const sectionRegex = new RegExp(
            `(^|\\n)(## ${escapeRegex(sectionName)})\\n[\\s\\S]*?(?=\\n## |$)`,
        );

        let updated: string;
        if (sectionRegex.test(existing)) {
            // 既存セクションを置換
            updated = existing.replace(sectionRegex, `$1${sectionHeader}\n${content}\n`);
        } else {
            // セクションが存在しない場合は末尾に追加
            updated = existing.trimEnd() + `\n\n${sectionHeader}\n${content}\n`;
        }

        const result = updateAnticrowMd(updated, 'overwrite');
        if (!result.success) {
            return { success: false, error: result.error };
        }

        logDebug(`anticrowCustomizer: section "${sectionName}" updated`);
        return { success: true };
    } catch (e) {
        logError(`anticrowCustomizer: failed to update section "${sectionName}"`, e);
        return {
            success: false,
            error: 'セクションの更新に失敗しました。',
        };
    }
}

/**
 * ANTICROW.md のファイルパスを取得する。
 */
export function getAnticrowMdPath(): string {
    return ANTICROW_MD_PATH;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** 正規表現の特殊文字をエスケープする */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
