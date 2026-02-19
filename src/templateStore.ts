// ---------------------------------------------------------------------------
// templateStore.ts — プロンプトテンプレートの永続化管理
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logDebug, logError } from './logger';
import { getTimezone } from './configHelper';

export interface PromptTemplate {
    name: string;
    prompt: string;
    created_at: string;
}

export class TemplateStore {
    private templates: Map<string, PromptTemplate> = new Map();
    private filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'templates.json');
        this.load();
    }

    /** テンプレートを保存 */
    save(name: string, prompt: string): void {
        const template: PromptTemplate = {
            name,
            prompt,
            created_at: new Date().toISOString(),
        };
        this.templates.set(name, template);
        this.persist();
        logInfo(`TemplateStore: saved template "${name}"`);
    }

    /** テンプレートを取得 */
    get(name: string): PromptTemplate | undefined {
        return this.templates.get(name);
    }

    /** 全テンプレートを取得 */
    getAll(): PromptTemplate[] {
        return Array.from(this.templates.values());
    }

    /** テンプレートを削除 */
    delete(name: string): boolean {
        const deleted = this.templates.delete(name);
        if (deleted) {
            this.persist();
            logInfo(`TemplateStore: deleted template "${name}"`);
        }
        return deleted;
    }

    /** プロンプト内の変数を置換 */
    static expandVariables(prompt: string): string {
        const now = new Date();
        const jst = new Date(now.toLocaleString('en-US', { timeZone: getTimezone() }));
        const year = jst.getFullYear();
        const month = String(jst.getMonth() + 1).padStart(2, '0');
        const day = String(jst.getDate()).padStart(2, '0');
        const hours = String(jst.getHours()).padStart(2, '0');
        const minutes = String(jst.getMinutes()).padStart(2, '0');

        return prompt
            .replace(/\{\{date\}\}/g, `${year}-${month}-${day}`)
            .replace(/\{\{time\}\}/g, `${hours}:${minutes}`)
            .replace(/\{\{datetime\}\}/g, `${year}-${month}-${day} ${hours}:${minutes}`)
            .replace(/\{\{year\}\}/g, String(year))
            .replace(/\{\{month\}\}/g, month)
            .replace(/\{\{day\}\}/g, day);
    }

    /** ファイルから読み込み */
    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (Array.isArray(data)) {
                    for (const t of data) {
                        if (t.name && t.prompt) {
                            this.templates.set(t.name, t);
                        }
                    }
                }
                logDebug(`TemplateStore: loaded ${this.templates.size} templates`);
            }
        } catch (e) {
            logError('TemplateStore: failed to load templates', e);
        }
    }

    /** ファイルに永続化 */
    private persist(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(this.filePath, JSON.stringify(this.getAll(), null, 2), 'utf-8');
        } catch (e) {
            logError('TemplateStore: failed to persist templates', e);
        }
    }
}
