

## IPC・デプロイ
- VSIX インストールで拡張ホスト再起動→IPC中断。レスポンス書き込みをVSIX前に行う
- stale response リカバリー、cleanupOldFiles定期実行、activeRequestsガード実装済み

## CDP・DOM操作の原則
- Shadow DOM対応: findFirstInTree/findAllInTree + TreeWalker + shadowRoot再帰探索が必須
- getTargetDoc()パターン: cascade-panel iframeを自動検出しメインフレームから操作可能に
- ボタンはBUTTON/DIV/A/vscode-button等多様。tag制約を外しテキストベースで判定
- クリックはdispatchEvent(mousedown/mouseup/click)でフルシミュレート
- iframe内はel.ownerDocument.defaultViewでgetComputedStyle呼び出し
- tooltip-idは安定セレクタ(cancel/send/history等)。モデル・モード切替にはなし
- VSCodeコマンド実行はCDP Runtime.evaluate内でカプセル化（クロスWS誤爆防止）

## autoApprove
- 2層: VSCodeネイティブコマンド(4種) + DOMフォールバック(TreeWalker+12テキストパターン)
- Alt+Enter方式は廃止。除外リスト方式(statusbar/menubar/titlebar)
- UIWatcherはExecutorPool経由でWS別起動（クロスWS誤爆修正済）
- autoOperationはPro限定機能

## キャンセル
- CANCEL_BUTTON_JS: 7段階戦略(vscode-cmd→cascade-js→main-js→button→escape)
- CLICKABLE_SELECTOR導入（DIV対応）。Escapeはiframe内textbox focus後にディスパッチ
- /cancel はWS分離対応済み（チャンネルカテゴリーから解決）

## キュー・パイプライン
- 2段: message

（要約が長すぎたため切り詰めました）

## 過去の記憶（要約）
## Anti-Crow CDP/DOM パターン
- CDPポート: 固定ポート（9333）に完全移行。自動スキャン廃止
- DOM操作: `getTargetDoc()` + `findFirstInTree/findAllInTree` パターンで Shadow DOM 再帰探索を標準化
- テキスト取得: `textContent` を使用（`innerText` はレイアウト依存で不可視要素に失敗するため禁止）
- 対象ファイル: cdpModels/cdpModes/cdpHistory/cdpUI/cdpBridge の5ファイル全てで getTargetDoc() 統一完了
- ボタンテキスト: 特定タグ（P等）に依存せず `getBtnText(el)` で直接取得

## autoApprove DOM フォールバック
- 短テキスト（run/ok/yes/allow等）は完全一致、長テキスト（always allow等）は部分一致の2層マッチング
- `div[data-tooltip-id]` はクリック対象から除外
- ドロップダウン系（headlessui-state/listbox/combobox/popover）の親要素チェックで誤操作防止
- model/cascade/agent mode 含む aria-label 要素を除外
- UIWatcher は autoFollowOutput 1本に統合

## WS分離パターン
- `resolveTargetCdp` 共通ヘルパーで全ハンドラを統一（handleStatus/handleCancel/handleNewchat/handleModels/handleMode/handleHistory/handleScreenshot/handleTestCmd）
- `ctx.cdp`（デフォルトCdpBridge）を直接使わず、チャンネルカテゴリー→WSキー→cdpPool.getActive で取得

## デスクトップショートカット
- 初回起動時にユーザー確認なしで自動作成

## Memory自動サマライズ
- memorySummarizer.ts: SummarizeOps依存注入、fire-and-forget非同期実行、モジュールレベルフラグで二重実行防止

### 2026-02-25
[2026-02-26] IPC レスポンス不達修正: (1) messageHandler.ts/templateHandler.ts の全 waitForResponse 呼び出しに registerActiveRequest/unregisterActiveRequest を追加（cleanupOldFiles 誤削除防止）。(2) fileIpc.ts の cleanupOldFiles tmp_* 閾値を 30秒→2分に引き上げ（AI がプロンプトファイルを view_file する前の削除防止）。(3) waitForResponse にポーリング開始前の即時チェック（tryReadResponse()）を追加。今後 waitForResponse を呼ぶ箇所を追加する際は、必ず registerActiveRequest/unregisterActiveRequest で保護すること。


### 2026-02-26
[2026-02-26] discordBot.ts の interactionCreate グローバルハンドラで確認ボタン系（confirm_approve/confirm_reject/choice_*/mchoice_*）を handleButtonInteraction に渡さずスキップする修正。グローバルハンドラとメッセージコンポーネントコレクタの処理順序競合により Discord API の 3 秒応答期限超過が発生していた。今後 discordReactions.ts にコレクタベースのインタラクション処理を追加する際は、discordBot.ts のグローバル interactionCreate ハンドラに対応するスキップ条件も必ず追加すること。


### 2026-02-26
[2026-02-26] Anti-Crow のパイプライン理解: plan_generation → 確認(Discord) → execution → レスポンス書き込み → Discord送信。AI はファイル書き込みまでが責務。Discord 送信は Anti-Crow（VSCode拡張）側の責務。VSIX デプロイで拡張ホスト再起動するとIPC中断し、レスポンスが Discord に届かないことがある。stale response リカバリーが bridgeLifecycle.ts に実装済みだが動作しないケースがある。


### 2026-02-26
[2026-02-26] stale response リカバリー修正: (1) waitForResponse タイムアウト時のレスポンスファイル削除を廃止（stale recovery でピックアップ可能に）。(2) bridgeLifecycle.ts に 5分間隔の定期 stale response チェックを追加（起動時1回では不十分 — VSIX 再起動後に AI が書いたレスポンスを拾えなかった）。(3) cleanupOldFiles の response/meta 削除閾値を 10分→30分に引き上げ。redeliverStaleResponses 関数に共通化。


### 2026-02-26
[2026-02-26] cdpModels.ts / cdpModes.ts の listScript（ドロップダウン内アイテム取得）と selectScript（アイテム選択）にも getTargetDoc() パターンが必要。FIND_MODEL_BUTTON / FIND_MODE_BUTTON には getTargetDoc() が適用済みだったが、別の IIFE で定義される listScript/selectScript には未適用だった。DOM操作の inline script を追加する際は、FIND_*_BUTTON 内だけでなく全ての IIFE に getTargetDoc() + ownerDocument パターンを適用すること。


### 2026-02-26
[2026-02-26] stale response リカバリーの WS 誤送信修正: findFirstAgentChatChannelId（全WS横断フォールバック）を完全に削除。2段フォールバック（① meta channelId → ② requestId/meta の workspaceName → カテゴリ内 #agent-chat）に変更。チャンネル特定不能時はスキップ＋クリーンアップ。requestId から WS 名を正規表現抽出するロジックも追加（req_{ws}_{ts}_{uuid} 形式に対応）。


### 2026-02-26
[2026-02-26] cdpHistory.ts の会話履歴スクレイピングに3段階フォールバック戦略を実装: (0) data-tooltip-id*="delete-conversation" → (1) button.group クラスマッチ → (2) スクロール可能コンテナ内の全 button/a 要素を汎用スキャン。全戦略失敗時は DOM ダンプ診断情報（ボタンのタグ/テキスト/クラス/tooltip/サイズ）をログに出力する。Antigravity の DOM 構造が変わっても戦略2でフォールバック可能。


### 2026-02-26
[2026-02-26] 提案ボタン（SUGGESTIONS）に「🤖 エージェントに任せる」固定ボタンを追加。SUGGEST_AUTO_ID='suggest_auto' でインデックスベースの suggest_0/1/2 と区別。slashHandler.ts で suggest_auto を先に判定（startsWith('suggest_') より前に exact match）。AUTO_PROMPT は固定文字列。ActionRow は最大4ボタン（AI提案3+自律1）。


### 2026-02-26
[2026-02-26] autoApprove の cleanText() テンプレートリテラル内エスケープバグ: `\\\\s` は文字列リテラル `\s` にマッチする正規表現になっていた（空白にマッチしない）。テンプレートリテラル内の正規表現では `\s` と書けばブラウザ側で正しく `/\s+/g` として解釈される。PERMISSION_SCRIPT のテキスト取得も `.trim()` だけでなく `.replace(/\s+/g, ' ').trim()` で内部の改行・連続空白を正規化すること。改行を含むボタンテキスト（Allow This↵Conversation 等）に対応。


### 2026-02-26
[2026-02-26] autoFollowOutput の実行順序修正: scroll → clickExpandAll → autoApprove → dismissReviewUI → dismissPermissionDialog。折りたたまれたセクション（1 Step Requires Input 等）内の承認ボタンを確実にクリックするには、autoApprove の前に clickExpandAll で展開する必要がある。


### 2026-02-26
[2026-02-26] IPC tmp ファイル削除問題の修正: activeRequests ガードは req_* プレフィックスでのみマッチし、tmp_* ファイルは保護されていなかった。protectedFiles セットを新設し、registerActiveRequest() に associatedFiles 引数を追加して tmp ファイルを明示的に保護。cleanupOldFiles と cleanupTmpFiles の両方で protectedFiles チェックを追加。tmp_* 閾値を 2分→5分に引き上げ。今後 cleanupOldFiles に新しいファイル種別を追加する際は、protectedFiles チェックが適用されることを確認すること。
