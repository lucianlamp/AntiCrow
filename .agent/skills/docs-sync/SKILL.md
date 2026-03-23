---
name: docs-sync
version: 1.0.0
description: 機能変更時に GitBook ドキュメント（docs/ja/, docs/en/）を自動で更新するスキル。コード変更の差分を分析し、該当するドキュメントページを特定・更新する。
---

# Docs Sync スキル

機能を追加・変更・削除した後に、GitBook ドキュメント（`docs/ja/`, `docs/en/`）を自動的に同期更新する。

## いつ使うか

以下のいずれかに該当する場合、このスキルを適用する:

- **機能の追加・変更・削除** を行った後
- **設定ファイルのスキーマ変更**（例: `teamConfig.ts` のプロパティ追加・削除）
- **コマンドの追加・削除・パラメータ変更**（例: スラッシュコマンド、auto-mode のオプション）
- **ユーザーが「ドキュメントも更新して」と明示的に依頼した場合**
- deploy ワークフロー実行の直前

## ドキュメント構造

```
docs/
├── ja/                     # 日本語版（メイン）
│   ├── .gitbook.yaml       # GitBook 設定
│   ├── README.md           # はじめに
│   ├── SUMMARY.md          # 目次
│   ├── getting-started.md  # インストール・初期設定
│   ├── basic-usage.md      # 基本的な使い方
│   ├── commands.md         # スラッシュコマンド一覧
│   ├── auto-mode.md        # 連続オートモード
│   ├── team-mode.md        # エージェントチームモード
│   ├── templates.md        # テンプレート機能
│   ├── schedules.md        # スケジュール実行
│   ├── pricing.md          # 料金プランと制限
│   ├── pro-plan.md         # Pro プラン
│   ├── platform-differences.md  # 環境別セットアップ
│   ├── faq.md              # よくある質問
│   ├── disclaimer.md       # 免責事項
│   ├── privacy.md          # プライバシーポリシー
│   └── security.md         # セキュリティポリシー
└── en/                     # 英語版（ja/ と同じ構造）
    └── ...                 # ja/ と1:1対応
```

## 機能→ドキュメント対応表

| 変更対象 | 対応ドキュメント |
|----------|-----------------|
| チームモード (`teamOrchestrator.ts`, `teamConfig.ts`) | `team-mode.md` |
| オートモード (`autoModeController.ts`) | `auto-mode.md` |
| スラッシュコマンド (`slashButton*.ts`, `adminHandler.ts`) | `commands.md` |
| テンプレート (`templateManager.ts`) | `templates.md` |
| スケジュール (`schedulerManager.ts`) | `schedules.md` |
| ライセンス・課金 (`licenseManager.ts`) | `pricing.md`, `pro-plan.md` |
| 初期設定・接続 (`discordBot.ts`, `configHelper.ts`) | `getting-started.md` |
| セーフティガード (`safetyGuard.ts`) | `auto-mode.md`, `security.md` |
| 基本操作フロー | `basic-usage.md` |
| 環境依存の変更 | `platform-differences.md` |

## 更新手順

### Step 1: 変更内容の分析

コード変更の差分を確認し、**ユーザー向けに影響がある変更**を特定する:

```bash
# 直近のコミットの差分を表示
git diff HEAD~1 --stat
git diff HEAD~1 -- src/
```

以下は**ドキュメント更新不要**な変更:
- 内部リファクタリング（ユーザー向け挙動変更なし）
- テストファイルの変更
- ビルド設定の変更
- コメントのみの変更

### Step 2: 該当ドキュメントの特定

上記の対応表を使い、影響を受けるドキュメントページを特定する。

### Step 3: 日本語版（`docs/ja/`）を更新

**日本語版を先に更新する**（メイン言語）。

更新ルール:
- **事実のみを記載**: コードの実際の動作に基づいて記述する
- **設定項目の増減**: 追加されたパラメータは説明を追加、削除されたパラメータは説明を削除
- **コマンド変更**: 新しいコマンドやオプションのドキュメントを追加
- **既存の文体を維持**: 周囲のドキュメントと同じトーンで書く
- **GitBook 記法を守る**: ヒント、警告は GitBook の記法で記載

### Step 4: 英語版（`docs/en/`）を同期更新

日本語版の変更を英語版に反映する:
- **構造を1:1で維持**: セクション構成を揃える
- **自然な英語に翻訳**: 機械翻訳のような不自然な表現を避ける
- **技術用語はそのまま**: コマンド名、パラメータ名、ファイルパスは原文のまま

### Step 5: SUMMARY.md の更新（必要な場合のみ）

新しいドキュメントページを追加した場合のみ、`docs/ja/SUMMARY.md` と `docs/en/SUMMARY.md` にリンクを追加する。

### Step 6: コミット

```bash
git add docs/
git commit -m "docs: update documentation for [変更した機能名]"
```

## 注意事項

- **privacy.md / security.md / disclaimer.md** は法的文書のため、機能変更で自動更新しない。変更が必要な場合はユーザーに確認する。
- **SUMMARY.md** はページの追加・削除時のみ更新。既存ページの内容更新では触らない。
- **画像やスクリーンショット** はドキュメントに含めない（GitBook が外部ホスティングを使用するため）。
