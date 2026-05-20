# Agent instructions — {{PROJECT_NAME}}

This repository was scaffolded by **nexus-foundry**. Every AI agent or human who
generates or modifies code here must follow these rules. They keep output
consistent across sessions, models, and contributors.

## What this project is

{{DESCRIPTION_BLOCK}}

The full intended scope is tracked in [`PLAN.md`](./PLAN.md). Treat `PLAN.md` as
the source of truth for features and keep it up to date as the app evolves.

## Stack & layout

- Template: `{{PROJECT_TYPE}}`
- Application code lives in: `{{APP_DIR}}`
- Package manager: **pnpm** — run scripts with `{{PNPM_INVOCATION}}`
- Detected scripts: {{PACKAGE_SCRIPTS}}

Work **only inside `{{APP_DIR}}`** unless a change explicitly requires repo-root
files (such as `PLAN.md` or this file).

## Database

- Scenario: **{{SCENARIO}}**
- Use the pre-wired client: {{DB_CLIENT}}
- The connection is configured via environment variables managed by Infisical.
  Read configuration through the existing `config/` modules — never re-implement
  it or hardcode connection strings.

## Hard rules (do not break)

- **Never edit** `{{CONFIG_DIR}}/server.ts` or `{{CONFIG_DIR}}/db.ts`, or any
  other foundry-managed wiring. The platform owns these files.
- **Never** commit secrets, tokens, or connection strings.
- The project **must `{{PNPM_INVOCATION}} build` and lint clean at all times.**
  If you add a file, make sure it compiles and is reachable.
- Match the conventions already present: TypeScript, `server-only` for
  server-side modules, and the existing directory structure.

## Scaffold conventions

Prefer small, typed, **compiling stubs** over half-finished logic:

- Pages / routes: render a clear heading plus a `TODO:` describing intent.
- API handlers / server actions: type the input, return a typed placeholder
  (or HTTP 501) with a `TODO:`.
- Components: typed, rendering stubs.
- Define shared types/interfaces from the data model up front so stubs
  type-check.

Every feature listed in `PLAN.md` should have a corresponding stub so the
structure is browsable and ready to fill in.
