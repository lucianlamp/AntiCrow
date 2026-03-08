// POST /api/admin/notify-update - アップデート通知メール一括送信
import { Env } from '../../../shared/types';
import { generateToken, sendEmailsInChunks } from '../../../shared/utils';
import { generateUpdateEmailHtml } from '../../../shared/email-templates';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { DB, RESEND_API_KEY } = context.env;
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        // 最新リリースを取得
        const latestRelease = await DB.prepare(
            'SELECT version, r2_key, changelog FROM releases WHERE is_latest = 1 LIMIT 1'
        ).first<{ version: string; r2_key: string; changelog: string }>();

        if (!latestRelease) {
            return new Response(
                JSON.stringify({ error: 'No release available' }),
                { status: 400, headers: corsHeaders }
            );
        }

        // invited 済みのユーザーを取得（まだ最新版をDLしていないユーザー）
        const users = await DB.prepare(
            "SELECT email FROM waitlist WHERE invite_status = 'invited' AND (current_version IS NULL OR current_version != ?)"
        ).bind(latestRelease.version).all<{ email: string }>();

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        // メール送信をチャンク化して並列実行（10件ずつ）
        const results = await sendEmailsInChunks(users.results, async (user) => {
            const token = generateToken();
            const downloadUrl = `https://anticrow.pages.dev/api/download/${token}`;

            // invite_log に記録
            await DB.prepare(
                'INSERT INTO invite_logs (email, version, download_token, token_expires_at, status) VALUES (?, ?, ?, ?, ?)'
            ).bind(user.email, latestRelease.version, token, expiresAt, 'sent').run();

            // Resend でメール送信
            const emailHtml = generateUpdateEmailHtml({
                downloadUrl,
                version: latestRelease.version,
                changelog: latestRelease.changelog || '',
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
                    to: user.email,
                    subject: `🚀 Anti-Crow v${latestRelease.version} がリリースされました！`,
                    html: emailHtml,
                }),
            });

            if (!resendRes.ok) {
                const errBody = await resendRes.text();
                throw new Error(`Resend API error: ${resendRes.status} ${errBody}`);
            }

            return { success: true };
        });

        const successCount = results.filter(r => r.success).length;
        return new Response(
            JSON.stringify({ results: results.map((r, i) => ({ email: users.results[i].email, ...r })), successCount, totalCount: users.results.length }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Notify update error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};
