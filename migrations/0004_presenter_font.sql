ALTER TABLE app_settings ADD COLUMN default_presenter_font TEXT NOT NULL DEFAULT 'roboto'
  CHECK (default_presenter_font IN ('roboto', 'inter', 'raleway'));
