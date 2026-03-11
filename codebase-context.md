# Codebase Context

This file serves as the single source of truth for understanding the project. It should be read at the start of each session and updated after significant changes.

---

## Project Summary

ProjectOPS is a strategic project management layer that sits above task managers like ClickUp. It organizes work into three tiers:

- **Verticals** — clients or contexts (top level)
- **Goals** — objectives with scope and boundaries (within a vertical)
- **Projects** — tracked work items (within a goal)

It provides an executive-level portfolio view without getting into task-level detail, with direct ClickUp integration that auto-creates Folders and Lists as you plan.

**Current state**: Static HTML file with localStorage. Migrating to a real backend (NeonDB + Clerk + Vercel Serverless) for persistence, multi-device access, and small team sharing.

---

## Architecture Overview

### Current Architecture (Pre-Migration)
- Single HTML page with embedded CSS/JS
- All data stored in browser localStorage
- ClickUp API calls proxied through a Vercel serverless function

### Target Architecture (Post-Migration)
- **Frontend**: Static HTML/CSS/JS served from `public/`
- **Backend**: Vercel Serverless Functions in `api/` (Node.js)
- **Database**: NeonDB (serverless Postgres) for persistent storage
- **Auth**: Clerk (invite-only, email + password)
- **Integration**: ClickUp REST API proxied through serverless functions

### Key Components

| Component | Responsibility |
|-----------|---------------|
| `public/` | Static frontend — HTML, CSS, vanilla JS |
| `api/` | Vercel Serverless Functions — CRUD operations, ClickUp proxy |
| NeonDB | Persistent storage — verticals, goals, projects |
| Clerk | Authentication — invite-only access control |
| ClickUp API | Integration — auto-create Folders/Lists from ProjectOPS structure |

### Data Flow

```
Browser (HTML/JS) → Vercel Serverless Functions (api/) → NeonDB (Postgres)
                                                       → ClickUp REST API
```

Auth flow: Browser → Clerk → Verified requests to API functions

---

## Directory Structure

```
/
├── .claude/
│   ├── agents/        # PACT agent definitions
│   ├── commands/      # Slash commands for PACT workflow
│   └── skills/        # UI/UX Pro Max design skill
├── public/            # Static frontend assets (HTML, CSS, JS)
├── api/               # Vercel Serverless Functions (Node.js)
├── docs/
│   ├── preparation/   # PREPARE phase outputs
│   ├── architecture/  # ARCHITECT phase outputs
│   ├── testing/       # TEST phase outputs
│   ├── fixes/         # Bug fix documentation
│   ├── sessions/      # Session handoff summaries
│   ├── specs/ui/      # UI specifications
│   └── decisions/     # Architectural Decision Records (ADRs)
├── sandbox/           # Static HTML mockups (/design command output)
├── vercel.json        # Vercel routing and function config
├── CLAUDE.md          # Claude Code instructions and project config
└── codebase-context.md # This file — project context and state
```

---

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Claude Code instructions and project config |
| `codebase-context.md` | This file — project context and state |
| `vercel.json` | Vercel routing config for serverless functions |
| `public/index.html` | Main application UI (single page) |
| `api/` | Serverless function endpoints |

---

## External Dependencies

| Service | Purpose | Config |
|---------|---------|--------|
| **NeonDB** | Serverless Postgres database | `NEON_DATABASE_URL` env var |
| **Clerk** | Auth (invite-only, email + password) | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| **ClickUp** | Task manager integration | `CLICKUP_API_TOKEN` |
| **Vercel** | Hosting + serverless functions | Vercel CLI / dashboard |

---

## Patterns and Conventions

### Naming Conventions

- **Files**: kebab-case (e.g., `click-up-proxy.js`)
- **Functions**: camelCase
- **CSS classes**: kebab-case
- **Database tables**: snake_case
- **API routes**: kebab-case (e.g., `/api/verticals`, `/api/click-up-proxy`)

### File Organization

- Frontend assets in `public/`
- Each serverless function in `api/` as a single file
- Documentation follows PACT structure in `docs/`

### Error Handling

- Serverless functions return appropriate HTTP status codes
- Frontend displays user-friendly error messages
- ClickUp API errors handled gracefully with fallback behavior

---

## Current State

### Active Development

- Setting up project with PACT framework
- Planning migration from localStorage to NeonDB backend

### Known Issues

- All data currently in localStorage (no persistence across devices)
- No authentication (anyone with the URL can access)

### Recent Changes

| Date | Change | Impact |
|------|--------|--------|
| 2026-03-11 | Project initialized with PACT starter template | Framework ready |

---

## Important Constraints

- **No framework**: Frontend is vanilla HTML/CSS/JS — no React, Vue, etc.
- **Invite-only**: Clerk auth should restrict access to invited users only
- **ClickUp integration**: Must preserve existing ClickUp proxy functionality during migration
- **Small team**: Designed for a small team, not enterprise scale

---

## Navigation Tips

- Start with `public/index.html` for the current UI
- Check `api/` for existing serverless functions
- `vercel.json` controls routing between static files and functions
