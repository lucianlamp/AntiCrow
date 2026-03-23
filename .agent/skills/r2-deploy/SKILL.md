---
name: r2-deploy
version: 1.0.0
description: Anti-Crow VSIX を Cloudflare R2 にアップロードして /update コマンドで配布するためのデプロイスキル。手順・キー設計・既知の問題を網羅。
---

# R2 デプロイスキル

Anti-Crow の VSIX パッケージを Cloudflare R2 にアップロードし、Discord `/update` コマンドで配布可能にする手順書。

## 前提条件

- `npx wrangler` が実行可能（グローバルインストール不要）
- Cloudflare アカウントにログイン済み（`npx wrangler login`）
- VSIX ファイルがビルド済み（`npm run compile && npm run bundle && npx vsce package`）

## R2 バケット情報

| 項目 | 値 |
|---|---|
| バケット名 | `anticrow-releases` |
| キー配置 | **バケット直下**（プレフィックスなし） |
| パブリック URL | `https://pub-43d0b2eef4734fc8b00c014791e17d8a.r2.dev/` |

## R2 キー設計

```
anticrow-releases/
├── latest.json                 # メタデータ（/update が参照）
└── anti-crow-{version}.vsix    # VSIX 本体（例: anti-crow-0.1.1.vsix）
```

### latest.json スキーマ

```json
{
  "version": "0.1.1",
  "uploadedAt": "2026-03-12T20:03:00+09:00",
  "fileName": "anti-crow-0.1.1.vsix"
}
```

- `version`: package.json の version と一致させる
- `uploadedAt`: ISO 8601 形式（JST: +09:00）
- `fileName`: R2 のオブジェクトキーと**完全一致**させる（`slashButtonUpdate.ts` が `buildR2Url(latestInfo.fileName)` で URL を構築するため）

## アップロード手順

### Step 1: VSIX の存在確認

```powershell
Test-Path anti-crow-*.vsix
(Get-Item anti-crow-*.vsix).Length
```

### Step 2: latest.json の作成

```powershell
# dist/ ディレクトリに作成（.gitignore 対象）
if (-not (Test-Path dist)) { New-Item -ItemType Directory -Path dist }
'{"version":"0.1.1","uploadedAt":"2026-03-12T20:03:00+09:00","fileName":"anti-crow-0.1.1.vsix"}' | Out-File -FilePath dist/latest.json -Encoding utf8NoBOM
```

### Step 3: VSIX アップロード

```powershell
npx wrangler r2 object put anticrow-releases/anti-crow-0.1.1.vsix --file=anti-crow-0.1.1.vsix
```

### Step 4: latest.json アップロード

```powershell
npx wrangler r2 object put anticrow-releases/latest.json --file=dist/latest.json
```

### Step 5: アップロード確認

```powershell
# latest.json の内容を確認
npx wrangler r2 object get anticrow-releases/latest.json --pipe
```

## /update コマンドとの連携

- `slashButtonUpdate.ts` が `latest.json` を取得してバージョン比較
- `RELEASES_PATH = ''`（バケット直下）
- `buildR2Url(latestInfo.fileName)` で VSIX ダウンロード URL を動的構築
- `LatestInfo` インターフェース: `{ version, uploadedAt, fileName }`

## 既知の問題と注意点

### ⚠️ パブリック URL のプレフィックス問題

`pub-*.r2.dev` パブリック URL では、プレフィックス付きキー（例: `anti-crow/releases/latest.json`）が **404 を返す**。

**解決策**: バケット直下にキーを配置する（プレフィックスなし）。

### ⚠️ CDN キャッシュ遅延

`wrangler r2 object put` で上書きしても、`pub-*.r2.dev` のパブリック URL では**旧データのキャッシュが返る**場合がある（数分〜数時間）。

- `wrangler` 経由では即時確認可能
- キャッシュ更新を待つか、`Cache-Control` ヘッダーの設定を検討

### ⚠️ wrangler コマンド

`wrangler` 単体ではなく **`npx wrangler`** を使用すること。PATH に入っていない場合がある。

### ⚠️ dist/latest.json

`.gitignore` に含まれるため、`git add` しても追跡されない。生成ファイルとして扱う。

## コマンドリファレンス

```powershell
# バケット内のオブジェクト一覧
npx wrangler r2 object list anticrow-releases

# オブジェクトのアップロード
npx wrangler r2 object put anticrow-releases/{キー} --file={ローカルパス}

# オブジェクトの取得（パイプ出力）
npx wrangler r2 object get anticrow-releases/{キー} --pipe

# オブジェクトの削除
npx wrangler r2 object delete anticrow-releases/{キー}

# ローカルファイルにダウンロード
npx wrangler r2 object get anticrow-releases/{キー} --file={ローカルパス}
```

## チェックリスト

R2 デプロイ時に確認すべき項目:

- [ ] VSIX ファイルが存在する
- [ ] package.json の version と latest.json の version が一致している
- [ ] latest.json の fileName が VSIX のファイル名と一致している
- [ ] `npx wrangler r2 object get --pipe` で latest.json の内容が正しい
- [ ] uploadedAt が現在時刻（JST）で正しい
