PRAGMA foreign_keys = OFF;

CREATE TABLE app_settings_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_name TEXT NOT NULL DEFAULT 'Men’s group',
  default_text_scale REAL NOT NULL DEFAULT 1.0 CHECK (default_text_scale >= 0.75 AND default_text_scale <= 1.35),
  default_presenter_font TEXT NOT NULL DEFAULT 'libre-baskerville'
    CHECK (default_presenter_font IN ('libre-baskerville', 'inter', 'raleway')),
  default_repeat_chorus INTEGER NOT NULL DEFAULT 0 CHECK (default_repeat_chorus IN (0, 1)),
  default_show_slide_count INTEGER NOT NULL DEFAULT 1 CHECK (default_show_slide_count IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings_next (
  id, group_name, default_text_scale, default_presenter_font,
  default_repeat_chorus, default_show_slide_count, updated_at
)
SELECT
  id, group_name, default_text_scale,
  CASE default_presenter_font
    WHEN 'roboto' THEN 'libre-baskerville'
    ELSE default_presenter_font
  END,
  default_repeat_chorus, default_show_slide_count, updated_at
FROM app_settings;

DROP TABLE app_settings;
ALTER TABLE app_settings_next RENAME TO app_settings;

PRAGMA foreign_keys = ON;
