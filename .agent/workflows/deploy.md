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

4. Anti-Crow 経由のタスク内で実行している場合、IPC レスポンスファイルへの書き込みを完了する。次のステップで拡張ホストが再起動し IPC が中断されるため、必ずこのステップで書き込みを終えること。

5. Antigravity にインストールする（この後 IPC は中断される）
```
antigravity --install-extension anti-crow-0.1.0.vsix --force
```

6. 完了メッセージ: Antigravity を再起動してください（`Developer: Reload Window` または完全再起動）
