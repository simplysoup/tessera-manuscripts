CREATE TABLE demo_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE demo_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES demo_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX demo_sessions_expiry ON demo_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE demo_auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  attempted INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX demo_auth_attempts_ip_time ON demo_auth_attempts(ip_hash, attempted);
