CREATE TABLE IF NOT EXISTS trusted_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO trusted_sources (id, name, base_url, enabled, created_at, updated_at)
VALUES
  ('trusted-hymnary', 'Hymnary', 'https://hymnary.org/', 1, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('trusted-hymnal-net', 'Hymnal.net', 'https://hymnal.net/', 1, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
