// Admin API 認証ミドルウェア
// ADMIN_API_KEY で認証を行う

interface Env {
    ADMIN_API_KEY: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const { request, env } = context;

    // CORS プリフライト
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
        });
    }

    // Authorization ヘッダーからAPIキーを取得
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(
            JSON.stringify({ error: 'Authorization required' }),
            {
                status: 401,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            }
        );
    }

    const apiKey = authHeader.slice(7);
    if (apiKey !== env.ADMIN_API_KEY) {
        return new Response(
            JSON.stringify({ error: 'Invalid API key' }),
            {
                status: 403,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            }
        );
    }

    // 認証OK → 次のハンドラへ
    return context.next();
};
