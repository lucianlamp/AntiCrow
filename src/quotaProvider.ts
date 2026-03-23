// ---------------------------------------------------------------------------
// quotaProvider.ts — Antigravity GetUserStatus API 経由でモデルクォータを取得
// ---------------------------------------------------------------------------
// 参考: ImL1s/antigravity-plus の antigravity-usage.ts + process-detector.ts
//
// 動作概要:
//   1. プロセス検出: Language Server プロセスから CSRF トークンとポートを取得
//   2. API 呼出: GetUserStatus API でモデルクォータを取得
//   3. レスポンス解析: clientModelConfigs から各モデルの残量を抽出
// ---------------------------------------------------------------------------

import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import { logDebug, logWarn, logError } from './logger';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ModelQuota {
    name: string;
    displayName: string;
    remainingPercentage: number;
    usedPercentage: number;
    resetTime?: Date;
    timeUntilResetFormatted?: string;
    isExhausted: boolean;
    supportsImages?: boolean;
    isRecommended?: boolean;
}

export interface PromptCredits {
    used: number;
    total: number;
    remainingPercentage: number;
}

export interface QuotaData {
    models: ModelQuota[];
    accountLevel: string;
    promptCredits?: PromptCredits;
    lastUpdated: Date;
}

interface ProcessInfo {
    pid: number;
    extensionPort: number;
    csrfToken: string;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const API_ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const PING_ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const HTTP_TIMEOUT_MS = 5000;
const PROCESS_CMD_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// CSRF トークン + ポート検出
// ---------------------------------------------------------------------------

/**
 * Language Server プロセスのコマンドラインから
 * CSRF トークンと extension_server_port を抽出する。
 */
export async function detectProcessInfo(): Promise<ProcessInfo | null> {
    const platform = os.platform();

    try {
        if (platform === 'win32') {
            return await detectWindows();
        } else {
            return await detectUnix();
        }
    } catch (e) {
        logDebug(`detectProcessInfo: failed — ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

async function detectWindows(): Promise<ProcessInfo | null> {
    // 1次パス: プロセス名で直接検索（antigravity-plus と同じ）
    const result = await detectWindowsByProcessName();
    if (result) { return result; }

    // 2次パス（フォールバック）: csrf_token キーワードで検索
    return await detectWindowsByKeyword();
}

async function detectWindowsByProcessName(): Promise<ProcessInfo | null> {
    const processName = 'language_server_windows_x64.exe';
    const utf8Header = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";
    const cmd = `chcp 65001 >nul && powershell -NoProfile -Command "${utf8Header}Get-CimInstance Win32_Process -Filter 'name=''${processName}''' | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;

    try {
        const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS, windowsHide: true });
        logDebug(`detectWindowsByProcessName: stdout length=${stdout?.length || 0}`);
        if (!stdout || !stdout.trim()) {
            logDebug('detectWindowsByProcessName: no process found by name');
            return null;
        }
        return parseWindowsProcessOutput(stdout, 'ByProcessName');
    } catch (e) {
        logDebug(`detectWindowsByProcessName: failed — ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

async function detectWindowsByKeyword(): Promise<ProcessInfo | null> {
    const utf8Header = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";
    const cmd = `chcp 65001 >nul && powershell -NoProfile -Command "${utf8Header}Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json"`;

    try {
        const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS, windowsHide: true });
        logDebug(`detectWindowsByKeyword: stdout length=${stdout?.length || 0}`);
        if (!stdout || !stdout.trim()) {
            logDebug('detectWindowsByKeyword: no process found by keyword');
            return null;
        }
        return parseWindowsProcessOutput(stdout, 'ByKeyword');
    } catch (e) {
        logDebug(`detectWindowsByKeyword: failed — ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

function parseWindowsProcessOutput(stdout: string, source: string): ProcessInfo | null {
    let cleanStdout = stdout;
    const jsonStart = stdout.indexOf('[');
    const jsonObjectStart = stdout.indexOf('{');
    if (jsonStart >= 0 || jsonObjectStart >= 0) {
        const start = (jsonStart >= 0 && jsonObjectStart >= 0)
            ? Math.min(jsonStart, jsonObjectStart)
            : Math.max(jsonStart, jsonObjectStart);
        cleanStdout = stdout.substring(start);
    }

    let data = JSON.parse(cleanStdout.trim());
    if (!Array.isArray(data)) { data = [data]; }
    logDebug(`detectWindows(${source}): found ${data.length} candidate process(es)`);

    for (const item of data) {
        const commandLine = item.CommandLine || '';
        if (!commandLine) { continue; }
        logDebug(`detectWindows(${source}): checking PID=${item.ProcessId}, cmdLine preview=${commandLine.substring(0, 200)}`);
        const info = parseCommandLine(commandLine, item.ProcessId);
        if (info) {
            logDebug(`detectWindows(${source}): matched PID=${info.pid}, port=${info.extensionPort}`);
            return info;
        } else {
            logDebug(`detectWindows(${source}): PID=${item.ProcessId} did not match parseCommandLine filters`);
        }
    }

    return null;
}

async function detectUnix(): Promise<ProcessInfo | null> {
    const platform = os.platform();
    const arch = os.arch();

    let processName: string;
    if (platform === 'darwin') {
        processName = arch === 'arm64' ? 'language_server_darwin_arm64' : 'language_server_darwin_x64';
    } else {
        processName = 'language_server_linux_x64';
    }

    const safeName = processName.replace(/[^a-zA-Z0-9._-]/g, '');
    const cmd = `ps -ww -eo pid,args | grep "${safeName}" | grep -v grep`;

    const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS, windowsHide: true });
    if (!stdout || !stdout.trim()) { return null; }

    const lines = stdout.split('\n').filter(l => l.trim());
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) { continue; }
        const pid = parseInt(parts[0], 10);
        if (isNaN(pid)) { continue; }
        const cmdline = parts.slice(1).join(' ');
        const info = parseCommandLine(cmdline, pid);
        if (info) { return info; }
    }

    return null;
}

function parseCommandLine(commandLine: string, pid: number): ProcessInfo | null {
    if (!commandLine.includes('--extension_server_port')) { return null; }
    if (!commandLine.includes('--csrf_token')) { return null; }
    // Antigravity の language server であることを確認
    // --app_data_dir antigravity を厳密にマッチ（antigravity-plus と同じ）
    const isAntigravity = /--app_data_dir\s+antigravity\b/i.test(commandLine)
        || /antigravity/i.test(commandLine);  // フォールバック: パス中の "antigravity"
    if (!isAntigravity) { return null; }

    const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
    const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/i);

    if (portMatch && tokenMatch) {
        return {
            pid,
            extensionPort: parseInt(portMatch[1], 10),
            csrfToken: tokenMatch[1],
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// ポート検証 (ping)
// ---------------------------------------------------------------------------

async function findConnectPort(info: ProcessInfo): Promise<number | null> {
    // まず extensionPort 自体で試す
    if (await pingPort(info.extensionPort, info.csrfToken)) {
        return info.extensionPort;
    }

    // リスニングポートを検出して試す
    const ports = await getListeningPorts(info.pid);
    for (const port of ports) {
        if (port === info.extensionPort) { continue; }
        if (await pingPort(port, info.csrfToken)) {
            return port;
        }
    }

    return null;
}

async function getListeningPorts(pid: number): Promise<number[]> {
    const platform = os.platform();
    try {
        let cmd: string;
        if (platform === 'win32') {
            cmd = `chcp 65001 >nul && netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
        } else if (platform === 'darwin') {
            cmd = `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;
        } else {
            cmd = `ss -tlnp 2>/dev/null | grep "pid=${pid},"`;
        }

        const { stdout } = await execAsync(cmd, { timeout: PROCESS_CMD_TIMEOUT_MS, windowsHide: true });
        if (!stdout) { return []; }

        const ports: number[] = [];
        if (platform === 'win32') {
            const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING/gi;
            let match;
            while ((match = portRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) { ports.push(port); }
            }
        } else {
            const portRegex = /[*\d.:]+:(\d+)/g;
            let match;
            while ((match = portRegex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) { ports.push(port); }
            }
        }
        return ports.sort((a, b) => a - b);
    } catch {
        return [];
    }
}

function pingPort(port: number, token: string): Promise<boolean> {
    return new Promise(resolve => {
        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            path: PING_ENDPOINT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': token,
                'Connect-Protocol-Version': '1',
            },
            rejectUnauthorized: false,
            timeout: 3000,
        };

        const req = https.request(options, res => resolve(res.statusCode === 200));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// GetUserStatus API 呼出
// ---------------------------------------------------------------------------

async function callGetUserStatus(port: number, csrfToken: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'anti-crow',
                locale: 'en',
            },
        });

        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            path: API_ENDPOINT,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            rejectUnauthorized: false,
            timeout: HTTP_TIMEOUT_MS,
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (!body || !body.trim()) {
                    reject(new Error('Empty response'));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch {
                    reject(new Error('Invalid JSON response'));
                }
            });
        });

        req.on('error', e => reject(new Error(`Connection failed: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(data);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// レスポンス解析
// ---------------------------------------------------------------------------

function parseQuotaResponse(response: unknown): QuotaData {
    const models: ModelQuota[] = [];

    if (!response || typeof response !== 'object') {
        logWarn('quotaProvider: invalid response structure');
        return createDefaultQuotaData();
    }
    const res = response as Record<string, unknown>;
    if (!res.userStatus || typeof res.userStatus !== 'object') {
        logWarn('quotaProvider: invalid response structure');
        return createDefaultQuotaData();
    }

    const status = res.userStatus as Record<string, unknown>;
    const planStatus = status.planStatus as Record<string, unknown> | undefined;
    const plan = planStatus?.planInfo as Record<string, unknown> | undefined;

    // clientModelConfigs から各モデルの配額を抽出
    const cascadeData = status.cascadeModelConfigData as Record<string, unknown> | undefined;
    const modelConfigs = (cascadeData?.clientModelConfigs || []) as Record<string, unknown>[];

    for (const config of modelConfigs) {
        const quotaInfo = config.quotaInfo as Record<string, unknown> | undefined;
        if (!quotaInfo) { continue; }

        const remainingFraction = quotaInfo.remainingFraction as number | undefined;
        const remainingPercentage = remainingFraction !== undefined
            ? remainingFraction * 100
            : 0;

        const now = new Date();
        let resetTime = quotaInfo.resetTime ? new Date(quotaInfo.resetTime as string | number) : undefined;
        let timeUntilResetFormatted = 'N/A';

        if (resetTime && !Number.isNaN(resetTime.getTime())) {
            const delta = resetTime.getTime() - now.getTime();
            timeUntilResetFormatted = formatDelta(delta);
        } else {
            resetTime = undefined;
        }

        const modelOrAlias = config.modelOrAlias as Record<string, unknown> | undefined;
        models.push({
            name: (modelOrAlias?.model as string) || 'unknown',
            displayName: (config.label as string) || (modelOrAlias?.model as string) || 'unknown',
            remainingPercentage: Math.round(remainingPercentage),
            usedPercentage: Math.round(100 - remainingPercentage),
            resetTime,
            timeUntilResetFormatted,
            isExhausted: remainingFraction === 0,
            supportsImages: config.supportsImages as boolean | undefined,
            isRecommended: config.isRecommended as boolean | undefined,
        });
    }

    // モデルソート（API 推奨順）
    const modelSorts = (cascadeData?.clientModelSorts || []) as ModelSortEntry[];
    sortModels(models, modelSorts);

    if (models.length === 0) {
        return createDefaultQuotaData();
    }

    // PromptCredits
    let promptCredits: PromptCredits | undefined;
    const credits = planStatus?.availablePromptCredits;
    if (plan && credits !== undefined) {
        const monthlyLimit = Number((plan as Record<string, unknown>).monthlyPromptCredits || 0);
        const available = Number(credits);
        if (monthlyLimit > 0) {
            promptCredits = {
                used: monthlyLimit - available,
                total: monthlyLimit,
                remainingPercentage: Math.round((available / monthlyLimit) * 100),
            };
        }
    }

    return {
        models,
        accountLevel: (status.userTier as Record<string, unknown> | undefined)?.name as string || (plan as Record<string, unknown> | undefined)?.teamsTier as string || 'Free',
        promptCredits,
        lastUpdated: new Date(),
    };
}

/** モデルソートエントリの型 */
interface ModelSortEntry {
    groups?: Array<{ modelLabels?: string[] }>;
}

function sortModels(models: ModelQuota[], modelSorts: ModelSortEntry[]): void {
    if (modelSorts.length === 0) { return; }

    const sortOrderMap = new Map<string, number>();
    const primarySort = modelSorts[0];
    let index = 0;
    for (const group of (primarySort.groups || [])) {
        for (const label of (group.modelLabels || [])) {
            sortOrderMap.set(label, index++);
        }
    }

    models.sort((a, b) => {
        const iA = sortOrderMap.get(a.displayName);
        const iB = sortOrderMap.get(b.displayName);
        if (iA !== undefined && iB !== undefined) { return iA - iB; }
        if (iA !== undefined) { return -1; }
        if (iB !== undefined) { return 1; }
        return a.displayName.localeCompare(b.displayName);
    });
}

function formatDelta(ms: number): string {
    if (ms <= 0) { return 'Ready'; }
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) { return `${days}d ${hours % 24}h`; }
    if (hours > 0) { return `${hours}h ${minutes % 60}m`; }
    if (minutes > 0) { return `${minutes}m`; }
    return `${seconds}s`;
}

function createDefaultQuotaData(): QuotaData {
    return {
        models: [],
        accountLevel: 'Unknown',
        lastUpdated: new Date(),
    };
}

// ---------------------------------------------------------------------------
// 公開 API: クォータ取得（高レベル）
// ---------------------------------------------------------------------------

/** キャッシュ: 最後に成功した接続情報 */
let cachedConnection: { port: number; csrfToken: string } | null = null;

/** リトライ上限 */
const MAX_FETCH_RETRIES = 3;

/**
 * Antigravity のモデルクォータを取得する。
 * プロセス検出 → ポート検証 → API 呼出 → レスポンス解析 の一連のフローを実行。
 * キャッシュミス時は最大 MAX_FETCH_RETRIES 回リトライする。
 */
export async function fetchQuota(): Promise<QuotaData | null> {
    // キャッシュがある場合はまずそれで試す
    if (cachedConnection) {
        try {
            const response = await callGetUserStatus(cachedConnection.port, cachedConnection.csrfToken);
            if (response) {
                logDebug('quotaProvider: quota fetched via cached connection');
                return parseQuotaResponse(response);
            }
        } catch {
            logDebug('quotaProvider: cached connection failed, re-detecting...');
            cachedConnection = null;
        }
    }

    // リトライ付きで検出 → 接続 → API 呼出
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
        try {
            // プロセス検出
            const processInfo = await detectProcessInfo();
            if (!processInfo) {
                logDebug(`quotaProvider: attempt ${attempt}/${MAX_FETCH_RETRIES} — no Antigravity process detected`);
                continue;
            }

            logDebug(`quotaProvider: attempt ${attempt} — process detected PID=${processInfo.pid}, extensionPort=${processInfo.extensionPort}`);

            // ポート検証
            const connectPort = await findConnectPort(processInfo);
            if (!connectPort) {
                logDebug(`quotaProvider: attempt ${attempt}/${MAX_FETCH_RETRIES} — no connectable port found`);
                continue;
            }

            logDebug(`quotaProvider: attempt ${attempt} — connect port verified: ${connectPort}`);

            // API 呼出
            const response = await callGetUserStatus(connectPort, processInfo.csrfToken);
            if (!response) {
                logDebug(`quotaProvider: attempt ${attempt}/${MAX_FETCH_RETRIES} — empty API response`);
                continue;
            }

            // 接続情報をキャッシュ
            cachedConnection = { port: connectPort, csrfToken: processInfo.csrfToken };
            return parseQuotaResponse(response);

        } catch (e) {
            logDebug(`quotaProvider: attempt ${attempt}/${MAX_FETCH_RETRIES} failed — ${e instanceof Error ? e.message : e}`);
            cachedConnection = null;
        }
    }

    logDebug('quotaProvider: all retry attempts exhausted');
    return null;
}

/**
 * キャッシュをクリアする（接続問題時に使用）
 */
export function clearQuotaCache(): void {
    cachedConnection = null;
}
