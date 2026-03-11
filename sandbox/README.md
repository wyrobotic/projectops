# Sandbox

Isolated prototyping space. Nothing here affects the app codebase.

**This folder is gitignored** (except this README).

## Structure

Each initiative gets its own sub-directory:

```
sandbox/
├── README.md
├── home_page/          # e.g. landing page design iterations
│   ├── home_001.html
│   ├── home_002.html
│   └── assets/
├── onboarding/         # e.g. onboarding flow prototypes
│   └── welcome_001.html
└── dashboard_v2/       # e.g. dashboard redesign
    └── overview_001.html
```

## How to use

Use the `/design` command to generate mockups:

> `/design home_page home_001`

Or invoke the skill directly:

> "Using the ui-ux-pro-max skill, design a static HTML mockup of [component/page]
> and save it to sandbox/[initiative]/[name].html."

## Workflow

1. **Prototype** — Use `/design` to create static HTML mockups in a sub-directory
2. **Iterate** — Use numbered suffixes (`_001`, `_002`) to track iterations
3. **Review** — Open the HTML files in a browser to evaluate
4. **Approve** — When satisfied, the approved designs become reference for `@pact-frontend-designer` specs
5. **Implement** — `@pact-frontend-designer` extracts patterns from approved sandbox files and writes specs → `@pact-frontend-coder` implements
