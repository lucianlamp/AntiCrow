// ---------------------------------------------------------------------------
// templateStore.ts — プロンプトテンプレートの永続化管理
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logError } from './logger';
import { getTimezone } from './configHelper';

export interface TemplateArg {
    name: string;
    label: string;
    placeholder?: string;
    required?: boolean;
}

export interface PromptTemplate {
    name: string;
    prompt: string;
    created_at: string;
    args?: TemplateArg[];
}

/** 日時系の予約変数名 */
const BUILTIN_VARS = new Set(['date', 'time', 'datetime', 'year', 'month', 'day']);

/** プロンプト内の {{xxx}} からユーザー定義引数を自動検出 */
export function parseTemplateArgs(prompt: string): TemplateArg[] {
    const regex = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
    const seen = new Set<string>();
    const args: TemplateArg[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(prompt)) !== null) {
        const name = match[1];
        if (!BUILTIN_VARS.has(name) && !seen.has(name)) {
            seen.add(name);
            args.push({ name, label: name, required: true });
        }
    }
    return args;
}

export class TemplateStore {
    private templates: Map<string, PromptTemplate> = new Map();
    private filePath: string;

    constructor(storagePath: string) {
        this.filePath = path.join(storagePath, 'templates.json');
        this.load();
    }

    /** テンプレートを保存（引数を自動検出） */
    save(name: string, prompt: string): void {
        const detectedArgs = parseTemplateArgs(prompt);
        const template: PromptTemplate = {
            name,
            prompt,
            created_at: new Date().toISOString(),
            ...(detectedArgs.length > 0 ? { args: detectedArgs } : {}),
        };
        this.templates.set(name, template);
        this.persist();
        logDebug(`TemplateStore: saved template "${name}" (${detectedArgs.length} args detected)`);
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
            logDebug(`TemplateStore: deleted template "${name}"`);
        }
        return deleted;
    }

    /** プロンプト内の変数を置換（日時変数 + ユーザー定義引数） */
    static expandVariables(prompt: string, userArgs?: Record<string, string>): string {
        const now = new Date();
        const jst = new Date(now.toLocaleString('en-US', { timeZone: getTimezone() }));
        const year = jst.getFullYear();
        const month = String(jst.getMonth() + 1).padStart(2, '0');
        const day = String(jst.getDate()).padStart(2, '0');
        const hours = String(jst.getHours()).padStart(2, '0');
        const minutes = String(jst.getMinutes()).padStart(2, '0');

        let result = prompt
            .replace(/\{\{date\}\}/g, `${year}-${month}-${day}`)
            .replace(/\{\{time\}\}/g, `${hours}:${minutes}`)
            .replace(/\{\{datetime\}\}/g, `${year}-${month}-${day} ${hours}:${minutes}`)
            .replace(/\{\{year\}\}/g, String(year))
            .replace(/\{\{month\}\}/g, month)
            .replace(/\{\{day\}\}/g, day);

        // ユーザー定義引数を展開
        if (userArgs) {
            for (const [key, value] of Object.entries(userArgs)) {
                result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
        }

        return result;
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
