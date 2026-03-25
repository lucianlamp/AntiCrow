<p align="center">
  <img src="https://raw.githubusercontent.com/lucianlamp/AntiCrow/main/images/ogp.png" alt="AntiCrow Banner" width="100%" />
</p>

# 🐦‍⬛ AntiCrow

![Version](https://img.shields.io/badge/version-0.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

[Website](https://anticrow.pages.dev) | [ドキュメント](https://anticrow.gitbook.io/ja) | [OpenVSX](https://open-vsx.org/extension/lucianlamp/anti-crow)

**Discord → Antigravity 自動化ブリッジ**

スマホの Discord から自然言語でメッセージを送信 → Antigravity が自動実行 → 結果が Discord に返ってくる 🚀

> 📖 [English README](README.md)

---

## ✨ 機能

- 📱 **スマホからリモート操作** — Discord 経由でどこからでも AI にタスクを依頼
- ⏰ **スケジュール実行** — cron 式で定期タスクを登録（毎日・毎週・毎時など）
- 🔄 **即時実行** — 今すぐやってほしいタスクをすぐに依頼
- 📂 **マルチワークスペース対応** — プロジェクトを Discord カテゴリに自動整理
- 📎 **ファイル添付** — 画像やドキュメントを添付して AI に分析させる
- 📊 **進捗通知** — 長時間タスクのリアルタイム進捗更新
- 📝 **プロンプトテンプレート** — よく使う指示をテンプレートとして保存、ワンタップ実行
- 🧠 **モデル・モード切替** — Discord から AI モデルや実行モードを切り替え
- 🤖 **連続オートモード** — AI が自律的にタスクを連続実行（セーフティガード付き）
- 🤝 **エージェントチームモード** — 複数の AI エージェントがタスクを並列実行
- 💾 **メモリ** — 過去の学習を自動記録・活用（グローバル / ワークスペース別）
- 🛡️ **セーフティガード** — 21パターンの危険操作検出（ファイル削除、認証情報漏洩、インジェクション攻撃）
- 🔐 **セキュリティ** — トークン暗号化保存、ユーザー ID 制限

---

## 🆓 全機能無料

AntiCrow は**完全無料・オープンソース**のプロジェクトです。すべての機能を誰でも無料で利用できます：

| 機能 | 状態 |
| --- | --- |
| Discord 経由のタスク実行 | ✅ 無制限 |
| スケジュール実行（cron） | ✅ |
| スラッシュコマンド | ✅ |
| ファイル添付・進捗通知 | ✅ |
| モデル・モード切替 | ✅ |
| テンプレート | ✅ |
| 連続オートモード | ✅ |
| エージェントチームモード | ✅ |

---

## 🔧 仕組み

AntiCrow は Discord と Antigravity の間のブリッジとして機能します。

```
📱 Discord（スマホ / PC）
    ↕ メッセージの送受信
🐦‍⬛ AntiCrow 拡張機能（あなたの PC）
    ↕ タスクの調整
🤖 Antigravity AI（あなたの PC）
```

> 🔒 **すべての処理はあなたの PC 上で完結します。** 外部サーバーへのデータ送信は一切ありません。Discord API との通信のみ行います。テレメトリや利用統計の収集もありません。

---

## 前提条件

| 項目 | 要件 |
| --- | --- |
| Antigravity | インストール済みで起動可能 |
| Node.js | 18.0.0 以上 |
| Discord アカウント | Bot 作成のため Developer Portal へのアクセスが必要 |
| Discord サーバー | 管理者権限を持つサーバー |

> 💡 完全自律動作には、Antigravity の承認ボタン（Run / Allow / Continue）を自動クリックするコンパニオン拡張機能 [pesosz/antigravity-auto-accept](https://github.com/pesosz/antigravity-auto-accept) のインストールを推奨します。

---

## セットアップガイド

### 1️⃣ Discord Bot を作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 右上の **「New Application」** をクリック → 名前を入力（例: `AntiCrow`）
3. 左メニューから **「Bot」** を選択
4. **「Reset Token」** をクリックしてトークンを取得 → **すぐに保存**（再表示不可）
5. 同じページで **Privileged Gateway Intents** を設定：
   - ✅ **MESSAGE CONTENT INTENT** — 必須（メッセージ内容の読み取り）
   - ✅ **SERVER MEMBERS INTENT** — 推奨（ユーザー情報の取得）

### 2️⃣ Bot をサーバーに招待

1. 左メニューから **「OAuth2」** を選択
2. **「URL Generator」** で設定：
   - **SCOPES**: `bot`
   - **BOT PERMISSIONS**: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Channels`, `Manage Messages`, `Attach Files`, `Embed Links`, `Use Slash Commands`, `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`
3. 生成された URL をブラウザで開く → Bot をサーバーに招待

### 3️⃣ 拡張機能をインストール

Antigravity の拡張機能マーケットプレイスで **「AntiCrow」** を検索し、**インストール** をクリック。

[OpenVSX Marketplace](https://open-vsx.org/extension/lucianlamp/anti-crow) からもインストールできます。

### 4️⃣ 初期設定

1. コマンドパレット（`Ctrl+Shift+P`）→ **「AntiCrow: Set Bot Token」** を実行 → 保存した Bot Token を入力
2. ステータスバーに **`✓ AntiCrow`** が表示されたら接続完了 🎉

> `autoStart` がデフォルトで有効なので、トークン設定後にブリッジが自動起動します。

> ⚠️ **重要:** AntiCrow を使用するには、Antigravity を専用のデスクトップショートカットから起動する必要があります。
> 初期設定後、`AntiCrow: Create Desktop Shortcut` コマンドでショートカットを作成し、常にそこから起動してください。

---

## 基本的な使い方

### 💬 自然言語でリクエスト（#agent-chat）

`#agent-chat` チャンネルにメッセージを送るだけ。AntiCrow が内容を分析し、即時実行かスケジュール登録かを自動判定します。

**即時実行:**

```
現在のプロジェクトの TODO を全てリストアップして
```

```
この画像に映っているバグを修正して
```

**スケジュール実行:**

```
毎朝9時に GitHub の通知をまとめて
```

→ cron 式に変換され、指定時刻に自動実行されます。

### ✅ 確認リアクション

実行前に確認が必要な場合：

- ✅ を押す → **承認して実行開始**
- ❌ を押す → **拒否してキャンセル**

### 📎 ファイル添付

メッセージにファイルを添付すると、AI が内容を分析してタスクに活用します。画像、テキスト、ドキュメントなど様々な形式に対応。

---

## ワークスペース連携

AntiCrow は開いている Antigravity ワークスペースを自動検出し、Discord サーバーにカテゴリを作成します。

```
📁 🔧 crypto（カテゴリ）
  └── #agent-chat
📁 🔧 web-app（カテゴリ）
  └── #agent-chat
```

カテゴリ内のチャンネルから送信されたメッセージは、対応するワークスペースで実行されます。ワークスペースの Antigravity が起動していない場合は、自動起動を試みます。

---

## 🤖 連続オートモード

AI が自律的に次のアクションを決定し、タスクを連続実行します。`/auto` コマンドで開始：

```
/auto ランディングページをリデザインして
/auto --steps 15 --confirm semi プロジェクト全体をリファクタリング
```

**オプション:** `--steps N`（1-20）、`--duration N`（5-120分）、`--confirm auto|semi|manual`、`--select auto-delegate|first|ai-select`

**セーフティガード:** ファイルシステム破壊、Git 強制操作、データベース削除、暗号鍵漏洩、プロンプトインジェクション攻撃を21パターンで検出・保護。

> 📖 [連続オートモードの詳細ドキュメント](https://anticrow.gitbook.io/ja/auto-mode)

---

## 🤝 エージェントチームモード

複数の AI サブエージェントがタスクを並列実行。大規模な変更は自動分割され、複数の AI が同時に作業します。

- 🚀 大規模タスクを自動分割して並列実行
- 💬 各サブエージェントの進捗を Discord スレッドでリアルタイム表示
- 🔄 結果を自動集約して Discord に返却

`/team` コマンドでオン・オフ切り替え。

> 📖 [エージェントチームモードの詳細ドキュメント](https://anticrow.gitbook.io/ja/team-mode)

---

## スラッシュコマンド

| コマンド | 説明 |
| --- | --- |
| `/status` | Bot・接続・キューの状態を表示 |
| `/stop` | 実行中のタスクを停止 |
| `/newchat` | Antigravity で新しいチャットを開く |
| `/workspace` | 検出されたワークスペース一覧を表示 |
| `/queue` | メッセージ処理キューの詳細を表示 |
| `/model` | AI モデルの表示・切り替え |
| `/mode` | AI モードの切り替え（Planning / Fast） |
| `/template` | プロンプトテンプレートの管理 |
| `/schedules` | スケジュール実行の表示・管理 |
| `/auto` | 連続オートモードを開始 |
| `/auto-config` | 連続オートモード設定の表示・変更 |
| `/team` | エージェントチームモードの管理 |
| `/suggest` | 提案ボタンを再表示 |
| `/screenshot` | 現在の画面をキャプチャ |
| `/soul` | カスタマイズ設定の確認・リセット |
| `/help` | 使い方ガイドを表示 |

---

## 設定リファレンス

| 設定キー | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `antiCrow.botToken` | boolean | `false` | Bot Token の設定状態（表示のみ） |
| `antiCrow.allowedUserIds` | string[] | `[]` | 許可する Discord ユーザー ID（**空 = 全拒否**） |
| `antiCrow.autoStart` | boolean | `true` | 起動時にブリッジを自動開始 |
| `antiCrow.language` | string | `ja` | UI・プロンプトの表示言語（`ja` / `en`） |
| `antiCrow.cdpPort` | number | `9000` | CDP（Chrome DevTools Protocol）ポート |
| `antiCrow.responseTimeoutMs` | number | `0` | 最終進捗更新からのアイドルタイムアウト（0 = 無制限） |
| `antiCrow.maxRetries` | number | `0` | タイムアウト時の自動リトライ回数（0 = 無効） |
| `antiCrow.categoryArchiveDays` | number | `7` | ワークスペースカテゴリの自動アーカイブ日数（0 = 無効） |
| `antiCrow.workspaceParentDirs` | string[] | `[]` | 新規ワークスペース作成時の親ディレクトリ |

---

## コマンドパレット

| コマンド | 説明 |
| --- | --- |
| `AntiCrow: Start` | Discord ブリッジを開始 |
| `AntiCrow: Stop` | Discord ブリッジを停止 |
| `AntiCrow: Set Bot Token` | Discord Bot Token を安全に保存 |
| `AntiCrow: Show Plans` | 登録済みプランを JSON で表示 |
| `AntiCrow: Clear All Plans` | すべてのプランを削除 |
| `AntiCrow: Create Desktop Shortcut` | Antigravity のデスクトップショートカットを作成 |

---

## カスタマイズ

### 🎨 AI の個性・トーン

`~/.anticrow/SOUL.md` に指示を書いて AI の振る舞いをカスタマイズ：

```markdown
# 基本スタイル
- 常に日本語で回答する
- フレンドリーで簡潔なトーンで

# コーディングスタイル
- TypeScript を使用
- ESLint ルールに従う
```

### 💾 メモリ

AntiCrow は過去のタスクから学んだ教訓を自動記録します：

| 種類 | 場所 | 用途 |
| --- | --- | --- |
| グローバルメモリ | `~/.anticrow/MEMORY.md` | プロジェクト横断の学習 |
| ワークスペースメモリ | `{workspace}/.anticrow/MEMORY.md` | プロジェクト固有の学習 |

---

## 🔒 セキュリティ

- Bot Token は Antigravity の SecretStorage に暗号化保存
- `allowedUserIds` ホワイトリストで Bot 操作者を制限
- すべての処理はローカルで実行 — 外部サーバーへのデータ送信なし
- テレメトリや利用統計の収集なし

> 📖 [セキュリティポリシー](https://anticrow.gitbook.io/ja/security) | [プライバシーポリシー](https://anticrow.gitbook.io/ja/privacy)

---

## 📖 完全なドキュメント

詳細なガイド、FAQ、トラブルシューティングなど：

- 🇯🇵 [日本語ドキュメント](https://anticrow.gitbook.io/ja)
- 🇬🇧 [English Documentation](https://anticrow.gitbook.io/en)

---

## 開発者について

AntiCrow は [@lucianlamp](https://x.com/lucianlamp) が開発・メンテナンスしています。

- **X (Twitter):** [@lucianlamp](https://x.com/lucianlamp)

---

## ⚠️ 免責事項

> **🛡️ AntiCrow の安全性**

AntiCrow 拡張機能自体には**悪意のあるコードや破壊的なコードは一切含まれていません**。API キーやシークレット情報の露出を防ぐよう設計されています。AntiCrow は Discord からの指示を Antigravity に中継するブリッジです。

> **⚠️ Antigravity 由来のリスク**

ただし、AntiCrow が接続する **Antigravity（AI コーディングエディタ）** は、AI の判断により以下のリスクを伴う操作を自律的に実行する可能性があります。**これらのリスクは AntiCrow ではなく、Antigravity AI プラットフォーム固有のものです。**

> **🔧 技術アーキテクチャ**

AntiCrow は Antigravity の OAuth キーや API キーを使用しません。**CDP（Chrome DevTools Protocol）** 経由で Antigravity エディタを直接操作します。そのため OAuth トークンの不正使用による BAN のリスクはありません。ただし、Antigravity のアップデートにより CDP ベースの操作が制限された場合、AntiCrow の一部または全部の機能が動作しなくなる可能性があります。

- **自動操作リスク** — AI 駆動の自動化により、意図しないファイルの変更や削除が発生する可能性
- **コード変更リスク** — 自動生成・編集されたコードが既存のコードベースを破壊する可能性
- **API キーの取り扱い** — API キーの露出防止を設計していますが、AI の判断によりキーが意図しない方法で使用される可能性
- **自己責任** — すべての使用は完全に**自己責任**で行ってください
- **「現状のまま」提供** — 明示・黙示を問わず、いかなる保証もありません
- **開発者免責** — 使用に起因するいかなる損害についても、開発者は責任を負いません

> 📖 [完全な免責事項](https://anticrow.gitbook.io/ja/disclaimer)

---

## 📄 ライセンス

このプロジェクトは [MIT License](LICENSE.md) の下でライセンスされています。

Copyright (c) 2026 LUCIAN (lucianlamp)
