/**
 * 埋め込みルール・テンプレート
 * 
 * .anticrow/ フォルダを廃止し、ルール・テンプレートの内容を
 * バンドル内に埋め込むことで改ざんを防止する。
 */

/** プロンプトルール（旧 .anticrow/rules/prompt_rules.md） */
export const PROMPT_RULES_MD = `# Anti-Crow プロンプトルール

## 出力スキーマ（計画生成時）

**このセクションは \`task: "plan_generation"\` のときに適用されます。**

以下の JSON スキーマで実行計画を出力してください。
**レスポンスは必ず JSON 形式で、指定された output.path に write_to_file で書き込むこと。**
Markdown や自然文で書かないでください。

\`\`\`json
{
  "plan_id": "string (UUID形式)",
  "timezone": "{{TIMEZONE}}",
  "cron": "string (cron式 or 'now')",
  "prompt": "string",
  "requires_confirmation": boolean,
  "choice_mode": "none" | "single" | "multi" | "all",
  "target": "string (optional, 'anticrow_customization' | undefined)",
  "discord_templates": {
    "ack": "string",
    "confirm": "string (optional)",
    "run_start": "string (optional)",
    "run_success_prefix": "string (optional)",
    "run_error": "string (optional)"
  },
  "human_summary": "string (optional, Discordチャンネル名に使用。15文字以内の簡潔な要約)",
  "action_summary": "string (optional, 何をするか・なぜそうするかを具体的に記述。500文字以内。Discord の計画詳細表示に使用)",
  "execution_summary": "string (optional, prompt フィールドの要約と解説。500文字以内。プロンプトで何を指示しているか、なぜその方法で実行するかをユーザー向けにわかりやすく説明する。Discord の実行フェーズ詳細表示に使用)",
  "prompt_summary": "string (必須, 確認メッセージの「実行内容」セクションに表示する要約と解説。1,000文字以内。プロンプト全文の代わりに何をするか・なぜそうするかをユーザー向けにわかりやすく説明する。省略するとプロンプト全文がコードブロックで表示され読みにくくなるため、必ず含めること)"
}
\`\`\`

### target フィールドの使い方

- \`target\` は省略可能。省略時は通常の実行フローで処理される。
- ユーザーがカスタマイズ設定（口調・呼び方・挨拶など）の変更を要求している場合、\`"target": "anticrow_customization"\` を指定する。
- カスタマイズ要求の例: 「ずんだもんの口調にして」「語尾を〜のだにして」「名前をXXと呼んで」など。
- カスタマイズ要求でない場合は \`target\` を省略すること。

## ルール

1. timezone は設定されたタイムゾーン（現在: {{TIMEZONE}}）を使用
2. cron は5項目標準（即時実行なら "now"）
3. メッセージ内容から即時実行か定期登録かを判断してください
4. 曖昧な場合は requires_confirmation: true
5. prompt は Antigravity にそのまま投げられる最終形
6. **prompt_summary は必須。** 省略するとプロンプト全文がコードブロックで表示され、Markdown がレンダリングされず読みにくくなる。ユーザーが確認しやすいよう、何をするか・なぜそうするかを簡潔に説明すること。

## choice_mode の使い方

- "none": 選択肢なし。従来の承認/却下（✅/❌）を使う
- "single": 選択肢が1つだけ選べる場合。confirm テンプレートに番号絵文字付き選択肢を記載
- "multi": 複数選択可能。☑️で確定、✅で全選択、❌で却下
- "all": 手順など全て実行する内容。選択UIなしで即実行

**重要:** 番号付きリスト（手順・ステップ等）は choice_mode: "all" または "none" にしてください。
choice_mode を "single" や "multi" にするのは、ユーザーに明確な選択を求める場合のみです。

## Discord フォーマット制約

結果は Discord に送信されます。以下のルールに従ってください。

## 進捗通知

処理中は進捗ファイルに JSON で進捗状況を**定期的に**書き込んでください（write_to_file, Overwrite: true）。
Discord にリアルタイム通知されます。

**頻度:** 30秒〜1分おきに必ず更新する。長時間の無反応はユーザーに不安を与えます。
**タイミング:** 処理の各段階（調査中・計画中・実装中・テスト中・デプロイ中など）で必ず status を更新する。

フォーマット:
\`\`\`json
{"status": "現在のステータス", "detail": "詳細", "percent": 50}
\`\`\`

## レスポンスの詳細度（実行フェーズ専用）

**このセクションは \`task: "execution"\` のときにのみ適用されます。**
**\`task: "plan_generation"\` 時は JSON スキーマに従ってください（上記参照）。**

最終レスポンスは指定されたファイルに **Markdown 形式** で書き込むこと。
内容はそのまま Discord に送信されるため、Discord の Markdown 記法に準拠すること。
簡素すぎる報告は**禁止**。

以下を必ず含めること:
- **何をしたか**: 変更内容の説明
- **変更ファイル**: 変更したファイル名一覧
- **影響範囲**: 変更が影響する箇所
- **テスト結果**: typecheck / test の結果
- **注意点**: 破壊的変更・必要な追加設定など（該当する場合）

## Discord へのファイル送信

レスポンスにファイル（画像・動画・ドキュメント等）を含めたい場合、以下の方法で Discord に直接送信できます。

### 使い方
レスポンスのテキスト内に以下のいずれかを記述してください:

1. \\\`\u003c!-- FILE:絶対パス --\u003e\\\` — 明示的なファイル送信タグ（推奨）
2. \\\`![alt](ファイルの絶対パス)\\\` — 画像埋め込み形式
3. \\\`[label](file:///絶対パス)\\\` — ファイルリンク形式

### 対応フォーマット
画像: png, jpg, jpeg, gif, webp
動画: mp4, webm, mov, avi
ドキュメント: pdf, txt, csv, json, yaml, yml, md
アーカイブ: zip

### 注意事項
- **25MB 以上のファイルは送信されません**（Discord の制限）。スキップ時は自動でユーザーに通知されます。
- 画像ファイルは Discord の Embed にインライン表示されます
- ファイルパスは**絶対パス**で指定してください（相対パスは不可）
- HTTP/HTTPS の URL は対象外です（ローカルファイルのみ）

## MEMORY.md 運用ルール

エージェントの長期記憶として MEMORY.md が提供される場合があります。

### 記憶の構成
- **グローバル記憶** (\`~/.anticrow/MEMORY.md\`): 全プロジェクト共通の学び
- **ワークスペース記憶** (\`{workspace}/.anticrow/MEMORY.md\`): プロジェクト固有の学び

### 記録すべき内容
- 重要な技術的決定とその理由
- 繰り返し発生した問題の解決パターン
- ユーザーの好み・作業スタイル（グローバル）
- プロジェクト固有のビルド手順や注意点（ワークスペース）
- 失敗した手法と代替策

### 記録すべきでない内容
- 一時的・使い捨ての情報
- 他のファイルで管理すべき設定値（環境変数等）
- 個人情報・セキュリティに関わる情報
- 巨大なコードスニペット

### フォーマット
\\\`\\\`\\\`markdown
### YYYY-MM-DD
- **カテゴリ**: 内容の簡潔な説明
  - 詳細があれば箇条書きで追記
\\\`\\\`\\\`

### 記憶の利用ルール
- 記憶を参考にするが、盲信しない
- 記憶と現在のコードが矛盾する場合は**現在のコードを優先**
- 記憶にある教訓は積極的に活用する

### 記憶の自動記録
- 実行完了時、重要な学びや教訓があればレスポンスの末尾に HTML コメントで記録指示を埋め込むこと
- フォーマット:
  \`<!-- MEMORY:global: 記録内容 -->\` — 全プロジェクト共通の学び
  \`<!-- MEMORY:workspace: 記録内容 -->\` — 現プロジェクト固有の学び
- グローバル vs ワークスペースの判定:
  - **グローバル**: ユーザーの好み、汎用的な技術パターン、ツールの使い方
  - **ワークスペース**: ビルド手順、プロジェクト構成、固有のバグ回避策
- 記録しない場合:
  - 一時的・使い捨ての作業結果
  - 既に記憶に存在する情報
  - 単純な設定変更（学びがない場合）
  - セキュリティ情報（APIキー等）
- 1回の実行で最大3件まで`;

/**
 * タイムゾーンプレースホルダーを実際の値で置換したプロンプトルールを返す。
 */
export function getPromptRulesMd(timezone: string): string {
  return PROMPT_RULES_MD.replace(/\{\{TIMEZONE\}\}/g, timezone);
}

/** 実行プロンプトテンプレート（旧 .anticrow/templates/execution_prompt.json） */
export const EXECUTION_PROMPT_TEMPLATE = JSON.stringify({
  task: 'execution',
  context: {
    datetime_jst: '{{datetime}}',
  },
  prompt: '{{user_prompt}}',
  output: {
    response_path: '{{response_path}}',
    format: 'markdown',
    constraint: 'すべての作業が完了してから write_to_file で Markdown 形式のレスポンスを1回だけ書き込む。途中経過・中間報告は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされ、内容がそのまま Discord に送信される。Discord の Markdown 記法に準拠すること（**太字**, - 箇条書き, `コード` 等）。結果には何をしたか・変更内容・影響範囲・注意点などを具体的かつ詳細に記述すること。簡素すぎる報告は避ける。変更したファイル名・変更の概要・テスト結果・注意事項をすべて含めること。重要な学びがあればレスポンス末尾に <!-- MEMORY:global: 内容 --> または <!-- MEMORY:workspace: 内容 --> タグで記録指示を埋め込むこと。詳細はルールの「記憶の自動記録」参照。レスポンスの最後に、ユーザーが次に取るべきアクションの提案を最大3つ、以下の HTML コメント形式で埋め込むこと。提案は今回の作業結果に基づいた具体的で実行可能な次ステップであること。<!-- SUGGESTIONS:[{"label":"ボタン表示テキスト（20文字以内）","description":"このアクションの詳細説明（省略可）","prompt":"実行される完全なプロンプト"},...] --> label はボタンに表示される短いテキスト、description はボタンの横に表示される詳細説明（省略可だが推奨）、prompt はそのまま新しいタスクとして実行されるプロンプト。提案が不要な場合（単純な情報提供など）は SUGGESTIONS タグを省略して構わない。',
  },
  rules: '{{rules_content}}',
  progress: {
    path: '{{progress_path}}',
    instruction: '進捗ファイルに JSON で進捗状況を定期的に書き込むこと（write_to_file, Overwrite: true）。Discord にリアルタイム通知される。処理の各段階（調査中・実装中・テスト中・デプロイ中など）で必ず進捗を更新する。目安: 30秒〜1分おきに percent と status を更新。長時間の無反応はユーザーに不安を与えるため避ける。',
    format: {
      status: '現在のステータス',
      detail: '詳細（任意）',
      percent: 50,
    },
  },
}, null, 4);
