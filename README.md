# 🐦‍⬛ AntiCrow

**Discord → Antigravity 自動操作ブリッジ**

スマホの Discord から自然文で依頼 → Antigravity が自動実行 → 結果を Discord に返す 🚀

## ✨ 特徴

- 📱 **スマホから遠隔操作** — 外出先からでも Discord 経由で AI にタスクを依頼
- ⏰ **定期実行** — cron 式で毎日・毎週・毎時など自動タスク登録
- 🔄 **即時実行** — 今すぐやってほしいことをサッと依頼
- 📂 **複数ワークスペース対応** — プロジェクトごとに Discord カテゴリーで自動振り分け
- 📎 **ファイル添付対応** — 画像やドキュメントを AI に分析させる
- 📊 **進捗通知** — 長時間タスクの進捗をリアルタイム表示
- 📝 **プロンプトテンプレート** — よく使う指示をテンプレート化してワンタップで実行
- 🧠 **モデル・モード切替** — AI モデルや実行モードを Discord から切り替え
- 🛡️ **セキュリティ** — Token 暗号化保存、ユーザー ID 制限

---

## 🔧 仕組み

AntiCrow は Discord と Antigravity の間のブリッジとして機能します。

```
📱 Discord（スマホ/PC）
    ↕ メッセージ送受信
🐦‍⬛ AntiCrow 拡張機能（あなたの PC）
    ↕ タスク連携
🤖 Antigravity AI（あなたの PC）
```

> 🔒 **すべての処理はあなたの PC 上で完結します。** 外部サーバーへのデータ送信は一切ありません。Discord API との通信のみを行います。テレメトリや使用統計の収集も行いません。

詳細は SECURITY.md と PRIVACY.md をご覧ください。

---

## 前提条件

| 項目 | 要件 |
| --- | --- |
| Antigravity | インストール済み・起動可能 |
| Node.js | 16.11 以上 |
| Discord アカウント | Bot 作成用に Developer Portal アクセスが必要 |
| Discord サーバー | 自分が管理権限を持つサーバー |

---

## セットアップ手順

### 1️⃣ Discord Bot を作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 右上の **「New Application」** をクリック → 名前を入力（例: `AntiCrow`）
3. 左メニューの **「Bot」** を選択
4. **「Reset Token」** をクリックしてトークンを取得 → **必ず控えておいてください**（再表示できません）
5. 同じ画面で **Privileged Gateway Intents** を設定:
   - ✅ **MESSAGE CONTENT INTENT** — 必須（メッセージ内容を読むため）
   - ✅ **SERVER MEMBERS INTENT** — 推奨（ユーザー情報の取得に使用）

### 2️⃣ Bot をサーバーに招待する

1. 左メニューの **「OAuth2」** を選択
2. **「URL Generator」** で以下を設定:
   - **SCOPES**: `bot`
   - **BOT PERMISSIONS**: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Channels`, `Attach Files`, `Embed Links`
3. 生成された URL をコピーしてブラウザで開く → Bot を自分のサーバーに招待

### 3️⃣ 拡張機能をインストールする

1. 開発者から `.vsix` ファイルを入手
2. Antigravity でコマンドパレット（`Ctrl+Shift+P`）→ **Extensions: Install from VSIX...** を選択
3. `.vsix` ファイルを指定してインストール

### 4️⃣ 初回設定

1. コマンドパレット（`Ctrl+Shift+P`）→ **「AntiCrow: Set Bot Token」** を実行 → 控えておいた Bot Token を入力
2. ステータスバーに **`✓ AntiCrow`** が表示されれば接続完了 🎉

> `autoStart` がデフォルトで有効なため、Token 設定後に自動的にブリッジが起動します。

> ⚠️ **重要:** AntiCrow は専用のデスクトップショートカットから Antigravity を起動する必要があります。
> 初回セットアップ後、`AntiCrow: Create Desktop Shortcut` コマンドでショートカットを作成し、以降はそのショートカットから起動してください。

### 5️⃣ スラッシュコマンドの登録（任意）

Discord のスラッシュコマンド（`/schedule`, `/status` など）を使いたい場合:

1. [Discord Developer Portal](https://discord.com/developers/applications) で **Application ID (Client ID)** を確認
2. Bot の Client ID は起動時に自動検出されますが、必要に応じて手動で設定することも可能です
3. Bot を再起動すると、ギルドコマンドが自動登録されます

---

## 基本的な使い方

### 💬 自然文で依頼する（#agent-chat）

`#agent-chat` チャンネルにメッセージを送るだけ。AntiCrow が内容を分析し、即時実行か定期登録かを自動判断します。

#### 即時実行の例

```
今のプロジェクトの TODO を一覧にして
```
```
この画像のバグを修正して
```
```
package.json の依存関係をアップデートして
```

→ すぐに Antigravity が実行し、結果を Discord に返します。

#### 定期登録の例

```
毎朝9時に GitHub の通知をまとめて
```
```
毎週月曜に今週のタスクを整理して
```

→ cron 式に変換され、指定時間に自動実行されます。

### ✅ 確認リアクション

実行前に確認が必要な場合、Bot が確認メッセージを投稿します:

- ✅ を押すと → **承認して実行開始**
- ❌ を押すと → **却下してキャンセル**

選択肢がある場合:
- 1️⃣ 2️⃣ 3️⃣ ... で **個別選択**
- ☑️ で **選択を確定**（複数選択時）

### 📎 ファイル添付

メッセージにファイルを添付すると、AI がファイルの内容を分析してタスクに活用します。画像・テキスト・ドキュメントなど、様々な形式に対応しています。

### 📊 進捗通知

長時間かかるタスクの場合、Discord に進捗がリアルタイムで通知されます（パーセンテージやステータスメッセージ付き）。

---

## ワークスペース連携

AntiCrow は複数の Antigravity ワークスペースを管理できます。

### 設定方法

Antigravity の設定で `antiCrow.workspacePaths` を設定:

```json
{
  "crypto": "C:\\Users\\user\\dev\\crypto",
  "web-app": "C:\\Users\\user\\dev\\web-app",
  "docs": "C:\\Users\\user\\dev\\docs"
}
```

### Discord カテゴリーとの紐付け

ワークスペースを設定すると、Discord サーバーに自動的にカテゴリーが作成されます:

```
📁 🔧 crypto（カテゴリー）
  └── #agent-chat
📁 🔧 web-app（カテゴリー）
  └── #agent-chat
```

カテゴリー内のチャンネルからメッセージを送ると、対応するワークスペースで実行されます。

### 自動起動

メッセージ送信時にワークスペースの Antigravity が起動していない場合、自動的に起動を試みます。ワークスペースが開いた後にタスクが実行されます。

### カテゴリーの自動アーカイブ

`antiCrow.categoryArchiveDays` で設定した日数（デフォルト: 7日）以上使われていないカテゴリーは自動的に削除されます。不要になったカテゴリーを手動で掃除する必要はありません。

---

## スラッシュコマンド

Bot の Client ID が検出されると、以下のスラッシュコマンドが Discord で使えるようになります:

| コマンド | 説明 |
| --- | --- |
| `/schedule` | cron 式とプロンプトを指定して定期実行を登録 |
| `/status` | Bridge の接続状態・実行中タスクなどを表示 |
| `/schedules` | インタラクティブなスケジュール管理パネルを表示（一時停止・再開・削除がボタンで操作可能） |
| `/reset` | 処理中のリクエストを強制リセット（フリーズ時に使用） |
| `/newchat` | Antigravity で新しいチャットを開く |
| `/workspaces` | 検出された Antigravity ワークスペース一覧を表示（起動/停止状態付き） |
| `/queue` | 実行キューの状態を表示（待機中・実行中のタスク一覧） |
| `/templates` | プロンプトテンプレートの一覧表示・管理パネル |
| `/models` | 利用可能な AI モデル一覧を表示・切り替え（クォータ残量付き） |
| `/mode` | AI モード切替（Planning / Fast） |

### `/schedule` の使い方

```
/schedule cron:0 9 * * * prompt:GitHub通知をまとめて
/schedule cron:*/30 * * * * prompt:サーバーの状態をチェック
```

### `/schedules` パネル

`/schedules` を実行すると、登録済みスケジュールの一覧がボタン付きで表示されます:

- ⏸️ **一時停止** / ▶️ **再開** — スケジュールの有効/無効を切り替え
- 🗑️ **削除** — スケジュールを完全に削除（確認あり）
- 次回実行時刻・実行回数・最終実行結果なども表示

### `/templates` の使い方

`/templates` を実行すると、テンプレート管理パネルが表示されます:

- ➕ **新規作成** — 名前とプロンプトを入力してテンプレートを登録
- ▶️ **実行** — テンプレートのプロンプトを即座に実行
- 🗑️ **削除** — テンプレートを削除

テンプレートのプロンプトでは以下の変数が使えます:

| 変数 | 展開例 |
|---|---|
| `{{date}}` | `2026-02-18` |
| `{{time}}` | `18:30` |
| `{{datetime}}` | `2026-02-18 18:30` |
| `{{year}}` | `2026` |
| `{{month}}` | `02` |
| `{{day}}` | `18` |

### `/models` の使い方

`/models` を実行すると、利用可能な AI モデルの一覧がクォータ残量と合わせて表示されます。ボタンを押すとモデルを切り替えられます。

### `/mode` の使い方

`/mode` を実行すると、AI のモードを切り替えられます:

- **Planning** — 通常モード。計画を立ててから実行
- **Fast** — 高速モード。計画をスキップして即実行

---

## 設定項目リファレンス

Antigravity の設定（`Ctrl+,`）で以下の項目を変更できます:

| 設定キー | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `antiCrow.botToken` | boolean | `false` | Bot Token の設定状態（表示用）。コマンドパレットから `Set Bot Token` で設定 |
| `antiCrow.responseTimeoutMs` | number | `1800000` | 最後の進捗更新からのアイドルタイムアウト（ミリ秒）。デフォルト30分 |
| `antiCrow.autoStart` | boolean | `true` | Antigravity 起動時に自動でブリッジ開始 |
| `antiCrow.categoryArchiveDays` | number | `7` | ワークスペースカテゴリーの自動アーカイブ日数。0で無効 |
| `antiCrow.allowedUserIds` | string[] | `[]` | メッセージ処理を許可する Discord ユーザーID一覧。**空=全拒否（必須設定）** |
| `antiCrow.autoAccept` | boolean | `false` | 自動承認（Run / Allow / Continue 等）を有効にする。ステータスバーのボタンでもトグル可能 |
| `antiCrow.commandBlacklist` | string[] | `["rm","rm -rf",...]` | 自動承認しないコマンドのブラックリスト。コマンド行の先頭に一致した場合、自動承認をスキップ |
| `antiCrow.maxRetries` | number | `0` | タイムアウト時の自動リトライ回数。0でリトライ無効 |
| `antiCrow.workspaceParentDirs` | string[] | `[]` | 新規ワークスペース作成時のフォルダ配置先ディレクトリ |

> 💡 `autoAccept` がオンの場合、AntiCrow 経由のジョブ実行中に限り、Antigravity が表示する確認ダイアログ（Continue, Allow, Retry 等）の自動クリックとエージェント提案の自動承認が動作します。手動で Antigravity を操作している間は自動承認されません。`commandBlacklist` に登録されたコマンドは自動承認の対象外になります。

---

## コマンドパレットコマンド一覧

Antigravity のコマンドパレット（`Ctrl+Shift+P`）から使えるコマンド:

| コマンド | 説明 |
| --- | --- |
| `AntiCrow: Start` | Discord Bridge を起動。Bot がオンラインになりメッセージの受付を開始 |
| `AntiCrow: Stop` | Discord Bridge を停止。Bot がオフラインに |
| `AntiCrow: Set Bot Token` | Discord Bot Token を安全に保存（SecretStorage で暗号化） |
| `AntiCrow: Show Plans` | 登録済みの全計画（即時実行含む）をエディタで JSON 表示 |
| `AntiCrow: Clear All Plans` | 全計画を削除（定期実行のスケジュールも含む） |
| `AntiCrow: Create Desktop Shortcut` | Antigravity のデスクトップショートカットを作成 |
| `AntiCrow: Toggle Auto Accept` | 自動承認（Run / Allow / Continue 等）のオン/オフ切り替え |
| `AntiCrow: License Info` | 現在のライセンス情報を表示 |
| `AntiCrow: License Login` | ライセンスアカウントにログイン |
| `AntiCrow: Purchase License` | ライセンスの購入ページを開く |
| `AntiCrow: License Logout` | ライセンスアカウントからログアウト |

---

## カスタマイズ

### 🎨 AI の性格・口調をカスタマイズする

`~/.anticrow/ANTICROW.md` に AI への指示を書くと、すべてのプロンプトに自動適用されます。

#### 設定ファイルの場所

```
Windows: C:\Users\<ユーザー名>\.anticrow\ANTICROW.md
```

#### 記述例

```markdown
# 基本スタイル
- 常に日本語で回答してください
- フレンドリーで簡潔な口調で話してください
- 絵文字を適度に使ってください
- 専門用語は避け、わかりやすい言葉を使ってください

# コーディングスタイル
- TypeScript を使ってください
- コメントは日本語で書いてください
- ESLint のルールに従ってください
```

### 🎛️ ユーザーコントロール

AntiCrow はユーザーが完全にコントロールできるように設計されています：

| 設定 | あなたがコントロールできること |
|---|---|
| `allowedUserIds` | 誰が Bot を操作できるかを決定（ホワイトリスト方式） |
| `~/.anticrow/ANTICROW.md` | AI に送られるカスタム指示を自分で確認・編集 |
| `autoAccept` | 自動承認のオン/オフ切り替え（ステータスバーからもトグル可能） |
| `commandBlacklist` | 自動承認しない危険なコマンドの指定 |
| `workspaceParentDirs` | 新規ワークスペース作成時のフォルダ配置先を指定 |
| `responseTimeoutMs` | タイムアウト時間の設定 |

> 💡 `ANTICROW.md` は平文の Markdown ファイルです。AI に送信されるカスタム指示の内容をいつでも確認でき、不要なら削除するだけで無効化できます。

---

## トラブルシューティング

### 🔴 Bot がオフラインのまま

- **トークンを確認**: `Set Bot Token` コマンドで正しいトークンを再入力
- **Intent を確認**: Discord Developer Portal で **MESSAGE CONTENT INTENT** が有効か確認
- **ネットワーク**: インターネット接続を確認

### 🔴 Antigravity に接続できない

- Antigravity が起動しているか確認
- Output Channel「AntiCrow」でエラーログを確認（`Ctrl+Shift+U` → ドロップダウンから「AntiCrow」を選択）

### 🔴 メッセージが無視される

- チャンネル名が `agent-chat` であることを確認
- `#logs` チャンネルへの入力は仕様上無視されます
- `allowedUserIds` が設定されている場合、自分の Discord ユーザー ID が含まれているか確認

### 🔴 長時間応答がない

- 設定の `responseTimeoutMs` の値を増やす（デフォルト: 30分）
- `/reset` コマンドで処理を強制リセットできます
- Output Channel「AntiCrow」でログを確認

### 🔴 スラッシュコマンドが表示されない

- Bot の Client ID が正しく検出されているか確認
- Bot を再起動（Stop → Start）してギルドコマンドを再登録
- Discord アプリを再起動（キャッシュの問題の場合）

### 🔴 ワークスペースが自動起動しない

- `antiCrow.workspacePaths` のパスが正しいか確認
- 指定したフォルダが実際に存在するか確認

---

## FAQ

### Q: Bot Token はどこに保存されますか？
**A:** Antigravity の SecretStorage に暗号化して保存されます。設定ファイルに平文で記録されることはありません。

### Q: 複数の Discord サーバーで使えますか？
**A:** 現在は最初に検出されたギルド（サーバー）で動作します。1つのサーバーでの利用を推奨します。

### Q: メッセージの処理順序は？
**A:** 同じワークスペースのメッセージは送信順に逐次処理されます。異なるワークスペースのメッセージは並列処理されます。

### Q: 定期実行はいつから開始されますか？
**A:** cron 式で指定した次の実行タイミングから自動的に開始されます。Bot が再起動しても、登録済みのスケジュールは永続化されているので自動的に復元されます。

### Q: 外出先からも使えますか？
**A:** はい！Discord さえ使えればどこからでも依頼できます。スマホの Discord アプリからメッセージを送るだけです。ただし、Antigravity が起動しているPCがオンラインである必要があります。

### Q: 添付ファイルのサイズ制限はありますか？
**A:** Discord のアップロード制限（通常 25MB）に準じます。ファイルはローカルに一時ダウンロードされて処理されます。

---

## セキュリティ上の注意

### 🔐 Bot Token の管理

- Bot Token は **絶対に他人と共有しないでください**
- Git リポジトリにコミットしないでください
- Token が漏洩した場合は、すぐに Developer Portal で **Reset Token** を実行

### 🛡️ アクセス制限の設定（必須）

> ⚠️ **重要:** `allowedUserIds` が空の場合、セキュリティのため **誰もBotを操作できません**。必ず自分のユーザーIDを設定してください。

#### ステップ 1: Discord の開発者モードを有効化する

1. Discord を開く（デスクトップ版またはモバイル版）
2. **ユーザー設定**（⚙️ アイコン）を開く
3. **アプリの設定** → **詳細設定** を選択
4. **開発者モード** をオンにする

#### ステップ 2: Discord ユーザーIDを取得する

1. Discord で自分のアイコンまたはユーザー名を **右クリック**（モバイルの場合は長押し）
2. 表示されたメニューから **「ユーザーIDをコピー」** を選択
3. 18桁程度の数字がクリップボードにコピーされます（例: `123456789012345678`）

#### ステップ 3: Antigravity の設定に追加する

1. Antigravity でコマンドパレット（`Ctrl+Shift+P`）→ **Preferences: Open Settings (JSON)** を実行
2. 以下を追加:

```json
{
  "antiCrow.allowedUserIds": ["ここにコピーしたユーザーIDを貼り付け"]
}
```

複数ユーザーを許可する場合はカンマ区切りで追加できます:

```json
{
  "antiCrow.allowedUserIds": ["123456789012345678", "987654321098765432"]
}
```

> 💡 設定を保存すると即座に反映されます。Bot の再起動は不要です。

---

## 開発者について

AntiCrow は [@lucianlampdefi](https://x.com/lucianlampdefi) が開発・メンテナンスしています。

フィードバック・質問・バグ報告はお気軽にどうぞ 💬

- **X (Twitter):** [@lucianlampdefi](https://x.com/lucianlampdefi)
- **セキュリティに関する報告:** SECURITY.md をご覧ください

---

## ライセンス

MIT
