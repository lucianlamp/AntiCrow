---
name: learnings
description: 作業中に得た学びや解決策をワークスペースレベルで保持するナレッジベース。新しい知見が得られたら追記していく。
---

# ワークスペース学習ナレッジ

anti-crow 開発で得られた知見・解決策・パターンを蓄積するスキルです。
新しい学びがあれば該当セクションに追記、または新セクションを作成してください。

---

## CDP (Chrome DevTools Protocol)

### ターゲット選択

- Antigravity は複数の CDP ターゲット（`Launchpad`, メインウィンドウ等）を持つ
- **cascade フレーム**（`antigravity.agentPanel`）を含むのは `workbench.html` ターゲットのみ
- `findAntigravityTarget` は `workbench.html` を含む URL を最優先で選択する
- テスト時は全ターゲットを列挙して正しいものを特定すること

### フレーム操作

- cascade パネルは iframe 内にある → `Page.getFrameTree` でフレームツリーを走査
- `Page.createIsolatedWorld` でフレーム内に JS 実行コンテキストを作成
  - **重要**: パラメータ名は `grantUniversalAccess`（`s` を忘れない）。CDP は未知パラメータを黙って無視するため、タイポすると universal access なしで作成されてしまい、iframe DOM 操作結果が空オブジェクト `{}` になる
- `Runtime.evaluate` で DOM を直接操作・調査
- コンテキスト ID はフレーム遷移でリセットされるため、事前の有効性チェックが必要

### DOM 調査パターン

DOM 構造を調べるには:
1. CDP ポートを `cdp_ports/` フォルダから取得
2. Node.js スクリプトで `http://127.0.0.1:{port}/json` からターゲット一覧取得
3. WebSocket で接続し `Page.getFrameTree` → cascade フレーム特定
4. `Page.createIsolatedWorld` → `Runtime.evaluate` で DOM ダンプ
5. 結果を JSON ファイルに保存して分析

---

## Antigravity UI DOM 構造

### モデルセレクタ

**モデルボタン**（チャット入力欄の下）:
- textbox (`div[role="textbox"]`) の親を 2-5 レベル上に辿り、nextElementSibling を走査
- セレクタ: `button[class*="relative"][class*="flex"][class*="cursor-pointer"]`
- フォールバック: セレクタが合わない場合、textbox 近傍の `button` で `<p>` タグを持つものを探す
- 現在のモデル名: ボタン内の `<p>` 要素のテキスト

**ドロップダウン**（モデルボタンクリック後）:
- ルート: `div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]`
- ヘッダー: `div[class*="opacity-80"]` (テキスト "Model")
- モデル名: `p[class*="overflow-hidden"][class*="text-ellipsis"][class*="whitespace-nowrap"]`
- クリック先: `div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]`
- 選択中モデル: grandParent に `bg-gray-500/20` クラスあり

> **注意**: 2026-02-18 時点で、モデルドロップダウンも新 UI 構造に変更されている可能性あり（モードドロップダウンと同様の変更パターン）。動作しない場合は下記モードセレクタと同じ `z-50 rounded-md shadow-md` セレクタを試すこと。

**2026-02 時点の利用可能モデル例** (7件):
- Gemini 3 Pro (High) / Gemini 3 Pro (Low) / Gemini 3 Flash
- Claude Sonnet 4.5 / Claude Sonnet 4.5 (Thinking)
- Claude Opus 4.6 (Thinking)
- GPT-OSS 120B (Medium)

**evaluateInCascade が空オブジェクト `{}` を返す問題の修正**:
- 根本原因: `Page.createIsolatedWorld` の `grantUniversalAccess` パラメータのタイポ（`grantUniveralAccess` → `grantUniversalAccess`）
- CDP は未知パラメータを**黙って無視**するため、IsolatedWorld は作成されるが universal access なし → iframe 内の DOM 操作結果が空になる
- 例外は発生せず `evaluate` は正常に返るが value が `undefined` になるため、デバッグが困難
- 対策: `evaluate` メソッドに生レスポンスのデバッグログ（`type`, `subtype`, `hasValue`）を追加して異常を検出しやすくした

### モードセレクタ

**モードボタン**（チャット入力欄の下、モデルボタンの左隣）:
- textbox の親を 2-5 レベル上に辿り、兄弟要素から button を探す
- ~~モードボタン/モデルボタンともに `<p>` タグでテキスト表示~~ → **2026-02-18 UI 変更で `<span>` に変更**
- **現行構造**: モードボタンは `<span>` タグ、モデルボタンは `<p>` タグでテキスト表示
- 識別方法: `<p>` を持つボタン（モデル）の手前にある `<span>` を持つボタンがモード
- 現在のモード名: ボタン内の `<span>` 要素のテキスト（フォールバック: `<p>` → `innerText`）

**ドロップダウン**（モードボタンクリック後）:
- ~~旧ルート: `div[class*="absolute"][class*="overflow-y-auto"][class*="rounded-lg"][class*="border"]`~~
- ~~旧ヘッダー: `div[class*="opacity-80"]` (テキスト "Mode")~~
- ~~旧モード名: `p[class*="overflow-hidden"][class*="text-ellipsis"]`~~
- **2026-02-18 新構造**:
  - ルート: `div[class*="z-50"][class*="rounded-md"][class*="border"][class*="shadow-md"]`
  - ヘッダー: なし（ヘッダーレス）
  - モード名: `div[class*="font-medium"]` のテキスト
  - クリック先: `div[class*="cursor-pointer"][class*="px-2"][class*="py-1"]`
  - 選択中モード: 親要素に `bg-gray-500/20` クラスあり
- **コード対応**: `cdpModes.ts` で新セレクタを優先使用し、旧セレクタをフォールバックとして残してある

**2026-02-18 時点の利用可能モード** (2件):
- Planning / Fast

**UI 変更時の調査パターン**:
1. CDP 経由で cascade コンテキストに接続
2. ボタンをクリックしてドロップダウンを開く
3. `font-medium`, `cursor-pointer`, `z-50` 等のクラスで要素を検索
4. innerHTML / className / 親子関係をJSON出力して分析
5. Antigravity UI 更新時はボタンのテキストタグ（`<p>` vs `<span>`）とドロップダウンのコンテナクラスの両方を確認すること

### チャットエリア

- textbox: `div[role="textbox"]`
- 送信ボタン: textbox の兄弟/近傍にある `button` 要素
- 履歴ボタン: 左サイドバー内

---

## デプロイ

### フロー

1. `npm run compile` — TypeScript → JavaScript
2. `npm run bundle` — esbuild バンドル
3. `npx -y @vscode/vsce package ...` — VSIX パッケージ作成
4. `antigravity --install-extension anti-crow-0.1.0.vsix --force` — インストール
5. Antigravity 再起動（Developer: Reload Window）

### 注意点

- **複合コマンド非推奨**: `&&` で全ステップをつなぐと `antigravity --install-extension` が失敗することがある → **分割実行が安全**
- vsce package 前の prepublish スクリプトで typecheck + bundle が再実行される → 事前の compile/bundle は冗長だが安全マージンとして有効
- `--no-dependencies` で npm install スキップ（バンドル済みのため）

---

## Discord.js

### ボタン制約

- `customId` は **100文字以内**
- 1つの `ActionRow` に最大 **5 ボタン**
- 1つのメッセージに最大 **5 ActionRow**
- ボタンラベルは **80文字以内**

### Embed 制約

- `description` は **4096文字以内**
- `field.value` は **1024文字以内**
- 合計 **6000文字以内**
- フィールド数 **25個以内**

### パターン

- `deferReply()` → 長時間処理 → `editReply()` で応答
- `deferUpdate()` → ボタン押下応答 → `editReply()` で更新
- `followUp({ ephemeral: true })` でエラーを本人のみに表示

---

## テスト・デバッグ

### ファイル消失問題

- `write_to_file` 後にファイルが消えることがある
- 対策: ファイル作成後に `find_by_name` や `view_file` で存在確認を推奨

### CDP 接続デバッグ

- CDP ポートは再起動のたびに変わる → `cdp_ports/port_{pid}.txt` から取得
- ターゲットの切り替え: PID 変更時に古いポートファイルが残ることがある
- テスト用スクリプトは `scripts/` に作成し、作業完了後に削除

### テスト実行

- `npm test` — vitest で全テスト実行（現在 100 件）
- テストは `src/__tests__/` 配下
- 新機能追加時は対応するテストも作成する

---

## 追記ガイド

新しい学びを追加する際:
1. 該当するセクションがあれば、そのセクション内に追記
2. 新しいカテゴリの場合は `---` 区切りで新セクションを作成
3. 具体的なセレクタやコマンドは**コードブロック**で記載
4. 「なぜそうなるか」の背景や理由も可能な限り記載
