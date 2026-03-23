-- AntiCrow Licenses Schema v3 - Stripe ライセンス管理テーブル

CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE NOT NULL,
    email TEXT,
    plan TEXT DEFAULT 'lifetime',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    activated_at TEXT,
    machine_id TEXT
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_customer ON licenses(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
