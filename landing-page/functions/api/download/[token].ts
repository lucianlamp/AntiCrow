// GET /api/download/[token] - トークン認証付きVSIXダウンロード
import { Env } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB, R2 } = context.env;
    const token = (context.params as { token: string }).token;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
    };

    try {
        if (!token) {
            return new Response('Invalid token', { status: 400, headers: corsHeaders });
        }

        // トークンを検証
        const inviteLog = await DB.prepare(
            'SELECT id, email, version, token_expires_at, downloaded_at FROM invite_logs WHERE download_token = ?'
        ).bind(token).first<{
            id: number;
            email: string;
            version: string;
            token_expires_at: string;
            downloaded_at: string | null;
        }>();

        if (!inviteLog) {
            return new Response(
                '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>❌ 無効なリンク</h1><p style="color:#888">このダウンロードリンクは無効です。</p></div></body></html>',
                { status: 404, headers: { 'Content-Type': 'text/html', ...corsHeaders } }
            );
        }

        // 既にダウンロード済みかチェック（再DL制限）
        if (inviteLog.downloaded_at) {
            return new Response(
                '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>✅ ダウンロード済み</h1><p style="color:#888">このリンクは既に使用されています。新しいダウンロードリンクが必要な場合は、管理者にお問い合わせください。</p></div></body></html>',
                { status: 410, headers: { 'Content-Type': 'text/html', ...corsHeaders } }
            );
        }

        // トークン有効期限チェック
        const now = new Date();
        const expiresAt = new Date(inviteLog.token_expires_at);
        if (now > expiresAt) {
            return new Response(
                '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>⏰ リンク期限切れ</h1><p style="color:#888">このダウンロードリンクは期限切れです。管理者に新しいリンクをリクエストしてください。</p></div></body></html>',
                { status: 410, headers: { 'Content-Type': 'text/html', ...corsHeaders } }
            );
        }

        // R2 からファイルを取得
        const release = await DB.prepare(
            'SELECT r2_key FROM releases WHERE version = ?'
        ).bind(inviteLog.version).first<{ r2_key: string }>();

        if (!release) {
            return new Response('Release not found', { status: 404, headers: corsHeaders });
        }

        const object = await R2.get(release.r2_key);
        if (!object) {
            return new Response('File not found in storage', { status: 404, headers: corsHeaders });
        }

        // ダウンロード記録を更新
        await DB.prepare(
            "UPDATE invite_logs SET downloaded_at = datetime('now'), status = 'downloaded' WHERE id = ?"
        ).bind(inviteLog.id).run();

        // waitlist のステータスも更新
        await DB.prepare(
            "UPDATE waitlist SET invite_status = 'downloaded', current_version = ? WHERE email = ?"
        ).bind(inviteLog.version, inviteLog.email).run();

        // リリースのダウンロードカウントを更新
        await DB.prepare(
            'UPDATE releases SET download_count = download_count + 1 WHERE version = ?'
        ).bind(inviteLog.version).run();

        // ファイルをストリーミング配信
        return new Response(object.body, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="anti-crow-${inviteLog.version}.vsix"`,
                'Content-Length': object.size.toString(),
                ...corsHeaders,
            },
        });
    } catch (error) {
        console.error('Download error:', error);
        return new Response('Internal server error', { status: 500, headers: corsHeaders });
    }
};
