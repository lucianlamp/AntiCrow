---
name: regression-prevention
description: コード変更時の回帰バグを防止するためのチェックリストと手順書。変更前に必ず参照する。
---

# 回帰バグ防止ガイド

コード変更時に他の箇所で不具合が生じるのを防ぐための手順書。
**変更前に必ずこのスキルを参照すること。**

---

## 1. 影響分析

変更するモジュールの依存関係を確認する。

### 手順
1. 変更対象ファイルの `export` を grep し、どのファイルが import しているか確認
2. 特に以下の「ハブモジュール」を変更する場合は影響範囲が広い:
   - `messageHandler.ts` — キュー・処理パイプライン全体
   - `executor.ts` / `executorPool.ts` — 実行パイプライン
   - `bridgeLifecycle.ts` — 初期化・接続管理
   - `discordBot.ts` — Discord API ラッパー
   - `adminHandler.ts` — スラッシュコマンド処理
3. 型の変更（interface / type）は全参照箇所に波及する

### ツール
```bash
# export されているシンボルの使用箇所を確認
Select-String -Path "src/*.ts" -Pattern "import.*from.*'./変更ファイル'" | Select-Object LineNumber,Line
```

---

## 2. 状態管理チェック

Map / Set / モジュールレベル変数のクリア・リセット箇所が全パスで整合しているか確認する。

### チェック項目
- [ ] 新しい Map/Set を追加した場合、対応する `clear()` が `reset` / `cancel` 関数に含まれているか
- [ ] Map エントリの `delete` が必要な箇所で `set(key, 0)` のまま放置していないか
- [ ] 複数の Map が同じ概念の状態を管理している場合、更新タイミングが同期しているか
- [ ] `finally` ブロックでのクリーンアップが全エラーパスをカバーしているか

### 過去の実例
| バグ | 原因 | 教訓 |
|-----|------|------|
| キューカウント不整合 | `cancelPlanGeneration` が `workspaceQueueCount` をリセットしない | cancel/reset 関数を追加・修正したら全関連 Map のクリアを確認 |
| ゴーストカウント | `enqueueMessage` finally で count=0 のエントリが残存 | `Math.max(0, count-1)` 後に 0 なら `delete` する |
| total 計算不整合 | `total` を別 Map から算出し `processing + waiting` と乖離 | 派生値は単一情報源から計算する |

---

## 3. コールバック伝搬チェック

新しいパラメータやコールバックを追加した場合、全ての呼び出し元に伝搬しているか確認する。

### チェック項目
- [ ] クラスの `constructor` にパラメータを追加した場合、全インスタンス化箇所を更新
- [ ] Pool パターン（`ExecutorPool` 等）がある場合、Pool の `constructor` / `getOrCreate` にも追加
- [ ] `bridgeLifecycle.ts` の初期化コードを確認（多くのコールバックがここで設定される）
- [ ] `BridgeContext` にコールバックを追加した場合、`extension.ts` の接続コードも更新

### 過去の実例
| バグ | 原因 | 教訓 |
|-----|------|------|
| 提案ボタン未表示 | ExecutorPool に `postSuggestions` コールバック未設定 | Pool にも忘れず追加 |

---

## 4. 表示ロジック整合性

表示値が複数の情報源から計算されている場合、単一情報源に統一する。

### チェック項目
- [ ] 表示する値が「逆算」（例: `total - processing`）で得られていないか → 直接配列の `.length` を使う
- [ ] `total` のような集約値が複数の Map の合計から計算されていないか
- [ ] Embed の表示が実態と乖離する条件（タイミング問題、レースコンディション）がないか

---

## 5. デプロイ前チェックリスト

以下を順番に実行し、全てパスしてからデプロイする。

```
1. npx tsc --noEmit          # 型チェック
2. npx vitest run            # テスト実行
3. npm run compile           # TypeScript コンパイル
4. npm run bundle            # esbuild バンドル
5. npx -y @vscode/vsce package --no-dependencies ...  # VSIX パッケージ
6. レスポンスファイル書き込み  # IPC レスポンスを先に書く
7. antigravity --install-extension anti-crow-0.1.0.vsix --force  # インストール
```

### 注意
- **VSIX インストールは拡張ホストを再起動する** → レスポンスファイルを先に書き込む
- テスト失敗が今回の変更に関係ないか必ず確認する（既存の失敗 vs 新規の失敗）

---

## 6. 変更種別ごとの必須テスト

| 変更種別 | 必須テスト |
|---------|-----------|
| キュー関連（messageHandler） | `messageHandler.test.ts` |
| テンプレート関連 | `templateStore.test.ts` |
| ライセンス関連 | `licenseChecker.test.ts` |
| IPC 関連 | `fileIpc.test.ts` |
| CDP 関連 | 実機テスト（手動） |
| Discord Bot 関連 | `botLock.test.ts` + 手動テスト |
| Executor 関連 | `executor.test.ts` |
| スケジューラ関連 | `scheduler.test.ts` |
| 設定関連 | `configHelper.test.ts` |
