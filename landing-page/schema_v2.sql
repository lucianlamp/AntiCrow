-- AntiCrow Waitlist Schema v2 - VSIX配布システム拡張

-- 既存 waitlist テーブルにカラム追加
ALTER TABLE waitlist ADD COLUMN invited_at TEXT;
ALTER TABLE waitlist ADD COLUMN invite_status TEXT DEFAULT 'pending';
ALTER TABLE waitlist ADD COLUMN current_version TEXT;

-- リリース管理テーブル
CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    r2_key TEXT NOT NULL,
    changelog TEXT,
    download_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    is_latest INTEGER DEFAULT 0
);

-- 招待ログテーブル
CREATE TABLE IF NOT EXISTS invite_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    version TEXT NOT NULL,
    download_token TEXT UNIQUE,
    token_expires_at TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    downloaded_at TEXT,
    status TEXT DEFAULT 'sent'
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_releases_version ON releases(version);
CREATE INDEX IF NOT EXISTS idx_releases_is_latest ON releases(is_latest);
CREATE INDEX IF NOT EXISTS idx_invite_logs_email ON invite_logs(email);
CREATE INDEX IF NOT EXISTS idx_invite_logs_token ON invite_logs(download_token);
CREATE INDEX IF NOT EXISTS idx_waitlist_invite_status ON waitlist(invite_status);
