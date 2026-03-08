// GET /api/admin/stats - 統計データ
import { Env } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB } = context.env;
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        const [total, pending, invited, downloaded, totalDownloads] = await Promise.all([
            DB.prepare('SELECT COUNT(*) as count FROM waitlist').first<{ count: number }>(),
            DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'pending' OR invite_status IS NULL").first<{ count: number }>(),
            DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'invited'").first<{ count: number }>(),
            DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'downloaded'").first<{ count: number }>(),
            DB.prepare('SELECT COALESCE(SUM(download_count), 0) as count FROM releases').first<{ count: number }>(),
        ]);

        // 最近7日の登録数
        const recentRegistrations = await DB.prepare(
            `SELECT date(created_at) as date, COUNT(*) as count
       FROM waitlist
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY date(created_at)
       ORDER BY date ASC`
        ).all();

        // 最近のメール送信数（クォート統一: シングルクォート）
        const recentEmails = await DB.prepare(
            "SELECT COUNT(*) as count FROM invite_logs WHERE sent_at >= datetime('now', '-7 days')"
        ).first<{ count: number }>();

        return new Response(
            JSON.stringify({
                totalUsers: total?.count || 0,
                pendingUsers: pending?.count || 0,
                invitedUsers: invited?.count || 0,
                downloadedUsers: downloaded?.count || 0,
                totalDownloads: totalDownloads?.count || 0,
                recentEmails: recentEmails?.count || 0,
                registrationTrend: recentRegistrations.results,
            }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Stats error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};
