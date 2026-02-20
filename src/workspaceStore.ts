// ---------------------------------------------------------------------------
// workspaceStore.ts — ワークスペース→フォルダパスの自動学習・永続化
// ---------------------------------------------------------------------------
// 責務:
//   1. ワークスペース名からフォルダパスへのマッピングを管理
//   2. 接続成功時にマッピングを自動学習・永続化
//   3. globalStorage/workspace_paths.json に保存
//   4. settings.json の手動設定よりも優先（手動設定は非推奨）
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn, logError } from './logger';

const STORE_FILE = 'workspace_paths.json';

interface WorkspaceEntry {
    folderPath: string;
    lastSeen: string;   // ISO 8601
}

type StoreData = Record<string, WorkspaceEntry>;

/**
 * ワークスペース→フォルダパスの自動学習ストア。
 *
 * 接続成功時に `learn()` を呼ぶとマッピングが永続化され、
 * 次回以降 `getFolderPath()` で自動取得できる。
 */
export class WorkspaceStore {
    private data: StoreData = {};
    private filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, STORE_FILE);
        this.load();
    }

    // -------------------------------------------------------------------
    // 読み書き
    // -------------------------------------------------------------------

    /** ストアファイルからデータを読み込む */
    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                this.data = JSON.parse(raw) as StoreData;
                logDebug(`WorkspaceStore: loaded ${Object.keys(this.data).length} workspace mapping(s)`);
            }
        } catch (e) {
            logWarn(`WorkspaceStore: failed to load ${STORE_FILE}: ${e instanceof Error ? e.message : e}`);
            this.data = {};
        }
    }

    /** データをファイルに永続化する */
    private save(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
            logDebug(`WorkspaceStore: saved ${Object.keys(this.data).length} workspace mapping(s)`);
        } catch (e) {
            logError(`WorkspaceStore: failed to save ${STORE_FILE}`, e);
        }
    }

    // -------------------------------------------------------------------
    // パブリック API
    // -------------------------------------------------------------------

    /**
     * ワークスペース名とフォルダパスのマッピングを学習・保存する。
     * 既存エントリがあっても最新のパスで上書きする。
     */
    learn(workspaceName: string, folderPath: string): void {
        if (!workspaceName || !folderPath) { return; }

        const previous = this.data[workspaceName];
        this.data[workspaceName] = {
            folderPath,
            lastSeen: new Date().toISOString(),
        };
        this.save();

        if (previous) {
            if (previous.folderPath !== folderPath) {
                logDebug(`WorkspaceStore: updated "${workspaceName}": "${previous.folderPath}" → "${folderPath}"`);
            } else {
                logDebug(`WorkspaceStore: refreshed "${workspaceName}" (path unchanged)`);
            }
        } else {
            logDebug(`WorkspaceStore: learned new workspace "${workspaceName}" → "${folderPath}"`);
        }
    }

    /**
     * ワークスペース名からフォルダパスを取得する。
     * 学習済みでなければ undefined を返す。
     */
    getFolderPath(workspaceName: string): string | undefined {
        const entry = this.data[workspaceName];
        return entry?.folderPath;
    }

    /** 全マッピングを Record<string, string> 形式で返す（configHelper 互換） */
    getAll(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [name, entry] of Object.entries(this.data)) {
            result[name] = entry.folderPath;
        }
        return result;
    }

    /** エントリを削除する */
    remove(workspaceName: string): boolean {
        if (workspaceName in this.data) {
            delete this.data[workspaceName];
            this.save();
            logDebug(`WorkspaceStore: removed "${workspaceName}"`);
            return true;
        }
        return false;
    }
}
