import { useState, useEffect, useCallback, useRef } from "react";

// --- 型定義 ---
interface User {
    id: number;
    email: string;
    referral_code: string;
    referred_by: string | null;
    referral_count: number;
    position: number;
    priority_score: number;
    created_at: string;
    invited_at: string | null;
    invite_status: string | null;
    current_version: string | null;
}

interface Release {
    id: number;
    version: string;
    r2_key: string;
    changelog: string;
    download_count: number;
    created_at: string;
    is_latest: number;
}

interface Stats {
    totalUsers: number;
    pendingUsers: number;
    invitedUsers: number;
    downloadedUsers: number;
    totalDownloads: number;
    recentEmails: number;
}

type Tab = 'stats' | 'users' | 'releases' | 'emails';

// --- API ヘルパー ---
function apiHeaders(apiKey: string) {
    return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string, apiKey: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`/api/admin/${path}`, { ...options, headers: { ...apiHeaders(apiKey), ...options?.headers } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// --- メインコンポーネント ---
export default function AdminPage() {
    const [apiKey, setApiKey] = useState(() => localStorage.getItem('admin_api_key') || '');
    const [isAuthed, setIsAuthed] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const [tab, setTab] = useState<Tab>('stats');
    const [stats, setStats] = useState<Stats | null>(null);
    const [users, setUsers] = useState<User[]>([]);
    const [userTotal, setUserTotal] = useState(0);
    const [userPage, setUserPage] = useState(1);
    const [userFilter, setUserFilter] = useState('all');
    const [userSearch, setUserSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();
    const [releases, setReleases] = useState<Release[]>([]);
    const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

    const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 4000);
    };

    // --- 認証 ---
    const handleLogin = async () => {
        try {
            await apiFetch('stats', keyInput);
            localStorage.setItem('admin_api_key', keyInput);
            setApiKey(keyInput);
            setIsAuthed(true);
        } catch {
            showToast('APIキーが無効です', 'err');
        }
    };

    // 自動ログイン
    useEffect(() => {
        if (apiKey) {
            apiFetch('stats', apiKey).then(() => setIsAuthed(true)).catch(() => {
                localStorage.removeItem('admin_api_key');
                setApiKey('');
            });
        }
    }, []);

    // --- データ取得 ---
    const fetchStats = useCallback(async () => {
        try { setStats(await apiFetch<Stats>('stats', apiKey)); } catch { /* skip */ }
    }, [apiKey]);

    const fetchUsers = useCallback(async () => {
        try {
            const data = await apiFetch<{ users: User[]; total: number }>(`users?page=${userPage}&status=${userFilter}&search=${userSearch}`, apiKey);
            setUsers(data.users);
            setUserTotal(data.total);
        } catch { /* skip */ }
    }, [apiKey, userPage, userFilter, userSearch]);

    const fetchReleases = useCallback(async () => {
        try {
            const data = await apiFetch<{ releases: Release[] }>('releases', apiKey);
            setReleases(data.releases);
        } catch { /* skip */ }
    }, [apiKey]);

    useEffect(() => { if (isAuthed) { fetchStats(); fetchUsers(); fetchReleases(); } }, [isAuthed, fetchStats, fetchUsers, fetchReleases]);

    // --- アクション ---
    const inviteSelected = async () => {
        if (selectedEmails.size === 0) return showToast('ユーザーを選択してください', 'err');
        setLoading(true);
        try {
            const data = await apiFetch<{ successCount: number; totalCount: number }>('invite', apiKey, {
                method: 'POST', body: JSON.stringify({ emails: Array.from(selectedEmails) }),
            });
            showToast(`${data.successCount}/${data.totalCount}件の招待メールを送信しました`);
            setSelectedEmails(new Set());
            fetchUsers(); fetchStats();
        } catch (e) { showToast((e as Error).message, 'err'); }
        setLoading(false);
    };

    const inviteBatch = async (count: number) => {
        setLoading(true);
        try {
            const data = await apiFetch<{ users: User[] }>(`users?status=pending&limit=${count}`, apiKey);
            const emails = data.users.map(u => u.email);
            if (emails.length === 0) { setLoading(false); return showToast('未招待のユーザーがいません', 'err'); }
            const result = await apiFetch<{ successCount: number; totalCount: number }>('invite', apiKey, {
                method: 'POST', body: JSON.stringify({ emails }),
            });
            showToast(`${result.successCount}件の招待メールを送信しました`);
            fetchUsers(); fetchStats();
        } catch (e) { showToast((e as Error).message, 'err'); }
        setLoading(false);
    };

    // 検索デバウンス（300ms）
    const handleSearchChange = (value: string) => {
        setSearchInput(value);
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => {
            setUserSearch(value);
            setUserPage(1);
        }, 300);
    };

    const uploadRelease = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        const formData = new FormData(form);
        setLoading(true);
        try {
            const res = await fetch('/api/admin/releases', {
                method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}` }, body: formData,
            });
            if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
            showToast('リリースをアップロードしました');
            form.reset();
            fetchReleases(); fetchStats();
        } catch (e) { showToast((e as Error).message, 'err'); }
        setLoading(false);
    };

    const notifyUpdate = async () => {
        setLoading(true);
        try {
            const data = await apiFetch<{ successCount: number; totalCount: number }>('notify-update', apiKey, { method: 'POST' });
            showToast(`${data.successCount}/${data.totalCount}件のアップデート通知を送信しました`);
        } catch (e) { showToast((e as Error).message, 'err'); }
        setLoading(false);
    };

    const toggleEmail = (email: string) => {
        setSelectedEmails(prev => {
            const next = new Set(prev);
            next.has(email) ? next.delete(email) : next.add(email);
            return next;
        });
    };

    const selectAll = () => {
        const pending = users.filter(u => !u.invite_status || u.invite_status === 'pending');
        setSelectedEmails(new Set(pending.map(u => u.email)));
    };

    // --- ログイン画面 ---
    if (!isAuthed) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center p-4">
                <div className="glass-card rounded-2xl p-8 w-full max-w-md space-y-6">
                    <div className="text-center">
                        <h1 className="text-2xl font-heading font-bold text-foreground">🦅 Anti-Crow Admin</h1>
                        <p className="text-muted-foreground text-sm mt-2">管理ダッシュボードにログイン</p>
                    </div>
                    <div className="space-y-4">
                        <input
                            type="password"
                            value={keyInput}
                            onChange={e => setKeyInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleLogin()}
                            placeholder="Admin API Key"
                            className="w-full px-4 py-3 bg-secondary/50 border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <button onClick={handleLogin} className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-semibold hover:opacity-90 transition">
                            ログイン
                        </button>
                    </div>
                </div>
                {toast && <Toast msg={toast.msg} type={toast.type} />}
            </div>
        );
    }

    // --- ダッシュボード ---
    const tabs: { id: Tab; label: string; icon: string }[] = [
        { id: 'stats', label: '統計', icon: '📊' },
        { id: 'users', label: 'ユーザー', icon: '👥' },
        { id: 'releases', label: 'リリース', icon: '📦' },
        { id: 'emails', label: 'メール', icon: '✉️' },
    ];

    return (
        <div className="min-h-screen bg-background">
            {/* ヘッダー */}
            <header className="border-b border-border px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <span className="text-xl">🦅</span>
                    <h1 className="font-heading font-bold text-lg text-foreground">Anti-Crow Admin</h1>
                </div>
                <button onClick={() => { localStorage.removeItem('admin_api_key'); setIsAuthed(false); setApiKey(''); }}
                    className="text-sm text-muted-foreground hover:text-foreground transition">ログアウト</button>
            </header>

            {/* タブ */}
            <nav className="border-b border-border px-6 flex gap-1">
                {tabs.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                        className={`px-4 py-3 text-sm font-medium transition border-b-2 ${tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                        {t.icon} {t.label}
                    </button>
                ))}
            </nav>

            <main className="p-6 max-w-7xl mx-auto">
                {/* 統計タブ */}
                {tab === 'stats' && stats && (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                            <StatCard label="総登録数" value={stats.totalUsers} color="primary" />
                            <StatCard label="未招待" value={stats.pendingUsers} color="amber" />
                            <StatCard label="招待済み" value={stats.invitedUsers} color="indigo" />
                            <StatCard label="DL済み" value={stats.downloadedUsers} color="green" />
                            <StatCard label="総DL数" value={stats.totalDownloads} color="coral" />
                            <StatCard label="最近のメール" value={stats.recentEmails} color="blue" />
                        </div>
                    </div>
                )}

                {/* ユーザータブ */}
                {tab === 'users' && (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-3">
                            <input value={searchInput} onChange={e => handleSearchChange(e.target.value)}
                                placeholder="メールアドレスで検索..." className="px-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-64" />
                            <select value={userFilter} onChange={e => { setUserFilter(e.target.value); setUserPage(1); }}
                                className="px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground">
                                <option value="all">すべて</option>
                                <option value="pending">未招待</option>
                                <option value="invited">招待済み</option>
                                <option value="downloaded">DL済み</option>
                            </select>
                            <span className="text-sm text-muted-foreground">{userTotal}件</span>
                            <div className="ml-auto flex gap-2">
                                <button onClick={selectAll} className="px-3 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm hover:opacity-80 transition">全選択</button>
                                <button onClick={inviteSelected} disabled={loading || selectedEmails.size === 0}
                                    className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:opacity-80 transition disabled:opacity-40">
                                    {loading ? '送信中...' : `招待する (${selectedEmails.size})`}
                                </button>
                                <button onClick={() => inviteBatch(10)} disabled={loading}
                                    className="px-3 py-2 bg-accent text-accent-foreground rounded-lg text-sm hover:opacity-80 transition disabled:opacity-40">
                                    上位10人を招待
                                </button>
                            </div>
                        </div>
                        <div className="glass-card rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="p-3 text-left w-10"></th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">#</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">メール</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">ステータス</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">紹介数</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">登録日</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map(u => (
                                        <tr key={u.id} className="border-b border-border/50 hover:bg-secondary/30 transition">
                                            <td className="p-3">
                                                {(!u.invite_status || u.invite_status === 'pending') && (
                                                    <input type="checkbox" checked={selectedEmails.has(u.email)} onChange={() => toggleEmail(u.email)}
                                                        className="w-4 h-4 rounded accent-primary" />
                                                )}
                                            </td>
                                            <td className="p-3 text-muted-foreground">{u.position}</td>
                                            <td className="p-3 text-foreground font-mono text-xs">{u.email}</td>
                                            <td className="p-3"><StatusBadge status={u.invite_status} /></td>
                                            <td className="p-3 text-foreground">{u.referral_count}</td>
                                            <td className="p-3 text-muted-foreground text-xs">{u.created_at?.slice(0, 10)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {/* ページネーション */}
                        <div className="flex justify-center gap-2">
                            <button onClick={() => setUserPage(p => Math.max(1, p - 1))} disabled={userPage <= 1}
                                className="px-3 py-1 bg-secondary text-sm rounded-lg disabled:opacity-40">← 前</button>
                            <span className="text-sm text-muted-foreground py-1">ページ {userPage}</span>
                            <button onClick={() => setUserPage(p => p + 1)} disabled={users.length < 50}
                                className="px-3 py-1 bg-secondary text-sm rounded-lg disabled:opacity-40">次 →</button>
                        </div>
                    </div>
                )}

                {/* リリースタブ */}
                {tab === 'releases' && (
                    <div className="space-y-6">
                        <form onSubmit={uploadRelease} className="glass-card rounded-xl p-6 space-y-4">
                            <h2 className="font-heading font-bold text-foreground">新しいリリースをアップロード</h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <input name="version" placeholder="バージョン (例: 0.8.0)" required
                                    className="px-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
                                <input name="file" type="file" accept=".vsix" required
                                    className="px-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground file:mr-3 file:bg-primary file:text-primary-foreground file:border-0 file:rounded-lg file:px-3 file:py-1 file:text-sm file:cursor-pointer" />
                            </div>
                            <textarea name="changelog" placeholder="変更点 (任意)" rows={3}
                                className="w-full px-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
                            <button type="submit" disabled={loading}
                                className="px-6 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition disabled:opacity-40">
                                {loading ? 'アップロード中...' : '📤 アップロード'}
                            </button>
                        </form>
                        <div className="glass-card rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="p-3 text-left text-muted-foreground font-medium">バージョン</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">DL数</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">リリース日</th>
                                        <th className="p-3 text-left text-muted-foreground font-medium">ステータス</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {releases.map(r => (
                                        <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/30 transition">
                                            <td className="p-3 text-foreground font-mono">v{r.version}</td>
                                            <td className="p-3 text-foreground">{r.download_count}</td>
                                            <td className="p-3 text-muted-foreground text-xs">{r.created_at?.slice(0, 10)}</td>
                                            <td className="p-3">{r.is_latest ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">最新</span> : <span className="text-xs text-muted-foreground">旧版</span>}</td>
                                        </tr>
                                    ))}
                                    {releases.length === 0 && (
                                        <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">リリースがまだありません</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* メールタブ */}
                {tab === 'emails' && (
                    <div className="space-y-6">
                        <div className="glass-card rounded-xl p-6">
                            <h2 className="font-heading font-bold text-foreground mb-4">一括アップデート通知</h2>
                            <p className="text-sm text-muted-foreground mb-4">
                                招待済みのユーザーに最新バージョンのアップデート通知メールを送信します。
                            </p>
                            <button onClick={notifyUpdate} disabled={loading}
                                className="px-6 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition disabled:opacity-40">
                                {loading ? '送信中...' : '🚀 アップデート通知を送信'}
                            </button>
                        </div>
                    </div>
                )}
            </main>

            {toast && <Toast msg={toast.msg} type={toast.type} />}
        </div>
    );
}

// --- サブコンポーネント ---
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
    const colors: Record<string, string> = {
        primary: 'border-primary/30 bg-primary/5',
        amber: 'border-yellow-500/30 bg-yellow-500/5',
        indigo: 'border-indigo-500/30 bg-indigo-500/5',
        green: 'border-green-500/30 bg-green-500/5',
        coral: 'border-pink-500/30 bg-pink-500/5',
        blue: 'border-blue-500/30 bg-blue-500/5',
    };
    return (
        <div className={`rounded-xl border p-4 ${colors[color] || colors.primary}`}>
            <div className="text-2xl font-bold text-foreground">{value.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground mt-1">{label}</div>
        </div>
    );
}

function StatusBadge({ status }: { status: string | null }) {
    const s = status || 'pending';
    const styles: Record<string, string> = {
        pending: 'bg-yellow-500/20 text-yellow-400',
        invited: 'bg-blue-500/20 text-blue-400',
        downloaded: 'bg-green-500/20 text-green-400',
    };
    const labels: Record<string, string> = {
        pending: '未招待',
        invited: '招待済み',
        downloaded: 'DL済み',
    };
    return <span className={`text-xs px-2 py-0.5 rounded-full ${styles[s] || styles.pending}`}>{labels[s] || s}</span>;
}

function Toast({ msg, type }: { msg: string; type: 'ok' | 'err' }) {
    return (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm font-medium shadow-lg z-50 animate-in slide-in-from-bottom-2 ${type === 'ok' ? 'bg-green-500/90 text-white' : 'bg-red-500/90 text-white'}`}>
            {msg}
        </div>
    );
}
