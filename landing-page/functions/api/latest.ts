// /api/latest - R2からlatest.jsonを取得するプロキシ
// R2のpub-*.r2.devはCORSヘッダーを返さないため、
// Pages Function経由で同一ドメインからアクセスする

const R2_PUBLIC_URL = 'https://pub-43d0b2eef4734fc8b00c014791e17d8a.r2.dev';

export const onRequestGet: PagesFunction = async () => {
  try {
    const response = await fetch(`${R2_PUBLIC_URL}/latest.json`);
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch latest.json from R2' }),
        {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60', // 1分キャッシュ
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Internal error fetching version info' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
