-- Preserve existing archived usage; future drafts only count after publication.
UPDATE meetings
SET published_at = COALESCE(NULLIF(updated_at, ''), NULLIF(created_at, ''), meeting_date)
WHERE status IN ('past', 'published') AND published_at IS NULL;
