

### 2026-02-20
コードレビュー＆セキュリティ監査レポート（docs/code-review-report.md, security-audit-report.md）と改善計画（docs/improvement-plan.md）を2026-02-20に作成。主な改善点: テストカバレッジ24%→50%目標、any型6件除去、executor.ts/messageHandler.ts/adminHandler.tsのリファクタリング。


### 2026-02-20
改善計画フェーズ2完了（2026-02-20）: any型7箇所を除去（quotaProvider.ts 3箇所、cdpModes.ts 2箇所、cdpModels.ts 2箇所）。unknown + Record<string, unknown> + 型ガードパターンで置換。typecheck + 155テスト全パス。


### 2026-02-20
フェーズ3完了（2026-02-20）: UIウォッチャー分離(uiWatcher.ts新規)、handleDiscordMessage 5関数分割、handleManageSlash 10コマンド別関数+ディスパッチマップ化。全リファクタで外部インターフェース変更なし。155テスト全パス。


### 2026-02-20
IPC レスポンス未達の根本原因: VSIX インストール（antigravity --install-extension）は拡張ホストを再起動するため、Anti-Crow の waitForResponse ポーリングが中断→レスポンスファイルが未回収になる。対策: (1) デプロイスキルでレスポンス書き込み後に VSIX インストールする、(2) startBridge 時に stale response をリカバリーする。


### 2026-02-20
IPC 再発防止4対策実装（2026-02-20）: (1) recoverStaleResponses で起動時に未回収レスポンス検出+ログ+削除、(2) デプロイスキルにVSIXインストール注意書き追加（レスポンス先行書き込み）、(3) cleanupOldFiles 5分定期実行 + activeRequests による誤削除防止 + response ファイル閾値5分→10分に引き上げ + catch-all から response 除外ガード、(4) waitForResponse タイムアウト時 logWarn でメトリクス出力。166テスト全パス。


### 2026-02-20
clickCancelButton に data-tooltip-id="input-send-button-cancel-tooltip" セレクタを戦略0（最優先）として追加（2026-02-20）。antigravity-discord-bot の stopGeneration 関数を参考。Page.captureScreenshot による screenshot 機能は将来検討事項。


### 2026-02-20
data-tooltip-id セレクタは tooltip が設定されている要素にのみ付与される属性。cdpModes.ts と cdpModels.ts の class ベース DOM 走査が最も脆く、tooltip-id 置換の最優先候補。ただし実機 DOM 調査が必要。改善時は cancel ボタンと同様に tooltip-id を最優先戦略としつつフォールバック戦略を残すべき。


### 2026-02-20
Antigravity DOM 実機調査結果（2026-02-20）: data-tooltip-id を持つ要素は9個。利用可能: new-conversation-tooltip（新規チャット）、history-tooltip（履歴）、cascade-header-menu（メニュー）、input-send-button-send-tooltip（送信）、input-send-button-cancel-tooltip（キャンセル/生成中のみ）。モデル切替・モード切替ボタンには data-tooltip-id は付与されておらず、data-headlessui-state で管理されている。


### 2026-02-20
cdpHistory.ts 全面リライト完了（2026-02-20）: 全セレクタを実機DOM調査に基づき修正。openHistoryPopup は data-tooltip-id=history-tooltip ベース、getConversationList は delete-conversation tooltip-id の親 BUTTON スクレイピング、selectConversation は直接 BUTTON クリック、closePopup は history-tooltip トグル。Quick Pick ベースの方式は完全廃止。584行→365行に簡潔化。


### 2026-02-20
/history スラッシュコマンド実装（2026-02-20）: historyButtons.ts 新規作成（buildHistoryListEmbed + buildHistorySelectResultEmbed, 148行）。adminHandler.ts に handleHistory 追加（handleModels パターン）。slashHandler.ts に hist_select_/hist_refresh/hist_page_/hist_close ボタンハンドラ追加。slashCommands.ts に /history コマンド定義追加。mapCommandToIntent には既に history: admin が登録済みだった。


### 2026-02-20
closePopup の evaluateInCascade は selectConversation 後に動作しない（resetCascadeContext が原因）。conn.evaluate をフォールバックとして追加する必要がある。CDP 操作で cascade context リセット後は evaluateInCascade が使えなくなることに注意。


### 2026-02-20
closePopup の最優先戦略は Escape キー送信（cascade context リセットに影響されず最も安定）。DOM 操作（history-tooltip クリック）はフォールバックとして残す。ユーザー確認により Escape で履歴パネルが閉じることが判明（2026-02-20）。


### 2026-02-20
Anti-Crow には2つのキューシステムがある: (1) messageHandler の workspaceQueueCount（メッセージ処理パイプライン：Discord受信→Plan生成→確認→executor）と (2) executor の queue（実行パイプライン：Plan→Antigravity実行→結果）。/status は前者を、/queue は後者を表示。2つは異なるパイプラインステージであることに注意。


### 2026-02-20
/queue 表示バグ修正（2026-02-20）: messageHandler に ProcessingStatus 型と currentProcessingStatuses Map を追加し、handleDiscordMessage の各フェーズ（connecting/plan_generating/confirming/dispatching）でステータスを更新。getMessageQueueStatus() に processing フィールドを追加。adminHandler の handleQueue で各フェーズを絵文字付き表示。


### 2026-02-20
/cancel 後 typing 継続バグ修正（2026-02-20）: messageHandler の typingInterval と progressInterval をモジュールレベル変数に昇格し、AbortController を追加。cancelPlanGeneration() をエクスポートして handleCancel から呼び出すことで、Plan生成フェーズの typing/progress/waitForResponse を即座にキャンセル可能にした。


### 2026-02-20
learningsスキル大幅拡充（2026-02-20）: .agent/skills/learnings/SKILL.md を181行→約320行に拡充。新セクション: 自律更新ルール、よくある失敗パターンと対策（6件）、ユーザー指摘履歴（表形式）、設計原則・ベストプラクティス、IPC通信、キュー・キャンセル処理（2段パイプライン図解）。MEMORY.md の知見を体系的に統合。


### 2026-02-20
ワークスペース自動起動エラー修正（2026-02-20）: cdpPool.ts doAcquire() の cdp.connect() が Antigravity 未起動時に失敗してた問題を修正。launchAntigravity は vscode.window.createTerminal を使うため CDP 接続不要。connect を try-catch で囲みスキップ可能にした。WorkspaceConnectionError クラスを追加し、sanitizeErrorForDiscord に依存しないユーザーフレンドリーなエラーメッセージを実装。ポーリングループ内にも try-catch を追加して防御的コーディングを強化。


### 2026-02-20
ワークスペースパス自動検知改善（2026-02-20）: guessBaseDirs() に USERPROFILE の親ディレクトリ（C:\Users）と USERPROFILE 自体を追加。ホームディレクトリ名（ysk41 等）もワークスペースフォルダとして自動学習可能に。Antigravity タイトルにはフルパスが含まれないため、CDP evaluate による直接パス取得は不可。タイトルには「ワークスペース名 — Antigravity」形式でフォルダ basename のみ含まれる。
