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
    // Windows, macOS, Linux に対応
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') { return; }

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

    if (process.platform === 'linux') {
        createLinuxShortcut(extensionPath);
        return;
    }

    if (process.platform !== 'win32') {
        logWarn('shortcutInstaller: not on Windows, macOS, or Linux, skipping');
        return;
    }

    const antigravityExe = path.join(
        process.env.LOCALAPPDATA || '',
        'Programs', 'antigravity', 'Antigravity.exe',
    );
    const iconIco = path.join(extensionPath, 'images', 'AntiCrowIcon.ico');

    // CDP 固定ポートを設定から取得（デフォルト 9000）
    let cdpPort = 9000;
    try {
        const vsc = require('vscode') as typeof import('vscode');
        cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9000;
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
 * macOS: デスクトップに CDP ポート付きの .command スクリプトを作成する。
 * シンボリックリンクでは .app バンドルに引数を渡せないため、
 * `open -a` コマンドでポート引数を渡すシェルスクリプトを配置する。
 */
function createMacShortcut(extensionPath: string): void {
    const fs = require('fs') as typeof import('fs');
    const desktop = path.join(os.homedir(), 'Desktop');
    const scriptPath = path.join(desktop, 'AntiCrow.command');

    // CDP 固定ポートを設定から取得（デフォルト 9000）
    let cdpPort = 9000;
    try {
        const vsc = require('vscode') as typeof import('vscode');
        cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9000;
    } catch { /* テスト環境では vscode が読めない場合がある */ }

    // .command シェルスクリプトを作成（macOS でダブルクリック実行可能）
    const script = [
        '#!/bin/bash',
        `open -a Antigravity --args --remote-debugging-port=${cdpPort}`,
        '',
    ].join('\n');

    try {
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        // 念のため実行権限を明示付与
        execSync(`chmod +x "${scriptPath}"`, { timeout: 5000 });
        logDebug(`shortcutInstaller: created macOS .command script at ${scriptPath} (cdpPort=${cdpPort})`);
    } catch (e) {
        logWarn(`shortcutInstaller: macOS .command creation failed — ${e instanceof Error ? e.message : e}`);
    }
}

/**
 * Linux: ~/.local/share/applications/ に .desktop ファイルを作成する。
 * アプリケーションメニューから AntiCrow を起動できるようにする。
 */
function createLinuxShortcut(extensionPath: string): void {
    const fs = require('fs') as typeof import('fs');
    const applicationsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    const desktopFilePath = path.join(applicationsDir, 'AntiCrow.desktop');

    // CDP 固定ポートを設定から取得（デフォルト 9000）
    let cdpPort = 9000;
    try {
        const vsc = require('vscode') as typeof import('vscode');
        cdpPort = vsc.workspace.getConfiguration('antiCrow').get<number>('cdpPort') ?? 9000;
    } catch { /* テスト環境では vscode が読めない場合がある */ }

    // アイコンファイルの存在チェック
    const iconPng = path.join(extensionPath, 'images', 'AntiCrowIcon.png');
    const hasIcon = fs.existsSync(iconPng);

    const lines = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=AntiCrow',
        'Comment=Launch Antigravity with CDP',
        `Exec=antigravity --remote-debugging-port=${cdpPort}`,
        'Terminal=false',
        'Categories=Development;',
    ];

    if (hasIcon) {
        lines.push(`Icon=${iconPng}`);
    }

    try {
        // ディレクトリが存在しない場合は再帰作成
        fs.mkdirSync(applicationsDir, { recursive: true });
        fs.writeFileSync(desktopFilePath, lines.join('\n') + '\n', { mode: 0o644 });
        logDebug(`shortcutInstaller: created Linux .desktop file at ${desktopFilePath} (cdpPort=${cdpPort})`);
    } catch (e) {
        logWarn(`shortcutInstaller: Linux .desktop creation failed — ${e instanceof Error ? e.message : e}`);
    }
}

