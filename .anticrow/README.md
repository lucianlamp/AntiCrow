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
│   └── execution_prompt.md     # 実行プロンプトテンプレート
└── README.md
```

## 各ディレクトリの用途

| ディレクトリ | 用途 | 読み込み元 |
| --- | --- | --- |
| `config/` | 拡張機能の動作設定（JSON） | `executor.ts` が起動時に読み込み |
| `rules/` | AI に送るプロンプトのルール・制約 | AI が `view_file` で読み取り |
| `templates/` | プロンプト構築テンプレート | `executor.ts` が起動時に読み込み |

## ルール

1. Anti-Crow 拡張機能固有の設定・ルールはすべてこのディレクトリに配置する
2. `.agent/` は Antigravity のスキル・ワークフロー用。拡張機能固有のものは `.anticrow/` に分離する
3. `config/` 内の JSON は拡張機能の TypeScript コードが直接読み込む（コード変更なしで動作変更可能）
4. `rules/` と `templates/` は AI のプロンプトに影響する（プロンプトの内容をコード変更なしで調整可能）
