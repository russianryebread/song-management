CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_name TEXT NOT NULL DEFAULT 'Men’s group',
  default_text_scale REAL NOT NULL DEFAULT 1.0 CHECK (default_text_scale >= 0.75 AND default_text_scale <= 1.35),
  default_repeat_chorus INTEGER NOT NULL DEFAULT 0 CHECK (default_repeat_chorus IN (0, 1)),
  default_show_slide_count INTEGER NOT NULL DEFAULT 1 CHECK (default_show_slide_count IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (
  id, group_name, default_text_scale, default_repeat_chorus, default_show_slide_count, updated_at
) VALUES (1, 'Men’s group', 1.0, 0, 1, '2026-08-12T00:00:00.000Z');
