// POST /api/validate-license — ライセンスキー検証 API
// Anti-Crow の licenseChecker.ts から呼ばれるエンドポイント
import { Env } from '../../shared/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    const { PURCHASE_DB: DB } = context.env;

    try {
        const body = await context.request.json() as { license_key: string };
        const { license_key } = body;

        if (!license_key || typeof license_key !== 'string') {
            return new Response(
                JSON.stringify({ valid: false, reason: 'invalid_request' }),
                { status: 400, headers: corsHeaders },
            );
        }

        const trimmedKey = license_key.trim().toUpperCase();

        // D1 からライセンスを検索
        const license = await DB.prepare(
            'SELECT license_key, email, plan, status, created_at, activated_at, machine_id FROM licenses WHERE UPPER(license_key) = ? AND status = ?'
        ).bind(trimmedKey, 'active').first<{
            license_key: string;
            email: string | null;
            plan: string;
            status: string;
            created_at: string;
            activated_at: string | null;
            machine_id: string | null;
        }>();

        if (!license) {
            // 無効なキーまたは非アクティブ
            return new Response(
                JSON.stringify({ valid: false, reason: 'invalid_key' }),
                { status: 200, headers: corsHeaders },
            );
        }

        return new Response(
            JSON.stringify({
                valid: true,
                plan: license.plan,
                email: license.email,
                created_at: license.created_at,
                activated_at: license.activated_at,
            }),
            { status: 200, headers: corsHeaders },
        );
    } catch (error) {
        console.error('Validate license error:', error);
        return new Response(
            JSON.stringify({ valid: false, reason: 'server_error' }),
            { status: 500, headers: corsHeaders },
        );
    }
};

// CORS プリフライト対応
export const onRequestOptions: PagesFunction<Env> = async () => {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
        },
    });
};
