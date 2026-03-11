// ---------------------------------------------------------------------------
// workspaceValidation.test.ts — isInvalidWorkspaceName / looksLikeFileName テスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// モック — bridgeLifecycle が依存するモジュール
// ---------------------------------------------------------------------------

vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        name: 'test-workspace',
        workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: vi.fn(),
        }),
    },
    ConfigurationTarget: { Global: 1 },
    commands: { registerCommand: vi.fn() },
    extensions: { getExtension: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../logger', () => ({
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
}));

vi.mock('../i18n', () => ({
    t: vi.fn((key: string) => key),
}));

import { isInvalidWorkspaceName, looksLikeFileName } from '../bridgeLifecycle';

// ---------------------------------------------------------------------------
// looksLikeFileName テスト
// ---------------------------------------------------------------------------

describe('looksLikeFileName', () => {
    describe('既知のコード拡張子 → true', () => {
        const codeFiles = [
            'main.ts', 'index.js', 'app.py', 'lib.rs', 'main.go',
            'style.css', 'config.json', 'data.yaml', 'readme.md',
            'script.sh', 'query.sql', 'schema.graphql',
            'page.tsx', 'component.jsx', 'module.mjs',
            'Makefile.bat', 'deploy.ps1',
        ];

        for (const name of codeFiles) {
            it(`"${name}" → true`, () => {
                expect(looksLikeFileName(name)).toBe(true);
            });
        }
    });

    describe('プロジェクト名（非コード拡張子）→ false', () => {
        const projectNames = [
            'next.js',      // .js はコード拡張子だが…これはプロジェクト名
            'three.js',
            'my-app.v2',
            'project.beta',
            'app.demo',
            'test.site',
            'my-project.dev',
        ];

        // Note: next.js / three.js は .js 拡張子を持つため looksLikeFileName は true を返す
        // これは関数の設計上正しい動作（名前だけでプロジェクト名かファイル名か区別できない）
        // isInvalidWorkspaceName レベルで必要に応じ追加の例外処理を行う

        it('"my-app.v2" → false (非コード拡張子)', () => {
            expect(looksLikeFileName('my-app.v2')).toBe(false);
        });

        it('"project.beta" → false (非コード拡張子)', () => {
            expect(looksLikeFileName('project.beta')).toBe(false);
        });

        it('"app.demo" → false (非コード拡張子)', () => {
            expect(looksLikeFileName('app.demo')).toBe(false);
        });

        it('"test.site" → false (非コード拡張子)', () => {
            expect(looksLikeFileName('test.site')).toBe(false);
        });
    });

    describe('ドットなし・先頭ドット → false', () => {
        it('"my-project" → false (ドットなし)', () => {
            expect(looksLikeFileName('my-project')).toBe(false);
        });

        it('".hidden" → false (先頭ドット)', () => {
            expect(looksLikeFileName('.hidden')).toBe(false);
        });

        it('"" → false (空文字)', () => {
            expect(looksLikeFileName('')).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------
// isInvalidWorkspaceName テスト
// ---------------------------------------------------------------------------

describe('isInvalidWorkspaceName', () => {
    describe('正常なワークスペース名 → false (有効)', () => {
        const validNames = [
            'anti-crow',
            'my-project',
            'AntiCrow',
            'lucian-app',
            'web3-dapp',
            'my-app.v2',       // ドット付きだが非コード拡張子
            'project.beta',
            'app.demo',
        ];

        for (const name of validNames) {
            it(`"${name}" → false (有効)`, () => {
                expect(isInvalidWorkspaceName(name)).toBe(false);
            });
        }
    });

    describe('無効なワークスペース名 → true (無効)', () => {
        it('空文字 → true', () => {
            expect(isInvalidWorkspaceName('')).toBe(true);
        });

        it('URL形式 → true', () => {
            expect(isInvalidWorkspaceName('https://example.com')).toBe(true);
        });

        it('"Antigravity" → true (初期タイトル)', () => {
            expect(isInvalidWorkspaceName('Antigravity')).toBe(true);
        });

        it('workbench.html含む → true', () => {
            expect(isInvalidWorkspaceName('vscode-workbench.html')).toBe(true);
        });

        it('Welcome含む → true', () => {
            expect(isInvalidWorkspaceName('Welcome Tab')).toBe(true);
        });

        it('Settings含む → true', () => {
            expect(isInvalidWorkspaceName('User Settings')).toBe(true);
        });

        it('Extensions含む → true', () => {
            expect(isInvalidWorkspaceName('Extensions View')).toBe(true);
        });

        it('隠しファイル → true', () => {
            expect(isInvalidWorkspaceName('.gitignore')).toBe(true);
        });

        it('ファイル名 (.ts) → true', () => {
            expect(isInvalidWorkspaceName('main.ts')).toBe(true);
        });

        it('ファイル名 (.json) → true', () => {
            expect(isInvalidWorkspaceName('package.json')).toBe(true);
        });

        it('ファイル名 (.py) → true', () => {
            expect(isInvalidWorkspaceName('script.py')).toBe(true);
        });

        it('50文字超 → true', () => {
            expect(isInvalidWorkspaceName('a'.repeat(51))).toBe(true);
        });

        it('SCMパターン (つの) → true', () => {
            expect(isInvalidWorkspaceName('3つの変更')).toBe(true);
        });

        it('SCMパターン (個の) → true', () => {
            expect(isInvalidWorkspaceName('5個の問題')).toBe(true);
        });

        it('"問題" 含む → true', () => {
            expect(isInvalidWorkspaceName('問題パネル')).toBe(true);
        });

        it('"problem" 含む → true', () => {
            expect(isInvalidWorkspaceName('problem panel')).toBe(true);
        });
    });

    describe('旧フィルタで誤ブロックされていたケースが通る', () => {
        // 旧実装: /\.[a-z]{1,5}$/i は全てのドット+1-5文字をブロック
        // 新実装: 既知のコード拡張子のみブロック

        it('"my-app.v2" → false (非コード拡張子)', () => {
            expect(isInvalidWorkspaceName('my-app.v2')).toBe(false);
        });

        it('"project.beta" → false (非コード拡張子)', () => {
            expect(isInvalidWorkspaceName('project.beta')).toBe(false);
        });

        it('"app.demo" → false', () => {
            expect(isInvalidWorkspaceName('app.demo')).toBe(false);
        });

        it('"test.site" → false', () => {
            expect(isInvalidWorkspaceName('test.site')).toBe(false);
        });
    });
});
