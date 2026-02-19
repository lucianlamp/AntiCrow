// ---------------------------------------------------------------------------
// convex/schema.ts — ライセンス管理システムのデータベーススキーマ
// ---------------------------------------------------------------------------
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
    // -----------------------------------------------------------------
    // users — Clerk 認証ユーザー
    // -----------------------------------------------------------------
    users: defineTable({
        clerkId: v.string(),         // Clerk ユーザー ID
        email: v.optional(v.string()),
        name: v.optional(v.string()),
        stripeCustomerId: v.optional(v.string()),  // Stripe Customer ID
        createdAt: v.number(),       // Unix timestamp (ms)
    })
        .index('by_clerk_id', ['clerkId'])
        .index('by_stripe_customer', ['stripeCustomerId']),

    // -----------------------------------------------------------------
    // licenses — ライセンスレコード（全プランタイプ統合）
    // -----------------------------------------------------------------
    licenses: defineTable({
        userId: v.id('users'),
        type: v.union(
            v.literal('monthly'),
            v.literal('annual'),
            v.literal('lifetime'),
            v.literal('beta'),
        ),
        status: v.union(
            v.literal('active'),
            v.literal('trialing'),
            v.literal('past_due'),
            v.literal('canceled'),
            v.literal('expired'),
        ),
        // Stripe 関連（beta 以外で使用）
        stripeSubscriptionId: v.optional(v.string()),
        stripePaymentIntentId: v.optional(v.string()),
        // 期間
        currentPeriodStart: v.optional(v.number()),  // Unix timestamp (ms)
        currentPeriodEnd: v.optional(v.number()),    // Unix timestamp (ms)
        trialEnd: v.optional(v.number()),            // Unix timestamp (ms)
        // beta 固有
        grantedBy: v.optional(v.string()),           // 管理者のメール or ID
        grantedAt: v.optional(v.number()),
        expiresAt: v.optional(v.number()),           // beta 有効期限
        // メタデータ
        createdAt: v.number(),
        updatedAt: v.number(),
    })
        .index('by_user', ['userId'])
        .index('by_stripe_subscription', ['stripeSubscriptionId'])
        .index('by_status', ['status']),
});
