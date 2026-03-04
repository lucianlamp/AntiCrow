# AntiCrow セキュリティ監査レポート

**監査日**: 2026-02-20
**対象バージョン**: 0.1.0
**全体リスクレベル**: **Low（低）** 🟢

---

## セキュリティ監査サマリー

AntiCrow のセキュリティ体制は全体的に **良好** です。機密情報は VS Code の SecretStorage に暗号化保存され、ソースコードにハードコードされていません。ビルド時のコード難読化（minify + sourcemap 無効）と VSIX のホワイトリスト方式（`.vscodeignore`）により、リバースエンジニアリング対策も適切に実装されています。アクセス制御はユーザーID ベースのホワイトリスト方式を採用し、デフォルトで全ユーザー拒否というセキュアなデフォルトが設定されています。

---

## 詳細評価

### 1. 機密情報の管理

**評価: Low Risk 🟢**

- **Bot トークン**: VS Code の `SecretStorage` に暗号化保存（`extension.ts` → `setToken` コマンド）
- **ハードコードされた秘密情報**: なし
- **環境変数経由の秘密情報**: なし（すべて VS Code 設定 API 経由）
- **ログへの秘密情報混入**: なし（`logger.ts` 経由の一元管理でアプリケーションログのみ）
- **`console.log` 直接使用**: 0 件（セキュリティ上安全）

**特記事項**:
- `accessControl.ts` に開発者の Discord ユーザー ID がハードコードされているが、これはユーザー ID（公開情報）であり、秘密情報ではない。設計上意図的なもの

---

### 2. 入力バリデーション

**評価: Low Risk 🟢**

- **Discord メッセージ**: `isUserAllowed()` による送信元ユーザーの検証
- **メッセージ長制限**: `getMaxMessageLength()` によるサイズ制限（デフォルト 6,000 文字）
- **重複メッセージ**: `recentMessageIds` マップによる5分間の重複排除
- **Plan JSON パース**: `planParser.ts` で構造検証を実施
- **IPC レスポンスサイズ**: `MAX_RESPONSE_SIZE_BYTES = 5MB` の上限設定（`fileIpc.ts`）

**改善提案**:
- `promptBuilder.ts` でプロンプトテンプレートに外部入力を埋め込む際、インジェクション的な攻撃ベクターは限定的だが、入力サニタイズの明示的なドキュメント化を推奨

---

### 3. 依存パッケージ

**評価: Low Risk 🟢**

現在の依存パッケージ（`package.json`）:

| パッケージ | バージョン | 用途 | 備考 |
|---|---|---|---|
| `discord.js` | ^14.16.3 | Discord Bot | メジャーバージョン最新 |
| `ws` | ^8.18.0 | WebSocket 通信 | 安定版 |
| `luxon` | ^3.5.0 | 日時処理 | 安定版 |
| `node-cron` | ^3.0.3 | CRON スケジューラ | 安定版 |
| `convex` | ^1.32.0 | ライセンス管理 | 安定版 |
| `@clerk/clerk-js` | ^5.124.0 | 認証 | 安定版 |
| `stripe` | ^20.3.1 | 決済 | 安定版 |

**推奨**: 定期的に `npm audit` を実行し、脆弱性のある依存パッケージを検出・更新する CI パイプラインの構築を検討

---

### 4. コード難読化（リバースエンジニアリング対策）

**評価: Low Risk 🟢 — セキュリティポリシー準拠**

#### esbuild 設定（`esbuild.js`）

| 設定項目 | 現在値 | 必須値 | 状態 |
|---|---|---|---|
| `minify` | `true` | `true` | ✅ 準拠 |
| `sourcemap` | `false` | `false` | ✅ 準拠 |
| `treeShaking` | `true` | — | ✅ 追加対策 |
| `bundle` | `true` | — | ✅ 単一ファイル化 |

#### `.vscodeignore`（ホワイトリスト方式）

```
**                    # すべて除外
!out/extension.js     # バンドル済みコードのみ
!package.json
!README.md
!images/**
!scripts/anticrow.ps1
```

**評価**: ホワイトリスト方式（全除外→必要なもののみ含める）は、ブラックリスト方式よりも安全。ソースコード、テスト、ビルド設定、エージェント設定がすべて除外されている

---

### 5. `.vscodeignore` の VSIX パッケージ保護

**評価: Low Risk 🟢**

VSIX パッケージに含まれるファイル:
- ✅ `out/extension.js` — バンドル・minify 済みコード
- ✅ `package.json` — 拡張機能のマニフェスト
- ✅ `README.md` — ユーザー向けドキュメント
- ✅ `images/**` — アイコン等
- ✅ `scripts/anticrow.ps1` — セットアップスクリプト

除外されるファイル:
- ✅ `src/**` — TypeScript ソースコード
- ✅ `**/*.ts` — すべての TypeScript ファイル
- ✅ `.agents/**` — AI エージェント設定
- ✅ `**/__tests__/**` — テストコード
- ✅ `tsconfig.json`, `esbuild.js` — ビルド設定
- ✅ `node_modules/`, `*.vsix` — 開発用ファイル
- ✅ `convex/` — バックエンド設定
- ✅ `docs/` — 内部ドキュメント

---

### 6. 通信セキュリティ

**評価: Low Risk 🟢**

- **Discord API**: `discord.js` ライブラリが TLS 通信を自動管理
- **内部通信**: ファイルベース IPC によるローカル通信（ネットワーク非露出）
- **ライセンス管理**: Convex クラウドサービスへの HTTPS 通信
- **決済処理**: Stripe API への HTTPS 通信

**特記事項**:
- ローカルの内部通信にファイルベース IPC を採用しており、ネットワーク経由の攻撃面が最小化されている

---

### 7. ログ出力

**評価: Low Risk 🟢**

- **ログモジュール**: `logger.ts` で `OutputChannel` への一元出力
- **ログレベル**: `DEBUG`, `INFO`, `WARN`, `ERROR` の4段階
- **デフォルトレベル**: `INFO`（デバッグ情報は非表示）
- **機密情報のログ出力**: なし
- **`console.log` 使用**: 0 件

**セキュリティポリシー準拠チェック**:
- ✅ ユーザー向け UI にログを表示していない
- ✅ OutputChannel のみへの出力（開発者向けデバッグ用）

---

### 8. アクセス制御

**評価: Low Risk 🟢**

- **ユーザー認証**: `allowedUserIds` によるホワイトリスト方式
- **セキュアデフォルト**: 空リスト = 全ユーザー拒否（`isUserAllowed()` in `configHelper.ts`）
- **開発者権限**: `accessControl.ts` で `isDeveloper()` による管理コマンドの制限
- **Bot ロック**: `botLock.ts` による単一 Bot インスタンス制御

---

## 発見事項と推奨対策

| # | リスクレベル | 発見事項 | 推奨対策 |
|---|---|---|---|
| 1 | 🟢 Low | `tsconfig.json` に `sourceMap: true`, `declarationMap: true` が設定されている | esbuild 設定では `sourcemap: false` のため VSIX には含まれない。ただし `tsc` 直接実行時の `.map` ファイル生成に注意。`.vscodeignore` のホワイトリスト方式で保護されているため実害なし |
| 2 | 🟢 Low | `package.json` の `description` に「Discord→Antigravity自動操作ブリッジ」と記載 | セキュリティポリシーで禁止されている内部用語は含まれていないが、「自動操作ブリッジ」の表現は将来的に見直し検討 |
| 3 | 🟢 Low | 依存パッケージの脆弱性チェックが CI に未統合 | `npm audit` を定期実行する仕組みの導入を推奨 |
| 4 | ℹ️ Info | `scripts/anticrow.ps1` が VSIX に含まれている | セットアップ用スクリプトのため問題なし。ただし内容にセンシティブな情報がないことを定期確認 |

---

## 優先度付き是正アクション

| 優先度 | アクション | 対象 |
|---|---|---|
| 🟡 Medium | `npm audit` を含む定期的な依存パッケージ脆弱性チェックの導入 | CI/CD |
| 🟢 Low | `package.json` の `description` 表現の見直し | `package.json` |
| 🟢 Low | セキュリティポリシードキュメントの定期レビュープロセスの確立 | 運用 |

---

## セキュリティポリシー準拠チェックリスト

- [x] README.md に内部実装の詳細が含まれていないか → **準拠**
- [x] package.json の設定 description に内部用語がないか → **準拠**
- [x] エラーメッセージにファイルパスやプロトコル名が含まれていないか → **準拠**
- [x] ログメッセージは OutputChannel のみで、ユーザー向け UI には出さないか → **準拠**
- [x] esbuild: `minify: true`, `sourcemap: false` → **準拠**
- [x] `.vscodeignore`: ソースコード除外 → **準拠（ホワイトリスト方式）**

---

**結論**: AntiCrow のセキュリティ体制は現時点で十分に堅牢であり、重大な脆弱性は発見されませんでした。セキュリティポリシーへの準拠も確認されています。定期的な依存パッケージの更新と、セキュリティポリシーの継続的なレビューを推奨します。
