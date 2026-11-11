-- Release blockers: demo-account isolation, forced password change, login throttling

-- Marks accounts created by the demo seed scripts. Demo accounts must never be
-- usable as real business accounts in a production deployment.
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

-- Forces a password change before the account can be used for anything else.
-- Set for retained demo accounts so the published demo password cannot become
-- a real credential.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- When the password was last changed (audit trail for the forced-change flow).
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_users_is_demo ON users(is_demo);

-- Persistent login-attempt log. An in-memory limiter alone would reset on every
-- restart, which is exactly when an attacker would retry.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  succeeded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);
