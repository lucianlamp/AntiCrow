// POST /api/admin/invite - 選択ユーザーに招待メール送信
import { generateInviteEmailHtml } from '../../../shared/email-templates';

interface Env {
    DB: D1Database;
    RESEND_API_KEY: string;
}

function generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 48; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { DB, RESEND_API_KEY } = context.env;
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        const body = await context.request.json() as { emails: string[] };
        const { emails } = body;

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return new Response(
                JSON.stringify({ error: 'emails array is required' }),
                { status: 400, headers: corsHeaders }
            );
        }

        // 最新リリースを取得
        const latestRelease = await DB.prepare(
            'SELECT version, r2_key FROM releases WHERE is_latest = 1 LIMIT 1'
        ).first<{ version: string; r2_key: string }>();

        if (!latestRelease) {
            return new Response(
                JSON.stringify({ error: 'No release available. Upload a VSIX first.' }),
                { status: 400, headers: corsHeaders }
            );
        }

        const results: { email: string; success: boolean; error?: string }[] = [];
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        for (const email of emails) {
            try {
                const token = generateToken();
                const downloadUrl = `https://anticrow.pages.dev/api/download/${token}`;

                // invite_log に記録
                await DB.prepare(
                    'INSERT INTO invite_logs (email, version, download_token, token_expires_at, status) VALUES (?, ?, ?, ?, ?)'
                ).bind(email, latestRelease.version, token, expiresAt, 'sent').run();

                // Resend でメール送信
                const emailHtml = generateInviteEmailHtml({
                    downloadUrl,
                    version: latestRelease.version,
                    expiresIn: '24時間',
                });

                const resendRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${RESEND_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: 'Anti-Crow <onboarding@resend.dev>',
                        to: email,
                        subject: '🦅 Anti-Crow へようこそ！ダウンロードリンクをお届けします',
                        html: emailHtml,
                    }),
                });

                if (!resendRes.ok) {
                    const errBody = await resendRes.text();
                    throw new Error(`Resend API error: ${resendRes.status} ${errBody}`);
                }

                // waitlist のステータスを更新
                await DB.prepare(
                    "UPDATE waitlist SET invite_status = 'invited', invited_at = datetime('now') WHERE email = ?"
                ).bind(email).run();

                results.push({ email, success: true });
            } catch (err) {
                results.push({ email, success: false, error: (err as Error).message });
            }
        }

        const successCount = results.filter(r => r.success).length;
        return new Response(
            JSON.stringify({ results, successCount, totalCount: emails.length }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Invite error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};
