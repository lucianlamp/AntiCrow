// POST /api/waitlist/register
// ウェイトリスト登録 API
interface Env {
  DB: D1Database;
}

interface RegisterRequest {
  email: string;
  referralCode?: string; // 紹介者のリファラルコード
}

function generateReferralCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'AC-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { DB } = context.env;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const body = (await context.request.json()) as RegisterRequest;
    const { email, referralCode } = body;

    // バリデーション
    if (!email || !isValidEmail(email)) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 既存チェック
    const existing = await DB.prepare(
      'SELECT id, referral_code, position, referral_count, priority_score FROM waitlist WHERE email = ?'
    ).bind(normalizedEmail).first();

    if (existing) {
      // 既に登録済みの場合はステータスを返す
      const totalCount = await DB.prepare('SELECT COUNT(*) as total FROM waitlist').first<{ total: number }>();
      const effectivePosition = Math.max(1, (existing.position as number) - (existing.priority_score as number));
      const points = (existing.referral_count as number) * 10;

      return new Response(
        JSON.stringify({
          success: true,
          alreadyRegistered: true,
          email: normalizedEmail,
          referralCode: existing.referral_code,
          position: effectivePosition,
          totalCount: totalCount?.total || 0,
          points,
          pointsLabel: `${points}pt`,
          referralLink: `https://anticrow.pages.dev?ref=${existing.referral_code}`,
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // 新規リファラルコード生成（重複チェック付き）
    let newReferralCode = generateReferralCode();
    let attempts = 0;
    while (attempts < 10) {
      const codeExists = await DB.prepare(
        'SELECT id FROM waitlist WHERE referral_code = ?'
      ).bind(newReferralCode).first();
      if (!codeExists) break;
      newReferralCode = generateReferralCode();
      attempts++;
    }

    // 次のポジションを取得
    const maxPosition = await DB.prepare(
      'SELECT COALESCE(MAX(position), 0) as max_pos FROM waitlist'
    ).first<{ max_pos: number }>();
    const nextPosition = (maxPosition?.max_pos || 0) + 1;

    // 紹介者がいる場合、紹介者の referral_count と priority_score を更新
    let referredBy: string | null = null;
    if (referralCode) {
      const referrer = await DB.prepare(
        'SELECT id, referral_code FROM waitlist WHERE referral_code = ?'
      ).bind(referralCode).first();

      if (referrer) {
        referredBy = referralCode;
        // 紹介者の referral_count +1, priority_score +5
        await DB.prepare(
          'UPDATE waitlist SET referral_count = referral_count + 1, priority_score = priority_score + 5 WHERE referral_code = ?'
        ).bind(referralCode).run();
      }
    }

    // ウェイトリストに登録
    await DB.prepare(
      'INSERT INTO waitlist (email, referral_code, referred_by, referral_count, position, priority_score, email_verified) VALUES (?, ?, ?, 0, ?, 0, 0)'
    ).bind(normalizedEmail, newReferralCode, referredBy, nextPosition).run();

    return new Response(
      JSON.stringify({
        success: true,
        alreadyRegistered: false,
        email: normalizedEmail,
        referralCode: newReferralCode,
        position: nextPosition,
        totalCount: nextPosition,
        points: 0,
        pointsLabel: '0pt',
        referralLink: `https://anticrow.pages.dev?ref=${newReferralCode}`,
      }),
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    console.error('Registration error:', error);
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
};
