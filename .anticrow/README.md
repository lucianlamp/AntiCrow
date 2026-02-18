# .anticrow ディレクトリ

Anti-Crow 拡張機能が利用するプロジェクト固有のファイルを格納するディレクトリです。

## 構成

```
.anticrow/
├── config/
│   └── auto_click_rules.json   # UI 自動クリックルール
├── rules/
│   └── prompt_rules.md         # AI プロンプトルール・スキーマ定義
├── templates/
│   └── execution_prompt.json   # 実行プロンプトテンプレート（JSON）
└── README.md
```

## 各ディレクトリの用途

| ディレクトリ | 用途 | 読み込み元 |
| --- | --- | --- |
| `config/` | 拡張機能の動作設定（JSON） | `executor.ts` が起動時に読み込み |
| `rules/` | AI に送るプロンプトのルール・制約 | `promptBuilder.ts` が JSON 変換し一時ファイルに書き出し → AI が `view_file` で読み取り |
| `templates/` | プロンプト構築テンプレート（JSON） | `executor.ts` が起動時に読み込み、変数展開後に一時ファイルへ書き出し |

## プロンプト一時ファイル方式

プロンプトは直接 CDP に渡さず、IPC ディレクトリの一時ファイルに書き出されます。
CDP には `view_file` で一時ファイルを読み込む1行指示のみが送信されます。

```
CDP入力: "以下のファイルを view_file ツールで読み込み、その指示に従ってください。ファイルパス: <path>"
```

一時ファイルは処理完了後に自動削除されます。

## ルール

1. Anti-Crow 拡張機能固有の設定・ルールはすべてこのディレクトリに配置する
2. `.agent/` は Antigravity のスキル・ワークフロー用。拡張機能固有のものは `.anticrow/` に分離する
3. `config/` 内の JSON は拡張機能の TypeScript コードが直接読み込む（コード変更なしで動作変更可能）
4. `rules/` と `templates/` は AI のプロンプトに影響する（プロンプトの内容をコード変更なしで調整可能）
