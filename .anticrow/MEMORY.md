

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


### 2026-02-20
docs/features.md（約12KB、222行）は Discord のメッセージ長制限（約4,000文字 = Embed含め約6,000文字相当）を超えるため、そのまま送信すると本文が届かない場合がある。長文ドキュメントの Discord 送信はセクション分割が必要。Anti-Crow 側の maxMessageLength 設定（デフォルト6,000）も影響する可能性あり。


### 2026-02-20
parsePlanJson失敗時のフォールバック改善（2026-02-21）: 警告メッセージ表示→通常メッセージ（Info, splitForEmbeds）送信に変更。messageHandler.ts の import に EmbedBuilder, splitForEmbeds, normalizeHeadings を追加。


### 2026-02-20
Anti-Crow差別化ロードマップ（2026-02-21）: ユーザーとの議論で優先順位決定。Phase1: テンプレート引数（パラメータ化テンプレート、{{変数}}でプレースホルダ置換、Discord モーダルで入力）→ Phase2: Workflow Pipeline（連鎖実行）→ Phase3: Git連携（/gitスラッシュコマンド）→ Phase4: プロジェクトダッシュボード → Phase5: インテリジェント提案（非侵入設計必須: 手動トリガー+定時レポート方式）。インテリジェント提案は作業中の割り込み感に注意。


### 2026-02-20
Anti-Crow UI設計原則（2026-02-21）: ユーザーの明確な方針としてスラッシュコマンドのサブコマンド方式は避け、ボタン中心UIを採用。3層構造: (1) スラッシュコマンド=エントリーポイントのみ、(2) Embed+ボタン=操作分岐・選択、(3) モーダル=テキスト入力。既存の /models, /modes, /history, 承認フローが既にこのパターン。新機能（テンプレート引数、Git連携等）もすべてこの方針で設計する。


### 2026-02-20
テンプレート引数（パラメータ化テンプレート）機能実装完了（2026-02-21）: templateStore.ts に TemplateArg 型、parseTemplateArgs()（{{xxx}}自動検出、BUILTIN_VARS除外、重複除去）、expandVariables に userArgs パラメータ追加。templateHandler.ts に tpl_modal_args_{name} モーダルと handleModalSubmit 拡張。save() で引数自動検出。Discord モーダル TextInput 最大5個制限あり。181テスト全パス（新規15件追加）。


### 2026-02-21
Anti-Crow 配布方法: VSIX 直接配布が最も安全で手軽。.vscodeignore がホワイトリスト方式でソースコード除外済み。受け取り側は (1) Discord Bot 作成（Message Content Intent + Server Members Intent）、(2) antigravity --install-extension で VSIX インストール、(3) AntiCrow: Set Bot Token でトークン設定、(4) clientId + allowedUserIds を設定。GitHub Actions での自動 VSIX リリースも可能（release.yml テンプレートあり）。


### 2026-02-21
Anti-Crow 販売方法（2026-02-21）: VS Code Marketplace は有料販売非対応。外部プラットフォーム（Lemonsqueezy推奨: 5%手数料+税金自動処理、Gumroad: 10%手数料）でライセンスキー発行→拡張機能内でAPI検証する方式が標準。類似拡張の価格帯: Cursor Pro $20/月、Copilot $10/月、Cline Teams $20/月。Anti-Crow推奨価格: 買い切り$29-49またはサブスク$5-10/月。フリーミアムモデル（基本無料+高度機能有料）が最適。


### 2026-02-21
Anti-Crow ライセンス強制戦略（2026-02-21）: VSIX 単体コピー対策として Discord Bot 側でのゲートキーピングが最も効果的。Bot トークンは per-user で allowedUserIds による制限が既に存在するため、追加でライセンスキー→Discord ID 紐付け検証を Bot 側に実装するだけで十分。拡張機能側の Lemonsqueezy API 検証はオプションの二重防御。サブスクモデルなら解約時に自動失効で管理コストも最小。


### 2026-02-21
autoOperation Pro限定化（2026-02-21）: PRO_ONLY_FEATURES セットを licenseGate.ts に新設し autoOperation を登録。uiWatcher.ts に isProCheck コールバックを注入する設計で循環依存を回避。extension.ts に getLicenseGate() アクセサを追加し bridgeLifecycle.ts から参照。Free プランでは autoOperation 設定 ON でもダイアログ自動クリックが無効化される。


### 2026-02-21
開発者ID全機能解放（2026-02-21）: licenseGate.ts に developerOverride フラグ + setDeveloperOverride() メソッドを追加。isPro() で開発者オーバーライド時は常に true を返し全ゲート（isFeatureAllowed, isCommandAllowed, canSaveTemplate, canAddWorkspace, requirePro）を自動バイパス。extension.ts の activate 時に allowedUserIds に isDeveloper() 該当 ID があれば永続オーバーライド設定。一般ユーザー環境では発動しない。


### 2026-02-21
確認フロー改善（2026-02-21）: discordReactions.ts に activeCollectors Map と cancelActiveConfirmation() を追加。3つの waitFor 関数（waitForConfirmation, waitForChoice, waitForMultiChoice）からタイムアウト（300秒）を完全削除し、コレクタを Map に登録して外部キャンセル可能に。messageHandler.ts の enqueueMessage で confirming フェーズ検出時に cancelActiveConfirmation を呼び出して自動却下。discordBot.ts のラッパーメソッドからも timeoutMs パラメータを削除。


### 2026-02-21
/suggest スラッシュコマンド実装（2026-02-21）: slashCommands.ts にコマンド定義追加、discordBot.ts に mapCommandToIntent 追加、adminHandler.ts に handleSuggest 追加。Bot 自身のメッセージは author.bot チェックで無視されるため、チャンネルへのメッセージ送信方式は不可。代わりに合成 Message オブジェクト（interaction.user を author に設定）を作成して enqueueMessage に直接フィードする方式を採用。これにより通常のメッセージパイプライン（Plan生成→確認→実行→提案抽出）がそのまま動く。


### 2026-02-21
choice_mode=single/multi 選択結果反映バグ修正（2026-02-21）: handleConfirmation の返り値を boolean → ConfirmationResult（{ confirmed, selectedChoices? }）に拡張。applyChoiceSelection ヘルパー関数で selectedChoices がある場合に plan.prompt の先頭に「【重要】選択肢 N のみ実行」指示を付加。呼び出し元2箇所（handleDiscordMessage, processSuggestionPrompt）で applyChoiceSelection を呼び出し。全選択（[-1]）は prompt 修正不要。283テスト全パス。


### 2026-02-21
clickCancelButton メインフレームフォールバック追加（2026-02-21）: evaluateInCascade が iframe コンテキスト取得に失敗した場合に conn.evaluate（メインフレーム全体）で同じ CANCEL_BUTTON_JS を実行するフォールバック戦略（main-js）を追加。clickElement フォールバックにも inCascade: false 候補と tooltip-id セレクタを追加。戦略は6段階: vscode-cmd → cascade-js → main-js → button:cascade → button:main → escape。handleCancel のレスポンスで escape のみの場合を明示。


### 2026-02-21
parsePlanJson バリデーション緩和（2026-02-21）: cron フィールドは null を許容（即時実行の正当な値として '' に変換）。requires_confirmation フィールドは欠落時に false をデフォルト使用。これにより plan_generation レスポンスが不必要にリジェクトされてテキスト表示される問題を防止。


### 2026-02-21
typing interval リーク修正（2026-02-21）: messageHandler.ts の currentPlanTypingInterval / currentPlanProgressInterval をモジュールレベル単一変数から Set<NodeJS.Timeout> に変更。generatePlan 内でローカル変数を使い Set に追加、finally で自分の interval のみ削除。複数メッセージ並行処理時の interval 上書き・リーク問題を解消。cancelPlanGeneration は Set 全体をクリア。


### 2026-02-21
.env管理実装（2026-02-21）: esbuild.js に dotenv + define オプションを追加し、PURCHASE_URL と LEMON_API_BASE をビルド時注入方式で.envから読み込み可能にした。.env がなくてもデフォルト値でフォールバック。licenseGate.ts で PURCHASE_URL を export し licenseCommands.ts から import 参照に統一（ハードコード3箇所を解消）。dotenv は devDependencies。


### 2026-02-21
Pro限定コマンド解除（2026-02-21）: PRO_ONLY_COMMANDS を空Set化（models/mode/history を削除）、PRO_ONLY_FEATURES から suggestions を削除。現在 Pro 限定なのは autoOperation のみ。Free プランのリソース制限（テンプレート3個、ワークスペース1個）は維持。将来 Pro 限定に戻す場合は Set に追加するだけで復元可能。


### 2026-02-21
ExecutorPool に postSuggestions コールバック未設定バグ修正（2026-02-21）: executorPool.ts の constructor と getOrCreate() に PostSuggestionsFunc パラメータを追加。bridgeLifecycle.ts の ExecutorPool 初期化に sendComponentsToChannel コールバックを追加。単体 Executor には元々渡されていたが ExecutorPool 経由のパスで欠落していた。今後 Executor に新しいオプション引数を追加する場合は ExecutorPool にも忘れず追加すること。


### 2026-02-21
WebView購入・ライセンス認証パネル実装（2026-02-21）: licenseWebview.ts を新規作成。VS Code WebviewPanel API でダーク系テーマの2ステップUI（購入ページ→キー入力）を実装。postMessage で拡張との通信、成功時3秒後自動クローズ。getWebviewHtml() をテスト可能な純関数として分離。licensePurchase コマンドを QuickPick から WebView に置き換え。CSP に lemonsqueezy.com を許可。Lemonsqueezy が iframe をブロックする場合に備え「ブラウザで開く」方式を採用。


### 2026-02-21
プラン別購入ボタン実装（2026-02-21）: iframe/Lemon.js方式を検討したが、VS Code WebViewのサンドボックス制約（Cookie/リダイレクト制限）とセキュリティ（決済ページのiframe埋め込みはフィッシング対策的に非推奨）の理由で取りやめ。openExternal方式を維持し、プラン別ボタン（PURCHASE_URL_MONTHLY/PURCHASE_URL_LIFETIME）を追加。getWebviewHtmlにmonthlyUrl/lifetimeUrlパラメータを追加。CSPからframe-srcを削除。298テスト全パス。


### 2026-02-21
/license スラッシュコマンドを /pro にリネーム（2026-02-21）: slashCommands.ts (.setName('pro'))、discordBot.ts (mapCommandToIntent)、adminHandler.ts (handlePro)。handlePro は Embed+ActionRow ボタン方式（Monthly/Lifetime LinkButton + 情報ボタン + キー入力モーダルボタン）。Discord モーダルからのキー入力は BridgeContext.setLicenseKeyFn コールバック経由で SecretStorage 保存→LS API 検証。slashHandler.ts に pro_info/pro_key_input ボタンと pro_key_modal モーダルハンドラを追加。convex/ フォルダと scripts/setup-licensing.ts は削除済み。


### 2026-02-21
Phase 4 トライアル機能実装完了（2026-02-21）: licenseChecker.ts に TRIAL_DURATION_MS（14日）と GLOBAL_STATE_TRIAL_START 定数、initTrial()/getTrialDaysRemaining()/isTrialActive() メソッドを追加。LicenseType に 'trial'、LicenseReason に 'trial_active'/'trial_expired' を追加。check() のキーなし分岐でトライアル判定（globalState に開始日記録、14日以内なら valid:true/type:trial/reason:trial_active）。isPro() に trial 対応。bridgeContext.ts に getTrialDaysRemaining コールバック追加、extension.ts で接続、adminHandler.ts の /pro コマンドでトライアル残り日数表示。package.json に antiCrow.licenseStatus 読み取り専用設定を追加。


### 2026-02-21
licenseChecker トライアルテスト追加（2026-02-21）: licenseChecker.test.ts 新規作成、25テスト。vi.useFakeTimers + globalState モックで時刻制御。発見: FREE_STATUS.valid は true なので trial_expired でも valid=true。Math.ceil(0) の -0 問題あり。全323テスト全パス。


### 2026-02-21
提案ボタン description フィールド追加（2026-02-21）: SuggestionItem に description?: string を追加。suggestionButtons.ts に buildSuggestionContent() 関数追加（description ある場合は絵文字付きリスト表示、なければ従来の見出しのみ）。embeddedRules.ts の constraint で description を「省略可だが推奨」として案内。後方互換あり。


### 2026-02-21
stale response Phase 2 再送実装完了（2026-02-22）: bridgeLifecycle.ts の recoverStaleResponses 後に、Bot 初期化完了後 #agent-chat チャンネルへ未配信レスポンスを再送する機能を実装。discordBot.ts に findFirstAgentChatChannelId() メソッドを追加。format=md はそのまま、json は extractResult() で整形。再送成否に関わらずファイル削除（無限ループ防止）。Bot 未初期化時はログ+削除にフォールバック。


### 2026-02-21
DOM実機調査（2026-02-22）: cancel ボタン（input-send-button-cancel-tooltip）は BUTTON ではなく DIV 要素。clickElement フォールバックの tag: 'button' では一切マッチしない。また audio-tooltip（マイクボタン）が SVG rect を含むため、CANCEL_BUTTON_JS の戦略A（SVG rect 検出）で誤検出リスクあり。CANCEL_BUTTON_JS 戦略0（querySelector直接 + click）は DIV でも動作するが、evaluateInCascade のコンテキスト問題の可能性残る。


### 2026-02-21
clickCancelButton 4箇所修正完了（2026-02-22）: (1) 戦略0 offsetParent チェック撤廃→DIV でも即クリック、レスポンスに tag/visible 追加 (2) 戦略A/B にマイクボタン除外フィルタ（audio-tooltip + record aria-label）追加 (3) デバッグ返り値に cancelTooltipExists/Tag/Visible + textboxFound + 各ボタン tooltipId 追加 (4) clickElement フォールバックの tooltip-id 候補から tag: 'button' 削除（DIV 対応）。根本原因: cancel ボタンは BUTTON ではなく DIV 要素だった。


### 2026-02-21
Allow / Always Allow ボタン自動承認追加（2026-02-22）: uiWatcher.ts の DEFAULT_AUTO_CLICK_RULES に allow-browser（text:'Allow'）と always-allow-browser（text:'Always Allow'）を追加。Cancel ボタンと違い、Allow ボタンは標準 BUTTON 要素＋テキストラベルなので DOM 実機調査は不要。既存の「Always run」「Continue」と同じテキストマッチパターンで動作する。


### 2026-02-22
ステータスバー統合完了（2026-02-22）: LicenseStatusBar（Right, priority=90）を廃止し、メインステータスバー（Left, priority=100）にライセンス情報を統合。bridgeLifecycle.ts に getPlanName/getLicenseSuffix/getLicenseTooltipLine を新設。extension.ts で LicenseChecker.onChange → updateStatusBar を呼び出してリアクティブ更新。trial タイプの getPlanName ケースも追加（残り日数付き）。getLicenseChecker() アクセサを extension.ts に追加。


### 2026-02-22
/queue コマンド改善（2026-02-22）: messageHandler.ts に workspaceWaitingMessages Map（待機メッセージ追跡）と clearWaitingMessages() を追加。getMessageQueueStatus に waiting フィールド追加。adminHandler.ts の handleQueue で空セクション（実行中のタスク: なし、実行待ち: なし）を削除し、待機中メッセージの内容・経過時間表示と削除ボタン（queue_clear_waiting）を追加。slashHandler.ts にボタンハンドラ追加。


### 2026-02-22
/history 時間表示日本語化+ワークスペース名表示（2026-02-22）: historyButtons.ts に formatTimeAgoJa() を追加（m→分前、h→時間前、d→日前、w→週間前、mo→ヶ月前、y→年前）。buildHistoryListEmbed に workspaceName パラメータ追加。adminHandler.ts と slashHandler.ts で cdp.getActiveTargetTitle() からワークスペース名を抽出（「— Antigravity」除去）。cdpHistory.ts に debugConversationAttributes() デバッグ関数を追加し、会話アイテム BUTTON の全属性を収集。ワークスペースフィルタリングは Phase B のデバッグ結果次第。


### 2026-02-22
キューカウント不整合の根本原因と修正（2026-02-22）: (1) resetProcessingFlag に currentProcessingStatuses.clear() 漏れ、(2) cancelPlanGeneration に workspaceQueueCount/workspaceWaitingMessages の clear() 漏れ、(3) getMessageQueueStatus の total が workspaceQueueCount 合計から算出されており processing/waiting の実態と乖離 → processing.length + waiting.length から直接計算に変更、(4) enqueueMessage finally でカウント0のMapエントリが残存 → delete に変更、(5) adminHandler の waitingCount = total - processing.length 逆算式を廃止し配列ベース表示に変更。教訓: 状態を複数のMapで管理する場合は同期保証が必須。単一の情報源（配列）から派生値を計算する方式が安全。


### 2026-02-22
テンプレート環境変数サポート追加（2026-02-22）: templateStore.ts の expandVariables に {{env:VARIABLE_NAME}} パターンの展開を追加（process.env から取得、未定義は空文字列）。parseTemplateArgs の正規表現を [a-zA-Z0-9_:] に拡張し env: プレフィックスを除外（カスタム引数として検出しない）。regression-prevention スキルを新規作成し、learnings スキルに変更影響チェックリストと回帰テスト必須パターンを追記。40テスト全パス。


### 2026-02-22
/templates → /template リネーム完了（2026-02-22）: slashCommands.ts、discordBot.ts、adminHandler.ts（handleTemplates→handleTemplate + COMMAND_HANDLERS キー変更）の3ファイルでコマンド名変更。templateHandler.ts の buildTemplateListPanel に変数ガイド（組み込み変数・環境変数・カスタム引数の使い方）を追加。テンプレート0件時もガイド表示。workspace 変数は組み込みに存在するが一覧から除外（channel も同様）。


### 2026-02-22
スケジュール機能強化 Phase 1 完了（2026-02-22）: scheduleButtons.ts に naturalTextToCron() を新規実装（日本語15パターン対応: 毎日/毎朝/毎晩/毎時/N分おき/N時間おき/毎週+曜日/平日/毎月+日）。buildScheduleListEmbed に sched_new ボタン + 変数ガイド追加。slashHandler.ts に sched_new ボタンハンドラ（3フィールドモーダル: プロンプト/スケジュール/名前）と sched_modal_new モーダルハンドラ（自然文cron変換 → Plan生成 → PlanStore.add → scheduler.register）を追加。カスタム引数は定期実行では使用不可（モーダル入力ができないため）。


### 2026-02-22
スケジュール機能 Phase 2 完了（2026-02-22）: scheduleButtons.ts に ▶️ 即時実行（sched_run_{id}）+ ✏️ 編集（sched_edit_{id}）ボタンを追加（4ボタン/行）。slashHandler.ts に sched_run ハンドラ（TemplateStore.expandVariables で変数展開→Plan 複製→enqueueImmediate）、sched_edit ハンドラ（既存値入りモーダル表示）、sched_modal_edit ハンドラ（naturalTextToCron 変換→planStore.update→scheduler.unregister+register）を追加。即時実行は元の Plan を変更せず複製で実行する設計。


### 2026-02-22
確認フローのボタン化完了（2026-02-22）: discordReactions.ts を ReactionCollector ベースから ButtonBuilder + createMessageComponentCollector ベースに全面書き換え。waitForConfirmation は ✅/❌ の2ボタン、waitForChoice は選択肢ボタン（最大3）+ ❌、waitForMultiChoice はトグルボタン（Secondary↔Primary + ✓ラベル）+ ☑️確定/✅全選択/❌拒否。操作完了後は全ボタン無効化（disableAllButtons ユーティリティ）。外部インターフェース（関数シグネチャ・戻り値型）は維持。countChoiceItems の上限を10→3に変更。embeddedRules.ts に最大3制限を追記。message.components の型は TopLevelComponent なので ButtonBuilder.from() が使えず、手動で再構成する必要がある。
