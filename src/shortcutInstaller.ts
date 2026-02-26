// ---------------------------------------------------------------------------
// shortcutInstaller.ts — デスクトップショートカット作成
// ---------------------------------------------------------------------------
// 責務:
//   初回起動時にデスクトップへ AntiCrow 起動用ショートカット (.lnk) を設置する。
//   Windows のみ対応。PowerShell の WScript.Shell COM 経由で .lnk を生成する。
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { logDebug, logError, logWarn } from './logger';

const GLOBAL_STATE_KEY = 'shortcutCreated';

/**
 * 初回起動チェック：ショートカット未作成なら自動で設置する。
 */
export async function checkAndOfferShortcut(context: vscode.ExtensionContext): Promise<void> {
    // Windows 以外は何もしない
    if (process.platform !== 'win32') { return; }

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
    if (process.platform !== 'win32') {
        logWarn('shortcutInstaller: not on Windows, skipping');
        return;
    }

    const scriptPath = path.join(extensionPath, 'scripts', 'anticrow.ps1');
    const desktopPath = path.join(process.env.USERPROFILE || '', 'Desktop');
    const shortcutPath = path.join(desktopPath, 'AntiCrow.lnk');
    // VSIX パッケージに同梱済みの ICO ファイルを使用
    const iconIco = path.join(extensionPath, 'images', 'AntiCrowIcon.ico');

    // CDP 固定ポートを設定から取得
    let cdpPortArg = '';
    try {
        const vsc = require('vscode') as typeof import('vscode');
        const cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9333;
        if (cdpPort > 0) {
            cdpPortArg = ` -CdpPort ${cdpPort}`;
        }
    } catch { /* テスト環境では vscode が読めない場合がある */ }

    // PowerShell で WScript.Shell COM 経由で .lnk を作成
    const escShortcut = shortcutPath.replace(/'/g, "''");
    const escWorkDir = path.dirname(scriptPath).replace(/'/g, "''");
    const escIco = iconIco.replace(/'/g, "''");
    const psScript = [
        '$ws = New-Object -ComObject WScript.Shell;',
        `$sc = $ws.CreateShortcut('${escShortcut}');`,
        "$sc.TargetPath = 'powershell.exe';",
        `$sc.Arguments = '-ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath.replace(/"/g, '`"')}"${cdpPortArg}';`,
        `$sc.WorkingDirectory = '${escWorkDir}';`,
        "$sc.Description = 'AntiCrow — Discord to Antigravity bridge';",
        `$icoPath = '${escIco}';`,
        "$antigravityExe = Join-Path $env:LOCALAPPDATA 'Programs\\\\antigravity\\\\Antigravity.exe';",
        'if (Test-Path $icoPath) { $sc.IconLocation = $icoPath }',
        'elseif (Test-Path $antigravityExe) { $sc.IconLocation = $antigravityExe };',
        '$sc.WindowStyle = 7;',
        '$sc.Save();',
    ].join(' ');

    execSync(`powershell.exe -NoProfile -Command "${psScript}"`, {
        timeout: 10000,
        windowsHide: true,
    });

    logDebug(`shortcutInstaller: created desktop shortcut at ${shortcutPath}`);
}
