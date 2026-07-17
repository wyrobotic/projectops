-- Migration: add priority + drive_url to projects
-- Date:      2026-07-17
-- Purpose:   Support the revised project view — a priority field for client-side
--            sorting/filtering and a manually-pasted Google Drive folder URL.
--
-- Safe to run on a live NeonDB with existing data:
--   - Uses ADD COLUMN IF NOT EXISTS so re-running is a no-op (idempotent).
--   - priority is NOT NULL DEFAULT 'medium' — existing rows backfill to 'medium'.
--   - drive_url is nullable — no default, no backfill.
--   - No transaction wrapper: the NeonDB HTTP driver has no transactions, so
--     each statement runs independently. Both statements are individually idempotent.
--
-- How to run:
--   psql "$NEON_DATABASE_URL" -f docs/architecture/migrations/2026-07-17-add-project-priority-drive-url.sql
--   ...or paste the two ALTER TABLE statements into the Neon SQL editor.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('urgent', 'high', 'medium', 'low'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS drive_url TEXT;
