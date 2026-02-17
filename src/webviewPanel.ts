// ---------------------------------------------------------------------------
// webviewPanel.ts — スケジュール管理 Webview ダッシュボード
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlanStore } from './planStore';
import { Scheduler } from './scheduler';
import { Plan } from './types';
import { logInfo, logError } from './logger';

/** Webview から受信するメッセージの discriminated union 型 */
type WebviewMessage =
    | { type: 'refresh' }
    | { type: 'togglePlan'; planId: string }
    | { type: 'deletePlan'; planId: string }
    | { type: 'addPlan'; cron?: string; prompt: string; timezone?: string; summary?: string }
    | { type: 'editPlan'; planId: string; cron?: string; prompt?: string; summary?: string };

export class ScheduleDashboardPanel {
    static currentPanel: ScheduleDashboardPanel | undefined;
    private static readonly viewType = 'scheduleDashboard';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private planStore: PlanStore;
    private scheduler: Scheduler;
    private onChannelRename?: (channelId: string, newName: string) => Promise<void>;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        planStore: PlanStore,
        scheduler: Scheduler,
        onChannelRename?: (channelId: string, newName: string) => Promise<void>,
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.planStore = planStore;
        this.scheduler = scheduler;
        this.onChannelRename = onChannelRename;

        this.panel.webview.html = this.getHtmlContent(this.panel.webview);

        // Webview からのメッセージを処理
        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            null,
            this.disposables,
        );

        // パネル破棄時のクリーンアップ
        this.panel.onDidDispose(
            () => this.dispose(),
            null,
            this.disposables,
        );
    }

    /** パネルを作成または表示 */
    static createOrShow(
        extensionUri: vscode.Uri,
        planStore: PlanStore,
        scheduler: Scheduler,
        onChannelRename?: (channelId: string, newName: string) => Promise<void>,
    ): void {
        const column = vscode.ViewColumn.Beside;

        if (ScheduleDashboardPanel.currentPanel) {
            ScheduleDashboardPanel.currentPanel.planStore = planStore;
            ScheduleDashboardPanel.currentPanel.scheduler = scheduler;
            ScheduleDashboardPanel.currentPanel.onChannelRename = onChannelRename;
            ScheduleDashboardPanel.currentPanel.panel.reveal(column);
            ScheduleDashboardPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ScheduleDashboardPanel.viewType,
            '📅 Schedule Dashboard',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        ScheduleDashboardPanel.currentPanel = new ScheduleDashboardPanel(
            panel, extensionUri, planStore, scheduler, onChannelRename,
        );
        ScheduleDashboardPanel.currentPanel.update();
    }

    /** Webview にプランデータを送信 */
    update(): void {
        const plans = this.planStore.getAll();
        const scheduledPlanIds = this.scheduler.getRegisteredPlanIds();
        this.panel.webview.postMessage({
            type: 'plans',
            plans,
            scheduledPlanIds,
        });
    }

    /** Webview からのメッセージを処理 */
    private async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'refresh':
                this.update();
                break;

            case 'togglePlan': {
                const plan = this.planStore.get(message.planId);
                if (!plan) { return; }

                if (plan.status === 'active') {
                    this.planStore.update(message.planId, { status: 'paused' });
                    this.scheduler.unregister(message.planId);
                    logInfo(`Dashboard: paused plan ${message.planId}`);

                    // チャンネル名に「（停止中）」を付加
                    if (plan.channel_id && this.onChannelRename) {
                        const baseName = plan.human_summary || message.planId;
                        if (!baseName.endsWith('（停止中）')) {
                            this.onChannelRename(plan.channel_id, baseName + '（停止中）').catch(e => logError('Dashboard: rename failed', e));
                        }
                    }
                } else if (plan.status === 'paused') {
                    this.planStore.update(message.planId, { status: 'active' });
                    const updated = this.planStore.get(message.planId);
                    if (updated) { this.scheduler.register(updated); }
                    logInfo(`Dashboard: resumed plan ${message.planId}`);

                    // チャンネル名から「（停止中）」を除去
                    if (plan.channel_id && this.onChannelRename) {
                        const baseName = (plan.human_summary || message.planId).replace(/（停止中）$/, '');
                        this.onChannelRename(plan.channel_id, baseName).catch(e => logError('Dashboard: rename failed', e));
                    }
                }
                this.update();
                break;
            }

            case 'deletePlan': {
                this.scheduler.unregister(message.planId);
                this.planStore.remove(message.planId);
                logInfo(`Dashboard: deleted plan ${message.planId}`);
                this.update();
                break;
            }

            case 'addPlan': {
                const newPlan: Plan = {
                    plan_id: this.generateUuid(),
                    timezone: message.timezone || 'Asia/Tokyo',
                    cron: message.cron || null,
                    prompt: message.prompt,
                    requires_confirmation: false,
                    source_channel_id: '',
                    notify_channel_id: '',
                    discord_templates: {
                        ack: '📅 GUIから登録されました',
                        run_start: '⏳ 実行開始...',
                        run_success_prefix: '✅ 実行完了',
                        run_error: '❌ 実行失敗',
                    },
                    human_summary: message.summary || message.prompt.substring(0, 60),
                    status: 'active',
                    created_at: new Date().toISOString(),
                };
                this.planStore.add(newPlan);
                if (newPlan.cron) {
                    this.scheduler.register(newPlan);
                }
                logInfo(`Dashboard: added plan ${newPlan.plan_id}`);
                this.update();
                break;
            }

            case 'editPlan': {
                const patch: Partial<Plan> = {};
                if (message.cron !== undefined) { patch.cron = message.cron; }
                if (message.prompt !== undefined) { patch.prompt = message.prompt; }
                if (message.summary !== undefined) { patch.human_summary = message.summary; }

                this.planStore.update(message.planId, patch);

                // スケジューラを再登録
                this.scheduler.unregister(message.planId);
                const updated = this.planStore.get(message.planId);
                if (updated && updated.status === 'active' && updated.cron) {
                    this.scheduler.register(updated);
                }
                logInfo(`Dashboard: edited plan ${message.planId}`);
                this.update();
                break;
            }
        }
    }

    /** HTML コンテンツを生成 */
    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();

        return /*html*/ `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Schedule Dashboard</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border, #333);
            --card-bg: var(--vscode-sideBar-background, #1e1e1e);
            --btn-bg: var(--vscode-button-background, #0e639c);
            --btn-fg: var(--vscode-button-foreground, #fff);
            --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
            --danger: #e74c3c;
            --success: #2ecc71;
            --warning: #f39c12;
            --muted: var(--vscode-descriptionForeground, #888);
            --input-bg: var(--vscode-input-background, #1e1e1e);
            --input-border: var(--vscode-input-border, #3c3c3c);
            --input-fg: var(--vscode-input-foreground, #ccc);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family, -apple-system, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--fg);
            background: var(--bg);
            padding: 16px;
        }
        .header {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 20px; padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }
        .header h1 { font-size: 1.4em; font-weight: 600; }
        .header .badge {
            display: inline-block; padding: 2px 8px; border-radius: 10px;
            font-size: 0.8em; margin-left: 8px;
        }
        .badge-active { background: var(--success); color: #fff; }
        .badge-paused { background: var(--warning); color: #000; }
        .btn {
            padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
            font-size: 0.9em; font-family: inherit;
            background: var(--btn-bg); color: var(--btn-fg);
            transition: background 0.15s;
        }
        .btn:hover { background: var(--btn-hover); }
        .btn-danger { background: var(--danger); }
        .btn-danger:hover { background: #c0392b; }
        .btn-sm { padding: 3px 8px; font-size: 0.8em; }
        .btn-outline {
            background: transparent; border: 1px solid var(--border);
            color: var(--fg);
        }
        .btn-outline:hover { background: var(--card-bg); }

        /* Tabs */
        .tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
        .tab {
            padding: 8px 16px; cursor: pointer; border: none; background: none;
            color: var(--muted); font-size: 0.95em; font-family: inherit;
            border-bottom: 2px solid transparent; transition: all 0.15s;
        }
        .tab:hover { color: var(--fg); }
        .tab.active { color: var(--fg); border-bottom-color: var(--btn-bg); }
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* Cards */
        .cards { display: grid; gap: 12px; }
        .card {
            background: var(--card-bg); border: 1px solid var(--border);
            border-radius: 8px; padding: 14px; position: relative;
            transition: border-color 0.15s;
        }
        .card:hover { border-color: var(--btn-bg); }
        .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .card-title { font-weight: 600; font-size: 1em; }
        .card-meta { color: var(--muted); font-size: 0.85em; margin-bottom: 8px; }
        .card-meta span { margin-right: 12px; }
        .card-actions { display: flex; gap: 6px; margin-top: 10px; }

        /* Toggle switch */
        .toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
            position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #555; border-radius: 20px; transition: 0.2s;
        }
        .toggle-slider:before {
            position: absolute; content: ""; height: 16px; width: 16px;
            left: 2px; bottom: 2px; background-color: #fff;
            border-radius: 50%; transition: 0.2s;
        }
        .toggle input:checked + .toggle-slider { background-color: var(--success); }
        .toggle input:checked + .toggle-slider:before { transform: translateX(16px); }

        /* Empty state */
        .empty { text-align: center; padding: 40px; color: var(--muted); }
        .empty-icon { font-size: 2em; margin-bottom: 8px; }

        /* History table */
        .history-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
        .history-table th, .history-table td {
            padding: 8px 12px; text-align: left;
            border-bottom: 1px solid var(--border);
        }
        .history-table th { color: var(--muted); font-weight: 500; }
        .status-ok { color: var(--success); }
        .status-fail { color: var(--danger); }

        /* Modal */
        .modal-overlay {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 100;
            align-items: center; justify-content: center;
        }
        .modal-overlay.show { display: flex; }
        .modal {
            background: var(--card-bg); border: 1px solid var(--border);
            border-radius: 10px; padding: 24px; width: 90%; max-width: 500px;
        }
        .modal h2 { margin-bottom: 16px; font-size: 1.2em; }
        .form-group { margin-bottom: 14px; }
        .form-group label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 0.9em; }
        .form-group input, .form-group textarea, .form-group select {
            width: 100%; padding: 8px 10px; border: 1px solid var(--input-border);
            background: var(--input-bg); color: var(--input-fg);
            border-radius: 4px; font-family: inherit; font-size: 0.9em;
        }
        .form-group textarea { min-height: 80px; resize: vertical; }
        .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
        .cron-preview { color: var(--muted); font-size: 0.85em; margin-top: 4px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📅 Schedule Dashboard</h1>
        <button class="btn" id="addBtn">＋ 新規追加</button>
    </div>

    <div class="tabs">
        <button class="tab active" data-tab="schedules">スケジュール</button>
        <button class="tab" data-tab="history">実行履歴</button>
    </div>

    <div id="tab-schedules" class="tab-content active">
        <div id="cardList" class="cards"></div>
    </div>

    <div id="tab-history" class="tab-content">
        <div id="historyContent"></div>
    </div>

    <!-- Add/Edit Modal -->
    <div class="modal-overlay" id="modal">
        <div class="modal">
            <h2 id="modalTitle">新規スケジュール追加</h2>
            <input type="hidden" id="editPlanId">
            <div class="form-group">
                <label>プロンプト</label>
                <textarea id="promptInput" placeholder="実行するプロンプトを入力..."></textarea>
            </div>
            <div class="form-group">
                <label>概要 (任意)</label>
                <input type="text" id="summaryInput" placeholder="短い説明">
            </div>
            <div class="form-group">
                <label>cron 式</label>
                <input type="text" id="cronInput" placeholder="*/5 * * * *">
                <div class="cron-preview" id="cronPreview"></div>
            </div>
            <div class="form-group">
                <label>プリセット</label>
                <select id="presetSelect">
                    <option value="">-- 選択 --</option>
                    <option value="* * * * *">毎分</option>
                    <option value="*/5 * * * *">5分毎</option>
                    <option value="*/15 * * * *">15分毎</option>
                    <option value="*/30 * * * *">30分毎</option>
                    <option value="0 * * * *">毎時</option>
                    <option value="0 9 * * *">毎日 9:00</option>
                    <option value="0 18 * * *">毎日 18:00</option>
                    <option value="0 9 * * 1">毎週月曜 9:00</option>
                    <option value="0 0 1 * *">毎月1日 0:00</option>
                </select>
            </div>
            <div class="form-actions">
                <button class="btn btn-outline" id="cancelBtn">キャンセル</button>
                <button class="btn" id="saveBtn">保存</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let plans = [];
        let scheduledPlanIds = [];

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            });
        });

        // cron to human readable
        function cronToHuman(cron) {
            const p = cron.split(/\\s+/);
            if (p.length !== 5) return cron;
            const [min, hr, dom, , dow] = p;
            const em = min.match(/^\\*\\/(\\d+)$/);
            if (em && hr === '*') return em[1] + '分毎';
            if (min === '*' && hr === '*') return '毎分';
            if (min !== '*' && hr === '*') return '毎時 ' + min + '分';
            if (min !== '*' && hr !== '*' && dom === '*' && dow === '*')
                return '毎日 ' + hr + ':' + min.padStart(2, '0');
            if (dow !== '*') {
                const days = ['日','月','火','水','木','金','土'];
                return '毎週' + (days[parseInt(dow)]||dow) + ' ' + hr + ':' + min.padStart(2,'0');
            }
            if (dom !== '*') return '毎月' + dom + '日 ' + hr + ':' + min.padStart(2,'0');
            return cron;
        }

        function statusBadge(status) {
            const map = { active: ['🟢', 'badge-active'], paused: ['⏸️', 'badge-paused'] };
            const [icon, cls] = map[status] || ['❓', ''];
            return '<span class="badge ' + cls + '">' + icon + ' ' + status + '</span>';
        }

        function renderCards() {
            const container = document.getElementById('cardList');
            const scheduled = plans.filter(p => p.cron);

            if (scheduled.length === 0) {
                container.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>スケジュールはありません</div>';
                return;
            }

            container.innerHTML = scheduled.map(p => {
                const human = cronToHuman(p.cron);
                const execCount = p.execution_count || 0;
                const lastExec = p.last_executed_at ? new Date(p.last_executed_at).toLocaleString('ja-JP') : 'なし';
                const isActive = p.status === 'active';
                const summary = p.human_summary || p.prompt.substring(0, 60);

                return '<div class="card">' +
                    '<div class="card-header">' +
                        '<span class="card-title">' + escHtml(summary) + '</span>' +
                        statusBadge(p.status) +
                    '</div>' +
                    '<div class="card-meta">' +
                        '<span>⏰ <code>' + escHtml(p.cron) + '</code> (' + human + ')</span>' +
                        '<span>📊 実行: ' + execCount + '回</span>' +
                        '<span>🕐 最終: ' + lastExec + '</span>' +
                    '</div>' +
                    '<div class="card-actions">' +
                        '<label class="toggle"><input type="checkbox" ' + (isActive ? 'checked' : '') +
                            ' onchange="togglePlan(\\'' + p.plan_id + '\\')"><span class="toggle-slider"></span></label>' +
                        '<button class="btn btn-sm btn-outline" onclick="editPlan(\\'' + p.plan_id + '\\')">✏️ 編集</button>' +
                        '<button class="btn btn-sm btn-danger" onclick="deletePlan(\\'' + p.plan_id + '\\')">🗑️ 削除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        function renderHistory() {
            const container = document.getElementById('historyContent');
            const allExecs = [];
            for (const p of plans) {
                if (p.executions) {
                    for (const ex of p.executions) {
                        allExecs.push({ ...ex, plan_summary: p.human_summary || p.prompt.substring(0, 40), plan_id: p.plan_id });
                    }
                }
            }
            allExecs.sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));

            if (allExecs.length === 0) {
                container.innerHTML = '<div class="empty"><div class="empty-icon">📭</div>実行履歴はありません</div>';
                return;
            }

            container.innerHTML = '<table class="history-table">' +
                '<tr><th>日時</th><th>プラン</th><th>結果</th><th>所要時間</th><th>プレビュー</th></tr>' +
                allExecs.slice(0, 50).map(ex => {
                    const dt = new Date(ex.executed_at).toLocaleString('ja-JP');
                    const statusCls = ex.success ? 'status-ok' : 'status-fail';
                    const statusIcon = ex.success ? '✅' : '❌';
                    const dur = (ex.duration_ms / 1000).toFixed(1) + 's';
                    const preview = escHtml((ex.result_preview || '').substring(0, 80));
                    return '<tr><td>' + dt + '</td><td>' + escHtml(ex.plan_summary) +
                        '</td><td class="' + statusCls + '">' + statusIcon +
                        '</td><td>' + dur + '</td><td>' + preview + '</td></tr>';
                }).join('') +
                '</table>';
        }

        function escHtml(s) {
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // Actions
        function togglePlan(planId) { vscode.postMessage({ type: 'togglePlan', planId }); }
        function deletePlan(planId) {
            if (confirm('このスケジュールを削除しますか？')) {
                vscode.postMessage({ type: 'deletePlan', planId });
            }
        }
        function editPlan(planId) {
            const plan = plans.find(p => p.plan_id === planId);
            if (!plan) return;
            document.getElementById('modalTitle').textContent = 'スケジュール編集';
            document.getElementById('editPlanId').value = planId;
            document.getElementById('promptInput').value = plan.prompt;
            document.getElementById('summaryInput').value = plan.human_summary || '';
            document.getElementById('cronInput').value = plan.cron || '';
            updateCronPreview();
            document.getElementById('modal').classList.add('show');
        }

        // Modal
        document.getElementById('addBtn').addEventListener('click', () => {
            document.getElementById('modalTitle').textContent = '新規スケジュール追加';
            document.getElementById('editPlanId').value = '';
            document.getElementById('promptInput').value = '';
            document.getElementById('summaryInput').value = '';
            document.getElementById('cronInput').value = '';
            document.getElementById('presetSelect').value = '';
            updateCronPreview();
            document.getElementById('modal').classList.add('show');
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            document.getElementById('modal').classList.remove('show');
        });
        document.getElementById('presetSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                document.getElementById('cronInput').value = e.target.value;
                updateCronPreview();
            }
        });
        document.getElementById('cronInput').addEventListener('input', updateCronPreview);
        function updateCronPreview() {
            const val = document.getElementById('cronInput').value.trim();
            const el = document.getElementById('cronPreview');
            if (!val) { el.textContent = ''; return; }
            el.textContent = '→ ' + cronToHuman(val);
        }
        document.getElementById('saveBtn').addEventListener('click', () => {
            const planId = document.getElementById('editPlanId').value;
            const prompt = document.getElementById('promptInput').value.trim();
            const summary = document.getElementById('summaryInput').value.trim();
            const cron = document.getElementById('cronInput').value.trim();
            if (!prompt) { alert('プロンプトを入力してください'); return; }
            if (!cron) { alert('cron 式を入力してください'); return; }

            if (planId) {
                vscode.postMessage({ type: 'editPlan', planId, prompt, summary, cron });
            } else {
                vscode.postMessage({ type: 'addPlan', prompt, summary, cron, timezone: 'Asia/Tokyo' });
            }
            document.getElementById('modal').classList.remove('show');
        });

        // Receive data from extension
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'plans') {
                plans = msg.plans;
                scheduledPlanIds = msg.scheduledPlanIds || [];
                renderCards();
                renderHistory();
            }
        });

        // Initial load
        vscode.postMessage({ type: 'refresh' });
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private generateUuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    dispose(): void {
        ScheduleDashboardPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}
