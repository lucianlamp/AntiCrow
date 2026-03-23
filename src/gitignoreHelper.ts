// ---------------------------------------------------------------------------
// gitignoreHelper.ts — .anticrow/ を .gitignore に自動追加するユーティリティ
// ---------------------------------------------------------------------------
// ユーザーのプロジェクトに .anticrow/ ディレクトリが作成された際、
// .gitignore にエントリが存在しなければ自動で追加する。
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { logDebug, logWarn } from './logger';

const GITIGNORE_ENTRY = '.anticrow/';
const GITIGNORE_COMMENT = '# AntiCrow ローカルデータ';

/**
 * 指定されたリポジトリルートの .gitignore に `.anticrow/` エントリを追加する。
 * 既に存在する場合は何もしない。.gitignore が存在しない場合は新規作成する。
 *
 * @param repoRoot リポジトリのルートパス（.git がある場所）
 */
export function ensureAnticrowGitignore(repoRoot: string): void {
    try {
        const gitignorePath = path.join(repoRoot, '.gitignore');

        // .git が存在しない場合は Git リポジトリではないのでスキップ
        if (!fs.existsSync(path.join(repoRoot, '.git'))) {
            logDebug('gitignoreHelper: .git not found, skipping .gitignore update');
            return;
        }

        let content = '';
        if (fs.existsSync(gitignorePath)) {
            content = fs.readFileSync(gitignorePath, 'utf-8');
        }

        // 既に .anticrow/ が含まれていれば何もしない
        // 行単位でチェック（部分一致を避ける）
        const lines = content.split(/\r?\n/);
        const alreadyExists = lines.some(line => {
            const trimmed = line.trim();
            return trimmed === GITIGNORE_ENTRY
                || trimmed === '.anticrow'
                || trimmed === '/.anticrow/'
                || trimmed === '/.anticrow';
        });

        if (alreadyExists) {
            logDebug('gitignoreHelper: .anticrow/ already in .gitignore');
            return;
        }

        // 末尾に追加（既存コンテンツの末尾に改行がなければ追加）
        const newlinePrefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        const entry = `${newlinePrefix}\n${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}\n`;
        fs.appendFileSync(gitignorePath, entry, 'utf-8');
        logDebug(`gitignoreHelper: added ${GITIGNORE_ENTRY} to ${gitignorePath}`);
    } catch (e) {
        // .gitignore の更新に失敗してもクラッシュさせない
        logWarn(`gitignoreHelper: failed to update .gitignore: ${e instanceof Error ? e.message : e}`);
    }
}
