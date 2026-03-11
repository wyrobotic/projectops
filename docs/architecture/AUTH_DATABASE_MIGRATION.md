# Architecture: AUTH_DATABASE_MIGRATION

**Phase**: ARCHITECT
**Feature**: Migrate ProjectOPS from localStorage to NeonDB + Clerk auth
**Date**: 2026-03-11
**Status**: Complete — ready for CODE phase
**Preparation doc**: `docs/preparation/AUTH_DATABASE_MIGRATION.md`

---

## 1. Executive Summary

ProjectOPS moves from a single-page app backed by `localStorage` to one backed by NeonDB (Postgres) with Clerk handling invite-only authentication. The frontend remains a single vanilla HTML/CSS/JS file served as a static asset from Vercel. All persistence moves through Vercel Serverless Functions in `api/`.

**Locked decisions (from user, not open for debate):**

- **Shared data model**: no `user_id` on any table. Auth is an access gate only. All authenticated users see and edit the same global dataset.
- **Clerk publishable key**: hardcoded directly in `index.html`. It is a publishable key — safe in HTML.
- **No data migration**: fresh start. No import endpoint needed.
- **ClickUp proxy stays unauthenticated**: `/api/clickup` requires no Clerk token verification.

---

## 2. System Context

```
Browser (index.html — vanilla JS)
  │
  ├─── Static assets ──────────────────────────────► Vercel CDN
  │
  ├─── Clerk SDK (CDN) ────────────────────────────► Clerk cloud (auth)
  │
  ├─── /api/verticals  ┐
  ├─── /api/goals      │ Vercel Serverless
  ├─── /api/projects   │ Functions (Node.js)
  ├─── /api/project-types                           │
  └─── /api/clickup   ─┘ (no auth check)
           │
           ├── @clerk/backend (token verification) ─► Clerk cloud
           ├── @neondatabase/serverless ────────────► NeonDB (Postgres)
           └── fetch() to ClickUp v2 API ───────────► ClickUp cloud
```

**External dependencies:**

| Service | Purpose | Auth mechanism |
|---------|---------|----------------|
| Clerk | Identity / session tokens | Frontend SDK + Backend JWT verification |
| NeonDB | Postgres persistence | `NEON_DATABASE_URL` connection string |
| ClickUp | Project management integration | `CLICKUP_API_TOKEN` server-side env var |
| Vercel | Hosting, CDN, serverless runtime | Deployment platform |

---

## 3. Database Schema

### Design principles

- **No `user_id` on any table** — shared dataset, auth is only a gate.
- Primary keys use `TEXT` — preserves the existing `uid()` format (`Date.now().toString(36) + random`). No UUID generation required.
- `sort_order INTEGER` on every user-orderable table — supports drag-and-drop without re-keying.
- `ON DELETE CASCADE` on `projects.goal_id` — deleting a goal removes its projects (matches current localStorage behavior).
- `ON DELETE SET NULL` on `goals.vertical_id` — deleting a vertical orphans its goals rather than destroying them.
- All timestamps as `TIMESTAMPTZ`.

### DDL

```sql
-- ── verticals ────────────────────────────────────────────
CREATE TABLE verticals (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL UNIQUE,   -- 4-char uppercase, globally unique
  color       TEXT        NOT NULL,          -- hex string e.g. "#c0392b"
  space_id    TEXT,                          -- ClickUp Space ID, nullable
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX verticals_sort_order_idx ON verticals(sort_order);

-- ── goals ────────────────────────────────────────────────
CREATE TABLE goals (
  id            TEXT        PRIMARY KEY,
  vertical_id   TEXT        REFERENCES verticals(id) ON DELETE SET NULL,
  name          TEXT        NOT NULL,
  code          TEXT,                        -- e.g. "ACME-100", generated server-side, nullable if no vertical
  type          TEXT        NOT NULL CHECK (type IN ('deliverable','timebox')),
  date          DATE,                        -- target / start date
  end_date      DATE,                        -- timebox end date, null for deliverables
  description   TEXT        NOT NULL DEFAULT '',
  boundaries    TEXT        NOT NULL DEFAULT '',
  cu_folder_id  TEXT,                        -- ClickUp Folder ID
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX goals_vertical_id_idx  ON goals(vertical_id);
CREATE INDEX goals_sort_order_idx   ON goals(sort_order);

-- ── projects ─────────────────────────────────────────────
CREATE TABLE projects (
  id            TEXT        PRIMARY KEY,
  goal_id       TEXT        NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  code_base     TEXT        NOT NULL,        -- e.g. "ACME-2611A"
  code_prefix   TEXT        NOT NULL,        -- e.g. "ACME-2611" — used for letter sequencing
  full_code     TEXT        NOT NULL,        -- e.g. "ACME-2611A Website"
  descriptor    TEXT        NOT NULL DEFAULT '',
  name          TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  type          TEXT        NOT NULL DEFAULT '',
  status        TEXT        NOT NULL DEFAULT 'backlog'
                            CHECK (status IN ('backlog','progress','blocked','done','archived')),
  cu_list_id    TEXT,                        -- ClickUp List ID
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX projects_goal_id_idx     ON projects(goal_id);
CREATE INDEX projects_code_prefix_idx ON projects(code_prefix);  -- used in letter sequencing query
CREATE INDEX projects_sort_order_idx  ON projects(sort_order);

-- ── project_types ─────────────────────────────────────────
CREATE TABLE project_types (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX project_types_sort_order_idx ON project_types(sort_order);
```

### Schema notes

- `verticals.code` is `UNIQUE` globally (no `user_id` scope). Duplicate codes across all users are rejected. The frontend already enforces this — the DB constraint is a safety net.
- `project_types.name` is `UNIQUE` globally for the same reason.
- No `users` table. No Clerk user ID stored anywhere.

---

## 4. Code Generation Logic

Both goal codes and project codes must be generated server-side inside a transaction to prevent race conditions between concurrent requests.

### 4.1 Goal code generation

Goal codes follow the pattern `VERTCODE-100`, `VERTCODE-101`, etc. — sequential per vertical, starting at 100.

**Transaction pattern** (inside `POST /api/goals`):

```sql
-- Step 1: lock the vertical row to prevent concurrent inserts racing on the count
SELECT id, code FROM verticals WHERE id = $verticalId FOR UPDATE;

-- Step 2: count existing goals for this vertical
SELECT COUNT(*) AS cnt FROM goals WHERE vertical_id = $verticalId;

-- Step 3: derive code in application layer
-- goalCode = `${vertical.code}-${100 + parseInt(cnt)}`

-- Step 4: insert the new goal with the derived code
INSERT INTO goals (id, vertical_id, name, code, ...) VALUES (...);
```

The `FOR UPDATE` lock on the vertical row serialises concurrent goal-create requests for the same vertical. The lock is held only for the duration of the transaction (milliseconds).

If `verticalId` is null, `code` is set to `null` — no code for unassigned goals.

### 4.2 Project code generation

Project codes follow the pattern `VERTCODE-YYWW[LETTER]` where `YY` = 2-digit year, `WW` = ISO week number (zero-padded), `LETTER` = A, B, C... sequential within that prefix.

The prefix is derived from the goal's vertical at request time.

**Transaction pattern** (inside `POST /api/projects`):

```sql
-- Step 1: fetch the goal and its vertical in one query
SELECT g.id, g.cu_folder_id, v.code AS vert_code, v.space_id
FROM goals g
LEFT JOIN verticals v ON v.id = g.vertical_id
WHERE g.id = $goalId
FOR UPDATE;     -- locks the goal row; prevents concurrent project creation under same goal racing

-- Step 2: compute prefix in application layer
-- yy  = String(new Date().getFullYear()).slice(2)
-- ww  = String(isoWeekNumber(new Date())).padStart(2, '0')
-- prefix = `${vertCode}-${yy}${ww}`

-- Step 3: count existing projects with this prefix (across ALL goals, not just this one)
SELECT COUNT(*) AS cnt FROM projects WHERE code_prefix = $prefix;

-- Step 4: derive letter and codes in application layer
-- letter   = String.fromCharCode(65 + parseInt(cnt))   // 'A', 'B', 'C'...
-- codeBase = `${prefix}${letter}`                       // e.g. "ACME-2611A"
-- fullCode = descriptor ? `${codeBase} ${descriptor}` : codeBase

-- Step 5: insert
INSERT INTO projects (id, goal_id, code_base, code_prefix, full_code, ...) VALUES (...);
```

**ISO week number helper** — must be implemented identically to the frontend's `isoWeek()` function to avoid code drift. This function must live in `api/_utils.js` and be used by both the project creation handler and any future endpoints that need it.

```javascript
// api/_utils.js
export function isoWeekNumber(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const w1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - w1) / 86400000 - 3 + (w1.getDay() + 6) % 7) / 7);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
```

---

## 5. API Specification

### Auth contract

Every endpoint except `/api/clickup` requires a valid Clerk session token in the `Authorization` header:

```
Authorization: Bearer <clerk_session_token>
```

Returns `401 { "error": "Unauthorized" }` if the token is missing or invalid.

### Error response shape (all endpoints)

```json
{ "error": "Human-readable message" }
```

HTTP status codes: `200` OK, `201` Created, `400` Bad Request, `401` Unauthorized, `404` Not Found, `405` Method Not Allowed, `500` Internal Server Error.

---

### Resource: Verticals — `api/verticals.js`

Handles all methods via query param dispatch: `?action=reorder` for batch reorder, otherwise dispatch on `req.method` + `req.query.id`.

#### `GET /api/verticals`

Returns all verticals ordered by `sort_order ASC`.

**Auth**: required

**Response 200:**
```json
[
  {
    "id": "abc123",
    "name": "Acme Corp",
    "code": "ACME",
    "color": "#c0392b",
    "spaceId": "90112345678",
    "sortOrder": 0
  }
]
```

Field mapping: DB `space_id` → JSON `spaceId`, DB `sort_order` → JSON `sortOrder`. All API responses use camelCase JSON. All DB columns use snake_case.

---

#### `POST /api/verticals`

Creates a new vertical.

**Auth**: required

**Request body:**
```json
{
  "name": "Acme Corp",
  "code": "ACME",
  "color": "#c0392b",
  "spaceId": "90112345678"
}
```

**Validation:**
- `name`: required, non-empty string
- `code`: required, 1–4 chars, uppercase alphanumeric — server normalises to uppercase
- `color`: required, non-empty string
- `spaceId`: optional, string or null

**Response 201:** Full vertical object (same shape as GET list item).

**Response 400:** `{ "error": "name and code are required" }` or `{ "error": "code already in use" }` (DB unique constraint violation catches the latter — catch `23505` Postgres error code).

---

#### `PUT /api/verticals?id={id}`

Updates a vertical.

**Auth**: required

**Request body:** Same fields as POST, all optional (partial update). Server only updates fields present in body.

**Response 200:** Updated vertical object.

**Response 404:** `{ "error": "Not found" }` if `id` does not exist.

---

#### `DELETE /api/verticals?id={id}`

Deletes a vertical. Goals that referenced this vertical have their `vertical_id` set to `NULL` (cascade defined in schema).

**Auth**: required

**Response 200:** `{ "ok": true }`

**Response 404:** `{ "error": "Not found" }`

---

#### `PUT /api/verticals?action=reorder`

Batch-updates `sort_order` for verticals. Accepts a full ordered list of IDs; assigns `sort_order` equal to array index.

**Auth**: required

**Request body:**
```json
{ "ids": ["id3", "id1", "id2"] }
```

**Implementation:** Run a single SQL `UPDATE` with a `CASE` expression or a `unnest` + `UPDATE FROM` pattern to update all rows in one query.

```sql
UPDATE verticals
SET sort_order = v.ord
FROM (
  SELECT unnest($1::text[]) AS id,
         generate_series(0, array_length($1::text[], 1) - 1) AS ord
) AS v
WHERE verticals.id = v.id;
```

**Response 200:** `{ "ok": true }`

---

### Resource: Goals — `api/goals.js`

#### `GET /api/goals`

Returns all goals ordered by `sort_order ASC`. Optionally filtered.

**Auth**: required

**Query params:**
- `?verticalId={id}` — filter to goals belonging to this vertical (optional)

**Response 200:**
```json
[
  {
    "id": "def456",
    "verticalId": "abc123",
    "name": "Q2 Website Overhaul",
    "code": "ACME-100",
    "type": "deliverable",
    "date": "2026-06-30",
    "endDate": null,
    "description": "Full redesign...",
    "boundaries": "Does not include...",
    "cuFolderId": "cu_folder_789",
    "sortOrder": 0
  }
]
```

---

#### `POST /api/goals`

Creates a new goal. Generates goal code server-side. Triggers ClickUp folder creation if the vertical has a `space_id` and the ClickUp token is configured.

**Auth**: required

**Request body:**
```json
{
  "name": "Q2 Website Overhaul",
  "type": "deliverable",
  "verticalId": "abc123",
  "date": "2026-06-30",
  "endDate": null,
  "description": "Full redesign...",
  "boundaries": "Does not include..."
}
```

**Validation:**
- `name`: required, non-empty
- `type`: required, must be `"deliverable"` or `"timebox"`
- `verticalId`: optional, string or null
- `date`: optional, ISO date string or null
- `endDate`: optional, ISO date string or null (only meaningful when `type === "timebox"`)
- `description`, `boundaries`: optional strings, default `""`

**Server-side logic:**
1. If `verticalId` is provided: open transaction, `SELECT ... FOR UPDATE` on vertical, count existing goals for that vertical, derive `code`.
2. Generate `id` via `uid()`.
3. If vertical has `space_id` and `CLICKUP_API_TOKEN` is set: call ClickUp `POST /space/{spaceId}/folder` with `name = "${code} ${name}"`. Store returned folder ID as `cu_folder_id`. ClickUp failure is non-fatal — log, set `cu_folder_id = null`, continue.
4. Insert goal row.
5. Commit.

**Response 201:** Full goal object.

---

#### `PUT /api/goals?id={id}`

Updates a goal. Does NOT re-generate the code. Does NOT create ClickUp folders on edit (matches current app behavior — ClickUp folder is only created on initial save).

**Auth**: required

**Request body:** Any subset of goal fields. `code` is read-only via this endpoint (ignored if present in body).

**Response 200:** Updated goal object.

**Response 404:** `{ "error": "Not found" }`

---

#### `DELETE /api/goals?id={id}`

Deletes a goal. Projects cascade-delete via DB constraint.

**Auth**: required

**Response 200:** `{ "ok": true }`

**Response 404:** `{ "error": "Not found" }`

---

#### `PUT /api/goals?action=reorder`

Batch sort_order update. Same pattern as verticals reorder.

**Auth**: required

**Request body:** `{ "ids": ["id3", "id1", "id2"] }`

**Response 200:** `{ "ok": true }`

---

### Resource: Projects — `api/projects.js`

#### `GET /api/projects`

Returns all projects ordered by `sort_order ASC`. Optionally filtered.

**Auth**: required

**Query params:**
- `?goalId={id}` — filter to projects belonging to this goal (optional)

**Response 200:**
```json
[
  {
    "id": "ghi789",
    "goalId": "def456",
    "codeBase": "ACME-2611A",
    "codePrefix": "ACME-2611",
    "fullCode": "ACME-2611A Website",
    "descriptor": "Website",
    "name": "Website Redesign",
    "description": "...",
    "type": "Design",
    "status": "backlog",
    "cuListId": null,
    "sortOrder": 0
  }
]
```

---

#### `POST /api/projects`

Creates a new project. Generates project code server-side. Triggers ClickUp list creation if the parent goal has a `cu_folder_id`.

**Auth**: required

**Request body:**
```json
{
  "goalId": "def456",
  "descriptor": "Website",
  "name": "Website Redesign",
  "description": "High-level description...",
  "type": "Design",
  "status": "backlog"
}
```

**Validation:**
- `goalId`: required
- `name`: required, non-empty
- `descriptor`: optional string, default `""`
- `type`: optional string
- `status`: optional, default `"backlog"`, must be one of the valid status values
- `description`: optional string

**Server-side logic:**
1. Open transaction.
2. `SELECT g.id, g.cu_folder_id, v.code, v.space_id FROM goals g LEFT JOIN verticals v ON v.id = g.vertical_id WHERE g.id = $goalId FOR UPDATE`.
3. Compute `prefix` from `vertCode + yy + ww`.
4. `SELECT COUNT(*) FROM projects WHERE code_prefix = $prefix` (within transaction).
5. Derive `letter`, `codeBase`, `fullCode`.
6. Generate `id` via `uid()`.
7. If goal has `cu_folder_id`: call ClickUp `POST /folder/{folderId}/list` with `name = fullCode`. Store `cu_list_id`. Non-fatal on failure.
8. Insert project row.
9. Commit.

**Response 201:** Full project object.

---

#### `PUT /api/projects?id={id}`

Updates a project. Handles the ClickUp archive side-effect.

**Auth**: required

**Request body:** Any subset of project fields. `code_base`, `code_prefix`, `full_code` are NOT updatable via this endpoint (codes are immutable after creation). `descriptor` IS updatable — when updated, server recomputes `full_code = codeBase + " " + descriptor` (or just `codeBase` if descriptor is empty).

**Special behavior — status transition to `"archived"`:**
If `status` in the body is `"archived"` and the current DB row has a different status AND has a `cu_list_id`: call ClickUp `PUT /list/{listId}` with `{ archived: true }`. Non-fatal on failure.

**Response 200:** Updated project object.

**Response 404:** `{ "error": "Not found" }`

---

#### `DELETE /api/projects?id={id}`

Deletes a project.

**Auth**: required

**Response 200:** `{ "ok": true }`

**Response 404:** `{ "error": "Not found" }`

---

#### `PUT /api/projects?action=reorder`

Batch update of `status` and `sort_order` for drag-and-drop across kanban columns. Accepts an array of `{ id, status, sortOrder }` tuples; updates all in a single transaction.

**Auth**: required

**Request body:**
```json
{
  "updates": [
    { "id": "ghi789", "status": "progress", "sortOrder": 0 },
    { "id": "jkl012", "status": "progress", "sortOrder": 1 }
  ]
}
```

**Implementation:** Use a single SQL `UPDATE ... FROM unnest(...)` to batch-update all rows without N round-trips.

```sql
UPDATE projects
SET status     = v.status,
    sort_order = v.ord,
    updated_at = NOW()
FROM (
  SELECT
    unnest($1::text[])    AS id,
    unnest($2::text[])    AS status,
    unnest($3::integer[]) AS ord
) AS v
WHERE projects.id = v.id;
```

**Note:** This endpoint does NOT trigger ClickUp archive. The ClickUp archive side-effect only fires on the single-item `PUT /api/projects?id={id}` path. Drag-to-archive on the kanban is a UX decision for the coder — it can either call the single-item PUT or handle it as a special case in the reorder call. Recommended: the frontend calls the single-item PUT when dragging to the `archived` column, and calls the batch reorder only when dragging within or between non-archive columns.

**Response 200:** `{ "ok": true }`

---

### Resource: Project Types — `api/project-types.js`

#### `GET /api/project-types`

Returns all types ordered by `sort_order ASC`.

**Auth**: required

**Response 200:**
```json
[
  { "id": "type1", "name": "Strategy", "sortOrder": 0 },
  { "id": "type2", "name": "Design",   "sortOrder": 1 }
]
```

---

#### `POST /api/project-types`

Adds a new type.

**Auth**: required

**Request body:** `{ "name": "Research" }`

**Validation:** `name` required, non-empty. DB unique constraint on `name` catches duplicates — return `400 { "error": "Type already exists" }` on `23505`.

**`sort_order`**: set to `(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_types)` — appends to end.

**Response 201:** `{ "id": "type3", "name": "Research", "sortOrder": 5 }`

---

#### `DELETE /api/project-types?id={id}`

Removes a type. Does NOT cascade to projects (projects retain their `type` string value — it becomes a "dangling" label, which matches the current localStorage behavior).

**Auth**: required

**Response 200:** `{ "ok": true }`

---

### Resource: ClickUp Proxy — `api/clickup.js`

**No changes.** Remains exactly as-is. No Clerk auth check added (locked decision).

---

## 6. Clerk Auth Architecture

### 6.1 Frontend: CDN loading

The Clerk JavaScript SDK is loaded via a CDN script tag in `<head>`. The publishable key is hardcoded in the HTML. No runtime config fetch, no environment variable substitution at serve time.

```html
<!-- public/index.html — in <head>, before any app scripts -->
<script
  async
  crossorigin="anonymous"
  data-clerk-publishable-key="pk_live_XXXXXXXXXX"
  src="https://YOUR_FRONTEND_API.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
  type="text/javascript"
></script>
```

The `src` URL is the Clerk Frontend API URL, available in the Clerk Dashboard under "API Keys". It is NOT `unpkg.com` or a generic CDN — it is specific to the Clerk application instance.

### 6.2 Frontend: Auth wall pattern

The app HTML is split into two top-level containers:

```html
<div id="auth-wall" style="display:none">
  <div id="sign-in-container"></div>
</div>

<div id="app" style="display:none">
  <!-- existing app HTML -->
</div>
```

On page load, both are hidden. After Clerk loads, exactly one is shown:

```javascript
window.addEventListener('load', async function () {
  await window.Clerk.load();

  if (window.Clerk.user) {
    document.getElementById('auth-wall').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    // Mount user button in header
    window.Clerk.mountUserButton(document.getElementById('userBtn'));
    initApp();
  } else {
    document.getElementById('auth-wall').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    window.Clerk.mountSignIn(document.getElementById('sign-in-container'));
  }
});
```

The existing `load()` / `save()` / `render()` call at the bottom of the script (`load(); if (!S.verticals.length...) seed(); render();`) is replaced by `initApp()` which is called only after auth is confirmed.

### 6.3 Frontend: `initApp()` and API fetch wrapper

All localStorage calls (`load()`, `save()`) are removed. `initApp()` fetches all data from the API, populates `S`, and calls `render()`.

All API calls go through a single `apiFetch(method, path, body)` wrapper that attaches the Clerk token:

```javascript
async function apiFetch(method, path, body = null) {
  const token = await window.Clerk.session.getToken();
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    await window.Clerk.signOut();
    location.reload();
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
```

`Clerk.session.getToken()` returns a fresh short-lived JWT. Clerk handles silent refresh transparently.

### 6.4 Frontend: User button placement

A `<div id="userBtn"></div>` is added to the header. Clerk mounts its prebuilt UserButton component there, which provides the avatar, profile link, and sign-out button. No custom sign-out button is needed.

### 6.5 Frontend: `initApp()` data loading

```javascript
async function initApp() {
  try {
    const [verticals, goals, projects, types] = await Promise.all([
      apiFetch('GET', '/api/verticals'),
      apiFetch('GET', '/api/goals'),
      apiFetch('GET', '/api/projects'),
      apiFetch('GET', '/api/project-types'),
    ]);
    S.verticals = verticals;
    S.goals     = goals;
    S.projects  = projects;
    S.types     = types.map(t => t.name);
    render();
    checkCuConnection();
  } catch (e) {
    // Show error state
    toast('Failed to load data. Please refresh.', 'error');
  }
}
```

### 6.6 Backend: Auth middleware

A shared helper `api/_auth.js` (prefixed `_` — Vercel does not expose it as a function endpoint) handles token verification. Every data endpoint calls this first.

```javascript
// api/_auth.js
import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({
  secretKey:      process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export async function requireAuth(req) {
  try {
    const requestState = await clerk.authenticateRequest(req, {
      authorizedParties: [process.env.APP_URL],
    });
    if (!requestState.isAuthenticated) return null;
    return requestState.toAuth(); // returns auth object; .userId not needed (shared data)
  } catch {
    return null;
  }
}
```

Since the data model is shared (no `user_id`), `requireAuth` only needs to confirm the request is authenticated. It returns the auth object (truthy) on success and `null` on failure. The calling handler returns `401` on `null`.

Usage pattern in every endpoint:

```javascript
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  // proceed with DB operations
}
```

### 6.7 Invite-only configuration

Configured entirely in the Clerk Dashboard — no code required:

1. Dashboard → User & Authentication → Restrictions
2. Set "Sign-up mode" to **Restricted (Invite only)**
3. Send invitations from Dashboard or via Clerk Backend API

### 6.8 CORS

The `api/clickup.js` already sets permissive CORS headers. The new data endpoints do NOT need CORS headers — they are same-origin requests (frontend and API both on the same Vercel deployment). Do not copy the CORS headers from `clickup.js` into the new handlers.

---

## 7. vercel.json

Replace the current explicit `builds` array with automatic function discovery. Keep the static routing for `public/`.

```json
{
  "version": 2,
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" },
    { "src": "/(.*)",     "dest": "/public/$1" }
  ]
}
```

**What changes:**
- Remove the `builds` array entirely. Vercel auto-discovers all `api/*.js` files.
- The existing `/api/clickup` route is covered by the `"/api/(.*)"` catch-all.
- The static wildcard `"/(.*)"` remains unchanged.

**No other vercel.json changes required.**

---

## 8. npm Package Setup

There is currently no `package.json`. One must be created at the project root. The Vercel Node.js runtime uses this to install dependencies for serverless functions.

### `package.json` (root)

```json
{
  "name": "projectops",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@clerk/backend": "^1",
    "@neondatabase/serverless": "^0.10"
  }
}
```

**`"type": "module"`** — enables ESM `import`/`export` syntax in `api/*.js` files, consistent with the patterns shown throughout the preparation doc. The existing `api/clickup.js` uses CommonJS-style (`export default`) which is compatible with ESM type when the file uses `export default` — but note: the existing file does not use `import` statements, only `export default`. With `"type": "module"`, all `api/` files must use ESM syntax. The coder must convert `api/clickup.js` from implicit CommonJS to explicit ESM (it only needs `export default function handler` which it already has — no `require()` calls exist, so no changes needed).

**Packages:**

| Package | Purpose |
|---------|---------|
| `@clerk/backend` | `createClerkClient`, `authenticateRequest` — token verification in serverless functions |
| `@neondatabase/serverless` | `neon` HTTP driver — Postgres queries against NeonDB |

No other packages are needed. The ClickUp proxy uses only built-in `fetch` (available in Node 18+, which Vercel uses by default).

---

## 9. NeonDB Connection Pattern

Use the `neon` HTTP driver for all endpoints. Create the `sql` tagged template function per-handler invocation (correct for stateless serverless — no persistent connections).

```javascript
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const auth = await requireAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const sql = neon(process.env.NEON_DATABASE_URL);
  // ...
}
```

For multi-statement transactions (goal create, project create), use `neon`'s transaction support:

```javascript
const sql = neon(process.env.NEON_DATABASE_URL);

const [vertRow] = await sql.transaction([
  sql`SELECT id, code, space_id FROM verticals WHERE id = ${verticalId} FOR UPDATE`,
  // further statements...
]);
```

`neon` supports non-interactive (pipeline) transactions via `sql.transaction(statementsArray)`. All statements execute in order within one HTTP round-trip to NeonDB.

**One `neon()` call per request** — do not share the instance across invocations (module-level caching is unsafe in serverless environments with varying connection strings).

---

## 10. Data Shape Mapping (DB → API)

All DB queries return snake_case column names. All API responses use camelCase JSON. Apply this mapping in every handler before `res.json()`.

```javascript
// api/_utils.js — add alongside isoWeekNumber and uid
export function mapVertical(row) {
  return {
    id:        row.id,
    name:      row.name,
    code:      row.code,
    color:     row.color,
    spaceId:   row.space_id,
    sortOrder: row.sort_order,
  };
}

export function mapGoal(row) {
  return {
    id:          row.id,
    verticalId:  row.vertical_id,
    name:        row.name,
    code:        row.code,
    type:        row.type,
    date:        row.date,
    endDate:     row.end_date,
    description: row.description,
    boundaries:  row.boundaries,
    cuFolderId:  row.cu_folder_id,
    sortOrder:   row.sort_order,
  };
}

export function mapProject(row) {
  return {
    id:          row.id,
    goalId:      row.goal_id,
    codeBase:    row.code_base,
    codePrefix:  row.code_prefix,
    fullCode:    row.full_code,
    descriptor:  row.descriptor,
    name:        row.name,
    description: row.description,
    type:        row.type,
    status:      row.status,
    cuListId:    row.cu_list_id,
    sortOrder:   row.sort_order,
  };
}

export function mapProjectType(row) {
  return {
    id:        row.id,
    name:      row.name,
    sortOrder: row.sort_order,
  };
}
```

---

## 11. ClickUp Integration — Backend-side Calls

The current app makes ClickUp calls from the browser (frontend calls `/api/clickup` proxy). Post-migration, ClickUp folder/list creation happens inside the API handlers server-to-server, not through the proxy.

**Why:** The proxy exists to hide the ClickUp API token from the browser. If the API handlers make ClickUp calls directly (server-to-server), the token never leaves the server and the proxy is only needed for the frontend connection check.

**ClickUp calls in API handlers** use a direct `fetch` to the ClickUp API, not the proxy:

```javascript
// Inside api/goals.js — POST handler
async function createClickUpFolder(spaceId, name) {
  const res = await fetch(`https://api.clickup.com/api/v2/space/${spaceId}/folder`, {
    method: 'POST',
    headers: {
      'Authorization': process.env.CLICKUP_API_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`ClickUp error ${res.status}`);
  return res.json();
}
```

**ClickUp failure is non-fatal**: if the ClickUp call fails, log the error, set `cu_folder_id` / `cu_list_id` to `null`, and complete the insert. The user sees the record saved successfully and a warning toast. This matches the current app's behavior.

**The frontend `/api/clickup` proxy** remains unchanged and is still called from the browser for:
- `GET /user` — connection status check (the green/red dot in the header)
- `GET /space/{id}` — space verification in the vertical modal

---

## 12. Frontend Mutation Pattern

After each successful mutation, the frontend updates its local `S` state directly (optimistic update) rather than re-fetching the full dataset. This minimises latency and matches the current app's feel.

**Pattern:**

```javascript
// Example: create vertical
async function saveVertical(data) {
  const result = await apiFetch('POST', '/api/verticals', data);
  if (!result) return;                          // 401 — handled by apiFetch
  S.verticals.push(result);                     // optimistic update
  render();
  toast('Vertical created', 'success');
}

// Example: update vertical
async function updateVertical(id, data) {
  const result = await apiFetch('PUT', `/api/verticals?id=${id}`, data);
  if (!result) return;
  const idx = S.verticals.findIndex(v => v.id === id);
  if (idx !== -1) S.verticals[idx] = result;   // replace with server response
  render();
  toast('Vertical updated', 'success');
}
```

Using the server response (not the local data) to update `S` ensures codes and sort_order values from the server are reflected correctly.

**Drag-and-drop reorder:** After a successful drag, the frontend already reorders the local array. It then fires the reorder API call in the background. On failure, it shows a warning toast but does not roll back the UI (eventual consistency — the user can reload to see the true state).

**`save()` function removal:** The existing `save()` function (which calls `localStorage.setItem`) is deleted. The `render()` function no longer calls `save()`. Persistence is now entirely through API calls triggered by user actions.

---

## 13. File Structure

### Files to create

| File | Purpose |
|------|---------|
| `package.json` | npm manifest; declares `@clerk/backend`, `@neondatabase/serverless` dependencies |
| `api/_auth.js` | Shared Clerk token verification helper — `requireAuth(req)` |
| `api/_utils.js` | Shared utilities — `uid()`, `isoWeekNumber()`, `mapVertical()`, `mapGoal()`, `mapProject()`, `mapProjectType()` |
| `api/verticals.js` | GET, POST, PUT, DELETE, reorder for verticals |
| `api/goals.js` | GET, POST, PUT, DELETE, reorder for goals |
| `api/projects.js` | GET, POST, PUT, DELETE, reorder/batch-update for projects |
| `api/project-types.js` | GET, POST, DELETE for project types |
| `docs/architecture/schema.sql` | Canonical DDL — single source of truth for DB schema |

### Files to modify

| File | Changes |
|------|---------|
| `vercel.json` | Remove `builds` array; update `routes` to catch-all pattern |
| `public/index.html` | Add Clerk CDN script tag; add `auth-wall` / `userBtn` HTML; replace `load()`/`save()` with `initApp()` / `apiFetch()`; replace all direct `S` mutations with API calls + local state updates; remove `seed()` call from init path |

### Files unchanged

| File | Reason |
|------|--------|
| `api/clickup.js` | No auth check added (locked decision); logic unchanged |

---

## 14. Environment Variables

| Variable | Where used | Notes |
|----------|-----------|-------|
| `NEON_DATABASE_URL` | `api/*.js` (server-side only) | NeonDB connection string — never exposed to browser |
| `CLERK_PUBLISHABLE_KEY` | `api/_auth.js` (server), `public/index.html` (hardcoded) | Safe to expose in HTML |
| `CLERK_SECRET_KEY` | `api/_auth.js` (server-side only) | Never expose in browser |
| `CLICKUP_API_TOKEN` | `api/clickup.js` (existing), `api/goals.js`, `api/projects.js` (new) | Never expose in browser |
| `APP_URL` | `api/_auth.js` — `authorizedParties` | e.g. `https://projectops.vercel.app` |

Set in `.env.local` for local dev (`vercel dev` loads this automatically). Set in Vercel Dashboard → Project Settings → Environment Variables for production.

---

## 15. Database Initialisation

The DDL in `docs/architecture/schema.sql` must be run once against the NeonDB instance before deployment. There is no migration runner — the project does not use a migration framework.

**Procedure:**
1. Copy the contents of `docs/architecture/schema.sql`
2. Run against NeonDB via the NeonDB SQL editor in their dashboard, or via `psql $NEON_DATABASE_URL`
3. Seed default project types:

```sql
INSERT INTO project_types (id, name, sort_order) VALUES
  ('type-strategy',    'Strategy',   0),
  ('type-design',      'Design',     1),
  ('type-development', 'Development',2),
  ('type-content',     'Content',    3),
  ('type-operations',  'Operations', 4),
  ('type-research',    'Research',   5);
```

---

## 16. Implementation Guidelines for Coder Agents

### Agent assignment

| Component | Agent |
|-----------|-------|
| `api/_auth.js`, `api/_utils.js`, `api/verticals.js`, `api/goals.js`, `api/projects.js`, `api/project-types.js`, `package.json`, `vercel.json` | `@pact-backend-coder` |
| `public/index.html` — Clerk integration, auth wall, `apiFetch`, mutation rewrites | `@pact-frontend-coder` |
| `docs/architecture/schema.sql` + NeonDB initialisation instructions | `@pact-database-engineer` |

### Recommended implementation order

1. **`@pact-database-engineer`** — Write `schema.sql`. Run it against NeonDB. Verify tables exist.
2. **`@pact-backend-coder`** — Implement in this order:
   a. `package.json`
   b. `api/_utils.js`
   c. `api/_auth.js`
   d. `api/project-types.js` (simplest — no code generation, no ClickUp)
   e. `api/verticals.js` (no code generation, no ClickUp)
   f. `api/goals.js` (code generation + ClickUp)
   g. `api/projects.js` (code generation + ClickUp + batch reorder)
   h. `vercel.json` update
3. **`@pact-frontend-coder`** — After backend is complete:
   a. Add Clerk CDN script tag and auth-wall HTML to `index.html`
   b. Implement `apiFetch()` wrapper
   c. Implement `initApp()` — initial data load
   d. Replace each mutation path (vertical save, goal save, project save, types add/remove, drag reorder) with API calls
   e. Remove `load()`, `save()`, `seed()` calls

### Critical implementation notes for coders

**Backend coder:**
- `api/clickup.js` must NOT be modified.
- Files prefixed with `_` are not exposed as Vercel functions — `_auth.js` and `_utils.js` are private helpers.
- The `neon()` driver instance is created per request inside the handler function, not at module scope.
- Use `sql.transaction([...statements])` for goal create and project create. These are the only two endpoints that require transactions.
- The reorder batch update for projects ALSO handles `status` changes (not just `sort_order`). The SQL must update both columns.
- `PUT /api/projects?id={id}` must read the current `status` from DB before applying the update to detect the `status → archived` transition. Do not rely on the client sending the old status.
- `PUT /api/goals?id={id}` ignores `code` in the request body — it is a read-only field.

**Frontend coder:**
- Do NOT touch any backend files.
- The existing `render()`, `renderSidebar()`, `renderContent()` functions remain largely unchanged. The mutation paths (modal save handlers, drag drop handlers, type add/remove) are what change.
- The `save()` function is deleted. Remove the `save()` call from `render()`.
- The `load()` function is deleted. Remove the `load()` call from the bottom init block.
- The `seed()` function can be deleted (locked decision: no seed data, fresh start).
- `checkCuConnection()` remains and is called from `initApp()` — it still uses `cuCall()` / the proxy, which is unchanged.
- The `S.types` array stores `string[]` (type names). The API returns `{ id, name, sortOrder }` objects. `initApp()` maps: `S.types = types.map(t => t.name)`. When adding a type, call `POST /api/project-types` with `{ name }` and push `result.name` to `S.types`. When deleting, call `DELETE /api/project-types?id={id}` — but `S.types` stores only names, not IDs. **Resolution:** change `S.types` to store the full type objects `[{ id, name }]`, and update `renderTypesList()` and `refreshProjectTypes()` accordingly. This is the only structural change to `S`.
- Drag-and-drop on goal cards currently mutates `S.goals` array order directly and calls `render()`. Post-migration, it should also fire `PUT /api/goals?action=reorder` with the new ID order. Same for project kanban drags.

---

## 17. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Goal code race condition | Low (small team) | Medium (duplicate codes) | Transaction with `FOR UPDATE` lock — fully addressed in design |
| Project code race condition | Low | Medium | Same transaction pattern — fully addressed |
| Clerk CDN load failure | Very low | High (app unusable) | Inherent in CDN dependency; acceptable at this scale |
| ClickUp call failing during goal/project create | Medium | Low (non-fatal) | Non-fatal handling specified — log and continue |
| NeonDB cold start latency | Low | Low | NeonDB serverless HTTP driver is optimised for this; first-request latency ~100ms |
| `APP_URL` misconfigured in `authorizedParties` | Medium (easy to miss) | High (all requests 401) | Document clearly in env var table; test immediately after deploy |
| Frontend `S.types` shape change breaking type display | Medium | Low | Addressed explicitly in implementation notes above |
| `"type": "module"` in package.json breaking existing clickup.js | Low | Medium | `clickup.js` already uses only `export default` — compatible with ESM |

---

## 18. Out of Scope

The following items were considered but are explicitly excluded from this migration:

- **Data migration / import tool** — fresh start only (locked by user).
- **Multi-user / team sharing** — single shared dataset; no org/workspace layer.
- **Role-based access control** — not needed for shared data model.
- **Clerk webhook for user sync** — no `users` table; not needed.
- **ClickUp proxy auth** — stays unauthenticated (locked by user).
- **Automated database migrations** — manual DDL execution via NeonDB dashboard or psql.
- **Offline support / service workers** — out of scope for this migration.
