# Anti-Crow インストールガイド

Anti-Crow は、Discord のチャットから Antigravity（AI コーディングエディタ）を操作できる拡張機能です。スマホからメッセージを送るだけで、PC 上の Antigravity にコードを書かせたり、プロジェクトの管理をしたりできます。

このガイドでは、Anti-Crow の VSIX ファイルを受け取った方向けに、インストールから初期設定、動作確認までの手順をわかりやすく説明します。初めての方でも安心して進められるように書いていますので、順番に読み進めてください。

---

## はじめに用意するもの

Anti-Crow を使い始めるには、以下の3つが必要です。

**Antigravity**がお使いの PC にインストールされていることが前提です。Antigravity は VS Code ベースの AI コーディングエディタで、Anti-Crow はその上で動作します。まだインストールしていない場合は、先に Antigravity のセットアップを済ませてください。

**Node.js**（バージョン 20 以上）も必要です。Node.js は Anti-Crow が内部で使用する実行環境です。[Node.js 公式サイト](https://nodejs.org/) からダウンロードしてインストールしてください。バージョンの確認は、コマンドプロンプトで `node -v` と入力すれば確認できます。

**Discord アカウント**も必要です。Anti-Crow は Discord を通じて操作するので、まだアカウントを持っていない方は [Discord](https://discord.com/) で無料アカウントを作成してください。

---

## Step 1: Discord Bot を作る

Anti-Crow を使うには、まず自分専用の Discord Bot を作成する必要があります。「Bot」というのは、Discord 上であなたの代わりにメッセージを受け取ったり返したりしてくれるプログラムのことです。

### アプリケーションの作成

まず、ブラウザで [Discord Developer Portal](https://discord.com/developers/applications) にアクセスしてください。Discord アカウントでログインしたら、画面右上にある「New Application」ボタンをクリックします。

アプリケーション名を入力する画面が出てくるので、好きな名前をつけてください（例：「My Anti-Crow」など）。利用規約に同意して「Create」をクリックすれば、アプリケーションが作成されます。

### Bot Token の取得

作成したアプリケーションの画面で、左側メニューから「Bot」をクリックしてください。

Bot の設定ページが開いたら、「Reset Token」ボタンをクリックします。確認ダイアログが出るので「Yes, do it!」をクリックすると、**Bot Token** が表示されます。

> ⚠️ **重要:** この Token は一度しか表示されません！必ずコピーして安全な場所に保存してください。もし忘れてしまった場合は、再度「Reset Token」で新しい Token を発行できますが、古い Token は無効になります。

Bot Token はパスワードのようなものです。他の人には絶対に教えないでください。

### 権限の設定

同じ Bot 設定ページの下の方に「Privileged Gateway Intents」というセクションがあります。ここで以下の2つをオンにしてください。

- **Message Content Intent** — Bot がメッセージの内容を読めるようにします
- **Server Members Intent** — サーバーメンバーの情報にアクセスできるようにします

これらをオンにしたら、ページ下部の「Save Changes」を忘れずにクリックしてください。

### Bot をサーバーに招待する

次に、Bot を自分の Discord サーバーに招待します。左側メニューから「OAuth2」をクリックしてください。

「OAuth2 URL Generator」というセクションで、以下の設定をしてください：

**SCOPES（スコープ）** で以下にチェック：
- `bot`

**BOT PERMISSIONS（Bot の権限）** で以下にチェック：
- Send Messages（メッセージの送信）
- Read Message History（メッセージ履歴の閲覧）
- Embed Links（埋め込みリンク）
- Manage Channels（チャンネルの管理）
- Manage Messages（メッセージの管理）

設定が終わると、ページ下部に URL が生成されます。この URL をブラウザにコピー＆ペーストして開くと、Bot を招待するサーバーを選択する画面が出ます。自分のサーバーを選んで「認証」をクリックすれば、Bot がサーバーに参加します。

---

## Step 2: VSIX ファイルをインストールする

受け取った `anti-crow-0.1.0.vsix` ファイルを、お好きな場所に保存してください（デスクトップなど、わかりやすい場所がおすすめです）。

次に、コマンドプロンプト（Windows の場合）または PowerShell を開いて、以下のコマンドを実行します。

```
antigravity --install-extension anti-crow-0.1.0.vsix --force
```

もし VSIX ファイルをデスクトップに保存した場合は、ファイルのフルパスを指定してください：

```
antigravity --install-extension C:\Users\あなたのユーザー名\Desktop\anti-crow-0.1.0.vsix --force
```

「Extension 'anti-crow-0.1.0.vsix' was successfully installed.」のようなメッセージが表示されれば成功です。

インストールが完了したら、**Antigravity を再起動**してください。Antigravity が開いている状態であれば、`Ctrl + Shift + P` でコマンドパレットを開き、「Developer: Reload Window」と入力して実行すると再起動できます。

---

## Step 3: 初期設定をする

Antigravity が再起動したら、いくつかの設定をする必要があります。

### Bot Token を登録する

`Ctrl + Shift + P` でコマンドパレットを開き、「**AntiCrow: Set Bot Token**」と入力して実行してください。

入力欄が表示されるので、Step 1 でコピーした Bot Token をペーストして Enter を押します。Token は Antigravity の SecretStorage に暗号化されて保存されるので、安全です。

### Client ID を設定する

`Ctrl + ,`（カンマ）で設定画面を開き、検索バーに「antiCrow」と入力してください。Anti-Crow の設定項目が表示されます。

「**Client Id**」の欄に、Discord Developer Portal で作成したアプリケーションの **Application ID** を入力してください。Application ID は、Developer Portal のアプリケーション設定ページの「General Information」タブで確認できます。

### 許可ユーザーを設定する

セキュリティのため、Anti-Crow は許可されたユーザーからのメッセージしか処理しません。

「**Allowed User Ids**」の欄に、自分の Discord ユーザー ID を追加してください。

> 💡 **Discord ユーザー ID の確認方法:**
> Discord の設定 → 詳細設定 → 「開発者モード」をオンにしてください。その後、自分のアイコンを右クリックして「ユーザー ID をコピー」を選択すると、ID がコピーされます。

### 自動起動の確認

「**Auto Start**」が `true`（チェックが入った状態）になっていることを確認してください。これがオンだと、Antigravity を起動するたびに Anti-Crow も自動的にスタートします。

---

## Step 4: 動作を確認する

すべての設定が終わったら、動作確認をしましょう。

まず、Discord を開いて、Bot を招待したサーバーのチャンネルを確認してください。右側のメンバーリストに、あなたが作った Bot が「オンライン」（緑色の丸）で表示されていれば、Anti-Crow は正常に起動しています。

次に、そのチャンネルで何かメッセージを送ってみてください。例えば「こんにちは」と送ると、Anti-Crow が反応して処理を始めます。

スラッシュコマンドも使えます。メッセージ入力欄で `/help` と入力すると、利用可能なコマンドの一覧が表示されます。

---

## トラブルシューティング

うまく動かない場合は、以下を確認してみてください。

### Bot がオフラインのままの場合

- **Bot Token は正しいですか？** — コマンドパレット → 「AntiCrow: Set Bot Token」で再入力してみてください
- **Antigravity は再起動しましたか？** — インストール後の再起動を忘れていないか確認してください
- **Auto Start はオンですか？** — 設定画面で `antiCrow.autoStart` が `true` になっているか確認してください
- **手動で起動してみる** — コマンドパレットで「AntiCrow: Start」を実行すると、手動でブリッジを開始できます

### メッセージに反応しない場合

- **Allowed User Ids に自分の ID が入っていますか？** — この設定が空だと、すべてのメッセージが拒否されます
- **Message Content Intent はオンですか？** — Discord Developer Portal で Bot の設定を確認してください
- **Bot はチャンネルにアクセスできますか？** — Bot がメッセージを読める権限のあるチャンネルで試してください

### スラッシュコマンドが表示されない場合

- **Client ID は設定しましたか？** — スラッシュコマンドの登録には Client ID が必要です
- **少し待ってみてください** — スラッシュコマンドの反映には数分かかる場合があります
- **Antigravity を再起動してください** — 再起動すると、スラッシュコマンドが再登録されます

### それでも解決しない場合

Anti-Crow を配布してくれた方に連絡して、状況を伝えてください。Antigravity のコマンドパレットから「AntiCrow: Start」を手動実行した際の出力パネル（Output）のログが、問題解決の手がかりになります。

---

## おわりに

以上で Anti-Crow のインストールと初期設定は完了です！これで Discord からスマホでメッセージを送るだけで、PC 上の Antigravity にコーディング作業を任せることができるようになりました。

使い方に慣れてきたら、テンプレート機能やワークスペース管理など、さらに便利な機能も試してみてくださいね。
