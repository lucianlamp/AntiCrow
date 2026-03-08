import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logDebug, logError, logWarn } from './logger';

const GLOBAL_STATE_KEY = 'shortcutCreated';

/**
 * 初回起動チェック：ショートカット未作成なら自動で設置する。
 */
export async function checkAndOfferShortcut(context: vscode.ExtensionContext): Promise<void> {
    // Windows と macOS のみ対応（Linux は将来対応）
    if (process.platform !== 'win32' && process.platform !== 'darwin') { return; }

    const alreadyCreated = context.globalState.get<boolean>(GLOBAL_STATE_KEY);
    if (alreadyCreated) { return; }

    try {
        createDesktopShortcut(context.extensionPath);
        logDebug('shortcutInstaller: auto-created desktop shortcut on first run');
        vscode.window.showInformationMessage('✅ デスクトップに AntiCrow ショートカットを自動作成しました。');
    } catch (e) {
        logError('shortcutInstaller: failed to auto-create shortcut', e);
    }

    // 成功・失敗どちらでも再試行しない
    await context.globalState.update(GLOBAL_STATE_KEY, true);
}

/**
 * デスクトップにショートカットを作成する。
 * package.json の contributes.commands から手動呼び出し可能にするため public。
 */
export function createDesktopShortcut(extensionPath: string): void {
    if (process.platform === 'darwin') {
        createMacShortcut(extensionPath);
        return;
    }

    if (process.platform !== 'win32') {
        logWarn('shortcutInstaller: not on Windows or macOS, skipping');
        return;
    }

    const antigravityExe = path.join(
        process.env.LOCALAPPDATA || '',
        'Programs', 'antigravity', 'Antigravity.exe',
    );
    const iconIco = path.join(extensionPath, 'images', 'AntiCrowIcon.ico');

    // CDP 固定ポートを設定から取得（デフォルト 9333）
    let cdpPort = 9333;
    try {
        const vsc = require('vscode') as typeof import('vscode');
        cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9333;
    } catch { /* テスト環境では vscode が読めない場合がある */ }

    // PowerShell で WScript.Shell COM 経由で .lnk を作成
    // OneDrive リダイレクト環境でも正しくデスクトップパスを取得するため
    // [Environment]::GetFolderPath('Desktop') を使用
    const psScript = [
        `$desktop = [Environment]::GetFolderPath('Desktop')`,
        `$lnkPath = Join-Path $desktop 'AntiCrow.lnk'`,
        `$ws = New-Object -ComObject WScript.Shell`,
        `$sc = $ws.CreateShortcut($lnkPath)`,
        `$sc.TargetPath = '${antigravityExe.replace(/'/g, "''")}'`,
        `$sc.Arguments = '--remote-debugging-port=${cdpPort}'`,
        `$sc.Description = 'AntiCrow — Launch Antigravity with CDP'`,
        `$ico = '${iconIco.replace(/'/g, "''")}'`,
        `if (Test-Path $ico) { $sc.IconLocation = $ico }`,
        `$sc.Save()`,
    ].join('; ');

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    execSync(`powershell.exe -NoProfile -EncodedCommand ${encoded}`, {
        timeout: 10000,
        windowsHide: true,
    });

    logDebug('shortcutInstaller: created desktop shortcut on Desktop');
}

/**
 * macOS: デスクトップに Antigravity.app のシンボリックリンクを作成する。
 */
function createMacShortcut(extensionPath: string): void {
    const desktop = path.join(os.homedir(), 'Desktop');
    const antigravityApp = '/Applications/Antigravity.app';
    const linkPath = path.join(desktop, 'Antigravity');

    // CDP 固定ポートを設定から取得（デフォルト 9333）
    let cdpPort = 9333;
    try {
        const vsc = require('vscode') as typeof import('vscode');
        cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9333;
    } catch { /* テスト環境では vscode が読めない場合がある */ }

    try {
        // シンボリックリンク作成（既存があれば上書き）
        execSync(`ln -sf "${antigravityApp}" "${linkPath}"`, {
            timeout: 5000,
        });
        logDebug(`shortcutInstaller: created macOS symlink at ${linkPath}`);
    } catch (e) {
        logWarn(`shortcutInstaller: macOS symlink creation failed — ${e instanceof Error ? e.message : e}`);
    }
}
