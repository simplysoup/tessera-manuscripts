ALTER TABLE demo_auth_attempts ADD COLUMN account_hash TEXT;
--> statement-breakpoint
CREATE INDEX demo_auth_attempts_account_time ON demo_auth_attempts(account_hash, attempted);
--> statement-breakpoint
CREATE TABLE demo_recovery_codes (
  user_id TEXT NOT NULL REFERENCES demo_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
--> statement-breakpoint
CREATE INDEX demo_recovery_codes_user ON demo_recovery_codes(user_id, used_at);
--> statement-breakpoint
CREATE TABLE room_change_limits (
  room_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (room_id, minute)
);
--> statement-breakpoint
CREATE INDEX room_change_limits_minute ON room_change_limits(minute);
