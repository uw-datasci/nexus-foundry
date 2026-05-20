Read `AGENTS.md` and `PLAN.md` first, then obey every rule in `AGENTS.md`.

# Task: build a stable, feature-shaped scaffold

Implement scaffold-level code for every feature in `PLAN.md`, inside
`{{APP_DIR}}`. This is v1: **compiling stubs**, not finished business logic.

## Requirements

- For each **Route / Page** in `PLAN.md`: create the file with minimal valid
  markup — a heading naming the feature and a `TODO:` describing what it will do.
- For each **API / Server action**: create the handler with the input typed and
  a typed placeholder return (or HTTP 501) plus a `TODO:`.
- For each **Component**: create a typed, rendering stub.
- Define the shared types/interfaces from the **Data model** so the stubs
  type-check.
- Wire index/navigation pages so the structure is browsable.
- You may reference the pre-wired DB client ({{DB_CLIENT}}) only inside typed,
  inert helpers — do **not** implement real queries yet.

## Non-negotiable

- Do **not** edit `{{CONFIG_DIR}}/server.ts`, `{{CONFIG_DIR}}/db.ts`, or any
  foundry-managed wiring.
- Do **not** add secrets.
- Stay within `{{APP_DIR}}` (the root files `PLAN.md` and `AGENTS.md` already
  exist and should not be moved).
- The project **must build and lint clean** when you finish. Run
  `{{PNPM_INVOCATION}} build` yourself and fix anything that fails before you
  stop.

Add dependencies with pnpm only if strictly required for the scaffold to compile.
