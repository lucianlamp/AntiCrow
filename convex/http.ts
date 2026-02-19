// ---------------------------------------------------------------------------
// convex/http.ts — HTTP ルート定義
// ---------------------------------------------------------------------------
import { httpRouter } from 'convex/server';
import { webhook } from './stripe';

const http = httpRouter();

// Stripe Webhook エンドポイント
http.route({
    path: '/stripe/webhook',
    method: 'POST',
    handler: webhook,
});

export default http;
