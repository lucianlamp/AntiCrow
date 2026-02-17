## コンテキスト

現在時刻(JST): {{datetime}}

{{user_prompt}}

## 重要: 出力方法

結果をすべて以下のファイルパスに write_to_file ツールで書き込んでください。
チャットにも結果を出力してください。
ファイルパス: {{response_path}}

{{rules_content}}

## 進捗通知（任意）

処理が長くなる場合は、進捗ファイルに進捗状況を JSON で書き込んでください（write_to_file, Overwrite: true）。
Discord に進捗がリアルタイム通知されます。

フォーマット:
```json
{"status": "現在のステータス", "detail": "詳細（任意）", "percent": 50}
```

## 進捗通知ファイルパス

進捗通知を送る場合のファイルパス: {{progress_path}}
