PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  hymn_number TEXT,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  source_url TEXT,
  lyrics_source_name TEXT,
  lyrics_format TEXT NOT NULL DEFAULT 'sectioned-v1',
  lyrics_text TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS songs_hymn_number_idx ON songs(hymn_number);
CREATE INDEX IF NOT EXISTS songs_normalized_title_idx ON songs(normalized_title);

CREATE TABLE IF NOT EXISTS song_aliases (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(song_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS song_aliases_normalized_alias_idx
  ON song_aliases(normalized_alias);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  meeting_date TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'past')),
  notes TEXT NOT NULL DEFAULT '',
  view_token TEXT UNIQUE,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_songs (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(meeting_id, position)
);

CREATE INDEX IF NOT EXISTS meeting_songs_song_id_idx ON meeting_songs(song_id);

CREATE TABLE IF NOT EXISTS meeting_slides (
  id TEXT PRIMARY KEY,
  meeting_song_id TEXT NOT NULL REFERENCES meeting_songs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('title', 'lyrics')),
  section TEXT,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(meeting_song_id, position)
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL UNIQUE,
  source_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);
