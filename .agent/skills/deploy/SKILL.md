---
name: deploy
description: anti-crow をビルド・VSIX パッケージして Antigravity にインストールする
---

# Deploy Skill

anti-crow プロジェクトをビルドし、VSIX パッケージを作成して Antigravity にインストールします。

> **重要:** anti-crow 拡張機能のコードを改修した場合は、改修完了後に必ずこの deploy スキルの手順を実行し、デプロイまで完了させてください。コード変更だけで終わらせず、TypeScript コンパイル → esbuild バンドル → VSIX パッケージ作成 → Antigravity インストールの一連の流れを改修作業の一部として行ってください。

## 手順

すべてのコマンドはプロジェクトルート `c:\Users\ysk41\dev\anti-crow` で実行してください。
各ステップは `SafeToAutoRun: true` で自動実行してください。

### 1. TypeScript コンパイル

```
npm run compile
```

コンパイルエラーが発生した場合はエラー内容を報告し、デプロイを中止してください。

### 2. esbuild バンドル

```
npm run bundle
```

### 3. VSIX パッケージ作成

```
npx -y @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license --baseContentUrl "." --baseImagesUrl "."
```

`--no-dependencies` を付けることで、`npm install` を内部で実行しません（バンドル済みのため不要）。
成功すると `anti-crow-X.X.X.vsix` ファイルが生成されます。

### 4. Antigravity にインストール

```
antigravity --install-extension anti-crow-0.1.0.vsix --force
```

`--force` で既存バージョンを上書きインストールします。

### 5. 完了

デプロイ完了を報告してください。反映には Antigravity の再起動（`Developer: Reload Window` または完全再起動）が必要です。

> **注意:** 以前の手動コピー先（`~/.antigravity/extensions/ytvar.anti-crow-0.1.0/`）に古いファイルが残っている場合は、競合を防ぐため削除してください。
