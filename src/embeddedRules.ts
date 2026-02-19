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
  "timezone": "Asia/Tokyo",
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
  "human_summary": "string (optional, Discordチャンネル名に使用。15文字以内の簡潔な要約)"
}
\`\`\`

### target フィールドの使い方

- \`target\` は省略可能。省略時は通常の実行フローで処理される。
- ユーザーがカスタマイズ設定（口調・呼び方・挨拶など）の変更を要求している場合、\`"target": "anticrow_customization"\` を指定する。
- カスタマイズ要求の例: 「ずんだもんの口調にして」「語尾を〜のだにして」「名前をXXと呼んで」など。
- カスタマイズ要求でない場合は \`target\` を省略すること。

## ルール

1. timezone は必ず "Asia/Tokyo"
2. cron は5項目標準（即時実行なら "now"）
3. メッセージ内容から即時実行か定期登録かを判断してください
4. 曖昧な場合は requires_confirmation: true
5. prompt は Antigravity にそのまま投げられる最終形

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
- **注意点**: 破壊的変更・必要な追加設定など（該当する場合）`;

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
        constraint: 'すべての作業が完了してから write_to_file で Markdown 形式のレスポンスを1回だけ書き込む。途中経過・中間報告は書き込まない。ファイルに書き込んだ時点でレスポンス完了と見なされ、内容がそのまま Discord に送信される。Discord の Markdown 記法に準拠すること（**太字**, - 箇条書き, `コード` 等）。結果には何をしたか・変更内容・影響範囲・注意点などを具体的かつ詳細に記述すること。簡素すぎる報告は避ける。変更したファイル名・変更の概要・テスト結果・注意事項をすべて含めること。',
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
