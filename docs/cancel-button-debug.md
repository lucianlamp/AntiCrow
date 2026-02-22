# Cancel/Stop ボタン DOM デバッグレポート

**調査日時:** 2026-02-22 02:02 JST  
**対象ウィンドウ:** anti-crow - Antigravity  
**Cascade Frame ID:** 81976DC5A87E099E2E4D4B52B0DDAADB  
**状態:** 生成中（アクティブ/ストリーミング状態）

---

## 🔴 重大な発見

### 1. Cancel ボタンは `DIV` であり `BUTTON` ではない

```
tooltipId: "input-send-button-cancel-tooltip"
tag: DIV （← BUTTON ではない！）
ariaLabel: null
visible: true
classes: "bg-gray-500/20 hover:bg-gray-500/30 w-6 h-6 rounded-full cursor-pointer flex items-center justify-ce..."
innerHTML: <div class="bg-red-500 w-[0.625rem] h-[0.625rem] rounded-xs"></div>
```

**影響:** `clickElement` のフォールバック戦略（ステップ4）は全て `tag: 'button'` を指定している。
`DIV` 要素はこれに一切マッチしないため、6つのフォールバック候補全てが失敗する。

### 2. Audio（マイク）ボタンが SVG rect を含む → 誤検出リスク

```
index: 17 (button)
ariaLabel: "Record voice memo"
tooltipId: "audio-tooltip"
hasSvgRect: true  ← SVG rect を含む
disabled: true
```

**影響:** `CANCEL_BUTTON_JS` の戦略A/B（SVG rect ベースの検出）が**マイクボタンを誤検出する可能性**がある。
マイクボタンは disabled だが、SVG rect フィルタリングに色チェックが入っていない戦略Aでは
`isStopBtn = hasSvgRect` で即マッチする。

### 3. send-tooltip 不在時の挙動

`sendBtnFound: false` — 生成中は「送信ボタン」が消えて「キャンセルボタン」に入れ替わる。
`sendAreaButtons: []` — 送信ボタンの親要素が存在しないため、送信エリアのボタン列挙も空。

---

## 📋 tooltip-id を持つ要素一覧（抜粋）

| tooltip-id | tag | visible | ariaLabel | 用途 |
|---|---|---|---|---|
| new-conversation-tooltip | A | ✅ | null | 新規チャット |
| history-tooltip | A | ✅ | null | 履歴 |
| cascade-header-menu | BUTTON | ✅ | null | メニュー |
| close-tooltip | A | ✅ | null | 閉じる |
| **audio-tooltip** | **BUTTON** | ✅ | Record voice memo | マイク |
| **input-send-button-cancel-tooltip** | **DIV** | ✅ | null | **キャンセル** |

---

## 📊 textbox 周辺のボタン（nearbyButtons）

| # | text | ariaLabel | tooltipId | hasSvgRect | 
|---|---|---|---|---|
| 0 | Review Changes | null | null | ❌ |
| 1 | (empty) | null | null | ❌ |
| 2 | Planning | null | null | ❌ |
| 3 | Claude Opus 4.6 (Thinking) | null | null | ❌ |
| 4 | (empty) | Record voice memo | audio-tooltip | ✅ |

**注意:** キャンセルボタン（DIV）は `button` タグではないため、このリストに登場しない。

---

## 🔧 修正提案

### 修正1: CANCEL_BUTTON_JS の戦略0 の動作検証

戦略0（tooltip-id セレクタ）のコードは正しく `querySelector` で DIV 要素を取得して `.click()` を呼ぶ。
`offsetParent` チェックも `visible: true` なので通過するはず。

**しかし、** `evaluateInCascade` 自体が失敗している可能性がある（context ID の問題 等）。
デバッグログで `cascade-js:OK(tooltip-id)` が出ているか確認が必要。

### 修正2: clickElement フォールバックの tag 修正

```diff
- { selector: '[data-tooltip-id="input-send-button-cancel-tooltip"]', tag: 'button', inCascade: true },
+ { selector: '[data-tooltip-id="input-send-button-cancel-tooltip"]', inCascade: true },
```

`tag: 'button'` を除去することで DIV 要素にもマッチするようになる。

### 修正3: SVG rect 誤検出対策

マイクボタン除外のため、戦略A に SVG rect 検出時の追加フィルタを追加:
- `aria-label !== "Record voice memo"` チェック
- または `data-tooltip-id !== "audio-tooltip"` チェック

---

## 📁 調査に使用したファイル

- **スクリプト:** `scripts/debug_cancel_dom.js`
- **生データ:** `tmp_dom_debug.json`
