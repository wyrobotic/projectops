# AUTH_DATABASE_MIGRATION — Preparation

**Phase**: PREPARE
**Feature**: Migrate ProjectOPS from localStorage to NeonDB + Clerk auth
**Date**: 2026-03-11
**Status**: Complete — ready for ARCHITECT phase

---

## Executive Summary

ProjectOPS is a single-page vanilla JS application that currently stores all data in `localStorage` under the key `projectops_v3`. The migration goal is to move this data to a real Postgres backend (NeonDB) with Clerk handling invite-only authentication, while keeping the frontend as vanilla HTML/CSS/JS served from Vercel.

The architecture is well-suited for this migration. The existing `api/clickup.js` pattern (a Vercel Serverless Function in `api/`) establishes the template for all new API endpoints. The data model is clean and well-understood from reading the source. The primary risks are: (1) handling the code-generation logic (`[VERTCODE]-[YYWW][LETTER]`) server-side to prevent race conditions, and (2) the multi-step save flow where creating a Goal also fires a ClickUp API call — this must remain atomic from the user's perspective.

The recommended migration strategy is a clean-start approach with a one-time localStorage import tool, rather than a live migration. Users export their existing data, sign in with Clerk, and import it. This avoids a complex migration path and matches the small-team context.

---

## 1. Current Data Model (localStorage)

### Storage Key

```
localStorage['projectops_v3']
```

### Top-Level Structure

```javascript
{
  verticals: Vertical[],
  goals: Goal[],
  projects: Project[],
  types: string[],            // e.g. ['Strategy','Design','Development',...]
  activeVerticalId: string | null   // UI state — NOT persisted to backend
}
```

### Vertical Object

```typescript
{
  id: string,          // uid() — Date.now().toString(36) + random
  name: string,        // e.g. "Acme Corp"
  code: string,        // 4-char uppercase alphanumeric, e.g. "ACME" — unique
  color: string,       // hex color string, e.g. "#c0392b"
  spaceId: string | null  // ClickUp Space ID, e.g. "90112345678" — optional
}
```

### Goal Object

```typescript
{
  id: string,
  name: string,
  code: string | null,        // e.g. "ACME-100" — auto-generated as VERTCODE-(100 + index)
  type: 'deliverable' | 'timebox',
  verticalId: string | null,  // FK to Vertical.id — optional
  date: string | null,        // ISO date "YYYY-MM-DD" — target/start date
  endDate: string | null,     // ISO date — only used when type === 'timebox'
  description: string,        // scope / what's in scope
  boundaries: string,         // anti-scope / exclusions
  cuFolderId: string | null   // ClickUp Folder ID — created on save if vertical has spaceId
}
```

**Goal code generation logic** (from source):
- On create: `${vert.code}-${100 + existing_goals_for_vertical.length}`
- Example: first goal for ACME → `ACME-100`, second → `ACME-101`
- This must be made race-condition-safe server-side (use `COUNT` + lock or sequence)

### Project Object

```typescript
{
  id: string,
  goalId: string,            // FK to Goal.id
  codeBase: string,          // e.g. "ACME-2611A" — base code without descriptor
  codePrefix: string,        // e.g. "ACME-2611" — used to count sibling projects in same week
  fullCode: string,          // e.g. "ACME-2611A Website" — display code (base + descriptor)
  descriptor: string,        // 1–2 word suffix appended to code, e.g. "Website"
  name: string,              // human-readable name, e.g. "Website Redesign"
  description: string,       // status narrative / high-level description
  type: string,              // from types list, e.g. "Design", "Development"
  status: 'backlog' | 'progress' | 'blocked' | 'done' | 'archived',
  cuListId: string | null    // ClickUp List ID — created on project save if goal has cuFolderId
}
```

**Project code generation logic** (from source):
- Format: `[VERTCODE]-[YY][WW][LETTER]` where YY = 2-digit year, WW = ISO week number (padded), LETTER = sequential A/B/C/...
- `codePrefix` = `VERTCODE-YYWW` (e.g. `ACME-2611`)
- `codeBase` = prefix + letter (e.g. `ACME-2611A`)
- Letter is determined by counting existing projects with the same `codePrefix`
- This must be made race-condition-safe server-side

### Types Array

```javascript
types: string[]
// Default: ['Strategy','Design','Development','Content','Operations','Research']
// User-managed: can add/remove
// Shared across all verticals/goals — global list
```

### UI State (not persisted to backend)

```javascript
activeVerticalId: string | null   // which vertical is selected in sidebar
showArchived: { [goalId]: boolean }  // whether to show archived projects per goal
```

---

## 2. Proposed Database Schema (Postgres / NeonDB)

### Conventions
- Tables: `snake_case`
- Primary keys: `TEXT` (preserve existing `uid()` format) or `UUID` — TEXT recommended to avoid a migration step on IDs
- All `created_at` / `updated_at` columns: `TIMESTAMPTZ DEFAULT NOW()`
- `user_id` columns reference Clerk user IDs (format: `user_2abc...`) — stored as TEXT, not FK to a users table (Clerk manages the user record)

### Table: `verticals`

```sql
CREATE TABLE verticals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,           -- Clerk user ID of owner/creator
  name        TEXT NOT NULL,
  code        TEXT NOT NULL,           -- 4-char uppercase, unique per user
  color       TEXT NOT NULL,           -- hex string
  space_id    TEXT,                    -- ClickUp Space ID, nullable
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT verticals_code_unique UNIQUE (user_id, code)
);
```

### Table: `goals`

```sql
CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  vertical_id   TEXT REFERENCES verticals(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  code          TEXT,                  -- e.g. "ACME-100", generated server-side
  type          TEXT NOT NULL CHECK (type IN ('deliverable', 'timebox')),
  date          DATE,                  -- target date
  end_date      DATE,                  -- timebox end date, nullable
  description   TEXT NOT NULL DEFAULT '',
  boundaries    TEXT NOT NULL DEFAULT '',
  cu_folder_id  TEXT,                  -- ClickUp Folder ID
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX goals_user_id_idx ON goals(user_id);
CREATE INDEX goals_vertical_id_idx ON goals(vertical_id);
```

### Table: `projects`

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  goal_id       TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  code_base     TEXT NOT NULL,         -- e.g. "ACME-2611A"
  code_prefix   TEXT NOT NULL,         -- e.g. "ACME-2611"
  full_code     TEXT NOT NULL,         -- e.g. "ACME-2611A Website"
  descriptor    TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'backlog'
                CHECK (status IN ('backlog','progress','blocked','done','archived')),
  cu_list_id    TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX projects_user_id_idx ON projects(user_id);
CREATE INDEX projects_goal_id_idx ON projects(goal_id);
CREATE INDEX projects_code_prefix_idx ON projects(code_prefix);
```

### Table: `project_types`

```sql
CREATE TABLE project_types (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT project_types_name_unique UNIQUE (user_id, name)
);

CREATE INDEX project_types_user_id_idx ON project_types(user_id);
```

### Notes on Schema Design

- **No separate `users` table**: Clerk is the source of truth for user records. `user_id` is stored as a TEXT column in every table but not FK'd to a local users table. This avoids needing a Clerk webhook to sync user creation.
- **`sort_order`**: Goals and Projects are drag-reorderable in the UI. `sort_order` stores display position. On reorder, the API must update `sort_order` for affected rows.
- **`ON DELETE CASCADE`** on `projects.goal_id`: Deleting a goal deletes its projects (matches current behavior in `localStorage` implementation).
- **`ON DELETE SET NULL`** on `goals.vertical_id`: Deleting a vertical does not delete goals, it orphans them (no vertical) — safer than cascade for strategic data.
- **Team/multi-user consideration**: Currently `user_id` is set to the logged-in Clerk user. For team sharing, a future migration would add an `org_id` or `workspace_id` column. The current design does not block this.

---

## 3. API Endpoints Needed

All endpoints live in `api/` as individual Vercel Serverless Functions. Every endpoint requires Clerk authentication — return `401` if the session token is missing or invalid.

The `user_id` is always extracted from the verified Clerk token server-side — never accepted from the request body.

### Auth middleware pattern (shared across all functions)

```javascript
// api/_auth.js — shared helper
import { createClerkClient } from '@clerk/backend'

export async function requireAuth(req) {
  const clerk = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  })
  const requestState = await clerk.authenticateRequest(req, {
    authorizedParties: [process.env.APP_URL],
  })
  if (!requestState.isAuthenticated) return null
  return requestState.toAuth().userId
}
```

### Verticals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/verticals` | List all verticals for the authenticated user, ordered by `sort_order` |
| `POST` | `/api/verticals` | Create a new vertical |
| `PUT` | `/api/verticals?id={id}` | Update a vertical (name, code, color, space_id) |
| `DELETE` | `/api/verticals?id={id}` | Delete a vertical |
| `PUT` | `/api/verticals/reorder` | Update sort_order for multiple verticals |

**GET /api/verticals** — Response:
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

**POST /api/verticals** — Request body:
```json
{
  "name": "Acme Corp",
  "code": "ACME",
  "color": "#c0392b",
  "spaceId": "90112345678"
}
```

**PUT /api/verticals/reorder** — Request body:
```json
{ "ids": ["id3", "id1", "id2"] }
```
(Server updates `sort_order` to match array index order)

---

### Goals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/goals` | List all goals for the user, optionally filtered by `?verticalId={id}` |
| `POST` | `/api/goals` | Create a new goal (generates `code` server-side; triggers ClickUp folder creation if applicable) |
| `PUT` | `/api/goals?id={id}` | Update a goal |
| `DELETE` | `/api/goals?id={id}` | Delete a goal and cascade-delete its projects |
| `PUT` | `/api/goals/reorder` | Update sort_order for multiple goals |

**POST /api/goals** — Request body:
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

**POST /api/goals** — Response (201):
```json
{
  "id": "def456",
  "name": "Q2 Website Overhaul",
  "code": "ACME-100",
  "type": "deliverable",
  "verticalId": "abc123",
  "date": "2026-06-30",
  "endDate": null,
  "description": "Full redesign...",
  "boundaries": "Does not include...",
  "cuFolderId": "cu_folder_789",
  "sortOrder": 0
}
```

**Note on goal code generation**: The server must generate the goal code atomically. Recommended approach:
```sql
SELECT COUNT(*) FROM goals WHERE user_id = $1 AND vertical_id = $2
```
Then code = `${vertical.code}-${100 + count}`. Use a transaction to prevent races. If no vertical, `code` is null.

---

### Projects

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects for the user, optionally filtered by `?goalId={id}` |
| `POST` | `/api/projects` | Create a new project (generates code server-side; triggers ClickUp list creation if applicable) |
| `PUT` | `/api/projects?id={id}` | Update a project (handles ClickUp archive on status→archived) |
| `DELETE` | `/api/projects?id={id}` | Delete a project |
| `PUT` | `/api/projects/reorder` | Batch update status + sort_order (for drag-and-drop across kanban columns) |

**POST /api/projects** — Request body:
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

**POST /api/projects** — Response (201):
```json
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
```

**Note on project code generation (server-side)**:
```javascript
// Inputs: vertical.code, current year/week
const yy = String(now.getFullYear()).slice(2)
const ww = String(isoWeekNumber(now)).padStart(2, '0')
const prefix = `${vertical.code}-${yy}${ww}`

// Count existing projects with this prefix to get next letter
const { count } = await sql`
  SELECT COUNT(*) FROM projects
  WHERE user_id = ${userId} AND code_prefix = ${prefix}
`
const letter = String.fromCharCode(65 + parseInt(count))
const codeBase = `${prefix}${letter}`
const fullCode = descriptor ? `${codeBase} ${descriptor}` : codeBase
```

**PUT /api/projects/reorder** — Request body (kanban drag-drop):
```json
{
  "updates": [
    { "id": "ghi789", "status": "progress", "sortOrder": 0 },
    { "id": "jkl012", "status": "progress", "sortOrder": 1 }
  ]
}
```

---

### Project Types

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/project-types` | List all types for the user, ordered by `sort_order` |
| `POST` | `/api/project-types` | Add a new type |
| `DELETE` | `/api/project-types?id={id}` | Remove a type |

---

### ClickUp Proxy (existing — no changes required)

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/clickup` | Existing proxy — passes `?path=` to ClickUp v2 API. No auth change needed since the token is server-side. |

**Consideration**: After migration, the ClickUp proxy should also validate the Clerk session token to prevent unauthenticated use. This is a security improvement, not a blocker.

---

### Data Import (migration support)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/import` | Accept a full `projectops_v3` JSON blob, bulk-insert all entities for the authenticated user |

This endpoint enables the localStorage-to-backend migration flow for existing users.

---

## 4. Clerk Integration Approach (Vanilla JS)

### Frontend: Loading Clerk via CDN

Clerk's JavaScript SDK loads directly from their CDN. No npm or bundler required.

```html
<!-- In public/index.html <head>, before other scripts -->
<script
  async
  crossorigin="anonymous"
  data-clerk-publishable-key="pk_live_xxxxx"
  src="https://[YOUR_FRONTEND_API_URL]/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
  type="text/javascript"
></script>
```

The `data-clerk-publishable-key` attribute must be set to `CLERK_PUBLISHABLE_KEY`. This is safe to expose in frontend HTML — it is the publishable key, not the secret key.

**Note**: The `src` URL uses a Clerk-specific Frontend API URL (format: `[subdomain].clerk.accounts.dev` for development, or a custom domain). This is different from the CDN URL and is found in the Clerk dashboard.

### Frontend: Page Protection Pattern

The entire app content should be hidden until Clerk loads and auth is confirmed. Unauthenticated users see only the Clerk `<SignIn />` component.

```javascript
window.addEventListener('load', async function () {
  await Clerk.load()

  if (Clerk.isSignedIn) {
    // Show the app, hide auth wall
    document.getElementById('app').style.display = 'block'
    document.getElementById('auth-wall').style.display = 'none'
    // Mount user button in header
    Clerk.mountUserButton(document.getElementById('userBtn'))
    // Initialize the application
    initApp()
  } else {
    // Show auth wall, hide app
    document.getElementById('app').style.display = 'none'
    document.getElementById('auth-wall').style.display = 'flex'
    Clerk.mountSignIn(document.getElementById('sign-in-container'))
  }
})
```

### Frontend: Getting Session Token for API Calls

Every API call to the backend must include the Clerk session token as a Bearer token in the `Authorization` header.

```javascript
async function apiCall(method, path, body = null) {
  const token = await Clerk.session.getToken()
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(path, opts)
  if (res.status === 401) {
    // Session expired — force re-auth
    await Clerk.signOut()
    return null
  }
  return res.json()
}
```

`Clerk.session.getToken()` returns a short-lived JWT. It auto-refreshes if the session is still valid.

### Frontend: Invite-Only Restriction

Clerk's invite-only mode is configured in the Clerk Dashboard, not in code:

1. In Clerk Dashboard → User & Authentication → Restrictions
2. Set "Sign-up mode" to **Restricted** (invite only)
3. Generate invitation links from the Clerk Dashboard or via the Clerk Backend API
4. Users who receive an invite link can create an account; all other sign-up attempts are rejected

No code changes are required to enforce this — Clerk handles it at the authentication layer.

### Backend: Verifying Clerk Tokens in Serverless Functions

Install the Clerk Backend SDK:
```
npm install @clerk/backend
```

Pattern for every API function:

```javascript
// api/verticals.js
import { createClerkClient } from '@clerk/backend'
import { neon } from '@neondatabase/serverless'

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
})

export default async function handler(req, res) {
  // 1. Authenticate
  const requestState = await clerk.authenticateRequest(req, {
    authorizedParties: [process.env.APP_URL],
  })
  if (!requestState.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const userId = requestState.toAuth().userId

  // 2. Connect to NeonDB
  const sql = neon(process.env.NEON_DATABASE_URL)

  // 3. Handle request
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM verticals WHERE user_id = ${userId}
      ORDER BY sort_order ASC
    `
    return res.status(200).json(rows)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
```

---

## 5. Vercel Routing Changes

### Current `vercel.json`

```json
{
  "version": 2,
  "builds": [
    { "src": "api/clickup.js", "use": "@vercel/node" },
    { "src": "public/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/clickup", "dest": "/api/clickup.js" },
    { "src": "/(.*)", "dest": "/public/$1" }
  ]
}
```

### Required Changes

The `builds` array must register each new API function. The `routes` array must route new API paths. The recommended approach is to switch to Vercel's automatic function detection rather than manually listing each file.

**Option A — Recommended: Remove explicit builds, use automatic detection**

```json
{
  "version": 2,
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/$1" },
    { "src": "/(.*)", "dest": "/public/$1" }
  ]
}
```

With this config, Vercel automatically discovers all `api/*.js` files as serverless functions. No manual registration per file. This is the standard Vercel pattern.

**Option B — Explicit (current pattern extended)**

If staying with the explicit pattern, each new file needs a `builds` entry and a `routes` entry:
```json
{
  "builds": [
    { "src": "api/clickup.js", "use": "@vercel/node" },
    { "src": "api/verticals.js", "use": "@vercel/node" },
    { "src": "api/goals.js", "use": "@vercel/node" },
    { "src": "api/projects.js", "use": "@vercel/node" },
    { "src": "api/project-types.js", "use": "@vercel/node" },
    { "src": "api/import.js", "use": "@vercel/node" },
    { "src": "public/**", "use": "@vercel/static" }
  ]
}
```

Option A is recommended — it is simpler to maintain as more endpoints are added.

**Note on reorder and sub-routes**: Vercel does not support path parameters within a single file (e.g., `/api/verticals/reorder` would need a file named `api/verticals/reorder.js`). Design endpoint structure to match the file system, or use query parameters (e.g., `PUT /api/verticals?action=reorder`) to keep logic in one file per resource.

**Recommended file layout**:
```
api/
├── _auth.js             # shared Clerk auth helper (prefixed _ = not a function)
├── clickup.js           # existing — no changes
├── verticals.js         # GET, POST, PUT, DELETE by ?id=, PUT ?action=reorder
├── goals.js             # GET, POST, PUT, DELETE by ?id=, PUT ?action=reorder
├── projects.js          # GET, POST, PUT, DELETE by ?id=, PUT ?action=reorder
├── project-types.js     # GET, POST, DELETE by ?id=
└── import.js            # POST — bulk import from localStorage JSON
```

---

## 6. Migration Strategy

### Recommended: Clean-Start with Import Tool

Rather than a live in-place migration, the recommended approach is:

1. **User exports their current data** using the existing "Export" feature (as JSON — the raw `projectops_v3` structure). A "Download JSON" button should be added to the Export modal, or a separate "Backup" button added to the header.
2. **User signs in via Clerk** on the new backend-powered deployment.
3. **User imports their data** via an Import UI that accepts the JSON file and posts it to `POST /api/import`.
4. **Server bulk-inserts** all verticals, goals, projects, and types, assigning the authenticated `user_id`.

**Why not a live migration?**
- localStorage is browser-specific — the server has no access to it
- Each user's data is isolated in their own browser; there is no central data to migrate
- A clean-start ensures IDs are properly formatted, `sort_order` is set, and `user_id` is attached

### Import Endpoint Behavior

`POST /api/import` accepts the raw `projectops_v3` shape:

```json
{
  "verticals": [...],
  "goals": [...],
  "projects": [...],
  "types": [...]
}
```

The server should:
1. Validate the structure
2. Begin a transaction
3. Insert all entities, assigning `user_id` from the Clerk token
4. Preserve existing `id` values (or remap them if collisions exist)
5. Set `sort_order` to array index order
6. Commit

### Fallback: Parallel Run

If import is risky, a parallel-run approach is also viable:
- Deploy the new backend at a new URL initially
- Keep the localStorage version accessible at the old URL
- Users migrate themselves at their own pace

### localStorage Deprecation

After migration is confirmed, the app should:
1. Stop reading from localStorage
2. On first load post-migration, attempt to detect existing localStorage data and prompt "Import your existing data?"
3. After a grace period, remove the localStorage read/write code

---

## 7. Environment Variables

### Vercel Environment Variables (`.env.local` for dev, set in Vercel Dashboard for prod)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEON_DATABASE_URL` | Yes | NeonDB Postgres connection string. Format: `postgresql://user:pass@host/dbname?sslmode=require` |
| `CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key. Format: `pk_live_...` (prod) or `pk_test_...` (dev). Safe to expose in frontend HTML. |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key. Format: `sk_live_...`. **Never expose in frontend.** Backend only. |
| `CLICKUP_API_TOKEN` | Yes (existing) | ClickUp personal API token. Already in use. |
| `APP_URL` | Yes | The canonical URL of the app (e.g. `https://projectops.vercel.app`). Used as `authorizedParties` in Clerk token verification. |

### Frontend Variable Handling

The `CLERK_PUBLISHABLE_KEY` must be embedded in `public/index.html` at build time or loaded from a config endpoint. Options:

1. **Static embed (simplest)**: Hardcode in `index.html` — acceptable since it is a publishable key, not a secret. Use different HTML files per environment, or replace at deploy time.
2. **Config endpoint**: Add a `GET /api/config` endpoint that returns `{ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY }`. The frontend fetches this before loading Clerk. Slightly more complex but avoids hardcoding.

Option 1 is recommended for simplicity at small team scale.

---

## 8. NeonDB Connection

### Package

```
npm install @neondatabase/serverless
```

### Connection Pattern for Vercel Serverless Functions

Use the `neon` HTTP driver for single queries (recommended for most endpoints). Use `Pool` only if multi-statement transactions are needed within one request.

```javascript
import { neon } from '@neondatabase/serverless'

export default async function handler(req, res) {
  const sql = neon(process.env.NEON_DATABASE_URL)
  // neon() is created per-request — this is correct for serverless
  const rows = await sql`SELECT * FROM verticals WHERE user_id = ${userId}`
}
```

The `neon` function uses HTTP (not WebSocket) and is appropriate for stateless serverless invocations. Each `sql` tagged template literal is a single HTTP request to NeonDB.

For transactions (e.g., creating a goal with a code generation lock):
```javascript
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.NEON_DATABASE_URL)
// neon supports non-interactive transactions via transaction()
await sql.transaction([
  sql`SELECT COUNT(*) FROM goals WHERE user_id = ${userId} AND vertical_id = ${verticalId} FOR UPDATE`,
  sql`INSERT INTO goals (...) VALUES (...)`,
])
```

---

## 9. ClickUp Integration — Preserved Behavior

The ClickUp integration behavior must match the current app exactly:

| Action | Current Behavior | Backend Behavior |
|--------|------------------|-----------------|
| Create Goal | If vertical has `spaceId` and CU connected: create CU Folder, store `cuFolderId` | API does the same: call CU proxy, store `cu_folder_id` in DB |
| Create Project | If goal has `cuFolderId` and CU connected: create CU List, store `cuListId` | API does the same: call CU proxy, store `cu_list_id` in DB |
| Archive Project | If project has `cuListId`: call CU archive endpoint | API does the same on status → archived |
| Verify Space | Frontend calls `/api/clickup?path=/space/{id}` | Unchanged — existing proxy handles this |

**Key difference post-migration**: ClickUp calls currently happen in the browser (frontend calls `/api/clickup` proxy). Post-migration, they should happen in the backend API functions (e.g., `POST /api/goals` calls the ClickUp API server-to-server, not through the browser). This is more reliable and keeps API tokens server-side.

The frontend ClickUp connection indicator (`cuConnected` flag, green/red dot) still needs a way to check connection. A `GET /api/clickup?path=/user` call from the frontend remains appropriate for this check.

---

## 10. Open Questions

The following items require input from the user before architecture can be finalized:

1. **Team sharing scope**: Is this currently single-user (one Clerk account) or multi-user (small team sharing the same data)? The schema design above supports single-user. Multi-user requires an `org_id` or `workspace_id` and role-based access control.

2. **Clerk publishable key embedding**: Preference for how to embed the publishable key in `index.html`? (A) hardcode per environment, or (B) fetch from a `/api/config` endpoint at runtime?

3. **Import UX**: Should the import flow be a full page (separate from the app), or a modal within the existing UI? This affects whether we need a separate HTML file for the import/onboarding flow.

4. **ClickUp proxy auth**: Should `POST /api/clickup` also require a valid Clerk session token after migration, or leave it open (it requires the server-side `CLICKUP_API_TOKEN` anyway, so it is not a credentials leak)?

5. **Existing data backup**: Are there existing users with real data in localStorage that must be migrated, or is this a fresh deployment where migration is optional/low-stakes?

6. **Sort order**: Goals are currently drag-reorderable. Should the initial sort order be preserved from the array order in localStorage, or reset (newest-first, etc.)?

---

## Resource Links

- [Clerk JavaScript Quickstart](https://clerk.com/docs/quickstarts/javascript) — CDN loading, mounting components
- [Clerk JS Frontend Getting Started](https://clerk.com/docs/js-frontend/getting-started/quickstart) — Auth state, session tokens
- [Clerk authenticateRequest() Reference](https://clerk.com/docs/reference/backend/authenticate-request) — Backend token verification
- [Clerk Backend SDK Getting Started](https://clerk.com/docs/js-backend/getting-started/quickstart) — Node.js backend setup
- [Clerk Manual JWT Verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification) — Advanced token verification
- [NeonDB Serverless Driver](https://neon.com/docs/serverless/serverless-driver) — `@neondatabase/serverless` usage
- [NeonDB Node.js Guide](https://neon.com/docs/guides/node) — Connecting from Node.js
- [Vercel Serverless Functions](https://vercel.com/docs/functions) — File-based routing for `api/`

---

## Recommendations for Architect Phase

1. **Use Option A `vercel.json`** (automatic function discovery) — eliminates manual registration overhead.

2. **Use the `neon` HTTP driver** (not Pool) for all endpoints except where multi-statement transactions are required. It is simpler and faster for single-query serverless operations.

3. **Centralize Clerk auth in `api/_auth.js`** — a single exported helper `requireAuth(req)` that returns `userId` or `null`. Every endpoint calls this first. Files prefixed with `_` are not treated as Vercel functions.

4. **Keep ClickUp calls server-side** — move ClickUp folder/list creation from frontend to the `POST /api/goals` and `POST /api/projects` handlers. The browser continues to call `/api/clickup` only for the connection check (`GET /user`).

5. **Address the goal-code race condition** with a short transaction — count + insert within a single `sql.transaction()` call. This is not complex but must be designed explicitly.

6. **Design the kanban reorder endpoint carefully** — when a user drags a card to a different column, two things change: `status` and `sort_order`. The `PUT /api/projects?action=reorder` endpoint should accept a batch update (array of `{id, status, sortOrder}`) to handle both atomically in one round-trip.

7. **Defer team/multi-user to a future phase** — design schema with `user_id` today, leave space for `org_id` in a future migration. Do not over-engineer now.
