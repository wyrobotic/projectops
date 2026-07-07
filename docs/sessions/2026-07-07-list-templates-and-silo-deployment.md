# Session 2026-07-07 — List Templates, Auth Hardening & Silo Deployment

## Summary

Large session spanning a feature build, a peer-reviewed hardening pass, and an
extended production incident while standing up a second (silo) deployment for a
different ClickUp workspace.

## Completed

### 1. Auth session-expiry hardening (`public/index.html`)
- `apiFetch` now guards a null `window.Clerk.session` (was crashing with
  `Cannot read properties of null (reading 'getToken')`).
- 401s no longer force a page reload (which discarded in-progress edits); a
  non-blocking "session expired" banner is shown instead, plus a scoped
  write-button lockout (`vSave`/`gSave`/`pSave`).
- Proactive Clerk listener surfaces an expired session before the next save.

### 2. ClickUp List Templates feature (DB + API + UI)
- New `list_templates` table (`docs/architecture/schema.sql`).
- New `api/list-templates.js` CRUD; `mapListTemplate` in `api/_utils.js`.
- Single-default invariant enforced in app code (NeonDB HTTP driver has no
  transactions); first template auto-promotes to default; deleting the default
  promotes the lowest-`sort_order` survivor (returns `newDefaultId`).
- `POST /api/projects` accepts optional `templateId` → creates the ClickUp List
  from a template (`/folder/{id}/list_template/{tpl}`), with a plain-List
  fallback on missing/invalid id or any ClickUp error.
- Frontend: **⚙ Temps** manager modal + default-aware template `<select>` in the
  project modal.
- Built via three parallel PACT agents (database-engineer, backend-coder,
  frontend-coder) against a frozen contract.

### 3. Peer review + fixes
- `/peer-review` (security, architect, backend, test agents).
- **Fixed BLOCKER (security):** `templateId` path-injection → validate `^t-\d+$`
  + `encodeURIComponent`; encoded folder/list path segments too.
- Fixed the zero-default-after-delete gap; added PUT type/length validation.

### 4. UI: fonts
- `DM Serif Display` + `DM Sans` → **Inter** (headings weight 600);
  `DM Mono` → **JetBrains Mono**.

### 5. Env-driven Clerk config (enables silo deployments)
- **Root problem:** Clerk publishable key + SDK domain were hardcoded in
  `index.html`, so every deployment authenticated against the *same* Clerk app.
- New `api/config.js` serves `CLERK_PUBLISHABLE_KEY` at runtime; `bootstrapClerk()`
  derives the Clerk Frontend API host from the key (base64) and injects the SDK.
- Added `DEPLOYMENT.md` — full silo-instance runbook.
- Unified `main` onto this code path (removed the hardcoded key).

## Incident: second deployment brought both apps down

Standing up a friend's instance surfaced a cascade, resolved in order:
1. **Login rejected her users** → her Vercel deployed `main` (still hardcoded key)
   → authenticating against the original Clerk app. Fixed by deploying the
   env-driven branch.
2. **Post-login spinner / 401** → then **both apps broke**. Root cause: frontend
   loaded `@clerk/clerk-js@latest`, which rolled to **v6 (core-3)**, incompatible
   with the installed `@clerk/backend@1` (core-2) verifier. **Pinned clerk-js to
   `@5`** on both `main` and her branch.
3. **"ClickUp not connected" / "failed to save"** on her app → her Neon database
   had no schema. Ran `schema.sql` against her DB (all 5 tables + project_types
   seed). ClickUp token was fine all along (verified via `/api/clickup?path=/user`
   returning 200); the "not connected" was a stale `cuConnected` from page load.

## Key decisions
- **Silo multi-tenancy** over pooled: for a handful of tenants, isolated
  deployments (own DB/Clerk/ClickUp per instance) beat pooled on effort AND
  safety (no per-tenant token custody, no cross-tenant query-filter risk).
  Break-even ~3–5 tenants.
- **Pin Clerk SDK versions in lockstep** — never float `clerk-js@latest`.

## Git
- Branch `feat/env-driven-clerk-config` (her instance deploys from it, pending
  repoint to `main`).
- `main` @ `c5783e3`: unified env-driven + v5-pinned.
- Feature work + fonts previously merged (`a093ff4`).

## Unresolved / next session
- **Repoint her Vercel project's production branch to `main`**, then delete
  `feat/env-driven-clerk-config`.
- **Rotate her Neon DB password** (was pasted in chat during the incident) +
  update her `NEON_DATABASE_URL` + redeploy.
- Confirm her vertical save + ClickUp verify work after the schema run.
- No test infrastructure exists — the List Templates feature has an untested
  default-invariant path (peer review flagged YELLOW).
- Optional future: upgrade to Clerk core-3 (bump `@clerk/backend` to match
  clerk-js v6) as a deliberate joint upgrade.
