# 🐦‍⬛ AntiCrow

**Discord → Antigravity 自動操作ブリッジ**

スマホの Discord から自然文で依頼 → Antigravity が自動実行 → 結果を Discord に返す 🚀

## ✨ 特徴

- 📱 **スマホから遠隔操作** — 外出先からでも Discord 経由で AI にタスクを依頼
- ⏰ **定期実行** — cron 式で毎日・毎週など自動タスク登録
- 📂 **複数ワークスペース対応** — プロジェクトごとに Discord カテゴリーで自動振り分け
- 📎 **ファイル添付対応** — 画像やドキュメントを AI に分析させる
- 📊 **進捗通知** — 長時間タスクの進捗をリアルタイム表示
- 🛡️ **セキュリティ** — Token 暗号化保存、ユーザー ID 制限

> 📖 **[詳しいユーザーガイドはこちら →](docs/user-guide.md)**

---

## クイックスタート

### 前提条件

- **Antigravity** インストール済み
- **Discord Bot** （[作成手順はユーザーガイド参照](docs/user-guide.md#1️⃣-discord-bot-を作成する)）

> ⚠️ **重要:** AntiCrow は専用のデスクトップショートカットから Antigravity を起動する必要があります。
> 初回セットアップ後、`AntiCrow: Create Desktop Shortcut` コマンドでショートカットを作成し、以降はそのショートカットから起動してください。

### インストール

1. `.vsix` ファイルを入手
2. Antigravity でコマンドパレット（`Ctrl+Shift+P`）→ **Extensions: Install from VSIX...** を選択
3. `.vsix` ファイルを指定してインストール

### 初回設定

1. コマンドパレット（`Ctrl+Shift+P`）→ **AntiCrow: Set Bot Token** → トークン入力
2. ステータスバーに **`✓ AntiCrow`** が表示されれば起動完了 🎉

> 自動起動（`autoStart`）がデフォルトで有効なため、トークン設定後に自動的にブリッジが起動します。

> 📖 **[セットアップの詳細はユーザーガイドを参照](docs/user-guide.md#セットアップ手順)**

---

## 使い方

### 💬 即時実行

Discord の `#agent-chat` チャンネルにメッセージを送るだけ:

```
今のプロジェクトの TODO を一覧にして
```

### ⏰ 定期登録

```
毎朝9時に GitHub の通知をまとめて
```

→ 確認が必要な場合は ✅/❌ リアクションで回答

### 🎮 スラッシュコマンド

| コマンド | 説明 |
| --- | --- |
| `/schedule` | cron 式で定期実行を登録 |
| `/status` | Bridge の接続状態表示 |
| `/schedules` | スケジュール管理パネル（ボタン操作） |
| `/reset` | 処理中リクエストの強制リセット |
| `/newchat` | 新しいチャットを開く |
| `/workspaces` | ワークスペース一覧表示 |

> 📖 **[使い方の詳細はユーザーガイドを参照](docs/user-guide.md#基本的な使い方)**

---

## 設定項目

| 設定キー | デフォルト | 説明 |
| --- | --- | --- |
| `antiCrow.botToken` | — | Bot Token（`Set Bot Token` コマンドで設定） |
| `antiCrow.timezone` | `Asia/Tokyo` | CRON 実行のタイムゾーン |
| `antiCrow.responseTimeoutMs` | `300000` | 応答タイムアウト（ms） |
| `antiCrow.autoStart` | `true` | 起動時に自動でブリッジ開始 |
| `antiCrow.clientId` | `""` | Discord Client ID（スラッシュコマンド用） |
| `antiCrow.workspacePaths` | `{}` | ワークスペース名→パスの対応表 |
| `antiCrow.categoryArchiveDays` | `7` | カテゴリー自動アーカイブ日数 |
| `antiCrow.allowedUserIds` | `[]` | 許可ユーザーID（空=全員） |
| `antiCrow.maxMessageLength` | `6000` | 最大メッセージ文字数 |

> 📖 **[設定の詳細はユーザーガイドを参照](docs/user-guide.md#設定項目リファレンス)**

---

## コマンド一覧

| コマンド | 説明 |
| --- | --- |
| `AntiCrow: Start` | Bridge 起動 |
| `AntiCrow: Stop` | Bridge 停止 |
| `AntiCrow: Set Bot Token` | Discord Token 保存（暗号化） |
| `AntiCrow: Show Plans` | 全計画をエディタ表示 |
| `AntiCrow: Clear All Plans` | 全計画削除 |
| `AntiCrow: Create Desktop Shortcut` | デスクトップショートカット作成 |

---

## カスタマイズ

`~/.anticrow/ANTICROW.md` に AI の性格・口調を記述すると、すべての応答スタイルをカスタマイズできます。
このファイルはデフォルトでは空です。必要に応じて以下のように記述してください：

```markdown
# 基本スタイル
- 常に日本語で回答してください
- フレンドリーで簡潔な口調で話してください
- 絵文字を適度に使ってください
```

> 📖 **[カスタマイズの詳細はユーザーガイドを参照](docs/user-guide.md#カスタマイズ)**

---

## トラブルシューティング

| 問題 | 解決策 |
| --- | --- |
| Bot がオフラインのまま | Token 再入力 / MESSAGE CONTENT Intent を有効化 |
| Antigravity に接続できない | Antigravity が起動しているか確認 |
| メッセージが無視される | チャンネル名が `agent-chat` か確認 / `allowedUserIds` を確認 |
| 長時間応答がない | `responseTimeoutMs` を増やす / `/reset` で強制リセット |

> 📖 **[トラブルシューティングの詳細はユーザーガイドを参照](docs/user-guide.md#トラブルシューティング)**

---

## ライセンス

MIT
