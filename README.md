# Nexus Foundry

Nexus Foundry is a GitHub Actions–driven **project launch pipeline**. It takes a template repository and a short questionnaire (database, domain, team access, and so on), then provisions infrastructure, wires secrets, applies static configuration, and opens an initial scaffold PR—all in one workflow run.

This repository is the **orchestrator**. It does not contain application code; it contains the workflow, Node scripts, Copilot prompt templates, and shared libraries that operate on **newly generated** repos in your GitHub organization.

## What a launch does

When you run **Foundry Launch** (`.github/workflows/launch.yml`), jobs run in order:

```mermaid
flowchart TB
  START(["Foundry Launch"])

  subgraph phase1["① Resolve"]
    setup["Parse inputs"]
  end

  subgraph phase2["② Bootstrap — runs in parallel"]
    direction LR
    create_repo["Create repository"]
    secrets_setup["Infisical folders"]
  end

  subgraph phase3["③ Platform"]
    direction TB
    db_setup["Provision database"]
    vercel_setup["Vercel project + domain + secret sync"]
    db_setup --> vercel_setup
  end

  subgraph phase4["④ Repository"]
    config["Static DB config → main"]
  end

  subgraph phase5["⑤ Codegen"]
    codegen["Copilot plan · build · open PR"]
  end

  DONE(["Scaffold PR ready"])

  START --> setup
  setup --> create_repo
  setup --> secrets_setup
  create_repo --> db_setup
  secrets_setup --> db_setup
  db_setup --> vercel_setup
  vercel_setup --> config
  config --> codegen
  codegen --> DONE

  classDef trigger fill:#ddf4ff,stroke:#0969da,stroke-width:2px,color:#0550ae
  classDef bootstrap fill:#f6f8fa,stroke:#8c959f,stroke-width:1.5px,color:#24292f
  classDef platform fill:#fff8c5,stroke:#bf8700,stroke-width:1.5px,color:#633c01
  classDef repo fill:#dafbe1,stroke:#1a7f37,stroke-width:1.5px,color:#116329
  classDef ai fill:#fbefff,stroke:#8250df,stroke-width:1.5px,color:#5928a5
  classDef resolve fill:#eef2ff,stroke:#6366f1,stroke-width:1.5px,color:#3730a3

  class START,DONE trigger
  class setup resolve
  class create_repo,secrets_setup bootstrap
  class db_setup,vercel_setup platform
  class config repo
  class codegen ai

  linkStyle default stroke:#8c959f,stroke-width:2px
```

| Stage | Script | Purpose |
|-------|--------|---------|
| **create_repo** | `create_repo.js` | Generate a new repo from a GitHub template; grant team access |
| **secrets_setup** | `secrets_setup.js` | Create Infisical folders (`dev`, `staging`, `prod`) for the project |
| **db_setup** | `db_setup.js` | Provision database (Neon fully implemented; others stubbed) |
| **vercel_setup** | `vercel_setup.js` | Create Vercel project, optional custom domain, Infisical → Vercel secret syncs |
| **config** | `config.js` | Clone the new repo, apply static DB wiring (Neon), commit to `main` |
| **codegen** | `codegen.js` | Plan + scaffold via GitHub Copilot CLI; open PR (draft if verify fails) |

Planned but commented out in the workflow: **redis_setup**, **s3_setup**.

## Triggering a launch

### Manual (`workflow_dispatch`)

In GitHub: **Actions → Foundry Launch → Run workflow**.

### Programmatic (`repository_dispatch`)

Send event type `foundry-launch` with a `client_payload` that mirrors the workflow inputs (for example from an internal queue or UI).

## Workflow inputs

| Input | Required | Description |
|-------|----------|-------------|
| `project_name` | Yes | New repository name (kebab-case) |
| `team_access` | Yes | GitHub team slug to grant access |
| `project_type` | Yes | Template repo name (see [Templates](#templates)) |
| `database` | Yes | `postgres` or `mongodb` |
| `postgres_provider` | If postgres | `neon` or `supabase` |
| `mongo_client` | If mongodb | `mongodb` or `mongoose` |
| `redis` | No | `true` or `false` (not wired yet) |
| `s3` | No | `true` or `false` (not wired yet) |
| `description` | No | Project description (used in codegen prompts) |
| `domain` | Yes | Production hostname for Vercel |

Database inputs are validated in `.github/lib/scenario.js`, which maps them to a single **scenario** key: `neon`, `supabase`, `mongodb`, or `mongoose`.

## Required GitHub secrets

Configure these on the Foundry repo (and use the `nexus-queue` environment for the `setup` job):

| Secret | Used by |
|--------|---------|
| `FOUNDRY_GITHUB_TOKEN` | Create repo, clone/push generated repos, open PRs |
| `COPILOT_TOKEN` | Copilot CLI (`COPILOT_GITHUB_TOKEN` in codegen) |
| `INFISICAL_ID` / `INFISICAL_TOKEN` / `INFISICAL_PROJECT_ID` | Infisical machine identity (workflow `env`) |
| `INFISICAL_VERCEL_CONNECTION_ID` | Infisical → Vercel secret syncs |
| `VERCEL_TOKEN` / `VERCEL_TEAM_ID` | Vercel project + domain |
| `NEON_API_KEY` | Neon provisioning (`NEON_ORG_ID` optional) |

The workflow also expects Infisical credentials as `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` (mapped from `INFISICAL_ID` and `INFISICAL_TOKEN`).

## Templates

Templates are **GitHub template repositories** in your org. Register layout metadata in `.github/lib/templates.js` so `config` and `codegen` know where the app and `config/` directory live:

| `project_type` | App directory | Config directory | pnpm filter |
|----------------|---------------|------------------|-------------|
| `sample-next-app` | `.` | `config` | — |
| `sample-web-api-monorepo` | `apps/web` | `apps/web/config` | `web` |

`create_repo.js` accepts `owner/repo` for templates outside the target org.

## Database scenarios

| Scenario | `db_setup` | `config` | Notes |
|----------|------------|----------|-------|
| **neon** | Provisions Neon project + branches; writes `DATABASE_URL` to Infisical | Uncomments `databaseUrl`, adds `@neondatabase/serverless`, writes `config/db.ts` | Fully implemented |
| **supabase** | Stub | Stub | Logs only |
| **mongodb** | Stub | Stub | Native driver path |
| **mongoose** | Stub | Stub | ODM path |

## Codegen

The **codegen** job clones the generated repo, writes `AGENTS.md` from a template, then runs three Copilot CLI phases:

1. **Plan** — writes `PLAN.md` (full-app spec)
2. **Build** — scaffolding stubs aligned with the plan
3. **Repair** — up to 2 attempts if `pnpm install` / `build` / `typecheck` / `lint` fail

Prompts live in `.github/codegen/` (`plan.prompt.md`, `build.prompt.md`, `repair.prompt.md`, `AGENTS.template.md`). Override models with `COPILOT_PLAN_MODEL`, `COPILOT_BUILD_MODEL`, and `COPILOT_REPAIR_MODEL` (defaults in the workflow: `gpt-5.2`, `gpt-5.2-codex`, `claude-haiku-4.5`).

Successful runs open a normal PR; failed verification opens a **draft** PR with logs in the body.

## Repository layout

```
.github/
  workflows/
    launch.yml          # Main pipeline
  scripts/
    create_repo.js      # GitHub template generate + team ACL
    secrets_setup.js    # Infisical folder bootstrap
    db_setup.js         # Database router
    db/neon_setup.js    # Neon API + Infisical DATABASE_URL
    vercel_setup.js     # Vercel + Infisical syncs
    config.js           # Static repo configuration
    codegen.js          # Copilot plan/build/repair + PR
    integrations/
      infisical.js      # Infisical API client
      vercel.js         # Vercel API client
  lib/
    scenario.js         # DATABASE → scenario validation
    templates.js        # Per-template paths and pnpm filter
    git.js              # Clone, commit, push, PR helpers
  codegen/              # Copilot prompt templates
```

Scripts are plain Node (no bundler). Jobs invoke them via `actions/github-script` or `node` with environment variables set from workflow outputs.

## Extending Foundry

1. **New template** — Add an entry to `.github/lib/templates.js` and ensure a matching GitHub template repo exists.
2. **New database scenario** — Implement methods on `DatabaseSetup` (`db_setup.js`), `ConfigSetup` (`config.js`), and extend `deriveScenario` / `SCENARIO_KEYS` in `scenario.js`.
3. **New integrations** — Add clients under `.github/scripts/integrations/` and a job step in `launch.yml`.
4. **Codegen behavior** — Edit prompts in `.github/codegen/` or adjust verification/repair logic in `codegen.js`.

## Local development

Scripts expect env vars documented in each file’s `assertRequiredEnv` / `prepare()` helpers. For git operations you need `GH_TOKEN` (or `FOUNDRY_GITHUB_TOKEN`) with rights on the target org.

Example (dry run of scenario derivation):

```bash
node -e "const { deriveScenario } = require('./.github/lib/scenario'); \
  console.log(deriveScenario({ database: 'postgres', postgresProvider: 'neon' }));"
```

Codegen and config jobs need **pnpm**, **Node 24**, and the **Copilot CLI** (`npm install -g @github/copilot`) when run outside Actions.

## Implementation status

- **Done:** repo creation, Infisical folders, Neon + Infisical `DATABASE_URL`, Vercel project + domain + secret syncs, Neon static config, Copilot plan/scaffold PR flow
- **Stub / planned:** Supabase, MongoDB/Mongoose, Redis, S3

---

Maintained as infrastructure for DSC Nexus–style project bootstrapping. For questions about a **generated** app, see that repo’s `AGENTS.md` and `PLAN.md` after launch.
