Read `AGENTS.md` in this repository first — it defines the stack, layout,
database client, and hard rules. Obey it.

# Task: write `PLAN.md`

Produce a single file `PLAN.md` at the repository root: a concrete build plan for
the application described below. This is the best-effort spec for the *full* app,
even though this run will only scaffold compiling stubs for it.

## Project description

{{DESCRIPTION_BLOCK}}

## Grounding — actual repository state

- Template: {{PROJECT_TYPE}}  ·  App dir: `{{APP_DIR}}`  ·  Database: {{SCENARIO}}
- Available scripts: {{PACKAGE_SCRIPTS}}
- Tracked files:
{{FILE_TREE}}

## `PLAN.md` must contain exactly these sections, in this order

1. `## Summary` — 2–4 sentences on what the app does.
2. `## Tech stack` — derived from the template; do **not** propose changing it.
3. `## Data model` — tables/collections and fields, typed for {{SCENARIO}}.
4. `## Routes / Pages` — a table: `Path | Purpose | Status (stub|todo)`.
5. `## API / Server actions` — a table: `Method or Name | Path | Purpose`.
6. `## Components` — a table: `Name | Purpose`.
7. `## Environment variables` — a table: `Name | Purpose` (managed via Infisical).
8. `## Milestones` — ordered steps from scaffold to the full app.
9. `## Out of scope (v1)` — what the scaffold will deliberately not implement yet.

Keep it realistic and internally consistent: the routes, components, and data
model must line up. In this phase, **only write `PLAN.md`** — do not create or
modify any other file.
