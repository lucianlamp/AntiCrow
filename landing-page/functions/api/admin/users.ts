// GET /api/admin/users - ユーザー一覧取得
import { Env } from '../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB } = context.env;
    const url = new URL(context.request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const status = url.searchParams.get('status') || 'all';
    const search = url.searchParams.get('search') || '';

    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        let whereClause = '';
        const params: string[] = [];

        if (status !== 'all') {
            if (status === 'pending') {
                whereClause = "WHERE (invite_status = 'pending' OR invite_status IS NULL)";
            } else {
                whereClause = 'WHERE invite_status = ?';
                params.push(status);
            }
        }

        if (search) {
            whereClause += whereClause ? ' AND email LIKE ?' : 'WHERE email LIKE ?';
            params.push(`%${search}%`);
        }

        const offset = (page - 1) * limit;

        const countQuery = await DB.prepare(
            `SELECT COUNT(*) as total FROM waitlist ${whereClause}`
        ).bind(...params).first<{ total: number }>();

        const users = await DB.prepare(
            `SELECT * FROM waitlist ${whereClause} ORDER BY priority_score DESC, created_at ASC LIMIT ? OFFSET ?`
        ).bind(...params, limit, offset).all();

        return new Response(
            JSON.stringify({ users: users.results, total: countQuery?.total || 0 }),
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
