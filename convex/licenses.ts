// ---------------------------------------------------------------------------
// convex/licenses.ts — ライセンス CRUD + 有効性チェック
// ---------------------------------------------------------------------------
import { query, mutation } from './_generated/server';
import { v } from 'convex/values';

// -----------------------------------------------------------------
// ライセンス有効性チェック（VSCode 拡張から HTTP 経由で呼び出し）
// -----------------------------------------------------------------
export const checkLicense = query({
    args: { clerkId: v.string() },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (!user) {
            return { valid: false, reason: 'user_not_found' as const, license: null };
        }

        const licenses = await ctx.db
            .query('licenses')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .collect();

        const now = Date.now();

        // アクティブなライセンスを探す（優先順位: lifetime > annual > monthly > beta）
        const priorityOrder = ['lifetime', 'annual', 'monthly', 'beta'] as const;

        for (const type of priorityOrder) {
            const license = licenses.find((l) => l.type === type);
            if (!license) continue;

            if (license.type === 'lifetime' && license.status === 'active') {
                return { valid: true, reason: 'lifetime' as const, license };
            }

            if (license.type === 'beta') {
                if (license.status === 'active' && license.expiresAt && license.expiresAt > now) {
                    return { valid: true, reason: 'beta' as const, license };
                }
                continue;
            }

            // サブスクリプション系
            if (['active', 'trialing'].includes(license.status)) {
                if (license.currentPeriodEnd && license.currentPeriodEnd > now) {
                    return { valid: true, reason: license.type as 'monthly' | 'annual', license };
                }
            }
        }

        return { valid: false, reason: 'no_active_license' as const, license: null };
    },
});

// -----------------------------------------------------------------
// ユーザーの全ライセンス一覧
// -----------------------------------------------------------------
export const listByUser = query({
    args: { clerkId: v.string() },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (!user) return [];

        return ctx.db
            .query('licenses')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .collect();
    },
});

// -----------------------------------------------------------------
// ユーザー作成 or 取得（Clerk Webhook / 初回認証時）
// -----------------------------------------------------------------
export const ensureUser = mutation({
    args: {
        clerkId: v.string(),
        email: v.optional(v.string()),
        name: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (existing) {
            // メール・名前の更新
            if (args.email || args.name) {
                await ctx.db.patch(existing._id, {
                    ...(args.email ? { email: args.email } : {}),
                    ...(args.name ? { name: args.name } : {}),
                });
            }
            return existing._id;
        }

        return ctx.db.insert('users', {
            clerkId: args.clerkId,
            email: args.email,
            name: args.name,
            createdAt: Date.now(),
        });
    },
});

// -----------------------------------------------------------------
// Stripe Customer ID を保存
// -----------------------------------------------------------------
export const setStripeCustomerId = mutation({
    args: {
        clerkId: v.string(),
        stripeCustomerId: v.string(),
    },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (!user) throw new Error(`User not found: ${args.clerkId}`);

        await ctx.db.patch(user._id, { stripeCustomerId: args.stripeCustomerId });
    },
});

// -----------------------------------------------------------------
// ライセンス作成（Stripe Webhook から呼び出し）
// -----------------------------------------------------------------
export const createLicense = mutation({
    args: {
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
        ),
        stripeSubscriptionId: v.optional(v.string()),
        stripePaymentIntentId: v.optional(v.string()),
        currentPeriodStart: v.optional(v.number()),
        currentPeriodEnd: v.optional(v.number()),
        trialEnd: v.optional(v.number()),
        grantedBy: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const now = Date.now();
        return ctx.db.insert('licenses', {
            userId: args.userId,
            type: args.type,
            status: args.status,
            stripeSubscriptionId: args.stripeSubscriptionId,
            stripePaymentIntentId: args.stripePaymentIntentId,
            currentPeriodStart: args.currentPeriodStart,
            currentPeriodEnd: args.currentPeriodEnd,
            trialEnd: args.trialEnd,
            grantedBy: args.grantedBy,
            grantedAt: args.grantedBy ? now : undefined,
            expiresAt: args.expiresAt,
            createdAt: now,
            updatedAt: now,
        });
    },
});

// -----------------------------------------------------------------
// ライセンス更新（Stripe Webhook: subscription.updated）
// -----------------------------------------------------------------
export const updateByStripeSubscription = mutation({
    args: {
        stripeSubscriptionId: v.string(),
        status: v.union(
            v.literal('active'),
            v.literal('trialing'),
            v.literal('past_due'),
            v.literal('canceled'),
            v.literal('expired'),
        ),
        currentPeriodStart: v.optional(v.number()),
        currentPeriodEnd: v.optional(v.number()),
        trialEnd: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const license = await ctx.db
            .query('licenses')
            .withIndex('by_stripe_subscription', (q) =>
                q.eq('stripeSubscriptionId', args.stripeSubscriptionId),
            )
            .unique();

        if (!license) throw new Error(`License not found for subscription: ${args.stripeSubscriptionId}`);

        await ctx.db.patch(license._id, {
            status: args.status,
            currentPeriodStart: args.currentPeriodStart ?? license.currentPeriodStart,
            currentPeriodEnd: args.currentPeriodEnd ?? license.currentPeriodEnd,
            trialEnd: args.trialEnd ?? license.trialEnd,
            updatedAt: Date.now(),
        });
    },
});
