// GET /api/waitlist/status?email=xxx@example.com
// ウェイトリストステータス取得 API
interface Env {
    DB: D1Database;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB } = context.env;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    };

    try {
        const url = new URL(context.request.url);
        const email = url.searchParams.get('email');

        if (!email) {
            return new Response(
                JSON.stringify({ error: 'Email parameter is required' }),
                { status: 400, headers: corsHeaders }
            );
        }

        const normalizedEmail = email.toLowerCase().trim();

        const user = await DB.prepare(
            'SELECT email, referral_code, referred_by, referral_count, position, priority_score, email_verified, created_at FROM waitlist WHERE email = ?'
        ).bind(normalizedEmail).first();

        if (!user) {
            return new Response(
                JSON.stringify({ error: 'Email not found in waitlist' }),
                { status: 404, headers: corsHeaders }
            );
        }

        const totalCount = await DB.prepare(
            'SELECT COUNT(*) as total FROM waitlist'
        ).first<{ total: number }>();

        // 内部計算で実効順位を算出（ロジックは非公開）
        const effectivePosition = Math.max(1, (user.position as number) - (user.priority_score as number));
        const points = (user.referral_count as number) * 10;

        return new Response(
            JSON.stringify({
                email: user.email,
                referralCode: user.referral_code,
                position: effectivePosition,
                totalCount: totalCount?.total || 0,
                points,
                pointsLabel: `${points}pt`,
                emailVerified: user.email_verified === 1,
                createdAt: user.created_at,
                referralLink: `https://anticrow.pages.dev?ref=${user.referral_code}`,
            }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Status error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};

// CORS プリフライト対応
export const onRequestOptions: PagesFunction = async () => {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
};
