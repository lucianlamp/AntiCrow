// ---------------------------------------------------------------------------
// src/__tests__/licenseWebview.test.ts — WebView パネルのテスト
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vscode モジュールをモック
vi.mock('vscode', () => ({
    window: {
        createWebviewPanel: vi.fn(),
        createOutputChannel: () => ({
            appendLine: () => { },
            dispose: () => { },
        }),
    },
    workspace: {
        getConfiguration: () => ({
            get: vi.fn(),
        }),
    },
    ViewColumn: { One: 1 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    env: { openExternal: vi.fn() },
    commands: { executeCommand: vi.fn() },
    ConfigurationTarget: { Global: 1 },
}));

import { getWebviewHtml } from '../licensing/licenseWebview';

describe('licenseWebview', () => {
    describe('getWebviewHtml', () => {
        it('正しい HTML 構造を生成する', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('AntiCrow Pro');
            expect(html).toContain('<html lang="ja">');
        });

        it('購入 URL が HTML 内に埋め込まれる', () => {
            const url = 'https://my-store.lemonsqueezy.com';
            const html = getWebviewHtml(url);

            expect(html).toContain(url);
        });

        it('CSP に frame-src が含まれない（iframe 不使用）', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).not.toContain('frame-src');
            expect(html).toContain("default-src 'none'");
        });

        it('Monthly と Lifetime の両プランが表示される', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('Monthly');
            expect(html).toContain('Lifetime');
            expect(html).toContain('$5');
            expect(html).toContain('$50');
        });

        it('ライセンスキー入力フィールドが存在する', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('id="license-key"');
            expect(html).toContain('XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX');
        });

        it('ステップインジケーターが存在する', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('step1-indicator');
            expect(html).toContain('step2-indicator');
            expect(html).toContain('購入');
            expect(html).toContain('認証');
        });

        it('acquireVsCodeApi が呼ばれている', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('acquireVsCodeApi()');
        });

        it('postMessage でキー検証メッセージを送信する JavaScript が含まれる', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain("command: 'validateKey'");
            expect(html).toContain("command: 'openExternal'");
        });

        it('validationResult メッセージのハンドラが含まれる', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain("message.command === 'validationResult'");
        });

        it('Enter キーイベントリスナーが設定されている', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain("e.key === 'Enter'");
        });

        it('ダーク系カラーが使われている', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('--bg-primary: #0d1117');
            expect(html).toContain('--bg-secondary: #161b22');
        });

        it('Pro 機能リストが表示される', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('全機能アンロック');
            expect(html).toContain('自動承認');
            expect(html).toContain('無制限テンプレート');
            expect(html).toContain('無制限ワークスペース');
        });

        it('プラン別の購入ボタンが存在する', () => {
            const html = getWebviewHtml('https://test.lemonsqueezy.com');

            expect(html).toContain('Monthly を購入');
            expect(html).toContain('Lifetime を購入');
            expect(html).toContain("openPurchasePage('monthly')");
            expect(html).toContain("openPurchasePage('lifetime')");
        });

        it('monthlyUrl / lifetimeUrl が指定時に使用される', () => {
            const html = getWebviewHtml(
                'https://fallback.lemonsqueezy.com',
                'https://monthly.lemonsqueezy.com/buy/monthly',
                'https://lifetime.lemonsqueezy.com/buy/lifetime',
            );

            expect(html).toContain('https://monthly.lemonsqueezy.com/buy/monthly');
            expect(html).toContain('https://lifetime.lemonsqueezy.com/buy/lifetime');
        });

        it('monthlyUrl / lifetimeUrl 未指定時は purchaseUrl にフォールバック', () => {
            const html = getWebviewHtml('https://fallback.lemonsqueezy.com');

            // monthly / lifetime の urls オブジェクトで purchaseUrl が使われる
            expect(html).toContain("monthly: 'https://fallback.lemonsqueezy.com'");
            expect(html).toContain("lifetime: 'https://fallback.lemonsqueezy.com'");
        });
    });
});
