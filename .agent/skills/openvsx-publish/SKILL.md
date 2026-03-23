---
name: openvsx-publish
version: 1.0.0
description: Anti-Crow VSIX を Open VSX Registry に公開するためのデプロイスキル。namespace 作成済み、トークン管理、公開手順を網羅。
---

# Open VSX 公開スキル

Anti-Crow の VSIX パッケージを [Open VSX Registry](https://open-vsx.org/) に公開する手順書。

## 前提条件

- VSIX ファイルがビルド済み（`npm run bundle && npx vsce package`）
- トークンは Windows ユーザー環境変数 `OVSX_PAT` に保存済み

## アカウント情報

| 項目 | 値 |
|---|---|
| レジストリ URL | https://open-vsx.org/ |
| Publisher | `lucianlamp` |
| Namespace | `lucianlamp`（作成済み） |
| 拡張機能ページ | https://open-vsx.org/extension/lucianlamp/anti-crow |

## 公開手順

### Step 1: トークン確認

```powershell
# Windows ユーザー環境変数から自動取得
$env:OVSX_PAT
```

### Step 2: VSIX の存在確認

```powershell
# turbo
Test-Path anti-crow-*.vsix
(Get-Item anti-crow-*.vsix).Name
```

### Step 3: 公開

```powershell
npx -y ovsx publish anti-crow-{version}.vsix -p $env:OVSX_PAT
```

### Step 4: 確認

公開後、以下の URL でページを確認:
```
https://open-vsx.org/extension/lucianlamp/anti-crow
```

## R2 デプロイとの併用

Open VSX 公開と R2 デプロイは独立して実行可能。通常のリリースフローでは両方実行する:

1. `npm run bundle && npx vsce package` — VSIX ビルド
2. `npx ovsx publish` — Open VSX 公開
3. `npx wrangler r2 object put` — R2 アップロード（`r2-deploy` スキル参照）
4. `antigravity --install-extension` — ローカルインストール

## 注意事項

- **namespace の作成は初回のみ**。`lucianlamp` は作成済み。
- **ライセンス**: `package.json` は `"UNLICENSED"`（All Rights Reserved）。
- **リポジトリ**: プライベート。ソースコードは非公開のまま VSIX のみ配布。
- **バージョン**: `package.json` の `version` と VSIX ファイル名を一致させること。
