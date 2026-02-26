---
name: autoapprove
description: autoApprove（Run/Allow/Continue ボタン自動クリック）の仕組み・アーキテクチャ・教訓。変更時に参照する。
---

# autoApprove スキル

Run / Allow / Continue 等のボタンを自動クリックし、タスク実行を中断なく進める機能。
`cdpUI.ts` に実装され、`uiWatcher.ts` から `autoFollowOutput()` 経由で定期的に呼び出される。

---

## 1. アーキテクチャ: 2層構造

autoApprove は **第1層（VSCode コマンド）** と **第2層（DOM フォールバック）** の2層で構成される。

```
uiWatcher.ts （1秒間隔ポーリング）
  └─ cdpUI.ts autoFollowOutput()
       ├─ scrollToBottom()
       ├─ autoApprove()
       │    ├─ 第1層: VSCode コマンド（CDP evaluate 経由）
       │    │    └─ conn.evaluate → vscode.commands.executeCommand(cmd)
       │    └─ 第2層: DOM フォールバック（JS スクリプト注入）
       │         └─ conn.evaluate → TreeWalker + Shadow DOM 再帰探索 → clickEl()
       ├─ clickExpandAll()
       ├─ dismissReviewUI()
       └─ dismissPermissionDialog()
```

### なぜ2層か

- **第1層** は Shadow DOM や UI 言語変更の影響を受けず **最も安定**
- **第2層** は VSCode コマンドでカバーできないダイアログ（Allow 等）に対応

---

## 2. 第1層: VSCode コマンド

メインフレームの `conn.evaluate` 内で `vscode.commands.executeCommand` を呼び出す。
CDP evaluate はターゲットウィンドウ内で実行されるため、複数ワークスペースでもクロスWS誤爆しない。

### APPROVE_COMMANDS 一覧

| コマンド | 役割 |
|---------|------|
| `antigravity.agent.acceptAgentStep` | Agent ステップ承認 |
| `antigravity.terminalCommand.accept` | ターミナルコマンド承認（Run ボタン） |
| `antigravity.command.accept` | コマンド承認 |
| `antigravity.prioritized.agentAcceptAllInFile` | ファイル変更の一括承認 |

### 実行パターン

```typescript
const evalJs = `
    (async () => {
        if (typeof vscode !== 'undefined' && vscode.commands) {
            await vscode.commands.executeCommand('${cmd}');
            return true;
        }
        return false;
    })()
`;
const executed = await ops.conn.evaluate(evalJs);
```

**重要:** `vscode.commands.executeCommand` を Node.js 環境から直接呼ぶと「現在アクティブなウィンドウ」に対して実行されてしまう。必ず CDP `conn.evaluate` 内で実行すること。

---

## 3. 第2層: DOM フォールバック

VSCode コマンドでカバーできない UI 要素に対応する。

### 2層テキストマッチング

テキストマッチは **SHORT_TEXTS（完全一致のみ）** と **LONG_TEXTS（部分一致OK）** の2層に分離されている。

#### SHORT_TEXTS（完全一致のみ `===`）

短いテキストは部分一致だとドロップダウンやメニュー項目を誤クリックするリスクが高いため、完全一致のみ。

```
run, ok, yes, allow, accept, retry, confirm, proceed
```

#### LONG_TEXTS（部分一致OK `indexOf`）

十分に長いテキストは部分一致でも誤爆リスクが低い。

```
always allow, continue, always run, allow once, allow this conversation
```

### 探索ロジック

1. **findAllInTree**: TreeWalker + Shadow DOM 再帰探索でクリック可能な要素を収集
2. **isVisible**: `getBoundingClientRect` + `offsetParent` + `getComputedStyle` で可視性判定
3. **isExcluded**: 除外対象の要素をフィルタリング（下記参照）
4. **テキストマッチ**: `innerText` 優先、空白圧縮、SHORT_TEXTS は完全一致 / LONG_TEXTS は部分一致
5. **clickEl**: `dispatchEvent` でフルクリックエミュレーション（mousedown → mouseup → click → pointerdown → pointerup）

### クリック可能な要素の検出条件

```javascript
tag === 'button' || tag === 'vscode-button' || tag === 'a' ||
el.getAttribute('role') === 'button' ||
(tag === 'div' && (el.getAttribute('aria-label') ||
                   el.classList.contains('action-label')))
```

**注意:** `div[data-tooltip-id]` はドロップダウン・ツールチップ等のトリガーとして使われるため、クリック対象から**完全除外**している。

### isExcluded 除外リスト

#### 基本除外（要素自身の祖先チェック）

- `[id*="statusbar"]`, `[class*="statusbar"]`
- `[class*="menubar"]`, `[role="menubar"]`
- `[class*="titlebar"]`

#### ドロップダウン・ポップアップ除外（祖先に以下がある場合も除外）

- `[data-headlessui-state]` — Headless UI のドロップダウン
- `[role="listbox"]` — セレクトメニュー
- `[role="combobox"]` — コンボボックス
- `.dropdown`, `.select-box`, `.popover` — 汎用ドロップダウン

#### aria-label 除外

以下の文字列を `aria-label` に含む要素は除外（モデル選択・モード選択を誤クリックしない）:

- `model`
- `cascade`
- `agent mode`

---

## 4. 呼び出しフロー

```
extension.ts activate()
  └─ bridgeLifecycle.ts
       └─ executorPool.startUIWatcherAll()
            └─ 各 Executor の UIWatcher.start()
                 └─ 1秒間隔ポーリング
                      └─ cdpUI.autoFollowOutput(ops)
                           ├─ scrollToBottom()     ← スクロール
                           ├─ autoApprove()        ← ボタン自動承認
                           ├─ clickExpandAll()     ← 差分展開
                           ├─ dismissReviewUI()    ← レビューUI閉じ
                           └─ dismissPermissionDialog() ← 許可ダイアログ承認
```

- `autoAccept` 設定 ON の場合のみ有効
- Pro 限定機能（`isProCheck` コールバックで判定）
- ExecutorPool 経由で各ワークスペース専用の CdpBridge で起動（クロスWS誤爆防止）
- **旧方式**: uiWatcher.ts が `autoApprove` → `clickElement`（ルールベース）→ `scrollToBottom` を個別に呼び出していた
- **現方式**: `autoFollowOutput` 1本で scroll → approve → expand → review → permission を自然な流れで実行

---

## 5. トラブルシューティング

### よくある失敗パターンと教訓

| 失敗パターン | 根本原因 | 教訓 |
|-------------|---------|------|
| **el.closest 親チェック** | dialog/action/notification 等のクラスを要求 → ボタンの親がマッチせずスキップ | 除外リスト方式（isExcluded）の方が安全 |
| **短テキスト部分一致で誤操作** | `indexOf` で "run" を部分一致すると "Always Run" ドロップダウン等が誤クリックされる | SHORT_TEXTS は完全一致（`===`）、LONG_TEXTS のみ部分一致 |
| **Alt+Enter キー方式** | CDP `Input.dispatchKeyEvent` はフォーカス依存。Allow 等にはショートカットがそもそもない | VSCode コマンド + DOM クリックに完全移行 |
| **tag:'button' 制約** | VSCode の UI 要素は DIV や `<vscode-button>` で実装されることがある | タグフィルタを外しテキストベースで判定 |
| **Shadow DOM 未対応** | `querySelector` では Shadow DOM 内部を検出できない | `findAllInTree` で `el.shadowRoot` を再帰的に探索 |
| **getComputedStyle エラー** | iframe 内で親ウィンドウの `window.getComputedStyle` を使うとクロスオリジンエラー | `el.ownerDocument.defaultView` を使う |
| **クロスWS誤爆** | UIWatcher が ctx.cdp（起動WS）に固定 | ExecutorPool 経由で WS 別に起動 |
| **data-tooltip-id DIV の誤クリック** | ドロップダウントリガーの DIV を承認ボタンと誤認 | `div[data-tooltip-id]` をクリック対象から完全除外 |

### デバッグ方法

1. **AntiCrow.log** を確認（`CDP: autoApprove —` または `CDP: autoFollowOutput` で検索）
2. `.log` にクリック結果（`clicked: N`）が出力される
3. VSCode コマンド実行成功時は `executed VSCode command: <cmd>` ログが出る
4. ログが更新されていなければ**拡張が再読み込みされていない**（Reload Window 必須）

---

## 6. 変更時の注意点

### 必須チェック

- [ ] VSIX デプロイ後に **Antigravity の `Developer: Reload Window`** を実行
- [ ] `executor.test.ts` のモックに新しい import / 関数を追加
- [ ] `regression-prevention` スキルのチェックリストを実行

### 変更種別と影響範囲

| 変更内容 | 影響ファイル |
|---------|------------|
| APPROVE_COMMANDS 追加/削除 | `cdpUI.ts` のみ |
| APPROVE_BUTTON_TEXTS 追加/削除 | `cdpUI.ts` のみ |
| autoApprove 関数シグネチャ変更 | `cdpUI.ts` + `uiWatcher.ts` |
| autoFollowOutput の処理順変更 | `cdpUI.ts` のみ |
| UIWatcher 起動ロジック変更 | `uiWatcher.ts` + `executorPool.ts` + `bridgeLifecycle.ts` |
| Pro 限定判定変更 | `licenseGate.ts` + `bridgeLifecycle.ts` |
| isExcluded 除外ルール変更 | `cdpUI.ts` のみ |

### 歴史的経緯

1. 初期: `uiWatcher.ts` の `DEFAULT_AUTO_CLICK_RULES` でテキストマッチ（**廃止済み**）
2. Shadow DOM 対応: `findInTree` 再帰探索を導入
3. Alt+Enter 方式: CDP `Input.dispatchKeyEvent` — **不安定で廃止**
4. 2層方式: VSCode コマンド（第1層）+ DOM フォールバック（第2層）
5. 現在: autoFollowOutput 統合 + 2層テキストマッチング（SHORT/LONG）+ ドロップダウン除外強化
