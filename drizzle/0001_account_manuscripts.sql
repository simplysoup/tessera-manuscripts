ALTER TABLE manuscript_links ADD COLUMN owner_id TEXT;
--> statement-breakpoint
ALTER TABLE manuscript_links ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE user_manuscripts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  manuscript TEXT NOT NULL,
  updated INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX user_manuscripts_owner_updated ON user_manuscripts(owner_id, updated DESC);
--> statement-breakpoint
CREATE TABLE user_room_access (
  owner_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES manuscript_links(id),
  created INTEGER NOT NULL,
  PRIMARY KEY (owner_id, room_id)
);
--> statement-breakpoint
CREATE TABLE user_share_limits (
  owner_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (owner_id, day)
);
