# Deploying a new ProjectOPS instance

ProjectOPS is a "silo" multi-tenant app: each customer/team gets a fully
independent deployment with its own database, auth, and ClickUp workspace.
Nothing is shared between instances. This runbook covers standing up one new
instance end to end.

Thanks to the env-driven config (`/api/config` serves the Clerk publishable key
at runtime), **no code edits are required per instance** — a new instance is
"copy repo → set env vars → deploy."

## Architecture (what each instance needs)

| Service | Purpose | Per-instance? |
|---------|---------|---------------|
| **Vercel** | Hosting + serverless API (`/api/*`) + static frontend (`/public`) | Yes — new project |
| **NeonDB** | Postgres data (verticals, goals, projects, templates) | Yes — new database |
| **Clerk** | Auth (invite-only) | Yes — new application |
| **ClickUp** | Folder/List sync via REST API | Yes — the target workspace + its API token |

## Environment variables

Set these on the Vercel project (Settings → Environment Variables). Locally they
live in `.env.local` (used by `vercel dev`).

| Variable | Where it comes from |
|----------|---------------------|
| `NEON_DATABASE_URL` | NeonDB → Connection string |
| `CLERK_PUBLISHABLE_KEY` | Clerk → API keys (safe to expose; the frontend fetches it via `/api/config`) |
| `CLERK_SECRET_KEY` | Clerk → API keys (secret) |
| `CLICKUP_API_TOKEN` | ClickUp → the target workspace's personal API token |
| `APP_URL` | The deployed URL (used for the post-sign-out redirect) |

> The frontend derives the Clerk Frontend API host from the publishable key
> itself, so `CLERK_PUBLISHABLE_KEY` drives both the key and the SDK script URL.
> If it is missing, the app shows an "Authentication is not configured" message
> instead of loading.

## Steps

### 1. Get the code
Fork or push a copy of this repo to a new GitHub repo (recommended for
independence), or reuse the same repo as the source for a second Vercel project.

### 2. NeonDB — create the database
1. Create a new Neon project → copy the `NEON_DATABASE_URL`.
2. Create the schema: run [`docs/architecture/schema.sql`](docs/architecture/schema.sql)
   in the Neon SQL editor.
3. (Optional) Seed a default List template so new projects pre-select it:
   ```sql
   INSERT INTO list_templates (id, name, cu_template_id, description, is_default, sort_order)
   VALUES ('tmpl-default', 'Default', 't-<CLICKUP_TEMPLATE_ID>', '', true, 0);
   ```
   Or add it in-app later via the **⚙ Temps** modal.

### 3. Clerk — create the auth application
1. Create a new Clerk application; configure it invite-only; invite the users.
2. Copy the **publishable key** and **secret key** → env vars above.
3. Add the Vercel deployment domain to Clerk's **Allowed origins**
   (Dashboard → the instance → Domains/Origins). Sign-in fails silently otherwise.

### 4. ClickUp — connect the workspace
1. In the target ClickUp workspace, create a personal **API token** →
   `CLICKUP_API_TOKEN`.
2. Nothing else is code: **List template IDs** are entered in the ⚙ Temps modal,
   and **Space IDs** are entered per-Vertical in the app after launch.

### 5. Vercel — deploy
1. New Vercel project from the repo (Vercel auto-detects `vercel.json`).
2. Add all five env vars.
3. Deploy. Then set `APP_URL` to the resulting URL and redeploy.

### 6. Verify
- Load the URL → you should get the Clerk sign-in wall (not a config error).
- Sign in.
- Create a **Vertical** and give it a ClickUp **Space ID** from the target workspace.
- Add a template in **⚙ Temps** (paste a `t-…` template ID from the workspace).
- Create a test **Project** under a goal that has a ClickUp folder → confirm the
  List is created (from the template) in the target ClickUp workspace.

## Notes
- **Data isolation is total** — each instance has its own DB, Clerk app, and
  ClickUp token; there is no cross-instance access by design.
- The ClickUp integration acts as whoever owns `CLICKUP_API_TOKEN`, so the token
  determines which workspace the instance reads/writes.
- `vercel.json` and all code copy as-is; there are no per-tenant values in code.
