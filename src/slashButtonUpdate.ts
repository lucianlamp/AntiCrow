// ---------------------------------------------------------------------------
// slashButtonUpdate.ts — /update コマンドハンドラ
// ---------------------------------------------------------------------------
// 責務:
//   - R2 上の latest.json を取得して最新バージョンを確認
//   - 現在の package.json バージョンと比較
//   - 新バージョンがあれば VSIX をダウンロードして自動インストール
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ChatInputCommandInteraction } from 'discord.js';
import { buildEmbed, EmbedColor } from './embedHelper';
import { logDebug, logError, logWarn } from './logger';
import { t } from './i18n';
import { BridgeContext } from './bridgeContext';

const execAsync = promisify(exec);

/**
 * 環境変数で上書き可能な URL を検証する（セキュリティ対策）。
 * HTTPS 強制 + ドメインホワイトリスト検証。
 * 不正な場合はデフォルト値にフォールバックし警告ログを出力。
 */
function validateEnvUrl(envValue: string | undefined, defaultUrl: string, allowedDomains: string[]): string {
    if (!envValue) return defaultUrl;
    try {
        const parsed = new URL(envValue);
        if (parsed.protocol !== 'https:') {
            logWarn(`[Security] URL must use HTTPS, falling back to default: ${defaultUrl}`);
            return defaultUrl;
        }
        const isAllowed = allowedDomains.some(domain =>
            parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
        );
        if (!isAllowed) {
            logWarn(`[Security] URL domain not in whitelist (${parsed.hostname}), falling back to default: ${defaultUrl}`);
            return defaultUrl;
        }
        return envValue;
    } catch {
        logWarn(`[Security] Invalid URL format, falling back to default: ${defaultUrl}`);
        return defaultUrl;
    }
}

// R2 パブリック URL（環境変数で上書き可能、HTTPS + ドメイン検証付き）
const R2_PUBLIC_URL_DEFAULT = 'https://pub-43d0b2eef4734fc8b00c014791e17d8a.r2.dev';
const R2_PUBLIC_URL = validateEnvUrl(process.env.ANTICROW_R2_PUBLIC_URL, R2_PUBLIC_URL_DEFAULT, ['r2.dev']);
// r2.dev パブリックURLではプレフィックス付きキーが 404 を返すため、バケット直下を使用
const RELEASES_PATH = '';

/** R2 パブリック URL を安全に構築する */
function buildR2Url(fileName: string): string {
    if (RELEASES_PATH) {
        return `${R2_PUBLIC_URL}/${RELEASES_PATH}/${fileName}`;
    }
    return `${R2_PUBLIC_URL}/${fileName}`;
}

interface LatestInfo {
    version: string;
    uploadedAt: string;
    fileName: string;
}

/**
 * 現在の拡張機能バージョンを取得する
 */
function getCurrentVersion(): string {
    try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * バージョン比較: v1 < v2 なら true
 */
function isNewerVersion(current: string, latest: string): boolean {
    const c = current.split('.').map(Number);
    const l = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(c.length, l.length); i++) {
        const cv = c[i] || 0;
        const lv = l[i] || 0;
        if (lv > cv) return true;
        if (lv < cv) return false;
    }
    return false;
}

/**
 * /update コマンドハンドラ
 */
export async function handleUpdate(
    _ctx: BridgeContext,
    interaction: ChatInputCommandInteraction,
): Promise<void> {
    await interaction.deferReply();

    const currentVersion = getCurrentVersion();
    logDebug(`handleUpdate: current version = ${currentVersion}`);

    try {
        // 1. R2 から latest.json を取得
        await interaction.editReply({
            embeds: [buildEmbed(t('update.checking'), EmbedColor.Info)],
        });

        const latestUrl = buildR2Url('latest.json');
        logDebug(`handleUpdate: fetching ${latestUrl}`);

        const response = await fetch(latestUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const latestInfo: LatestInfo = await response.json() as LatestInfo;
        logDebug(`handleUpdate: latest version = ${latestInfo.version}`);

        // 2. バージョン比較
        if (!isNewerVersion(currentVersion, latestInfo.version)) {
            await interaction.editReply({
                embeds: [buildEmbed(
                    t('update.alreadyLatest', currentVersion),
                    EmbedColor.Success,
                )],
            });
            return;
        }

        // 3. VSIX をダウンロード
        await interaction.editReply({
            embeds: [buildEmbed(t('update.downloading'), EmbedColor.Info)],
        });

        const vsixUrl = buildR2Url(latestInfo.fileName);
        logDebug(`handleUpdate: downloading ${vsixUrl}`);

        const vsixResponse = await fetch(vsixUrl);
        if (!vsixResponse.ok) {
            throw new Error(`VSIX download failed: HTTP ${vsixResponse.status}`);
        }

        const vsixBuffer = Buffer.from(await vsixResponse.arrayBuffer());
        const tmpDir = os.tmpdir();
        const vsixPath = path.join(tmpDir, `anti-crow-${latestInfo.version}.vsix`);
        fs.writeFileSync(vsixPath, vsixBuffer);
        logDebug(`handleUpdate: saved VSIX to ${vsixPath} (${vsixBuffer.length} bytes)`);

        // 4. インストール
        await interaction.editReply({
            embeds: [buildEmbed(t('update.installing'), EmbedColor.Info)],
        });

        const installCmd = `antigravity --install-extension "${vsixPath}" --force`;
        logDebug(`handleUpdate: running ${installCmd}`);

        // インストール完了メッセージを先に送信（インストール後は拡張ホストが再起動するため）
        await interaction.editReply({
            embeds: [buildEmbed(
                `✅ ${t('update.complete')}\n\n`
                + `**${currentVersion}** → **${latestInfo.version}**\n\n`
                + `📅 リリース日: ${latestInfo.uploadedAt}`,
                EmbedColor.Success,
            )],
        });

        // インストール実行（拡張ホストが再起動する可能性あり）
        try {
            await execAsync(installCmd);
        } catch (installErr) {
            logWarn(`handleUpdate: install command returned error (may be expected due to host restart): ${installErr}`);
        }

        // 一時ファイル削除
        try {
            fs.unlinkSync(vsixPath);
        } catch { /* ignore */ }

    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logError('handleUpdate: failed', e);
        await interaction.editReply({
            embeds: [buildEmbed(t('update.error', errMsg), EmbedColor.Error)],
        }).catch(() => { });
    }
}
