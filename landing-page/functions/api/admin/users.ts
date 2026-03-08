// GET /api/admin/users - ウェイトリストユーザー一覧
interface Env {
    DB: D1Database;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB } = context.env;
    const url = new URL(context.request.url);

    const status = url.searchParams.get('status') || 'all';
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const search = url.searchParams.get('search') || '';
    const offset = (page - 1) * limit;

    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        let whereClause = '';
        const params: string[] = [];

        if (status !== 'all') {
            whereClause = 'WHERE invite_status = ?';
            params.push(status);
        }

        if (search) {
            whereClause = whereClause
                ? `${whereClause} AND email LIKE ?`
                : 'WHERE email LIKE ?';
            params.push(`%${search}%`);
        }

        // 総件数
        const countResult = await DB.prepare(
            `SELECT COUNT(*) as total FROM waitlist ${whereClause}`
        ).bind(...params).first<{ total: number }>();

        // ユーザー一覧
        const users = await DB.prepare(
            `SELECT id, email, referral_code, referred_by, referral_count, position, priority_score, email_verified, created_at, invited_at, invite_status, current_version
       FROM waitlist ${whereClause}
       ORDER BY position ASC
       LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all();

        return new Response(
            JSON.stringify({
                users: users.results,
                total: countResult?.total || 0,
                page,
                limit,
                totalPages: Math.ceil((countResult?.total || 0) / limit),
            }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Users list error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};
