# LP: ウェイトリスト → OpenVSX誘導への移行

## 概要

AntiCrow のランディングページ（LP）のメインCTAを、ウェイトリスト登録フォームから OpenVSX / Antigravity マーケットプレイスへのインストール誘導に変更する。

## 背景

- AntiCrow は OpenVSX に公開済み: https://open-vsx.org/extension/lucianlamp/anti-crow
- Antigravity の拡張機能マーケットプレイスからもインストール可能
- ウェイトリスト（紹介コード・順番待ち・ポイントシステム・管理画面）は完全廃止

## 設計方針

- **ミニマル差し替え**: ウェイトリスト部分のみをCTAボタンに置換、既存のビジュアル・構成は維持
- **CTAボタンはページ最下部のみ**: 免責事項（Disclaimer）の後に配置。Heroにはボタンを置かない
- **i18n（日英）維持**

## フロントエンド変更

### HeroSection.tsx
- ウェイトリストフォーム（メール入力・紹介コード・ポジション表示・シェアボタン）をすべて削除
- `?ref=` パラメータ解析ロジックを削除
- `id="waitlist"` 属性を削除
- バッジテキストを「Closed Beta Waitlist Open」→「Now Available」系に変更
- CTAボタンは配置しない（バッジ + キャッチコピーのみ）

### CTASection.tsx
- 現在の `#waitlist` リンクボタンを以下の2ボタン構成に変更:
  1. **プライマリ**: 「OpenVSXでインストール」→ `https://open-vsx.org/extension/lucianlamp/anti-crow`（外部リンク）
  2. **セカンダリ（案内表示）**: 「Antigravity 内で "AntiCrow" を検索」→ リンクなし（IDE内マーケットプレイスのため）
- `id="install"` 属性を追加（Navbarのアンカーリンク先）
- `cta.subtitle` のコピーをウェイトリスト訴求文からOpenVSX公開済みの文言に更新

### Navbar.tsx
- デスクトップ版・モバイルメニュー版の両方の「Join Waitlist」リンクを `#install`（CTASectionへのアンカー）に変更
- ラベルを「Install」に変更

### App.tsx
- `/download` ルートを削除
- `/admin` ルートを削除（存在する場合）

### i18n（en.json / ja.json）
- ウェイトリスト関連キーを削除:
  - `nav.waitlist`
  - `hero.badge`, `hero.placeholder`, `hero.submit`, `hero.successTitle`, `hero.alreadyRegistered`, `hero.invalidEmail`, `hero.referralHint`, `hero.referralApplied`, `hero.share`, `hero.shareXText`
  - `hero.loading`, `hero.successMessage`, `hero.genericError`, `hero.referralCopied`, `hero.shareText`
  - `download.*` セクション全体
- 更新するキー:
  - `hero.badge` → 新テキスト: "Now Available" / "公開中"
  - `cta.subtitle` → ウェイトリスト訴求文からOpenVSX公開済みの文言に変更
- 新規キーを追加:
  - `nav.install`
  - `cta.installOpenVSX` / `cta.searchAntigravity`

### 削除対象コンポーネント
- `AdminPage.tsx`
- `DownloadPage.tsx`
- `ManusDialog.tsx` — AdminPage からのみ使用されており、AdminPage 削除に伴い削除
- `PricingSection.tsx` — スタブ状態（中身はコメントのみ）、削除

## 削除対象ファイル

### Cloudflare Functions (API)
- `functions/api/waitlist/register.ts`
- `functions/api/waitlist/status.ts`
- `functions/api/validate-code.ts`
- `functions/api/validate-license.ts`
- `functions/api/download/[token].ts`
- `functions/api/stripe-webhook.ts`
- `functions/api/latest.ts`
- `functions/api/admin/users.ts`
- `functions/api/admin/invite.ts`
- `functions/api/admin/stats.ts`
- `functions/api/admin/notify-update.ts`
- `functions/api/admin/promo-codes.ts`
- `functions/api/admin/releases.ts`
- `functions/api/admin/_middleware.ts`
- `functions/functions/api/` — 二重ネストの重複ディレクトリ（存在する場合は丸ごと削除）

### その他
- `admin.html`
- `schema.sql`

## wrangler.toml
- D1 Database `anticrow-waitlist` バインディングを削除
- D1 Database `anticrow-purchases` バインディングを削除（ダウンロード/購入フローが廃止のため）
- R2 Bucket `anticrow-releases` バインディングを削除（拡張機能の配布はOpenVSXに移行済み）

## リダイレクト
- `_redirects` ファイルを作成し、`/download` → `/` への301リダイレクトを設定
- 既存の `?ref=` パラメータ付きURLは無視される（パラメータが残っても問題なくトップページが表示される）

## 変更しないファイル
- `FeaturesSection.tsx`
- `SecuritySection.tsx`
- `FAQSection.tsx`
- `DisclaimerSection.tsx`
- `Footer.tsx`
- `ParticleField.tsx`
- `Map.tsx`

## スコープ外
- デザインの刷新・新機能追加は行わない
- 既存のビジュアル・アニメーションはそのまま維持
