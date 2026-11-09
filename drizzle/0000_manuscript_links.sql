CREATE TABLE manuscript_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('copy', 'room')),
  title TEXT NOT NULL,
  manuscript TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE room_changes (
  room_id TEXT NOT NULL REFERENCES manuscript_links(id),
  revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  patch TEXT NOT NULL,
  PRIMARY KEY (room_id, revision),
  UNIQUE (room_id, operation_id)
);
