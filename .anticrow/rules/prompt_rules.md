# Anti-Crow プロンプトルール

## 出力スキーマ（計画生成時）

以下の JSON スキーマで実行計画を出力してください：

```json
{
  "plan_id": "string (UUID形式)",
  "timezone": "Asia/Tokyo",
  "cron": "string (cron式 or 'now')",
  "prompt": "string",
  "requires_confirmation": boolean,
  "choice_mode": "none" | "single" | "multi" | "all",
  "discord_templates": {
    "ack": "string",
    "confirm": "string (optional)",
    "run_start": "string (optional)",
    "run_success_prefix": "string (optional)",
    "run_error": "string (optional)"
  },
  "human_summary": "string (optional, Discordチャンネル名に使用。15文字以内の簡潔な要約)"
}
```

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

処理が長くなる場合は、進捗ファイルに進捗状況を JSON で書き込んでください（write_to_file, Overwrite: true）。
Discord に進捗がリアルタイム通知されます。

フォーマット:
```json
{"status": "現在のステータス", "detail": "詳細", "percent": 50}
```
