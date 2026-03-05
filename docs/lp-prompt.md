# AntiCrow Landing Page Prompt Specification

AntiCrow のランディングページを日英対応で作成してください。

## 製品概要

AntiCrow は Discord から AI コーディングアシスタント Antigravity を遠隔操作できるブリッジ拡張機能です。スマホの Discord から自然言語でメッセージを送るだけで、PC 上の Antigravity が自動でタスクを実行し、結果を Discord に返します。

## ターゲットユーザー

- Antigravity ユーザーで、外出先からも AI にタスクを依頼したい開発者
- 定期的なタスク自動化をしたい個人開発者
- チームで複数プロジェクトを並行管理している開発者

## 技術スタック

- Vite + React + TypeScript
- Tailwind CSS v4（`@import "tailwindcss"` 構文）
- i18n は react-i18next で日英切替
- 1ページ完結の SPA（ルーティング不要）
- デプロイ先: Cloudflare Pages（静的サイト）

## デザイン要件

- ダークテーマベース（背景: #0a0a0f〜#111827 系のグラデーション）
- アクセントカラー: パープル〜バイオレット系（#7c3aed, #a855f7）
- グラスモーフィズムのカード UI
- スクロール連動のフェードイン・スライドインアニメーション（Intersection Observer）
- レスポンシブ対応（モバイルファースト）
- Google Fonts: Inter（本文）+ JetBrains Mono（コード）
- ヘッダーに日本語/English 切替トグル

## セクション構成と具体的なコンテンツ

### 1. Header（固定ヘッダー）

- ロゴ: 🐦‍⬛ AntiCrow
- ナビ: Features / How It Works / Pricing / FAQ
- 右端: 言語切替トグル（🇯🇵/🇬🇧）
- スクロールで背景にブラー効果

### 2. Hero セクション

- メインコピー（英語）: "Control Your AI from Anywhere"
- メインコピー（日本語）: "どこからでも AI を操作する"
- サブコピー（英語）: "Send a message on Discord → AI codes on your PC → Results delivered back to Discord"
- サブコピー（日本語）: "Discord でメッセージを送る → PC の AI がコーディング → 結果が Discord に届く"
- CTA ボタン: "Get Started" / "始める"（ダウンロードページへ）
- 背景にターミナル風のタイピングアニメーション（Discord メッセージ → AntiCrow → Antigravity のフロー）

### 3. Features セクション（6つのカード）

カードは 3x2 グリッド（モバイルは 1 列）

| # | アイコン | 英語タイトル | 日本語タイトル | 英語説明 | 日本語説明 |
|---|---|---|---|---|---|
| 1 | 📱 | Remote Control | スマホから遠隔操作 | Send tasks to AI from your phone via Discord, anywhere, anytime | 外出先でも Discord からタスクを依頼できる |
| 2 | ⏰ | Scheduled Tasks | 定期実行 | Automate recurring tasks with cron expressions | cron 式で毎日・毎週の自動タスクを登録 |
| 3 | 🤝 | Agent Team Mode | チームモード | Multiple AI agents work in parallel for faster results (Pro) | 複数 AI が並列でタスクを高速実行（Pro） |
| 4 | ⚡ | Auto Accept | 自動承認 | Automatically approves AI actions during remote execution (Pro) | 遠隔実行中の確認ダイアログを自動クリック（Pro） |
| 5 | 💾 | Memory | メモリー | AI remembers past lessons and applies them to future tasks | 過去の学びを記憶して次のタスクに活かす |
| 6 | 📂 | Multi-Workspace | 複数WS対応 | Manage multiple projects with automatic Discord channels | プロジェクトごとに Discord チャンネルを自動作成 |

### 4. How It Works セクション（3ステップ）

ステップカードを横並び（モバイルは縦）で、番号付きで表示。
カード間に矢印（→）のアニメーション。

1. **Send a message** / **メッセージを送る**
   - 英語: Type your request in Discord — on your phone, tablet, or PC
   - 日本語: Discord に依頼を入力 — スマホ、タブレット、PC どこからでも
   - アイコン: 💬

2. **AI executes** / **AI が実行**
   - 英語: AntiCrow bridges your request to Antigravity on your PC
   - 日本語: AntiCrow が PC 上の Antigravity にタスクを橋渡し
   - アイコン: 🤖

3. **Get results** / **結果を受け取る**
   - 英語: Results are sent back to Discord with real-time progress updates
   - 日本語: リアルタイムの進捗通知と共に結果が Discord に届く
   - アイコン: ✅

### 5. Pricing セクション（2つのプランカード）

**Free プラン:**

- 価格: $0
- タスク実行: 日10回 / 週50回
- 定期実行 ✅
- スラッシュコマンド ✅
- テンプレート ✅
- メモリー ✅
- 自動承認 ❌
- チームモード ❌

**Pro プラン:**

- 価格: 要問い合わせ（Coming Soon）
- タスク実行: 無制限
- 全機能 ✅
- 14日間無料トライアル
- Pro カードはアクセントカラーのボーダーでハイライト
- "Start Free Trial" / "無料トライアル開始" ボタン

### 6. Security セクション（信頼性訴求）

- 🔒 すべての処理は PC 上で完結。外部サーバーにデータ送信なし
- 🔐 Bot Token は暗号化保存（SecretStorage）
- 🛡️ ユーザー ID ベースのアクセス制御
- テレメトリ・使用統計の収集なし

### 7. FAQ セクション（アコーディオン）

以下の QA をアコーディオンで表示:

- Q: 外出先からも使える？ / Can I use it while away?
  A: Discord さえ使えればどこからでも。PC がオンラインであれば OK
- Q: Bot Token は安全？ / Is my Bot Token secure?
  A: SecretStorage で暗号化保存。設定ファイルに平文記録されない
- Q: 複数プロジェクトを同時に管理できる？ / Can I manage multiple projects?
  A: 自動で Discord カテゴリーが作られ、プロジェクトごとに独立管理
- Q: Pro トライアルはある？ / Is there a Pro trial?
  A: 14日間無料でお試し可能

### 8. CTA セクション（ページ下部）

- "Ready to code from anywhere?" / "どこからでもコーディングする準備はできた？"
- "Get AntiCrow" / "AntiCrow を入手" ボタン
- 背景にグラデーションメッシュ

### 9. Footer

- © 2026 AntiCrow by @lucianlamp
- リンク: GitHub / X (Twitter) / SECURITY.md / PRIVACY.md
- "Made with ❤️ by LUCIAN"

## i18n 実装仕様

- react-i18next でファイルベース翻訳（src/i18n/en.json, src/i18n/ja.json）
- ヘッダーのトグルで切替、localStorage に保存
- デフォルト言語: ブラウザの navigator.language で自動判定（ja なら日本語、それ以外は英語）
- すべてのテキストを翻訳キーで管理（ハードコードしない）

## その他の要件

- OGP メタタグ（Twitter Card 対応）
- favicon: 🐦‍⬛ の絵文字ベース
- Lighthouse スコア 90+ を目指すパフォーマンス最適化
- アニメーションは prefers-reduced-motion を尊重
