#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// scripts/setup-licensing.ts
// ライセンス管理システムの全セットアップを1コマンドで実行する自動化スクリプト
//
// 使い方:
//   npx tsx scripts/setup-licensing.ts
//
// 前提:
//   - Stripe CLI がインストール済み & ログイン済み（stripe login）
//   - STRIPE_API_KEY 環境変数が設定済み（テストモードの sk_test_...）
//   - CONVEX_TEAM_TOKEN 環境変数が設定済み
//   - Node.js 18+ がインストール済み
// ---------------------------------------------------------------------------

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// =====================================================================
// ユーティリティ
// =====================================================================

const ROOT = path.resolve(__dirname, '..');

function run(cmd: string, options?: { cwd?: string; silent?: boolean }): string {
    const cwd = options?.cwd ?? ROOT;
    const silent = options?.silent ?? false;
    if (!silent) console.log(`\n🔧 $ ${cmd}`);
    try {
        const result = execSync(cmd, { cwd, encoding: 'utf-8', stdio: silent ? 'pipe' : 'inherit' });
        return typeof result === 'string' ? result.trim() : '';
    } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string };
        console.error(`❌ コマンド失敗: ${cmd}`);
        if (err.stderr) console.error(err.stderr);
        throw e;
    }
}

function runCapture(cmd: string): string {
    console.log(`\n🔍 $ ${cmd}`);
    const result = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    return result.trim();
}

function requireEnv(name: string): string {
    const val = process.env[name];
    if (!val) {
        console.error(`❌ 環境変数 ${name} が設定されていません。`);
        console.error(`   Windows: [システム] → [環境変数] で設定してください。`);
        process.exit(1);
    }
    return val;
}

function heading(text: string): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${text}`);
    console.log(`${'='.repeat(60)}`);
}

// =====================================================================
// 設定値（必要に応じて変更）
// =====================================================================

const CONFIG = {
    // Stripe Products
    products: {
        monthly: { name: 'Anti-Crow Monthly', price: 980, currency: 'jpy', interval: 'month' },
        annual: { name: 'Anti-Crow Annual', price: 9800, currency: 'jpy', interval: 'year' },
        lifetime: { name: 'Anti-Crow Lifetime', price: 29800, currency: 'jpy' },
    },
    // クーポン
    coupons: [
        { name: 'WELCOME_FREE', percentOff: 100, duration: 'once' },
        { name: 'DISCOUNT_20', percentOff: 20, duration: 'repeating', durationInMonths: 3 },
    ],
    // Convex
    convex: {
        projectName: 'anti-crow',
    },
};

// =====================================================================
// Step 1: 環境変数チェック
// =====================================================================

function step1_checkEnv(): void {
    heading('Step 1: 環境変数チェック');

    const stripeKey = requireEnv('STRIPE_API_KEY');
    console.log(`  ✅ STRIPE_API_KEY: ${stripeKey.substring(0, 12)}...`);

    // CONVEX_TEAM_TOKEN は任意（Convex CLI がブラウザ認証も使える）
    const convexToken = process.env['CONVEX_TEAM_TOKEN'];
    if (convexToken) {
        console.log(`  ✅ CONVEX_TEAM_TOKEN: ${convexToken.substring(0, 12)}...`);
    } else {
        console.log(`  ⚠️ CONVEX_TEAM_TOKEN: 未設定（ブラウザ認証を使用）`);
    }

    // Stripe CLI 確認
    try {
        runCapture('stripe --version');
        console.log('  ✅ Stripe CLI: インストール済み');
    } catch {
        console.error('  ❌ Stripe CLI が見つかりません。');
        console.error('     Windows: winget install Stripe.StripeCli');
        process.exit(1);
    }

    // Convex CLI 確認
    try {
        runCapture('npx convex --version');
        console.log('  ✅ Convex CLI: インストール済み');
    } catch {
        console.error('  ❌ Convex CLI が見つかりません。');
        process.exit(1);
    }
}

// =====================================================================
// Step 2: Stripe Products/Prices/Coupons 作成
// =====================================================================

interface StripeResult {
    monthlyPriceId: string;
    annualPriceId: string;
    lifetimePriceId: string;
    webhookSecret: string;
}

function step2_setupStripe(convexSiteUrl: string): StripeResult {
    heading('Step 2: Stripe 設定');

    const result: Partial<StripeResult> = {};

    // Monthly Product + Price
    console.log('\n📦 Monthly Product 作成...');
    const monthlyProduct = JSON.parse(
        runCapture(`stripe products create --name="${CONFIG.products.monthly.name}" -d "metadata[plan]=monthly" --format=json`),
    );
    const monthlyPrice = JSON.parse(
        runCapture(
            `stripe prices create --product="${monthlyProduct.id}" --unit-amount=${CONFIG.products.monthly.price} --currency=${CONFIG.products.monthly.currency} -d "recurring[interval]=${CONFIG.products.monthly.interval}" --format=json`,
        ),
    );
    result.monthlyPriceId = monthlyPrice.id;
    console.log(`  ✅ Monthly: ${monthlyProduct.id} / Price: ${monthlyPrice.id}`);

    // Annual Product + Price
    console.log('\n📦 Annual Product 作成...');
    const annualProduct = JSON.parse(
        runCapture(`stripe products create --name="${CONFIG.products.annual.name}" -d "metadata[plan]=annual" --format=json`),
    );
    const annualPrice = JSON.parse(
        runCapture(
            `stripe prices create --product="${annualProduct.id}" --unit-amount=${CONFIG.products.annual.price} --currency=${CONFIG.products.annual.currency} -d "recurring[interval]=${CONFIG.products.annual.interval}" --format=json`,
        ),
    );
    result.annualPriceId = annualPrice.id;
    console.log(`  ✅ Annual: ${annualProduct.id} / Price: ${annualPrice.id}`);

    // Lifetime Product + Price
    console.log('\n📦 Lifetime Product 作成...');
    const lifetimeProduct = JSON.parse(
        runCapture(`stripe products create --name="${CONFIG.products.lifetime.name}" -d "metadata[plan]=lifetime" --format=json`),
    );
    const lifetimePrice = JSON.parse(
        runCapture(
            `stripe prices create --product="${lifetimeProduct.id}" --unit-amount=${CONFIG.products.lifetime.price} --currency=${CONFIG.products.lifetime.currency} --format=json`,
        ),
    );
    result.lifetimePriceId = lifetimePrice.id;
    console.log(`  ✅ Lifetime: ${lifetimeProduct.id} / Price: ${lifetimePrice.id}`);

    // Webhook エンドポイント作成
    console.log('\n🔗 Webhook エンドポイント作成...');
    const webhookUrl = `${convexSiteUrl}/stripe/webhook`;
    const webhook = JSON.parse(
        runCapture(
            `stripe webhook_endpoints create --url="${webhookUrl}" -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" --format=json`,
        ),
    );
    result.webhookSecret = webhook.secret;
    console.log(`  ✅ Webhook: ${webhook.id}`);
    console.log(`  📋 Webhook URL: ${webhookUrl}`);
    console.log(`  🔑 Webhook Secret: ${webhook.secret}`);

    // クーポン作成
    console.log('\n🎟️ クーポン作成...');
    for (const coupon of CONFIG.coupons) {
        const args = [
            `stripe coupons create`,
            `--name="${coupon.name}"`,
            `--percent-off=${coupon.percentOff}`,
            `--duration=${coupon.duration}`,
        ];
        if (coupon.duration === 'repeating' && coupon.durationInMonths) {
            args.push(`--duration-in-months=${coupon.durationInMonths}`);
        }
        args.push('--format=json');

        const created = JSON.parse(runCapture(args.join(' ')));
        console.log(`  ✅ クーポン "${coupon.name}": ${created.id}`);

        // プロモーションコード作成
        const promoCode = JSON.parse(
            runCapture(`stripe promotion_codes create --coupon="${created.id}" --code="${coupon.name}" --format=json`),
        );
        console.log(`  ✅ プロモーションコード: ${promoCode.code}`);
    }

    return result as StripeResult;
}

// =====================================================================
// Step 3: Convex プロジェクト初期化・デプロイ
// =====================================================================

interface ConvexResult {
    deploymentUrl: string;
    siteUrl: string;
}

function step3_setupConvex(stripeWebhookSecret: string): ConvexResult {
    heading('Step 3: Convex 設定');

    // convex.json が存在するか確認
    const convexJsonPath = path.join(ROOT, 'convex.json');
    const hasConvexJson = fs.existsSync(convexJsonPath);

    if (!hasConvexJson) {
        console.log('\n📁 Convex プロジェクト初期化...');
        // 非対話モードでデプロイ（CONVEX_TEAM_TOKEN が必要）
        run('npx convex deploy --cmd="echo done"');
    } else {
        console.log('\n📁 既存の Convex プロジェクトを使用');
    }

    // スキーマと関数のデプロイ
    console.log('\n🚀 Convex スキーマ & 関数デプロイ...');
    run('npx convex deploy --cmd="echo done"');

    // デプロイメント URL を取得
    console.log('\n🔗 デプロイメント URL 取得...');
    let deploymentUrl = '';
    let siteUrl = '';

    // convex.json からプロジェクト情報を読む
    if (fs.existsSync(convexJsonPath)) {
        const convexJson = JSON.parse(fs.readFileSync(convexJsonPath, 'utf-8'));
        const project = convexJson.project;
        const team = convexJson.team;
        if (project) {
            // Convex URL の規則: https://<adjective-animal-123>.convex.cloud
            console.log(`  📋 Project: ${project}, Team: ${team}`);
        }
    }

    // convex deployment list から URL を取得する試み
    try {
        const output = runCapture('npx convex deployment list --format=json 2>&1');
        const deployments = JSON.parse(output);
        if (Array.isArray(deployments) && deployments.length > 0) {
            const prod = deployments.find((d: { kind: string }) => d.kind === 'prod') ?? deployments[0];
            deploymentUrl = prod.url || '';
            siteUrl = deploymentUrl.replace('.convex.cloud', '.convex.site');
        }
    } catch {
        console.log('  ⚠️ デプロイメント URL の自動取得に失敗。手動で確認してください。');
        console.log('     Convex Dashboard → Settings → URL をコピー');
    }

    // 環境変数を Convex に設定
    const stripeApiKey = process.env['STRIPE_API_KEY'] || '';
    if (stripeApiKey) {
        console.log('\n🔐 Convex 環境変数設定...');
        try {
            run(`npx convex env set STRIPE_API_KEY "${stripeApiKey}"`);
            console.log('  ✅ STRIPE_API_KEY を Convex に設定');
        } catch {
            console.log('  ⚠️ STRIPE_API_KEY の設定に失敗。手動で設定してください。');
        }

        if (stripeWebhookSecret) {
            try {
                run(`npx convex env set STRIPE_WEBHOOK_SECRET "${stripeWebhookSecret}"`);
                console.log('  ✅ STRIPE_WEBHOOK_SECRET を Convex に設定');
            } catch {
                console.log('  ⚠️ STRIPE_WEBHOOK_SECRET の設定に失敗。手動で設定してください。');
            }
        }
    }

    return { deploymentUrl, siteUrl };
}

// =====================================================================
// Step 4: VSCode 拡張の設定
// =====================================================================

function step4_configureVSCode(convexUrl: string): void {
    heading('Step 4: VSCode 拡張設定');

    if (!convexUrl) {
        console.log('  ⚠️ Convex URL が取得できなかったため、手動で設定してください。');
        console.log('     Settings → antiCrow.convexUrl に Convex デプロイメント URL を設定');
        return;
    }

    // .vscode/settings.json に書き込み
    const vscodeDir = path.join(ROOT, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    const settingsPath = path.join(vscodeDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
            settings = {};
        }
    }

    settings['antiCrow.convexUrl'] = convexUrl;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
    console.log(`  ✅ antiCrow.convexUrl = "${convexUrl}"`);
    console.log(`  📁 ${settingsPath}`);
}

// =====================================================================
// Step 5: 設定サマリーファイル出力
// =====================================================================

function step5_writeSummary(stripe: StripeResult, convex: ConvexResult): void {
    heading('Step 5: 設定サマリー保存');

    const summary = {
        createdAt: new Date().toISOString(),
        stripe: {
            monthlyPriceId: stripe.monthlyPriceId,
            annualPriceId: stripe.annualPriceId,
            lifetimePriceId: stripe.lifetimePriceId,
            webhookSecret: '***REDACTED***',
        },
        convex: {
            deploymentUrl: convex.deploymentUrl,
            siteUrl: convex.siteUrl,
        },
    };

    const summaryPath = path.join(ROOT, '.licensing-setup.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
    console.log(`  ✅ 設定サマリーを保存: ${summaryPath}`);
    console.log(`  ⚠️ このファイルには機密情報は含まれていません（Webhook Secret はマスク済み）`);
}

// =====================================================================
// メイン実行
// =====================================================================

async function main(): Promise<void> {
    console.log('🚀 Anti-Crow ライセンス管理セットアップ開始！\n');

    // Step 1: 環境チェック
    step1_checkEnv();

    // Step 3 を先に（Convex URL が Stripe Webhook に必要）
    // まず仮デプロイしてURLを取得
    const convexResult = step3_setupConvex('');

    if (!convexResult.siteUrl) {
        console.error('\n❌ Convex Site URL の取得に失敗しました。');
        console.error('   手動で Convex Dashboard から URL を確認し、');
        console.error('   以下の環境変数を設定した上で再実行してください:');
        console.error('   CONVEX_SITE_URL=https://xxx.convex.site');
        process.exit(1);
    }

    // Step 2: Stripe 設定（Convex Site URL を使用）
    const stripeResult = step2_setupStripe(convexResult.siteUrl);

    // Webhook Secret を Convex に設定
    if (stripeResult.webhookSecret) {
        console.log('\n🔐 Webhook Secret を Convex に再設定...');
        try {
            run(`npx convex env set STRIPE_WEBHOOK_SECRET "${stripeResult.webhookSecret}"`);
        } catch {
            console.log('  ⚠️ 手動で設定してください。');
        }
    }

    // Step 4: VSCode 設定
    step4_configureVSCode(convexResult.deploymentUrl);

    // Step 5: サマリー
    step5_writeSummary(stripeResult, convexResult);

    heading('🎉 セットアップ完了！');
    console.log(`
  次のステップ:
  1. Stripe CLI でログイン: stripe login（まだの場合）
  2. VSCode で License Login コマンドを実行
  3. テスト決済を試す

  設定値:
  - Monthly Price ID:  ${stripeResult.monthlyPriceId}
  - Annual Price ID:   ${stripeResult.annualPriceId}
  - Lifetime Price ID: ${stripeResult.lifetimePriceId}
  - Convex URL:        ${convexResult.deploymentUrl}
  - Convex Site URL:   ${convexResult.siteUrl}
    `);
}

main().catch((e) => {
    console.error('\n💥 セットアップ中にエラーが発生しました:', e);
    process.exit(1);
});
