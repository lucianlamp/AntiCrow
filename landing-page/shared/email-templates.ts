// メールテンプレート - 招待メール＆アップデート通知
export function generateInviteEmailHtml(params: {
    downloadUrl: string;
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
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">🦅 Anti-Crow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">ウェイトリストから招待されました！🎉</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Anti-Crow へのアクセスが承認されました。以下のボタンからVSIX拡張機能をダウンロードしてください。
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        ⬇️ Anti-Crow v${params.version} をダウンロード
      </a>
    </div>
    <p style="color:#666;font-size:13px;text-align:center;margin:0 0 24px">
      ⏰ このリンクは${params.expiresIn}有効です
    </p>
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">📦 セットアップ手順</h3>
      <ol style="color:#aaa;font-size:13px;line-height:1.8;margin:0;padding-left:20px">
        <li>上のボタンから .vsix ファイルをダウンロード</li>
        <li>VS Code / Antigravity で <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">拡張機能</code> → <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">...</code> → <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">VSIXからインストール</code></li>
        <li>ダウンロードした .vsix ファイルを選択してインストール</li>
      </ol>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      Anti-Crow Team — このメールはウェイトリスト登録に基づいて送信されています
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function generateUpdateEmailHtml(params: {
    downloadUrl: string;
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
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">🦅 Anti-Crow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">新バージョン v${params.version} がリリースされました！🚀</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Anti-Crow の最新バージョンがリリースされました。以下から最新版をダウンロードしてください。
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        ⬇️ v${params.version} をダウンロード
      </a>
    </div>
    <p style="color:#666;font-size:13px;text-align:center;margin:0 0 24px">
      ⏰ このリンクは${params.expiresIn}有効です
    </p>
    ${params.changelog ? `
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">📋 変更点</h3>
      <div style="color:#aaa;font-size:13px;line-height:1.8;white-space:pre-line">${params.changelog}</div>
    </div>` : ''}
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-top:16px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 8px">💡 アップデート方法</h3>
      <p style="color:#aaa;font-size:13px;margin:0">
        Discord で <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">/update</code> コマンドを実行するか、上のボタンから手動でダウンロードしてインストールしてください。
      </p>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      Anti-Crow Team — このメールはウェイトリスト登録に基づいて送信されています
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
