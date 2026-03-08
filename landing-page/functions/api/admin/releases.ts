// GET/POST /api/admin/releases - リリース管理
interface Env {
    DB: D1Database;
    R2: R2Bucket;
}

// GET: リリース一覧
export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { DB } = context.env;
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        const releases = await DB.prepare(
            'SELECT id, version, r2_key, changelog, download_count, created_at, is_latest FROM releases ORDER BY created_at DESC'
        ).all();

        return new Response(
            JSON.stringify({ releases: releases.results }),
            { status: 200, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Releases list error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};

// POST: VSIXアップロード
export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { DB, R2 } = context.env;
    const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    };

    try {
        const formData = await context.request.formData();
        const file = formData.get('file') as File | null;
        const version = formData.get('version') as string | null;
        const changelog = formData.get('changelog') as string | null;

        if (!file || !version) {
            return new Response(
                JSON.stringify({ error: 'file and version are required' }),
                { status: 400, headers: corsHeaders }
            );
        }

        // バージョン重複チェック
        const existing = await DB.prepare(
            'SELECT id FROM releases WHERE version = ?'
        ).bind(version).first();

        if (existing) {
            return new Response(
                JSON.stringify({ error: `Version ${version} already exists` }),
                { status: 409, headers: corsHeaders }
            );
        }

        // R2 にアップロード
        const r2Key = `releases/anti-crow-${version}.vsix`;
        const fileBuffer = await file.arrayBuffer();
        await R2.put(r2Key, fileBuffer, {
            httpMetadata: {
                contentType: 'application/octet-stream',
                contentDisposition: `attachment; filename="anti-crow-${version}.vsix"`,
            },
        });

        // 既存の is_latest をリセット
        await DB.prepare('UPDATE releases SET is_latest = 0 WHERE is_latest = 1').run();

        // DB に記録
        await DB.prepare(
            'INSERT INTO releases (version, r2_key, changelog, is_latest) VALUES (?, ?, ?, 1)'
        ).bind(version, r2Key, changelog || '').run();

        return new Response(
            JSON.stringify({ success: true, version, r2Key }),
            { status: 201, headers: corsHeaders }
        );
    } catch (error) {
        console.error('Release upload error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500, headers: corsHeaders }
        );
    }
};
