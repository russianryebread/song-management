ALTER TABLE trusted_sources ADD COLUMN lyrics_selector TEXT NOT NULL DEFAULT '';

UPDATE trusted_sources
SET lyrics_selector = CASE
  WHEN lower(rtrim(base_url, '/')) IN (
    'https://hymnary.net', 'https://www.hymnary.net',
    'https://hymnary.org', 'https://www.hymnary.org'
  ) THEN '#at_fulltext'
  WHEN lower(rtrim(base_url, '/')) IN (
    'https://hymnallibrary.org', 'https://www.hymnallibrary.org'
  ) THEN '.hymn-main-card'
  WHEN lower(rtrim(base_url, '/')) IN (
    'https://hymnal.net', 'https://www.hymnal.net'
  ) THEN '.hymn-content'
  ELSE ''
END;
