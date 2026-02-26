// ---------------------------------------------------------------------------
// cdpTargets.ts — CDP ターゲット発見・スコアリング・管理
// ---------------------------------------------------------------------------
// 責務:
//   1. CDP /json エンドポイントからのターゲット一覧取得
//   2. ターゲットのスコアリング（Antigravity メインウインドウ検出）
//   3. マルチウインドウ対応のインスタンス発見
// ---------------------------------------------------------------------------

import * as http from 'http';
import { logDebug, logWarn, logError } from './logger';
import { EXCLUDED_CDP_PORTS } from './configHelper';

/** CDP /json から取得できるターゲット情報 */
export interface CdpTarget {
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl: string;
}

/** マルチウインドウ対応: 発見されたインスタンス情報 */
export interface DiscoveredInstance {
    id: string;          // ターゲット ID
    port: number;        // CDP ポート番号
    title: string;       // ウインドウタイトル
    url: string;         // ページ URL
    wsUrl: string;       // WebSocket デバッガー URL
    score: number;       // スコア（高い方が優先）
}

/** Page.getFrameTree のフレーム情報 */
export interface FrameInfo {
    frame: {
        id: string;
        parentId?: string;
        name?: string;
        url: string;
    };
    childFrames?: FrameInfo[];
}

// ---------------------------------------------------------------------------
// ターゲット取得
// ---------------------------------------------------------------------------

/** 指定ポートの CDP /json からターゲット一覧を取得 */
export function fetchTargetsFromPort(port: number): Promise<CdpTarget[]> {
    return new Promise((resolve, reject) => {
        const url = `http://127.0.0.1:${port}/json`;
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse CDP targets: ${e}`));
                }
            });
        });
        req.on('error', (err) => {
            reject(new Error(`CDP target fetch failed (port ${port}): ${err.message}`));
        });
        // 短いタイムアウト（ポートスキャン用）
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error(`CDP target fetch timeout (port ${port})`));
        });
    });
}

// ---------------------------------------------------------------------------
// ターゲットスコアリング
// ---------------------------------------------------------------------------

/**
 * ターゲットのスコアリング。
 * 高スコア = Antigravity のメインチャットウインドウに近い。
 */
export function scoreTarget(target: CdpTarget): number {
    let score = 0;
    const title = (target.title || '').toLowerCase();
    const url = (target.url || '').toLowerCase();

    // workbench.html（メインウインドウ）: 最高スコア
    if (url.includes('workbench.html') && !url.includes('jetski-agent')) {
        score += 100;
    }
    // jetski-agent workbench: やや高スコア
    if (url.includes('workbench') && url.includes('jetski-agent')) {
        score += 70;
    }
    // Antigravity タイトル: 中スコア
    if (title.includes('antigravity')) {
        score += 50;
    }
    // cascade/chat 関連: 加点
    if (url.includes('cascade') || title.includes('chat')) {
        score += 20;
    }
    // page タイプ: 加点
    if (target.type === 'page') {
        score += 10;
    }

    // 減点対象
    if (url.includes('devtools') || title.includes('devtools')) {
        score -= 50;
    }
    if (url.includes('qr') || title.includes('mobile')) {
        score -= 30;
    }
    if (url.includes('extension-output') || url.includes('webview')) {
        score -= 20;
    }

    return score;
}

// ---------------------------------------------------------------------------
// インスタンス発見
// ---------------------------------------------------------------------------

/**
 * ポートレンジをスキャンして全 Antigravity インスタンス（ターゲット）を発見する。
 * 全ポートを並列スキャンし、結果をマージしてスコア降順で返す。
 */
export async function discoverInstances(ports: number[]): Promise<DiscoveredInstance[]> {
    // セーフティネット: 除外ポートをフィルタリング
    const safePorts = ports.filter(p => !EXCLUDED_CDP_PORTS.has(p));
    if (safePorts.length < ports.length) {
        logWarn(`CDP: discoverInstances — filtered out ${ports.length - safePorts.length} excluded port(s)`);
    }

    const allInstances: DiscoveredInstance[] = [];
    const seen = new Set<string>();

    // 全ポートを並列スキャン
    const results = await Promise.allSettled(
        safePorts.map(async (port) => {
            const targets = await fetchTargetsFromPort(port);
            return { port, targets };
        }),
    );

    for (const result of results) {
        if (result.status !== 'fulfilled') { continue; }
        const { port, targets } = result.value;

        for (const t of targets) {
            // フィルタリング: 不要なターゲットを除外
            if (!t.webSocketDebuggerUrl) { continue; }
            if (t.type && t.type !== 'page') { continue; }

            const title = (t.title || '').toLowerCase();
            const url = (t.url || '').toLowerCase();

            // DevTools, WebView, ServiceWorker, Launchpad, 空タイトルを除外
            if (title.includes('devtools://')) { continue; }
            if (url.includes('devtools://')) { continue; }
            if (title === '' && url === '') { continue; }
            if (title.includes('launchpad')) { continue; }

            // 重複排除（webSocketDebuggerUrl ベース）
            if (seen.has(t.webSocketDebuggerUrl)) { continue; }
            seen.add(t.webSocketDebuggerUrl);

            const s = scoreTarget(t);

            allInstances.push({
                id: t.id || `${port}-${t.title || 'unknown'}`,
                port,
                title: t.title || `Instance :${port}`,
                url: t.url || '',
                wsUrl: t.webSocketDebuggerUrl,
                score: s,
            });
        }
    }

    // スコア降順でソート
    allInstances.sort((a, b) => b.score - a.score);

    logDebug(`CDP: discovered ${allInstances.length} instance(s) across ${safePorts.length} port(s)`);
    return allInstances;
}

// ---------------------------------------------------------------------------
// ワークスペース名抽出
// ---------------------------------------------------------------------------

/**
 * タイトルからワークスペース名を抽出する。
 * 例: "src/main.ts - my-project - Visual Studio Code" → "my-project"
 * 例: "workspace — Antigravity" → "workspace"
 */
export function extractWorkspaceName(title: string): string {
    if (!title) { return ''; }
    let name = title;

    // リモートや拡張開発ホストのプレフィックスを除去: "[Extension Development Host] - " など
    name = name.replace(/^\[[^\]]+\]\s*[-\u2013\u2014]\s*/, '');

    // IDE のサフィックスを除去: " — Antigravity", " - Visual Studio Code" など
    name = name.replace(/\s*[-\u2013\u2014]\s*(?:Antigravity|Visual Studio(?: Code)?).*$/, '');

    // "ファイル名 - フォルダ名" の形式からフォルダ名（ワークスペース名）を抽出する
    // '-', '\u2013' (EN dash), '\u2014' (EM dash) をセパレータとして扱う
    const parts = name.split(/\s+[-\u2013\u2014]\s+/);
    if (parts.length > 1) {
        // 「ファイル名 — ワークスペース名」: 最後の要素がワークスペース名
        return parts[parts.length - 1].trim();
    }
    if (parts.length === 1) {
        // サフィックス除去後に1要素 = 「ワークスペース名」のみ or ファイル名なし
        return parts[0].trim();
    }

    return name.trim();
}

/**
 * ポートレンジをスキャンして Antigravity のメインウィンドウを見つける。
 * 初回スキャン結果を再利用し、重複ネットワークコールを排除。
 */
export async function findAntigravityTarget(ports: number[]): Promise<{ target: CdpTarget; port: number } | null> {
    // セーフティネット: 除外ポートをフィルタリング
    const safePorts = ports.filter(p => !EXCLUDED_CDP_PORTS.has(p));
    if (safePorts.length < ports.length) {
        logWarn(`CDP: findAntigravityTarget — filtered out ${ports.length - safePorts.length} excluded port(s)`);
    }

    // 全ポートを並列スキャン（1回のみ）
    const results = await Promise.allSettled(
        safePorts.map(async (port) => {
            const targets = await fetchTargetsFromPort(port);
            return { port, targets };
        }),
    );

    // 成功した結果だけ収集
    const scanned: { port: number; targets: CdpTarget[] }[] = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            scanned.push(result.value);
        }
    }

    // まず workbench.html を持つターゲットを各ポートから探す
    for (const { port, targets } of scanned) {
        const candidate = targets.find(t =>
            t.type === 'page' &&
            t.url.includes('workbench.html') &&
            !t.url.includes('jetski-agent')
        );
        if (candidate) {
            logDebug(`CDP: found target on port ${port}: "${candidate.title}"`);
            return { target: candidate, port };
        }
    }

    // workbench.html が見つからない場合、スキャン結果からスコアリングで最良を選択
    let bestTarget: CdpTarget | null = null;
    let bestPort = 0;
    let bestScore = -1;

    for (const { port, targets } of scanned) {
        for (const t of targets) {
            if (!t.webSocketDebuggerUrl) { continue; }
            if (t.type && t.type !== 'page') { continue; }
            const s = scoreTarget(t);
            if (s > bestScore) {
                bestScore = s;
                bestTarget = t;
                bestPort = port;
            }
        }
    }

    if (bestTarget) {
        logDebug(`CDP: using best-scored target "${bestTarget.title}" (score=${bestScore}) on port ${bestPort}`);
        return { target: bestTarget, port: bestPort };
    }

    return null;
}
