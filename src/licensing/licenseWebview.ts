// ---------------------------------------------------------------------------
// src/licensing/licenseWebview.ts — WebView ベースの購入・ライセンス認証パネル
// ---------------------------------------------------------------------------
// 責務:
//   1. Antigravity 内に WebView パネルを表示
//   2. Lemonsqueezy 購入ページへの誘導（iframe or 外部ブラウザ）
//   3. ライセンスキー入力 → API 検証 → 結果表示
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import { LicenseChecker } from './licenseChecker';
import { PURCHASE_URL, PURCHASE_URL_MONTHLY, PURCHASE_URL_LIFETIME } from './licenseGate';
import { logDebug, logError } from '../logger';

// 同時に1つだけ開く
let currentPanel: vscode.WebviewPanel | undefined;

/**
 * WebView パネルの postMessage で受け取るメッセージ型。
 */
interface WebviewMessage {
    command: 'validateKey' | 'openExternal' | 'close';
    key?: string;
    url?: string;
}

/**
 * ライセンス購入・認証用 WebView パネルを開く。
 * 既に開いている場合はフォーカスする。
 */
export function openLicenseWebview(
    context: vscode.ExtensionContext,
    checker: LicenseChecker,
): void {
    // 既存パネルがあればフォーカス
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'anti-crow.license',
        'AntiCrow Pro',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        },
    );

    currentPanel = panel;

    panel.webview.html = getWebviewHtml(PURCHASE_URL, PURCHASE_URL_MONTHLY, PURCHASE_URL_LIFETIME);

    // WebView からのメッセージ処理
    panel.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
            switch (message.command) {
                case 'validateKey': {
                    if (!message.key) {
                        panel.webview.postMessage({
                            command: 'validationResult',
                            success: false,
                            error: 'ライセンスキーを入力してください',
                        });
                        return;
                    }

                    const key = message.key.trim();
                    logDebug(`LicenseWebview: validating key...`);

                    // SecretStorage に保存
                    await context.secrets.store('license-key', key);
                    await vscode.workspace.getConfiguration('antiCrow')
                        .update('licenseKey', true, vscode.ConfigurationTarget.Global);

                    checker.setLicenseKey(key);

                    // 検証
                    const status = await checker.check(true);

                    if (status.valid && status.type !== 'free') {
                        const planName = status.type === 'lifetime'
                            ? 'Pro（永久ライセンス）'
                            : 'Pro（月額）';

                        panel.webview.postMessage({
                            command: 'validationResult',
                            success: true,
                            planName,
                        });

                        checker.startAutoCheck();
                        logDebug(`LicenseWebview: validation success — ${planName}`);

                        // 3秒後に自動クローズ
                        setTimeout(() => {
                            if (currentPanel) {
                                currentPanel.dispose();
                            }
                        }, 3000);
                    } else {
                        panel.webview.postMessage({
                            command: 'validationResult',
                            success: false,
                            error: 'ライセンスキーが無効です。正しいキーを入力してください。',
                        });
                        logDebug(`LicenseWebview: validation failed — reason: ${status.reason}`);
                    }
                    break;
                }

                case 'openExternal': {
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;
                }

                case 'close': {
                    panel.dispose();
                    break;
                }
            }
        },
        undefined,
        context.subscriptions,
    );

    panel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

/**
 * テスト用: WebView HTML を生成する関数をエクスポート。
 */
export function getWebviewHtml(
    purchaseUrl: string,
    monthlyUrl?: string,
    lifetimeUrl?: string,
): string {
    const mUrl = monthlyUrl || purchaseUrl;
    const lUrl = lifetimeUrl || purchaseUrl;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>AntiCrow Pro</title>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --border: #30363d;
            --text-primary: #e6edf3;
            --text-secondary: #8b949e;
            --accent: #58a6ff;
            --accent-hover: #79c0ff;
            --success: #3fb950;
            --error: #f85149;
            --gradient-start: #6e40c9;
            --gradient-end: #58a6ff;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
        }

        .container {
            max-width: 640px;
            width: 100%;
        }

        /* ヘッダー */
        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        .logo {
            font-size: 48px;
            margin-bottom: 12px;
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-8px); }
        }

        .header h1 {
            font-size: 28px;
            font-weight: 700;
            background: linear-gradient(135deg, var(--gradient-start), var(--gradient-end));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }

        .header p {
            color: var(--text-secondary);
            font-size: 14px;
        }

        /* ステップインジケーター */
        .steps {
            display: flex;
            justify-content: center;
            gap: 8px;
            margin-bottom: 32px;
        }

        .step-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .step-indicator.active {
            background: linear-gradient(135deg, var(--gradient-start), var(--gradient-end));
            color: white;
            box-shadow: 0 4px 12px rgba(88, 166, 255, 0.3);
        }

        .step-indicator.inactive {
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            border: 1px solid var(--border);
        }

        .step-indicator.completed {
            background: var(--success);
            color: white;
        }

        .step-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
        }

        /* カード */
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
        }

        /* プラン比較 */
        .plans {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 24px;
        }

        .plan {
            background: var(--bg-tertiary);
            border: 2px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }

        .plan:hover {
            border-color: var(--accent);
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        }

        .plan.popular::before {
            content: 'BEST VALUE';
            position: absolute;
            top: 12px;
            right: -32px;
            background: linear-gradient(135deg, var(--gradient-start), var(--gradient-end));
            color: white;
            font-size: 10px;
            font-weight: 700;
            padding: 4px 40px;
            transform: rotate(45deg);
        }

        .plan-icon {
            font-size: 32px;
            margin-bottom: 12px;
        }

        .plan-name {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .plan-price {
            font-size: 28px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--gradient-start), var(--gradient-end));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 4px;
        }

        .plan-period {
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 16px;
        }

        .plan-features {
            list-style: none;
            text-align: left;
        }

        .plan-features li {
            font-size: 13px;
            color: var(--text-secondary);
            padding: 4px 0;
        }

        .plan-features li::before {
            content: '✓ ';
            color: var(--success);
            font-weight: bold;
        }

        /* ボタン */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--gradient-start), var(--gradient-end));
            color: white;
            box-shadow: 0 4px 12px rgba(88, 166, 255, 0.3);
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(88, 166, 255, 0.4);
        }

        .btn-secondary {
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border: 1px solid var(--border);
        }

        .btn-secondary:hover {
            border-color: var(--accent);
            background: var(--bg-secondary);
        }

        .btn-success {
            background: var(--success);
            color: white;
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }

        /* 入力フィールド */
        .input-group {
            margin-bottom: 16px;
        }

        .input-group label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .input-group input {
            width: 100%;
            padding: 12px 16px;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text-primary);
            font-size: 14px;
            font-family: 'SF Mono', Monaco, Menlo, monospace;
            transition: border-color 0.2s;
            outline: none;
        }

        .input-group input:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.1);
        }

        .input-group input::placeholder {
            color: var(--text-secondary);
            opacity: 0.5;
        }

        /* メッセージ */
        .message {
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 14px;
            margin-top: 12px;
            display: none;
            animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.success {
            background: rgba(63, 185, 80, 0.15);
            border: 1px solid rgba(63, 185, 80, 0.3);
            color: var(--success);
            display: block;
        }

        .message.error {
            background: rgba(248, 81, 73, 0.15);
            border: 1px solid rgba(248, 81, 73, 0.3);
            color: var(--error);
            display: block;
        }

        /* スピナー */
        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* ステップコンテンツ */
        .step-content {
            display: none;
        }

        .step-content.active {
            display: block;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        /* リンク */
        .text-link {
            color: var(--accent);
            text-decoration: none;
            cursor: pointer;
            font-size: 13px;
        }

        .text-link:hover {
            text-decoration: underline;
        }

        .divider {
            display: flex;
            align-items: center;
            gap: 12px;
            margin: 20px 0;
            color: var(--text-secondary);
            font-size: 13px;
        }

        .divider::before,
        .divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: var(--border);
        }

        /* フッター */
        .footer {
            text-align: center;
            margin-top: 24px;
            color: var(--text-secondary);
            font-size: 12px;
        }

        .footer a {
            color: var(--accent);
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- ヘッダー -->
        <div class="header">
            <div class="logo">🐦‍⬛</div>
            <h1>AntiCrow Pro</h1>
            <p>全機能をアンロックして最大限に活用しよう</p>
        </div>

        <!-- ステップインジケーター -->
        <div class="steps">
            <div class="step-indicator active" id="step1-indicator" onclick="showStep(1)">
                <span class="step-dot"></span>
                購入
            </div>
            <div class="step-indicator inactive" id="step2-indicator" onclick="showStep(2)">
                <span class="step-dot"></span>
                認証
            </div>
        </div>

        <!-- ステップ1: 購入 -->
        <div class="step-content active" id="step1">
            <div class="card">
                <div class="plans">
                    <div class="plan">
                        <div class="plan-icon">📅</div>
                        <div class="plan-name">Monthly</div>
                        <div class="plan-price">$5</div>
                        <div class="plan-period">/ 月</div>
                        <ul class="plan-features">
                            <li>全機能アンロック</li>
                            <li>自動承認</li>
                            <li>無制限テンプレート</li>
                            <li>無制限ワークスペース</li>
                            <li>いつでもキャンセル可</li>
                        </ul>
                        <button class="btn btn-primary" style="margin-top: 16px;" onclick="openPurchasePage('monthly')">
                            🛒 Monthly を購入
                        </button>
                    </div>
                    <div class="plan popular">
                        <div class="plan-icon">♾️</div>
                        <div class="plan-name">Lifetime</div>
                        <div class="plan-price">$50</div>
                        <div class="plan-period">買い切り</div>
                        <ul class="plan-features">
                            <li>全機能アンロック</li>
                            <li>自動承認</li>
                            <li>無制限テンプレート</li>
                            <li>無制限ワークスペース</li>
                            <li>永久アクセス</li>
                        </ul>
                        <button class="btn btn-primary" style="margin-top: 16px;" onclick="openPurchasePage('lifetime')">
                            🛒 Lifetime を購入
                        </button>
                    </div>
                </div>

                <div class="divider">購入済みの方はこちら</div>

                <button class="btn btn-secondary" onclick="showStep(2)">
                    🔑 ライセンスキーを入力 →
                </button>
            </div>
        </div>

        <!-- ステップ2: 認証 -->
        <div class="step-content" id="step2">
            <div class="card">
                <h3 style="margin-bottom: 16px; font-size: 18px;">🔑 ライセンスキー入力</h3>
                <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 20px;">
                    購入完了後にメールで届いたライセンスキーを入力してください。
                </p>

                <div class="input-group">
                    <label for="license-key">ライセンスキー</label>
                    <input
                        type="text"
                        id="license-key"
                        placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                        autocomplete="off"
                        spellcheck="false"
                    />
                </div>

                <button class="btn btn-primary" id="validate-btn" onclick="validateKey()">
                    ✨ 認証する
                </button>

                <div class="message" id="result-message"></div>

                <div class="divider">まだ購入していない方</div>

                <button class="btn btn-secondary" onclick="showStep(1)">
                    ← 購入ページに戻る
                </button>
            </div>
        </div>

        <!-- フッター -->
        <div class="footer">
            <p>問題がある場合は Discord サーバーでお問い合わせください</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentStep = 1;

        function showStep(step) {
            currentStep = step;

            // ステップインジケーター更新
            document.getElementById('step1-indicator').className =
                step === 1 ? 'step-indicator active' : 'step-indicator inactive';
            document.getElementById('step2-indicator').className =
                step === 2 ? 'step-indicator active' : 'step-indicator inactive';

            // コンテンツ切り替え
            document.getElementById('step1').className =
                step === 1 ? 'step-content active' : 'step-content';
            document.getElementById('step2').className =
                step === 2 ? 'step-content active' : 'step-content';

            // ステップ2に切り替えた時に入力フィールドにフォーカス
            if (step === 2) {
                setTimeout(() => {
                    document.getElementById('license-key').focus();
                }, 100);
            }
        }

        function openPurchasePage(plan) {
            const urls = {
                monthly: '${mUrl}',
                lifetime: '${lUrl}'
            };
            vscode.postMessage({
                command: 'openExternal',
                url: urls[plan] || '${purchaseUrl}'
            });
        }

        function validateKey() {
            const keyInput = document.getElementById('license-key');
            const key = keyInput.value.trim();
            const btn = document.getElementById('validate-btn');
            const msg = document.getElementById('result-message');

            if (!key) {
                msg.className = 'message error';
                msg.textContent = '⚠️ ライセンスキーを入力してください';
                return;
            }

            // ローディング状態
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 認証中...';
            msg.className = 'message';
            msg.style.display = 'none';

            vscode.postMessage({
                command: 'validateKey',
                key: key
            });
        }

        // Enter キーで認証
        document.getElementById('license-key').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                validateKey();
            }
        });

        // 拡張からのメッセージ処理
        window.addEventListener('message', (event) => {
            const message = event.data;

            if (message.command === 'validationResult') {
                const btn = document.getElementById('validate-btn');
                const msg = document.getElementById('result-message');

                if (message.success) {
                    btn.innerHTML = '✅ 認証成功！';
                    btn.className = 'btn btn-success';
                    btn.disabled = true;
                    msg.className = 'message success';
                    msg.textContent = '🎉 ' + message.planName + ' のライセンスが有効化されました！3秒後にパネルが閉じます...';

                    // ステップインジケーター更新
                    document.getElementById('step1-indicator').className = 'step-indicator completed';
                    document.getElementById('step2-indicator').className = 'step-indicator completed';
                } else {
                    btn.disabled = false;
                    btn.innerHTML = '✨ 認証する';
                    msg.className = 'message error';
                    msg.textContent = '❌ ' + message.error;
                }
            }
        });
    </script>
</body>
</html>`;
}
