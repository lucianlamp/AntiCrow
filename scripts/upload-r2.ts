/**
 * upload-r2.ts — AntiCrow VSIX を Cloudflare R2 にアップロードするスクリプト
 *
 * 使い方:
 *   npx tsx scripts/upload-r2.ts [--bucket <name>] [--vsix <path>]
 *
 * 環境変数:
 *   CLOUDFLARE_ACCOUNT_ID — Cloudflare アカウント ID（必須）
 *   CLOUDFLARE_API_TOKEN  — Cloudflare API トークン（wrangler 認証に必要）
 *
 * 動作:
 *   1. VSIX ファイルを R2 バケットにアップロード（anti-crow/releases/anti-crow-latest.vsix）
 *   2. バージョン付きコピーもアップロード（anti-crow/releases/anti-crow-{version}.vsix）
 *   3. メタデータ JSON を書き込み（anti-crow/releases/latest.json）
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── 引数パース ───────────────────────────────────────────────
function parseArgs(args: string[]): { bucket: string; vsixPath: string } {
  let bucket = 'anti-crow-releases'; // デフォルトバケット名
  let vsixPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bucket' && args[i + 1]) {
      bucket = args[i + 1];
      i++;
    } else if (args[i] === '--vsix' && args[i + 1]) {
      vsixPath = args[i + 1];
      i++;
    }
  }

  return { bucket, vsixPath };
}

// ─── メイン処理 ───────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { bucket, vsixPath: argVsixPath } = parseArgs(args);

  // プロジェクトルートを特定
  const projectRoot = path.resolve(__dirname, '..');
  const packageJsonPath = path.join(projectRoot, 'package.json');

  // package.json からバージョンを取得
  if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ package.json が見つかりません:', packageJsonPath);
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const version: string = packageJson.version;
  const name: string = packageJson.name || 'anti-crow';

  console.log(`📦 AntiCrow v${version} を R2 にアップロードするのだ！`);
  console.log(`🪣 バケット: ${bucket}`);

  // VSIX ファイルの特定
  let vsixPath = argVsixPath;
  if (!vsixPath) {
    // デフォルト: プロジェクトルートの anti-crow-{version}.vsix
    vsixPath = path.join(projectRoot, `${name}-${version}.vsix`);
  }

  if (!fs.existsSync(vsixPath)) {
    console.error(`❌ VSIX ファイルが見つかりません: ${vsixPath}`);
    console.error('💡 先に npm run package を実行して VSIX を生成してください。');
    process.exit(1);
  }

  const vsixStat = fs.statSync(vsixPath);
  const vsixSizeMB = (vsixStat.size / (1024 * 1024)).toFixed(2);
  console.log(`📄 VSIX: ${vsixPath} (${vsixSizeMB} MB)`);

  // ─── R2 アップロード ─────────────────────────────────────────

  // 1. 最新版としてアップロード（常に上書き）
  const latestKey = 'anti-crow/releases/anti-crow-latest.vsix';
  console.log(`\n⬆️  [1/3] 最新版をアップロード中... (${latestKey})`);
  runWrangler(`r2 object put "${bucket}/${latestKey}" --file "${vsixPath}" --content-type "application/octet-stream"`);
  console.log('✅ 最新版アップロード完了！');

  // 2. バージョン付きアーカイブをアップロード
  const versionedKey = `anti-crow/releases/${name}-${version}.vsix`;
  console.log(`⬆️  [2/3] バージョン付きアーカイブをアップロード中... (${versionedKey})`);
  runWrangler(`r2 object put "${bucket}/${versionedKey}" --file "${vsixPath}" --content-type "application/octet-stream"`);
  console.log('✅ アーカイブアップロード完了！');

  // 3. latest.json メタデータを書き込み
  const metadataKey = 'anti-crow/releases/latest.json';
  const metadata = {
    version,
    uploadedAt: new Date().toISOString(),
    fileName: `${name}-${version}.vsix`,
    downloadUrl: `anti-crow/releases/anti-crow-latest.vsix`,
  };

  // 一時ファイルに書き出してアップロード
  const tmpMetadataPath = path.join(projectRoot, '.tmp-latest-metadata.json');
  fs.writeFileSync(tmpMetadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  console.log(`⬆️  [3/3] メタデータを書き込み中... (${metadataKey})`);
  runWrangler(`r2 object put "${bucket}/${metadataKey}" --file "${tmpMetadataPath}" --content-type "application/json"`);

  // 一時ファイルを削除
  fs.unlinkSync(tmpMetadataPath);
  console.log('✅ メタデータ書き込み完了！');

  // ─── 完了 ───────────────────────────────────────────────────
  console.log('\n🎉 すべてのアップロードが完了したのだ！');
  console.log('────────────────────────────────────────');
  console.log(`  バージョン : v${version}`);
  console.log(`  バケット   : ${bucket}`);
  console.log(`  最新版キー : ${latestKey}`);
  console.log(`  アーカイブ : ${versionedKey}`);
  console.log(`  メタデータ : ${metadataKey}`);
  console.log('────────────────────────────────────────');
}

/**
 * wrangler CLI コマンドを実行するヘルパー
 */
function runWrangler(command: string): void {
  try {
    execSync(`npx wrangler ${command}`, {
      stdio: 'inherit',
      encoding: 'utf-8',
    });
  } catch (error) {
    console.error(`❌ wrangler コマンドが失敗しました: wrangler ${command}`);
    process.exit(1);
  }
}

// ─── エントリーポイント ───────────────────────────────────────
main().catch((err) => {
  console.error('❌ 予期しないエラーが発生しました:', err);
  process.exit(1);
});
