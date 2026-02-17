# AntiCrow

スマホのDiscordから自然文で依頼 → VS Code拡張がAntigravityを自動操作 → 結果をDiscordに返す。

## 仕組み

```
Discord(自然文) → VS Code拡張 → CDP → Antigravity → CDP → VS Code拡張 → Discord(結果)
```

拡張一本で完結。外部プロセス不要。

## セットアップ

### 1. 前提

- **VS Code** 1.90+
- **Node.js** 16.11+（VS Code組込みで通常OK）
- **Antigravity** を `--remote-debugging-port=9333` で起動

```powershell
# Antigravity起動例（Windows）
& "C:\Users\<username>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Antigravity\Antigravity.lnk" --remote-debugging-port=9333
```

### 2. Discord Bot作成

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot → **Reset Token** でトークン取得（控えておく）
3. **Privileged Gateway Intents** で以下を有効化:
   - MESSAGE CONTENT Intent ✅
   - SERVER MEMBERS Intent ✅ （任意）
4. OAuth2 → bot スコープ + Send Messages, Read Message History, Add Reactions 権限でURLを生成
5. 生成URLでBotを自分のサーバーに招待

### 3. Discordサーバー準備

以下のチャンネルを作成:

| チャンネル名 | 用途 |
|---|---|
| `schedule` | 定期登録（毎日/毎週/平日など） |
| `run` | 単発の即時実行 |
| `inbox` | どちらでも受ける |
| `logs` | 通知のみ（入力は無視） |
| `admin` | 状態確認・管理 |

### 4. 拡張インストール

```powershell
cd anti-crow
npm install
npm run bundle
```

VS Codeで「拡張機能をフォルダからインストール」→ このフォルダを選択。

または開発モード:
```powershell
# VS Codeでこのフォルダを開いて F5 で起動
```

### 5. 初回設定

1. コマンドパレット → **AntiCrow: Set Bot Token** → トークン入力
2. コマンドパレット → **AntiCrow: Start**
3. ステータスバーに `✓ AntiCrow` が表示されれば稼働中

## 設定 (settings.json)

```json
{
  "antiCrow.cdpPort": 9333,
  "antiCrow.watchChannels": {
    "schedule": "schedule",
    "run": "run",
    "inbox": "inbox",
    "admin": "admin"
  },
  "antiCrow.logsChannel": "logs",
  "antiCrow.timezone": "Asia/Tokyo",
  "antiCrow.cdpResponseTimeoutMs": 300000,
  "antiCrow.autoStart": false
}
```

## 使い方

### 即時実行 (#run)
```
今のプロジェクトのTODOを一覧にして
```

### 定期登録 (#schedule)
```
毎朝9時にGitHubの通知をまとめて
```
→ 確認が必要な場合は ✅/❌ リアクションで回答

### 管理 (#admin)
```
状態確認
計画一覧
停止 <plan_id>
```

## VS Code コマンド一覧

| コマンド | 説明 |
|---|---|
| `Start` | Bridge起動 |
| `Stop` | Bridge停止 |
| `Set Bot Token` | Discordトークン保存 |
| `Show Plans` | 全計画をエディタ表示 |
| `Clear All Plans` | 全計画削除 |

## トラブルシューティング

### Botがオフラインのまま
- トークンが正しいか確認（Set Bot Token で再入力）
- MESSAGE CONTENT Intentが有効か確認

### CDPに接続できない
- Antigravityが `--remote-debugging-port=9333` で起動しているか確認
- `http://127.0.0.1:9333/json` にブラウザでアクセスして応答があるか確認

### メッセージが無視される
- チャンネル名が設定の `watchChannels` に含まれているか確認
- `logs` チャンネルへの入力は仕様上無視されます

### 長時間応答がない
- `cdpResponseTimeoutMs` を増やす（デフォルト5分）
- Output Channel「AntiCrow」でログを確認

## アーキテクチャ

```
extension.ts       全モジュールの配線・VS Codeライフサイクル
├── discordBot.ts   Discord Gateway接続・チャンネルルーティング
├── cdpBridge.ts    CDP WebSocket接続・プロンプト送信・回答検出
├── scheduler.ts    node-cron CRONスケジューラ (JST)
├── planStore.ts    JSON永続化 (globalStorageUri)
├── executor.ts     直列実行キュー
├── planParser.ts   Skill JSON解析・バリデーション
├── discordFormatter.ts  2000文字分割・ファイル添付
├── types.ts        共通型定義
└── logger.ts       OutputChannelロガー
```

## ライセンス

MIT
