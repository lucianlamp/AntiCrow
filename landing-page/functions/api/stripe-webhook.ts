// POST /api/stripe-webhook — Stripe Webhook エンドポイント
// checkout.session.completed イベントを受信し、ライセンスキーを自動生成して D1 に保存する
import { Env } from '../../shared/types';
import { generateLicenseEmailHtml } from '../../shared/email-templates';

/**
 * ライセンスキーを生成する（AC-XXXXXXXX-XXXXXXXX-XXXXXXXX 形式）
 */
function generateLicenseKey(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segments: string[] = [];
    for (let s = 0; s < 3; s++) {
        let segment = '';
        for (let i = 0; i < 8; i++) {
            const randomBytes = new Uint8Array(1);
            crypto.getRandomValues(randomBytes);
            segment += chars[randomBytes[0] % chars.length];
        }
        segments.push(segment);
    }
    return `AC-${segments.join('-')}`;
}

/**
 * Stripe Webhook の署名を検証する
 * Stripe の署名検証は crypto.subtle を使用
 */
async function verifyStripeSignature(
    payload: string,
    signature: string,
    secret: string,
): Promise<boolean> {
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.substring(2);
    const v1Signature = parts.find(p => p.startsWith('v1='))?.substring(3);

    if (!timestamp || !v1Signature) return false;

    // タイムスタンプが古すぎないかチェック（5分以内）
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    // HMAC-SHA256 で署名を計算
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const expectedSignature = Array.from(new Uint8Array(mac))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    // タイミングセーフ比較
    if (expectedSignature.length !== v1Signature.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expectedSignature.length; i++) {
        mismatch |= expectedSignature.charCodeAt(i) ^ v1Signature.charCodeAt(i);
    }
    return mismatch === 0;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const { PURCHASE_DB: DB, RESEND_API_KEY } = context.env;
    const webhookSecret = context.env.STRIPE_WEBHOOK_SECRET;


    if (!webhookSecret) {
        console.error('STRIPE_WEBHOOK_SECRET is not configured');
        return new Response('Server configuration error', { status: 500 });
    }

    // リクエストボディを取得
    const payload = await context.request.text();
    const signature = context.request.headers.get('stripe-signature');

    if (!signature) {
        return new Response('Missing stripe-signature header', { status: 400 });
    }

    // 署名検証
    const isValid = await verifyStripeSignature(payload, signature, webhookSecret);
    if (!isValid) {
        console.error('Stripe webhook signature verification failed');
        return new Response('Invalid signature', { status: 400 });
    }

    // イベントをパース
    let event: {
        type: string;
        data: {
            object: {
                id: string;
                customer: string;
                customer_email: string | null;
                customer_details?: { email: string | null };
                payment_status: string;
                metadata?: Record<string, string>;
            };
        };
    };

    try {
        event = JSON.parse(payload);
    } catch {
        return new Response('Invalid JSON', { status: 400 });
    }

    // checkout.session.completed イベントのみ処理
    if (event.type !== 'checkout.session.completed') {
        // 他のイベントは無視（200 を返す）
        return new Response(JSON.stringify({ received: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const session = event.data.object;

    // 支払い完了チェック
    if (session.payment_status !== 'paid') {
        return new Response(JSON.stringify({ received: true, skipped: 'not paid' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ライセンスキーを生成
    const licenseKey = generateLicenseKey();
    const email = session.customer_email || session.customer_details?.email || null;

    try {
        // 重複チェック（同じ session_id で既にライセンスが発行されていないか）
        const existing = await DB.prepare(
            'SELECT license_key FROM licenses WHERE stripe_session_id = ?'
        ).bind(session.id).first<{ license_key: string }>();

        if (existing) {
            console.log(`License already exists for session ${session.id}: ${existing.license_key}`);
            // 重複時でもメールが未送信の可能性があるため、メール送信を試みる
            if (email && RESEND_API_KEY) {
                try {
                    const emailHtml = generateLicenseEmailHtml({
                        licenseKey: existing.license_key,
                        email,
                        plan: 'Lifetime',
                    });
                    const resendRes = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${RESEND_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            from: 'AntiCrow <onboarding@resend.dev>',
                            to: email,
                            subject: '🔑 AntiCrow Pro ライセンスキーをお届けします',
                            html: emailHtml,
                        }),
                    });
                    const resendBody = await resendRes.text();
                } catch (emailError) {
                    console.error('Failed to send license email (duplicate):', emailError);
                }
            }
            return new Response(JSON.stringify({
                received: true,
                license_key: existing.license_key,
                duplicate: true,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // D1 にライセンスを保存
        await DB.prepare(
            `INSERT INTO licenses (license_key, customer_id, stripe_session_id, email, plan, status)
             VALUES (?, ?, ?, ?, 'lifetime', 'active')`
        ).bind(licenseKey, session.customer || 'unknown', session.id, email).run();

        console.log(`License created: ${licenseKey} for ${email || 'unknown'} (session: ${session.id})`);

        // Resend でライセンスキーをメール送信
        if (email && RESEND_API_KEY) {
            try {
                const emailHtml = generateLicenseEmailHtml({
                    licenseKey,
                    email,
                    plan: 'Lifetime',
                });

                console.log(`Sending email via Resend: from=AntiCrow <onboarding@resend.dev>, to=${email}`);

                const resendRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${RESEND_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: 'AntiCrow <onboarding@resend.dev>',
                        to: email,
                        subject: '🔑 AntiCrow Pro ライセンスキーをお届けします',
                        html: emailHtml,
                    }),
                });

                const resendBody = await resendRes.text();
                console.log(`Resend API response: status=${resendRes.status}, body=${resendBody}`);

                if (!resendRes.ok) {
                    console.error(`Resend API error: ${resendRes.status} ${resendBody}`);
                }
            } catch (emailError) {
                // メール送信失敗はライセンス発行には影響させない
                console.error('Failed to send license email:', emailError);
            }
        } else {
            console.warn(`Email sending skipped: email=${email || 'null'}, RESEND_API_KEY=${RESEND_API_KEY ? 'set' : 'not set'}`);
        }

        return new Response(JSON.stringify({
            received: true,
            license_key: licenseKey,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Failed to create license:', error);
        return new Response(JSON.stringify({
            received: true,
            error: 'Failed to create license',
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
