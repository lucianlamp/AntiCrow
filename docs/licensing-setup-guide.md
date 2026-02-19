# AntiCrow ライセンス管理システム — セットアップガイド

> このガイドでは、AntiCrow の外部決済型ライセンス管理システム（Stripe + Convex + Clerk）をゼロからセットアップする手順を解説します。

---

## 目次

1. [前提条件](#1-前提条件)
2. [Stripe 設定](#2-stripe-設定)
3. [Convex 設定](#3-convex-設定)
4. [Clerk 設定](#4-clerk-設定)
5. [VSCode 拡張（AntiCrow）の設定](#5-vscode-拡張anticrowの設定)
6. [運用ガイド](#6-運用ガイド)
7. [トラブルシューティング](#7-トラブルシューティング)

---

## 1. 前提条件

### 必要なアカウント

| サービス | 用途 | URL |
|---------|------|-----|
| **Stripe** | 決済・サブスクリプション管理 | https://dashboard.stripe.com |
| **Convex** | バックエンドDB・API | https://dashboard.convex.dev |
| **Clerk** | ユーザー認証・セッション管理 | https://dashboard.clerk.com |

### 必要な環境変数

```
STRIPE_API_KEY         — Stripe の Secret Key（sk_test_... or sk_live_...）
STRIPE_WEBHOOK_SECRET  — Stripe Webhook の Signing Secret（whsec_...）
CONVEX_DEPLOY_KEY      — Convex デプロイキー
CLERK_SECRET_KEY       — Clerk のシークレットキー
```

> **注意:** API キーの実値をソースコードや設定ファイルにハードコードしないでください。Windows のユーザー環境変数に設定するか、Convex の環境変数画面で設定してください。

### 必要なツール

- Node.js v18+
- npm v9+
- Antigravity (VSCode ベース IDE)

---

## 2. Stripe 設定

### 2.1 アカウント & テストモード

1. [Stripe Dashboard](https://dashboard.stripe.com) にログイン
2. 左上のトグルで **「テストモード」** を有効にする（開発中は必ずテストモードで作業）
3. **Developers → API keys** から `Secret key` (sk_test_...) をコピー

### 2.2 Products の作成

**Developers → Products → + Add product** で3つの商品を作成:

#### Monthly（月額プラン）

| 項目 | 値 |
|------|-----|
| Name | Anti-Crow Monthly |
| Pricing model | Standard pricing |
| Price | 任意の月額（例: ¥980/month） |
| Billing period | Monthly |
| Free trial | 任意（例: 7 days） |

#### Annual（年額プラン）

| 項目 | 値 |
|------|-----|
| Name | Anti-Crow Annual |
| Pricing model | Standard pricing |
| Price | 任意の年額（例: ¥9,800/year） |
| Billing period | Yearly |
| Free trial | 任意（例: 7 days） |

#### Lifetime（買い切りプラン）

| 項目 | 値 |
|------|-----|
| Name | Anti-Crow Lifetime |
| Pricing model | Standard pricing |
| Price | 任意の一括価格（例: ¥29,800） |
| Type | **One time**（サブスクリプションではない） |

> **重要:** Checkout Session 作成時に `metadata.clerkId` を必ず含めること。Webhook ハンドラ（`convex/stripe.ts`）がこの値でユーザーを特定します。

### 2.3 Webhook エンドポイントの登録

1. **Developers → Webhooks → + Add endpoint**
2. Endpoint URL: `https://<your-convex-deployment>.convex.site/stripe/webhook`
3. 受信するイベントを選択:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 作成後、**Signing secret** (`whsec_...`) をコピー → 環境変数 `STRIPE_WEBHOOK_SECRET` に設定

### 2.4 クーポン & プロモーションコード

**Products → Coupons → + Create coupon** から作成:

#### 初月無料クーポン

| 項目 | 値 |
|------|-----|
| Type | Percentage discount |
| Discount | 100% |
| Duration | Once |
| Name | 初月無料 |

#### 期間割引クーポン

| 項目 | 値 |
|------|-----|
| Type | Percentage discount |
| Discount | 任意（例: 20%） |
| Duration | Repeating (例: 3 months) |
| Name | 期間限定割引 |

#### 100%割引コード（完全無料）

| 項目 | 値 |
|------|-----|
| Type | Percentage discount |
| Discount | 100% |
| Duration | Forever |
| Name | フルアクセスコード |

その後、**Promotion Codes** タブで各クーポンにコードを割り当て（例: `WELCOME`, `DISCOUNT20`, `FREEACCESS`）

#### Lifetime 割引コード

1. 上記と同様にクーポンを作成（Percentage or Fixed amount）
2. Promotion Code を割り当て
3. Checkout Session 作成時に `allow_promotion_codes: true` を指定

### 2.5 テストモードでの動作確認

Stripe はテストモード用のカード番号を提供しています:

| カード番号 | 結果 |
|-----------|------|
| `4242 4242 4242 4242` | 成功 |
| `4000 0000 0000 3220` | 3D Secure 認証を要求 |
| `4000 0000 0000 0002` | 拒否 |

有効期限: 未来の任意の日付、CVC: 任意の3桁

**Stripe CLI でテスト:**

```bash
# Stripe CLI をインストール
# Windows:
scoop install stripe

# Webhook をローカルに転送
stripe listen --forward-to https://<your-convex>.convex.site/stripe/webhook

# テストイベントを送信
stripe trigger checkout.session.completed
```

---

## 3. Convex 設定

### 3.1 プロジェクトの初期化

```bash
# プロジェクトルートで実行
cd c:\Users\ysk41\dev\anti-crow

# Convex を初期化（初回のみ）
npx convex dev
```

初回実行時にブラウザが開き、Convex にログインを求められます。プロジェクト名を設定してデプロイ ID を取得してください。

### 3.2 スキーマのデプロイ

`npx convex dev` を実行すると、自動的にスキーマがデプロイされます。

デプロイされるテーブル（`convex/schema.ts`）:

| テーブル | 説明 | インデックス |
|---------|------|------------|
| `users` | Clerk 認証ユーザー | `by_clerk_id`, `by_stripe_customer` |
| `licenses` | ライセンスレコード（全プランタイプ統合） | `by_user`, `by_stripe_subscription`, `by_status` |

### 3.3 環境変数の設定

**Convex Dashboard → Settings → Environment Variables** で以下を設定:

```
STRIPE_API_KEY=sk_test_xxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
```

### 3.4 HTTP エンドポイントの確認

デプロイ後、以下の HTTP エンドポイントが利用可能になります:

| パス | メソッド | 用途 |
|------|---------|------|
| `/stripe/webhook` | POST | Stripe Webhook 受信 |

デプロイメント URL は `https://<deployment-id>.convex.site` の形式です。

### 3.5 関数の確認

**Convex Dashboard → Functions** で以下の関数が登録されていることを確認:

| モジュール | 関数 | 種別 |
|-----------|------|------|
| `licenses` | `checkLicense` | Query |
| `licenses` | `listByUser` | Query |
| `licenses` | `ensureUser` | Mutation |
| `licenses` | `setStripeCustomerId` | Mutation |
| `licenses` | `createLicense` | Mutation |
| `licenses` | `updateByStripeSubscription` | Mutation |
| `admin` | `grantBetaAccess` | Mutation |
| `admin` | `revokeBetaAccess` | Mutation |
| `admin` | `listBetaUsers` | Query |
| `admin` | `expireOldBetaLicenses` | Mutation |
| `auth` | `getUser` | Query |

---

## 4. Clerk 設定

### 4.1 アプリケーション作成

1. [Clerk Dashboard](https://dashboard.clerk.com) にログイン
2. **Create application** → アプリ名を設定
3. 認証方法を選択（Email, Google, GitHub など）

### 4.2 Convex との認証プロバイダー統合

1. Clerk Dashboard → **JWT Templates** → **+ New template**
2. テンプレート名: `convex`
3. Claims に以下を設定:
   ```json
   {
     "sub": "{{user.id}}"
   }
   ```
4. Convex Dashboard → **Settings → Authentication** → **Add auth provider**
5. Clerk を選択し、Clerk の Issuer URL を貼り付け

### 4.3 ユーザーサインアップフロー

ユーザーがサインアップすると、自動的に Clerk User ID (`user_xxx...`) が発行されます。この ID が:

- Convex `users` テーブルの `clerkId` フィールドに保存される
- VSCode 拡張の License Login で入力する値になる
- Stripe Checkout の `metadata.clerkId` に渡される

---

## 5. VSCode 拡張（AntiCrow）の設定

### 5.1 Convex URL の設定

Antigravity の設定（`Ctrl+,`）で以下を設定:

```
antiCrow.convexUrl = "https://<your-deployment-id>.convex.cloud"
```

> **注意:** `.convex.cloud` ドメインを使用（`.convex.site` はHTTPエンドポイント用）

### 5.2 ライセンスコマンド

コマンドパレット（`Ctrl+Shift+P`）から以下のコマンドを利用:

| コマンド | 説明 |
|---------|------|
| `AntiCrow: License Login` | Clerk ユーザー ID を入力してログイン（SecretStorage に暗号化保存） |
| `AntiCrow: License Info` | 現在のライセンス状態を表示 |
| `AntiCrow: Purchase License` | プラン選択画面を表示し、購入ページへ遷移 |
| `AntiCrow: License Logout` | ライセンスからログアウト |

### 5.3 ステータスバー

ログイン後、ステータスバー（右下）にライセンス状態が表示されます:

| 表示 | 意味 |
|------|------|
| ✅ AntiCrow: Monthly | 月額プラン有効 |
| ✅ AntiCrow: Annual | 年額プラン有効 |
| ✅ AntiCrow: Lifetime | Lifetime プラン有効 |
| ✅ AntiCrow: Beta | ベータアクセス有効 |
| ⚠️ AntiCrow: ライセンス無効 | ライセンスなし or 期限切れ |
| 🔑 AntiCrow: 未認証 | 未ログイン |

### 5.4 ライセンスチェックの仕組み

- **自動チェック:** 5分間隔で Convex API に問い合わせ
- **キャッシュ:** 1分間のキャッシュでAPIコール削減
- **優先順位:** Lifetime > Annual > Monthly > Beta の順でアクティブなライセンスを検索
- **オフライン:** ネットワーク切断時は最後のキャッシュ値を使用

---

## 6. 運用ガイド

### 6.1 ベータアクセスの付与

Convex Dashboard → **Functions → admin:grantBetaAccess** から直接実行:

```json
{
  "clerkId": "user_xxxxxxxxxxxxxxxx",
  "grantedBy": "admin@example.com",
  "durationDays": 30
}
```

**動作:**
- 既存のベータライセンスがあれば自動的に失効させてから新規作成
- `durationDays` 日後に自動失効

### 6.2 ベータアクセスの取り消し

```json
// admin:revokeBetaAccess
{
  "clerkId": "user_xxxxxxxxxxxxxxxx"
}
```

### 6.3 ベータユーザー一覧の確認

**Functions → admin:listBetaUsers** を引数なしで実行。全ベータユーザーの情報（Clerk ID、メール、ライセンス状態、有効期限）が返されます。

### 6.4 期限切れベータの自動失効

**Functions → admin:expireOldBetaLicenses** を手動実行するか、Convex の Cron ジョブとして設定:

```typescript
// convex/crons.ts（要追加）
import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();
crons.daily("expire beta licenses", { hourUTC: 0, minuteUTC: 0 }, api.admin.expireOldBetaLicenses);
export default crons;
```

### 6.5 ライセンス状態の確認

**Functions → licenses:checkLicense** で特定ユーザーのライセンス状態を確認:

```json
{
  "clerkId": "user_xxxxxxxxxxxxxxxx"
}
```

**レスポンス例:**
```json
{
  "valid": true,
  "reason": "annual",
  "license": {
    "type": "annual",
    "status": "active",
    "currentPeriodEnd": 1735689600000
  }
}
```

---

## 7. トラブルシューティング

### ライセンスが認識されない

1. **ステータスバー確認:** 「未認証」なら `License Login` を実行
2. **Clerk ID 確認:** `user_` で始まる正しいIDを入力しているか
3. **Convex URL 確認:** `antiCrow.convexUrl` が正しく設定されているか
4. **ネットワーク確認:** Convex API にアクセスできるか
5. **Convex Dashboard:** `licenses:checkLicense` を直接実行して結果を確認

### Stripe Webhook が動かない

1. **Webhook URL:** `https://<deployment>.convex.site/stripe/webhook` が正しいか
2. **イベント選択:** 4つのイベントがすべて選択されているか
3. **Signing Secret:** 環境変数 `STRIPE_WEBHOOK_SECRET` が正しいか
4. **Stripe Dashboard → Webhooks → Recent events** でエラーログを確認
5. **Stripe CLI:** `stripe listen` でローカルテストを試す

### ベータアクセスが期限切れにならない

- `expireOldBetaLicenses` が定期実行されているか確認
- Cron ジョブを設定していない場合は手動実行するか、`convex/crons.ts` を追加

### Checkout で clerkId が渡されない

Checkout Session 作成時に必ず `metadata` を含めること:

```javascript
const session = await stripe.checkout.sessions.create({
  // ...
  metadata: {
    clerkId: user.id,  // Clerk ユーザー ID
  },
});
```

---

## アーキテクチャ図

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Stripe    │────>│   Convex    │<────│    Clerk    │
│  (決済)     │ WH  │  (Backend)  │ Auth│   (認証)    │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    HTTP API│(checkLicense)
                           │
                    ┌──────┴──────┐
                    │  AntiCrow   │
                    │ (VSCode拡張) │
                    └─────────────┘
```

**データフロー:**
1. ユーザーが Clerk でサインアップ → `user_xxx` ID を取得
2. Stripe Checkout で決済 → Webhook が Convex にイベント送信
3. Convex が `licenses` テーブルにレコード作成/更新
4. VSCode 拡張が定期的に `checkLicense` を呼び出して有効性確認
