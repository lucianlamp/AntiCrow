// ---------------------------------------------------------------------------
// templateStore.test.ts — テンプレートストアテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// vscode モジュールをモック
vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
    },
}));

import { TemplateStore, parseTemplateArgs } from '../templateStore';

const TEST_DIR = path.join(__dirname, '__templatestore_test_tmp__');

function cleanTestDir(): void {
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
}

describe('TemplateStore', () => {
    beforeEach(() => {
        cleanTestDir();
        fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
        cleanTestDir();
    });

    // ----- save / get -----

    describe('save and get', () => {
        it('should save and retrieve a template', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('greeting', 'Hello {{date}}!');
            const tmpl = store.get('greeting');
            expect(tmpl).toBeDefined();
            expect(tmpl!.name).toBe('greeting');
            expect(tmpl!.prompt).toBe('Hello {{date}}!');
            expect(tmpl!.created_at).toBeTruthy();
        });

        it('should overwrite existing template with same name', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('test', 'original');
            store.save('test', 'updated');
            const tmpl = store.get('test');
            expect(tmpl!.prompt).toBe('updated');
        });

        it('should return undefined for non-existent template', () => {
            const store = new TemplateStore(TEST_DIR);
            expect(store.get('does-not-exist')).toBeUndefined();
        });
    });

    // ----- getAll -----

    describe('getAll', () => {
        it('should return empty array when no templates exist', () => {
            const store = new TemplateStore(TEST_DIR);
            expect(store.getAll()).toEqual([]);
        });

        it('should return all saved templates', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('a', 'prompt-a');
            store.save('b', 'prompt-b');
            store.save('c', 'prompt-c');
            const all = store.getAll();
            expect(all.length).toBe(3);
            expect(all.map(t => t.name).sort()).toEqual(['a', 'b', 'c']);
        });
    });

    // ----- delete -----

    describe('delete', () => {
        it('should delete an existing template', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('temp', 'value');
            expect(store.delete('temp')).toBe(true);
            expect(store.get('temp')).toBeUndefined();
        });

        it('should return false when deleting non-existent template', () => {
            const store = new TemplateStore(TEST_DIR);
            expect(store.delete('ghost')).toBe(false);
        });
    });

    // ----- persistence -----

    describe('persistence', () => {
        it('should persist templates to file and reload', () => {
            const store1 = new TemplateStore(TEST_DIR);
            store1.save('persisted', 'will survive');

            // 新しいインスタンスで再読み込み
            const store2 = new TemplateStore(TEST_DIR);
            const tmpl = store2.get('persisted');
            expect(tmpl).toBeDefined();
            expect(tmpl!.prompt).toBe('will survive');
        });

        it('should handle corrupted template file gracefully', () => {
            const filePath = path.join(TEST_DIR, 'templates.json');
            fs.writeFileSync(filePath, 'not valid json', 'utf-8');

            // エラーにならずに空のストアが作成されること
            const store = new TemplateStore(TEST_DIR);
            expect(store.getAll()).toEqual([]);
        });

        it('should handle missing template file gracefully', () => {
            // templates.json が存在しない場合
            const store = new TemplateStore(TEST_DIR);
            expect(store.getAll()).toEqual([]);
        });
    });

    // ----- expandVariables -----

    describe('expandVariables', () => {
        it('should expand {{date}} to YYYY-MM-DD format', () => {
            const result = TemplateStore.expandVariables('Today is {{date}}');
            expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
        });

        it('should expand {{time}} to HH:MM format', () => {
            const result = TemplateStore.expandVariables('Now: {{time}}');
            expect(result).toMatch(/Now: \d{2}:\d{2}/);
        });

        it('should expand {{datetime}} to YYYY-MM-DD HH:MM format', () => {
            const result = TemplateStore.expandVariables('At: {{datetime}}');
            expect(result).toMatch(/At: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
        });

        it('should expand {{year}}, {{month}}, {{day}} individually', () => {
            const result = TemplateStore.expandVariables('{{year}}/{{month}}/{{day}}');
            expect(result).toMatch(/\d{4}\/\d{2}\/\d{2}/);
        });

        it('should expand multiple variables in one string', () => {
            const result = TemplateStore.expandVariables('{{date}} at {{time}}');
            expect(result).toMatch(/\d{4}-\d{2}-\d{2} at \d{2}:\d{2}/);
        });

        it('should leave unknown variables untouched', () => {
            const result = TemplateStore.expandVariables('Hello {{unknown}}!');
            expect(result).toBe('Hello {{unknown}}!');
        });

        it('should return string as-is when no variables present', () => {
            const result = TemplateStore.expandVariables('No variables here');
            expect(result).toBe('No variables here');
        });

        it('should expand user-defined args when provided', () => {
            const result = TemplateStore.expandVariables(
                'Check {{contract_address}} on {{chain}}',
                { contract_address: '0xABC', chain: 'solana' },
            );
            expect(result).toBe('Check 0xABC on solana');
        });

        it('should expand both builtin and user args together', () => {
            const result = TemplateStore.expandVariables(
                '{{date}} - {{project}} report',
                { project: 'anti-crow' },
            );
            expect(result).toMatch(/\d{4}-\d{2}-\d{2} - anti-crow report/);
        });

        it('should leave unresolved user args untouched', () => {
            const result = TemplateStore.expandVariables(
                '{{foo}} and {{bar}}',
                { foo: 'hello' },
            );
            expect(result).toBe('hello and {{bar}}');
        });

        it('should handle empty userArgs object', () => {
            const result = TemplateStore.expandVariables('Hello {{name}}!', {});
            expect(result).toBe('Hello {{name}}!');
        });
    });

    // ----- parseTemplateArgs -----

    describe('parseTemplateArgs', () => {
        it('should detect user-defined args from prompt', () => {
            const args = parseTemplateArgs('Check {{contract_address}} on {{chain}}');
            expect(args.length).toBe(2);
            expect(args[0].name).toBe('contract_address');
            expect(args[1].name).toBe('chain');
        });

        it('should exclude builtin date/time variables', () => {
            const args = parseTemplateArgs('{{date}} report for {{project}}');
            expect(args.length).toBe(1);
            expect(args[0].name).toBe('project');
        });

        it('should exclude all builtin variables', () => {
            const args = parseTemplateArgs('{{date}} {{time}} {{datetime}} {{year}} {{month}} {{day}}');
            expect(args.length).toBe(0);
        });

        it('should deduplicate repeated args', () => {
            const args = parseTemplateArgs('{{x}} then {{y}} then {{x}} again');
            expect(args.length).toBe(2);
            expect(args.map(a => a.name)).toEqual(['x', 'y']);
        });

        it('should return empty array when no args present', () => {
            const args = parseTemplateArgs('Plain prompt with no variables');
            expect(args.length).toBe(0);
        });

        it('should return empty array for builtin-only prompt', () => {
            const args = parseTemplateArgs('Today is {{date}} at {{time}}');
            expect(args.length).toBe(0);
        });

        it('should set required=true by default', () => {
            const args = parseTemplateArgs('{{foo}}');
            expect(args[0].required).toBe(true);
        });

        it('should set label same as name by default', () => {
            const args = parseTemplateArgs('{{my_var}}');
            expect(args[0].label).toBe('my_var');
        });
    });

    // ----- save with args auto-detection -----

    describe('save with args auto-detection', () => {
        it('should auto-detect args on save', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('dex-check', 'Check {{contract_address}} on DEX');
            const tmpl = store.get('dex-check');
            expect(tmpl!.args).toBeDefined();
            expect(tmpl!.args!.length).toBe(1);
            expect(tmpl!.args![0].name).toBe('contract_address');
        });

        it('should not add args field when no user args detected', () => {
            const store = new TemplateStore(TEST_DIR);
            store.save('daily', 'Daily report for {{date}}');
            const tmpl = store.get('daily');
            expect(tmpl!.args).toBeUndefined();
        });

        it('should persist args across reload', () => {
            const store1 = new TemplateStore(TEST_DIR);
            store1.save('reloaded', 'Project {{name}} status');

            const store2 = new TemplateStore(TEST_DIR);
            const tmpl = store2.get('reloaded');
            expect(tmpl!.args).toBeDefined();
            expect(tmpl!.args![0].name).toBe('name');
        });
    });

    // ----- 環境変数サポート ({{env:XXX}}) -----

    describe('expandVariables — env variables', () => {
        it('should expand {{env:XXX}} from process.env', () => {
            const orig = process.env.TEST_EXPAND_VAR;
            process.env.TEST_EXPAND_VAR = 'my-secret-key';
            try {
                const result = TemplateStore.expandVariables('Key is {{env:TEST_EXPAND_VAR}}');
                expect(result).toBe('Key is my-secret-key');
            } finally {
                if (orig === undefined) { delete process.env.TEST_EXPAND_VAR; }
                else { process.env.TEST_EXPAND_VAR = orig; }
            }
        });

        it('should expand undefined env var to empty string', () => {
            delete process.env.__ANTICROW_TEST_UNDEFINED__;
            const result = TemplateStore.expandVariables('Value: {{env:__ANTICROW_TEST_UNDEFINED__}}');
            expect(result).toBe('Value: ');
        });

        it('should expand multiple env vars', () => {
            const origA = process.env.TEST_A;
            const origB = process.env.TEST_B;
            process.env.TEST_A = 'alpha';
            process.env.TEST_B = 'beta';
            try {
                const result = TemplateStore.expandVariables('{{env:TEST_A}} and {{env:TEST_B}}');
                expect(result).toBe('alpha and beta');
            } finally {
                if (origA === undefined) { delete process.env.TEST_A; } else { process.env.TEST_A = origA; }
                if (origB === undefined) { delete process.env.TEST_B; } else { process.env.TEST_B = origB; }
            }
        });

        it('should expand env vars alongside builtin vars and user args', () => {
            const orig = process.env.TEST_API_KEY;
            process.env.TEST_API_KEY = 'sk-abc123';
            try {
                const result = TemplateStore.expandVariables(
                    '{{date}} — key: {{env:TEST_API_KEY}} — project: {{project}}',
                    { project: 'anti-crow' },
                );
                expect(result).toMatch(/\d{4}-\d{2}-\d{2} — key: sk-abc123 — project: anti-crow/);
            } finally {
                if (orig === undefined) { delete process.env.TEST_API_KEY; } else { process.env.TEST_API_KEY = orig; }
            }
        });

        it('should leave non-env unknown variables untouched', () => {
            const result = TemplateStore.expandVariables('{{env:SOME_VAR}} and {{unknown}}');
            // env:SOME_VAR → empty (undefined), unknown → untouched
            expect(result).toBe(' and {{unknown}}');
        });
    });

    describe('parseTemplateArgs — env exclusion', () => {
        it('should exclude {{env:XXX}} from detected args', () => {
            const args = parseTemplateArgs('Use {{env:API_KEY}} to search {{keyword}}');
            expect(args.length).toBe(1);
            expect(args[0].name).toBe('keyword');
        });

        it('should return empty when only env vars and builtins', () => {
            const args = parseTemplateArgs('{{env:KEY}} at {{date}}');
            expect(args.length).toBe(0);
        });

        it('should handle mixed env, builtin, and user args', () => {
            const args = parseTemplateArgs('{{env:TOKEN}} {{date}} {{project}} {{env:SECRET}} {{target}}');
            expect(args.length).toBe(2);
            expect(args.map(a => a.name)).toEqual(['project', 'target']);
        });
    });
});

