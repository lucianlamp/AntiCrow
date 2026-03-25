// ---------------------------------------------------------------------------
// embeddedSkill.ts — AntiCrow エージェントスキルテンプレート
// ---------------------------------------------------------------------------
// ワークスペースの .agent/skills/anticrow/SKILL.md に配置するスキル内容を定義。
// bridgeLifecycle.ts の起動時に毎回上書きコピーされる。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logInfo, logWarn } from './logger';
import { ensureAnticrowGitignore } from './gitignoreHelper';

/** スキルの配置先ディレクトリ名 */
const SKILL_DIR = '.agent/skills/anticrow';
/** スキルファイル名 */
const SKILL_FILE = 'SKILL.md';

export const ANTICROW_SKILL_VERSION = '1.1.0';

/**
 * AntiCrow スキルテンプレート
 * Antigravity のエージェントが AntiCrow の機能を理解し活用するためのガイド。
 */
export const ANTICROW_SKILL_CONTENT = `---
name: anticrow
version: ${ANTICROW_SKILL_VERSION}
description: AntiCrow 拡張機能の機能を活用するためのスキル。チームモード、連続オートモード、IPC通信、進捗報告、ファイル送信などの使い方を理解する。
---

# AntiCrow スキル

AntiCrow は Discord 経由でタスクを受け取り、Antigravity エージェントに実行を委任する VS Code 拡張機能です。
このスキルでは、AntiCrow の機能を最大限に活用する方法を説明します。

## チームモード（並列サブエージェント実行）

チームモードは、複数の独立したタスクをサブエージェントに分散して並列実行する機能です。

### 使い方

計画生成（plan_generation）時に \\\`tasks\\\` 配列を出力すると、各タスクが個別のサブエージェントに割り当てられます。

\\\`\\\`\\\`json
{
  "tasks": [
    "src/auth.ts に新しい認証ロジックを実装する",
    "src/__tests__/auth.test.ts にユニットテストを追加する",
    "src/docs/auth.md にドキュメントを作成する"
  ]
}
\\\`\\\`\\\`

### タスク分割の判断基準

**tasks を使う（チームモード）:**
- 3ファイル以上にまたがる変更
- 新機能の実装＋テスト＋デプロイが必要な作業
- 独立した複数の問題を同時に修正する作業
- 調査・実装・検証が別々に並行可能な作業

**tasks を使わない（メインエージェント単独）:**
- 単一ファイルの修正・設定変更
- 情報の確認・質問への回答
- 簡単なバグ修正（1-2ファイル以内）
- 型チェック・テスト・ビルドのみの実行
- ドキュメント・コメントの修正

### 重要なルール

- 各タスクは**独立して実行可能な単位**にすること
- **同じファイルを複数のタスクで修正しない**こと（コンフリクトの原因）
- タスクが1つしかない場合は \\\`tasks\\\` を省略すること
- **VSIX デプロイはサブエージェントが行わない**（メインエージェントが最後に実行）
  - サブエージェントは VSIX ファイル作成（compile → bundle → vsce package）まで
  - \\\`antigravity --install-extension\\\` はメインエージェントの責務
  - サブエージェントが VSIX をインストールすると拡張ホスト再起動で IPC が中断し、レスポンスが届かなくなる

## 連続オートモード（自律実行ループ）

連続オートモードは、AI が自律的に次のアクションを決定し、連続でタスクを実行する機能です。

### 使い方

Discord で \\\`/auto\\\` コマンドを使うか、提案ボタンの「エージェントに任せる」を押すと開始します。

\\\`\\\`\\\`
/auto LPをリニューアルして
/auto --steps 15 --confirm semi 全体をリファクタリングして
\\\`\\\`\\\`

### 設定オプション

- \\\`--steps N\\\`: 最大ステップ数（1-20、デフォルト: 10）
- \\\`--duration N\\\`: 最大実行時間・分（5-120、デフォルト: 30分）
- \\\`--confirm MODE\\\`: 確認モード（auto / semi / manual）
- \\\`--select MODE\\\`: 次アクション選択方式（auto-delegate / first / ai-select）

### 確認モード

- **auto**: 全ステップを自動実行（デフォルト）
- **semi**: 偶数ステップごとにユーザー確認を挟む
- **manual**: 毎ステップでユーザー確認を要求

### セーフティガード

連続オートモードには21パターンの危険操作検知が組み込まれています:
- **ファイルシステム破壊**: rm -rf, format, truncate
- **Git 破壊操作**: reset --hard, push --force, clean -fd
- **DB 破壊**: DROP TABLE/DATABASE, TRUNCATE TABLE
- **暗号資産保護**: 秘密鍵、シードフレーズ、資金ドレインの検出（10パターン）
- **プロンプトインジェクション**: 指示無視、システムプロンプト上書き、eval/exec

severity が block の場合はループが一時停止し、Discord で承認/スキップ/停止を選択できます。

### 完了判定

オートモードはレスポンス末尾15行の完了フレーズで自動停止します。
ただし \\\`SUGGESTIONS\\\` タグがある場合は完了フレーズを無視します（提案がある = まだ続きがある）。

## スケジュール実行

cron 式を使って定期的にタスクを自動実行できます。

### 計画生成での指定

\\\`\\\`\\\`json
{
  "cron": "0 9 * * 1-5",
  "timezone": "Etc/GMT-9",
  "prompt": "毎朝のテストを実行して"
}
\\\`\\\`\\\`

- \\\`cron\\\`: 5項目標準 cron 式（秒は不要）
- 即時実行の場合は \\\`"now"\\\` を指定
- \\\`/schedules\\\` コマンドで登録済みスケジュールの一覧・管理が可能

## カスタマイズ機能

\\\`~/.anticrow/SOUL.md\\\` にキャラクター設定を書くことで、AntiCrow の口調や呼び方を変更できます。

### 計画生成での指定

ユーザーがカスタマイズを要求した場合、\\\`target: "anticrow_customization"\\\` を指定する:

\\\`\\\`\\\`json
{
  "target": "anticrow_customization",
  "prompt": "語尾を「なのだ」にして"
}
\\\`\\\`\\\`

Discord の \\\`/soul\\\` コマンドで現在の設定を確認・リセットできます。

## テンプレート機能

よく使うプロンプトをテンプレートとして保存し、再利用できます。
\\\`/template\\\` コマンドでテンプレートの一覧・実行・削除が可能です。

## IPC レスポンス

AntiCrow はファイルベースの通信でタスクの完了を検知します。

### 完了条件

**\\\`response_path\\\` に指定されたファイルに write_to_file で書き込むこと**が完了条件です。
書き込まないと、タスクは永遠に「実行中」のままになります。

- \\\`task: "execution"\\\` → Markdown 形式で \\\`response_path\\\` に書き込む
- \\\`task: "plan_generation"\\\` → JSON 形式で \\\`response_path\\\` に書き込む

### VSIX デプロイ時の注意

VSIX インストールで拡張ホストが再起動すると通信が中断します。
**必ずレスポンスファイルへの書き込みを VSIX インストールの前に行うこと。**

### エラー時の自動リトライ

通信が中断した場合（例: 拡張ホスト再起動）、AntiCrow は自動で以下のリトライを試みます:
1. 5秒待機（拡張ホストの再起動完了を待つ）
2. 既に書き込み済みのレスポンスファイルを検索・回収
3. 回収できなかった場合、新しい接続で120秒間再待機

リトライが成功した場合、レポートに \\\`retried: true\\\` が記録されます。

## 進捗報告

処理中は \\\`progress_path\\\` に JSON で進捗を定期的に書き込んでください。
Discord にリアルタイム通知されます。

\\\`\\\`\\\`json
{"status": "実装中", "detail": "auth.ts を修正中", "percent": 50}
\\\`\\\`\\\`

**頻度:** 30秒〜1分おきに更新する。長時間の無反応はユーザーに不安を与えます。

## Discord へのファイル送信

レスポンスにファイルを添付したい場合、以下のタグを使います:

\\\`\\\`\\\`
<!-- FILE:C:/path/to/file.png -->
\\\`\\\`\\\`

対応フォーマット: png, jpg, gif, webp, mp4, webm, pdf, txt, csv, json, md, zip

**制限:** 25MB 以上のファイルは送信されません（Discord の制限）。

## 記憶の記録

重要な学びや教訓があれば、レスポンス末尾に以下のタグを埋め込んでください:

\\\`\\\`\\\`
<!-- MEMORY:global: 全プロジェクト共通の学び -->
<!-- MEMORY:workspace: 現プロジェクト固有の学び -->
\\\`\\\`\\\`

## 提案ボタン

レスポンス末尾に以下のタグを埋め込むと、Discord に次アクションの提案ボタンが表示されます:

\\\`\\\`\\\`
<!-- SUGGESTIONS:[{"label":"ボタンテキスト","description":"説明","prompt":"実行プロンプト"}] -->
\\\`\\\`\\\`

最大3つの提案 + 固定の「エージェントに任せる」ボタンが表示されます。

## ベストプラクティス

### チームモードの効果的な使い方

- **タスクは具体的に**: 「テストを書く」ではなく「src/__tests__/auth.test.ts にログイン/ログアウトのユニットテストを追加する」
- **依存関係を避ける**: タスク A の結果をタスク B が必要とする場合、チームモードは不適切
- **ファイル競合を防ぐ**: 各タスクが触るファイルを事前に明確にし、重複があればタスクを統合する
- **デプロイは最後に**: コード変更タスクを全て完了してから、メインエージェントがまとめてデプロイ

### レスポンスの品質

- **詳細に書く**: 何をしたか・変更ファイル・影響範囲・テスト結果を必ず含める
- **簡素すぎる報告は禁止**: 「完了しました」だけでは不十分
- **提案を活用**: 次ステップの提案ボタン（SUGGESTIONS）を積極的に使い、ユーザーの操作を簡単にする

## 制約事項

### ファイルサイズ

- **Discord 添付ファイル**: 25MB 以下
- **レスポンス**: Discord のメッセージ長制限（2,000文字）を超える場合は自動分割される

### デプロイ順序

VSIX デプロイを含むタスクでは以下の順序を厳守:
1. コード変更を完了する
2. \\\`npm run compile\\\` → \\\`npm run bundle\\\` → \\\`npx vsce package\\\`
3. **レスポンスファイルに書き込む**（最重要）
4. **その後に** \\\`antigravity --install-extension\\\` を実行
5. 順序を間違えると拡張ホスト再起動で通信が中断し、レスポンスが消失する

## トラブルシューティング

### レスポンスが Discord に届かない

- **原因**: レスポンスファイルへの書き込みが完了していない、または VSIX インストール後に書き込んだ
- **対処**: \\\`response_path\\\` に正しい形式（execution → Markdown, plan_generation → JSON）で書き込まれているか確認する
- **注意**: AntiCrow は自動で未配達レスポンスを定期的にスキャンし再配信する（5分間隔）

### 進捗が Discord に反映されない

- **原因**: \\\`progress_path\\\` の JSON フォーマットが不正
- **対処**: \\\`{"status": "...", "detail": "...", "percent": N}\\\` の形式を厳守する。余計なフィールドやコメントは不可

### チームモードでサブエージェントのレスポンスが消える

- **原因**: サブエージェントが VSIX インストールを実行し、拡張ホストが再起動した
- **対処**: VSIX インストールはメインエージェントのみが行う。サブエージェントは VSIX ファイル作成まで

## Discord スラッシュコマンド一覧

- \\\`/status\\\` — Bot・ワークスペースの接続状態を表示
- \\\`/stop\\\` — 実行中のタスクをキャンセル
- \\\`/newchat\\\` — 新しいチャットセッションを開始
- \\\`/workspace\\\` — ワークスペースの一覧・切替
- \\\`/queue\\\` — メッセージキューの状態を表示
- \\\`/model\\\` — AI モデルの切替
- \\\`/mode\\\` — エージェントモードの切替
- \\\`/template\\\` — テンプレートの一覧・実行・削除
- \\\`/schedules\\\` — スケジュールの一覧・管理
- \\\`/auto\\\` — 連続オートモードの開始
- \\\`/auto-config\\\` — 連続オートモード設定の表示・変更
- \\\`/team\\\` — チームモード・サブエージェント管理
- \\\`/suggest\\\` — 直前の提案ボタンを再表示
- \\\`/screenshot\\\` — Antigravity の画面キャプチャを取得
- \\\`/soul\\\` — カスタマイズ設定の確認・リセット
- \\\`/help\\\` — ヘルプ・コマンド一覧を表示

## ワークスペース構造

\\\`\\\`\\\`
{workspace}/
├── .anticrow/
│   ├── team.json      # チームモード設定（enabled, maxAgents 等）
│   ├── MEMORY.md      # ワークスペース固有の記憶
│   └── worktrees/     # サブエージェント用 git worktree
├── .agent/
│   └── skills/
│       └── anticrow/
│           └── SKILL.md  # このファイル（自動配置）
~/.anticrow/
├── SOUL.md            # カスタマイズ設定（口調・呼び方）
├── SOUL.md.bak        # カスタマイズのバックアップ
└── MEMORY.md          # グローバル記憶
\\\`\\\`\\\`
`;

/**
 * ワークスペースに AntiCrow スキルファイルを配置する。
 * 毎回上書きで最新版を書き出す。
 *
 * @param workspacePath ワークスペースのルートパス
 */
export function deployAntiCrowSkill(workspacePath: string): void {
    if (!workspacePath) {
        logDebug('embeddedSkill: no workspace path provided, skipping skill deployment');
        return;
    }

    const skillDir = path.join(workspacePath, SKILL_DIR);
    const skillPath = path.join(skillDir, SKILL_FILE);

    try {
        // ディレクトリ作成（再帰的）
        fs.mkdirSync(skillDir, { recursive: true });

        // スキルファイルを上書き
        fs.writeFileSync(skillPath, ANTICROW_SKILL_CONTENT, 'utf-8');
        logInfo(`embeddedSkill: AntiCrow skill deployed to ${skillPath}`);

        // .gitignore に .anticrow/ を自動追加（なければ作成）
        ensureAnticrowGitignore(workspacePath);
    } catch (e) {
        logWarn(`embeddedSkill: failed to deploy skill: ${e instanceof Error ? e.message : e}`);
    }
}
