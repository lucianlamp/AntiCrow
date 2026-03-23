// 共有型定義（Cloudflare Workers 環境で使用）

export interface Env {
    PURCHASE_DB: D1Database;
    RESEND_API_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
}
