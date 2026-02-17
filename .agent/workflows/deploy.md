---
description: ビルドして VSIX パッケージを作成し Antigravity にインストールする
---

// turbo-all

1. TypeScript をコンパイルする
```
npm run compile
```

2. esbuild でバンドルする
```
npm run bundle
```

3. VSIX パッケージを作成する
```
npx -y @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

4. Antigravity にインストールする
```
antigravity --install-extension anti-crow-0.1.0.vsix --force
```

5. 完了メッセージ: Antigravity を再起動してください（`Developer: Reload Window` または完全再起動）
