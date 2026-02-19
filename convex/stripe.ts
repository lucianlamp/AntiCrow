// ---------------------------------------------------------------------------
// convex/stripe.ts — Stripe Webhook ハンドラ（HTTP endpoint）
// ---------------------------------------------------------------------------
import { httpAction } from './_generated/server';
import { api } from './_generated/api';

/**
 * Stripe Webhook を受信する HTTP エンドポイント。
 *
 * 処理するイベント:
 * - checkout.session.completed — 新規サブスクリプション or Lifetime 購入
 * - customer.subscription.updated — サブスクリプション期間更新・ステータス変更
 * - customer.subscription.deleted — サブスクリプション解約
 */
export const webhook = httpAction(async (ctx, request) => {
    const body = await request.text();

    // Stripe Webhook Signing Secret による署名検証
    // 注: 本番環境では Stripe SDK で署名を検証すること
    const sig = request.headers.get('stripe-signature');
    if (!sig) {
        return new Response('Missing Stripe signature', { status: 400 });
    }

    let event: {
        type: string;
        data: { object: Record<string, unknown> };
    };

    try {
        event = JSON.parse(body);
    } catch {
        return new Response('Invalid JSON', { status: 400 });
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const mode = session.mode as string;
                const clerkId = (session.metadata as Record<string, string>)?.clerkId;
                const stripeCustomerId = session.customer as string;

                if (!clerkId) {
                    console.error('checkout.session.completed: missing clerkId in metadata');
                    return new Response('Missing clerkId', { status: 400 });
                }

                // ユーザーの Stripe Customer ID を保存
                await ctx.runMutation(api.licenses.setStripeCustomerId, {
                    clerkId,
                    stripeCustomerId,
                });

                if (mode === 'subscription') {
                    // サブスクリプション — customer.subscription.created で処理
                    // checkout.session.completed では何もしない（二重作成防止）
                } else if (mode === 'payment') {
                    // Lifetime 買い切り
                    const userId = await ctx.runMutation(api.licenses.ensureUser, {
                        clerkId,
                    });
                    await ctx.runMutation(api.licenses.createLicense, {
                        userId,
                        type: 'lifetime',
                        status: 'active',
                        stripePaymentIntentId: session.payment_intent as string | undefined,
                    });
                }
                break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const stripeSubscriptionId = subscription.id as string;
                const stripeCustomerId = subscription.customer as string;
                const status = subscription.status as string;
                const clerkId = (subscription.metadata as Record<string, string>)?.clerkId;

                // price -> plan type mapping
                const items = (subscription as Record<string, unknown>).items as {
                    data: Array<{ price: { id: string; recurring?: { interval: string } } }>;
                };
                const priceItem = items?.data?.[0];
                const interval = priceItem?.price?.recurring?.interval;
                const planType = interval === 'year' ? 'annual' : 'monthly';

                // ステータスマッピング
                const statusMap: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'> = {
                    active: 'active',
                    trialing: 'trialing',
                    past_due: 'past_due',
                    canceled: 'canceled',
                    unpaid: 'expired',
                    incomplete_expired: 'expired',
                };
                const mappedStatus = statusMap[status] ?? 'active';

                const periodStart = (subscription.current_period_start as number) * 1000;
                const periodEnd = (subscription.current_period_end as number) * 1000;
                const trialEnd = subscription.trial_end
                    ? (subscription.trial_end as number) * 1000
                    : undefined;

                if (event.type === 'customer.subscription.created') {
                    // 新規サブスクリプション
                    if (clerkId) {
                        const userId = await ctx.runMutation(api.licenses.ensureUser, {
                            clerkId,
                        });
                        await ctx.runMutation(api.licenses.createLicense, {
                            userId,
                            type: planType,
                            status: mappedStatus,
                            stripeSubscriptionId,
                            currentPeriodStart: periodStart,
                            currentPeriodEnd: periodEnd,
                            trialEnd,
                        });
                    } else {
                        // clerkId がない場合 — stripeCustomerId からユーザーを探す
                        console.warn(`subscription.created: no clerkId, customer=${stripeCustomerId}`);
                    }
                } else {
                    // 既存サブスクリプション更新
                    await ctx.runMutation(api.licenses.updateByStripeSubscription, {
                        stripeSubscriptionId,
                        status: mappedStatus,
                        currentPeriodStart: periodStart,
                        currentPeriodEnd: periodEnd,
                        trialEnd,
                    });
                }
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const stripeSubscriptionId = subscription.id as string;

                await ctx.runMutation(api.licenses.updateByStripeSubscription, {
                    stripeSubscriptionId,
                    status: 'canceled',
                });
                break;
            }

            default:
                // 未処理のイベントタイプ
                console.log(`Unhandled Stripe event: ${event.type}`);
        }
    } catch (error) {
        console.error(`Stripe webhook error: ${error}`);
        return new Response('Webhook handler error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
});
