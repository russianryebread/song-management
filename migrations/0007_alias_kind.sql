ALTER TABLE song_aliases ADD COLUMN kind TEXT NOT NULL DEFAULT 'alternate'
  CHECK (kind IN ('alternate', 'first-line'));
ALTER TABLE song_aliases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
