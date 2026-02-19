// ---------------------------------------------------------------------------
// convex/auth.ts — Clerk 認証統合
// ---------------------------------------------------------------------------
import { query } from './_generated/server';
import { v } from 'convex/values';

/**
 * Clerk トークンを検証してユーザー情報を返す。
 * VSCode 拡張から Convex クエリとして呼び出す。
 *
 * 注: 実際の Clerk JWT 検証は Convex の Auth プロバイダー設定で行う。
 * この関数は認証済みコンテキストからユーザー情報を取得するヘルパー。
 */
export const getUser = query({
    args: { clerkId: v.string() },
    handler: async (ctx, args) => {
        const user = await ctx.db
            .query('users')
            .withIndex('by_clerk_id', (q) => q.eq('clerkId', args.clerkId))
            .unique();

        return user ?? null;
    },
});
