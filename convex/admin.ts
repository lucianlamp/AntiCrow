// ---------------------------------------------------------------------------
// convex/admin.ts — 管理者用関数（ベータアクセス付与・失効・一覧）
// ---------------------------------------------------------------------------
import { query, mutation } from './_generated/server';
import { v } from 'convex/values';

// -----------------------------------------------------------------
// ベータアクセス付与
// -----------------------------------------------------------------
export const grantBetaAccess = mutation({
    args: {
        clerkId: v.string(),
        grantedBy: v.string(),
        durationDays: v.number(),  // 有効期間（日数）
    },
    handler: async (ctx, args) => {
        // ユーザーを取得 or 作成
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (!user) {
            throw new Error(`User not found: ${args.clerkId}. User must sign up first.`);
        }

        const now = Date.now();
        const expiresAt = now + args.durationDays * 24 * 60 * 60 * 1000;

        // 既存のベータライセンスがあれば失効させる
        const existingBeta = await ctx.db
            .query('licenses')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .filter((q) => q.eq(q.field('type'), 'beta'))
            .unique();

        if (existingBeta) {
            await ctx.db.patch(existingBeta._id, {
                status: 'expired',
                updatedAt: now,
            });
        }

        // 新しいベータライセンスを作成
        return ctx.db.insert('licenses', {
            userId: user._id,
            type: 'beta',
            status: 'active',
            grantedBy: args.grantedBy,
            grantedAt: now,
            expiresAt,
            createdAt: now,
            updatedAt: now,
        });
    },
});

// -----------------------------------------------------------------
// ベータアクセス取り消し
// -----------------------------------------------------------------
export const revokeBetaAccess = mutation({
    args: { clerkId: v.string() },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        if (!user) throw new Error(`User not found: ${args.clerkId}`);

        const betaLicense = await ctx.db
            .query('licenses')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .filter((q) =>
                q.and(
                    q.eq(q.field('type'), 'beta'),
                    q.eq(q.field('status'), 'active'),
                ),
            )
            .unique();

        if (!betaLicense) throw new Error('No active beta license found');

        await ctx.db.patch(betaLicense._id, {
            status: 'expired',
            updatedAt: Date.now(),
        });
    },
});

// -----------------------------------------------------------------
// 全ベータユーザー一覧
// -----------------------------------------------------------------
export const listBetaUsers = query({
    handler: async (ctx) => {
        const betaLicenses = await ctx.db
            .query('licenses')
            .filter((q) => q.eq(q.field('type'), 'beta'))
            .collect();

        const results = [];
        for (const license of betaLicenses) {
            const user = await ctx.db.get(license.userId);
            results.push({
                license,
                user: user ? { clerkId: user.clerkId, email: user.email, name: user.name } : null,
            });
        }
        return results;
    },
});

// -----------------------------------------------------------------
// 期限切れベータライセンスの自動失効（cron ジョブ用）
// -----------------------------------------------------------------
export const expireOldBetaLicenses = mutation({
    handler: async (ctx) => {
        const now = Date.now();
        const activeBetas = await ctx.db
            .query('licenses')
            .filter((q) =>
                q.and(
                    q.eq(q.field('type'), 'beta'),
                    q.eq(q.field('status'), 'active'),
                ),
            )
            .collect();

        let expiredCount = 0;
        for (const license of activeBetas) {
            if (license.expiresAt && license.expiresAt < now) {
                await ctx.db.patch(license._id, {
                    status: 'expired',
                    updatedAt: now,
                });
                expiredCount++;
            }
        }
        return { expiredCount };
    },
});
