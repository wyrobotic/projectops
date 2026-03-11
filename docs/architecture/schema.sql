-- ProjectOPS — Canonical Database Schema
-- Target: NeonDB (serverless Postgres)
-- Run once via NeonDB SQL editor or: psql $NEON_DATABASE_URL -f schema.sql
--
-- Design notes:
--   - No user_id on any table. Auth is an access gate; data is shared across all users.
--   - Primary keys are TEXT to preserve uid() format (Date.now().toString(36) + random).
--   - sort_order on all user-orderable tables for drag-and-drop.
--   - ON DELETE CASCADE on projects.goal_id — deleting a goal removes its projects.
--   - ON DELETE SET NULL on goals.vertical_id — deleting a vertical orphans goals.


-- ── verticals ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verticals (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL UNIQUE,     -- 4-char uppercase alphanumeric
  color       TEXT        NOT NULL,            -- hex string e.g. "#c0392b"
  space_id    TEXT,                            -- ClickUp Space ID, nullable
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verticals_sort_order_idx ON verticals(sort_order);


-- ── goals ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT        PRIMARY KEY,
  vertical_id   TEXT        REFERENCES verticals(id) ON DELETE SET NULL,
  name          TEXT        NOT NULL,
  code          TEXT,                          -- e.g. "ACME-100", null if no vertical
  type          TEXT        NOT NULL CHECK (type IN ('deliverable', 'timebox')),
  date          DATE,                          -- target / start date
  end_date      DATE,                          -- timebox end date, null for deliverables
  description   TEXT        NOT NULL DEFAULT '',
  boundaries    TEXT        NOT NULL DEFAULT '',
  cu_folder_id  TEXT,                          -- ClickUp Folder ID
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goals_vertical_id_idx ON goals(vertical_id);
CREATE INDEX IF NOT EXISTS goals_sort_order_idx  ON goals(sort_order);


-- ── projects ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT        PRIMARY KEY,
  goal_id       TEXT        NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  code_base     TEXT        NOT NULL,          -- e.g. "ACME-2611A"
  code_prefix   TEXT        NOT NULL,          -- e.g. "ACME-2611" — letter sequencing key
  full_code     TEXT        NOT NULL,          -- e.g. "ACME-2611A Website"
  descriptor    TEXT        NOT NULL DEFAULT '',
  name          TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  type          TEXT        NOT NULL DEFAULT '',
  status        TEXT        NOT NULL DEFAULT 'backlog'
                            CHECK (status IN ('backlog', 'progress', 'blocked', 'done', 'archived')),
  cu_list_id    TEXT,                          -- ClickUp List ID
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS projects_goal_id_idx     ON projects(goal_id);
CREATE INDEX IF NOT EXISTS projects_code_prefix_idx ON projects(code_prefix);
CREATE INDEX IF NOT EXISTS projects_sort_order_idx  ON projects(sort_order);


-- ── project_types ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_types (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_types_sort_order_idx ON project_types(sort_order);


-- ── default project types ─────────────────────────────────────────────────────
-- Matches the default types array from the localStorage version of the app.
-- Skip this block if types already seeded.

INSERT INTO project_types (id, name, sort_order) VALUES
  ('type-strategy',    'Strategy',    0),
  ('type-design',      'Design',      1),
  ('type-development', 'Development', 2),
  ('type-content',     'Content',     3),
  ('type-operations',  'Operations',  4),
  ('type-research',    'Research',    5)
ON CONFLICT (name) DO NOTHING;
