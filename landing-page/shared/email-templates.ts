// メールテンプレート - 招待メール＆アップデート通知
export function generateInviteEmailHtml(params: {
    downloadPageUrl: string;
    accessCode: string;
    version: string;
    expiresIn: string;
}): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid #222">
  <tr><td style="padding:40px 40px 20px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">🦅 AntiCrow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">ウェイトリストから招待されました！🎉</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      AntiCrow へのアクセスが承認されました。以下のボタンからダウンロードページにアクセスしてください。
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadPageUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        📥 ダウンロードページを開く
      </a>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#2a1a3e);border-radius:12px;padding:24px;border:1px solid #6366f1;margin:0 0 20px;text-align:center">
      <div style="font-size:13px;color:#a78bfa;font-weight:600;margin:0 0 8px">🔑 アクセスコード</div>
      <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:4px;font-family:'Courier New',monospace;background:#222;display:inline-block;padding:10px 24px;border-radius:8px;border:1px solid #444">${params.accessCode}</div>
      <div style="font-size:12px;color:#888;margin-top:10px">ダウンロードページでこのコードを入力してください</div>
    </div>
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">📦 セットアップ手順</h3>
      <ol style="color:#aaa;font-size:13px;line-height:1.8;margin:0;padding-left:20px">
        <li>上のボタンからダウンロードページにアクセス</li>
        <li>アクセスコードを入力してログイン</li>
        <li>利用規約に同意して .vsix ファイルをダウンロード</li>
        <li>VS Code / Antigravity で <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">拡張機能</code> → <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">...</code> → <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">VSIXからインストール</code></li>
      </ol>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      AntiCrow Team — このメールはウェイトリスト登録に基づいて送信されています
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function generateUpdateEmailHtml(params: {
    downloadPageUrl: string;
    accessCode: string;
    version: string;
    changelog: string;
    expiresIn: string;
}): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid #222">
  <tr><td style="padding:40px 40px 20px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">🦅 AntiCrow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">新バージョン v${params.version} がリリースされました！🚀</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      AntiCrow の最新バージョンがリリースされました。以下からダウンロードページにアクセスしてください。
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadPageUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        📥 ダウンロードページを開く
      </a>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#2a1a3e);border-radius:12px;padding:24px;border:1px solid #6366f1;margin:0 0 20px;text-align:center">
      <div style="font-size:13px;color:#a78bfa;font-weight:600;margin:0 0 8px">🔑 アクセスコード</div>
      <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:4px;font-family:'Courier New',monospace;background:#222;display:inline-block;padding:10px 24px;border-radius:8px;border:1px solid #444">${params.accessCode}</div>
      <div style="font-size:12px;color:#888;margin-top:10px">ダウンロードページでこのコードを入力してください</div>
    </div>
    ${params.changelog ? `
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">📋 変更点</h3>
      <div style="color:#aaa;font-size:13px;line-height:1.8;white-space:pre-line">${params.changelog}</div>
    </div>` : ''}
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-top:16px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 8px">💡 アップデート方法</h3>
      <p style="color:#aaa;font-size:13px;margin:0">
        Discord で <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">/update</code> コマンドを実行するか、上のボタンからダウンロードページにアクセスして手動でダウンロードしてください。
      </p>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      AntiCrow Team — このメールはウェイトリスト登録に基づいて送信されています
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function generateLicenseEmailHtml(params: {
    licenseKey: string;
    email: string;
    plan: string;
}): string {
    return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid #222">
  <tr><td style="padding:40px 40px 20px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">🦅 AntiCrow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">ご購入ありがとうございます！🎉</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      AntiCrow Pro (${params.plan}) のライセンスキーをお届けします。<br>
      以下のキーを VS Code / Antigravity の設定で入力してください。
    </p>
    <div style="background:linear-gradient(135deg,#1a3a1e,#1a2a3e);border-radius:12px;padding:24px;border:1px solid #22c55e;margin:0 0 20px;text-align:center">
      <div style="font-size:13px;color:#4ade80;font-weight:600;margin:0 0 8px">🔑 ライセンスキー</div>
      <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:2px;font-family:'Courier New',monospace;background:#222;display:inline-block;padding:12px 24px;border-radius:8px;border:1px solid #444;word-break:break-all">${params.licenseKey}</div>
      <div style="font-size:12px;color:#888;margin-top:10px">このキーは大切に保管してください</div>
    </div>
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a;margin-bottom:16px">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">📦 方法1: VS Code / Antigravity で適用</h3>
      <ol style="color:#aaa;font-size:13px;line-height:1.8;margin:0;padding-left:20px">
        <li>コマンドパレットを開く (Ctrl+Shift+P)</li>
        <li><code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">AntiCrow: Enter License Key</code> を実行</li>
        <li>上記のライセンスキーを入力</li>
        <li>Pro 機能がアンロックされます ✨</li>
      </ol>
    </div>
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">💬 方法2: Discord で適用</h3>
      <ol style="color:#aaa;font-size:13px;line-height:1.8;margin:0;padding-left:20px">
        <li>AntiCrow Bot が参加しているサーバーのチャンネルを開く</li>
        <li><code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">/pro</code> コマンドを実行</li>
        <li>「🔑 ライセンスキー入力」ボタンをクリック</li>
        <li>表示されたモーダルにライセンスキーを入力</li>
      </ol>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      AntiCrow Team — ご不明点は Discord でお問い合わせください
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
