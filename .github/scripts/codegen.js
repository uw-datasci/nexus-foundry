#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { getTemplate } = require("../lib/templates");
const { deriveScenario } = require("../lib/scenario");
const { cloneRepo, createBranch, commitAll, pushBranch, openPr } = require("../lib/git");

/** Directory holding the rendered-on-the-fly prompt/instruction templates. */
const CODEGEN_DIR = path.join(__dirname, "..", "codegen");
/** Fallback model when no per-phase override is set; override with COPILOT_MODEL. */
const DEFAULT_MODEL = "gpt-5.2";
/** Self-heal attempts before falling back to a draft PR. */
const MAX_REPAIRS = 2;
/** How much of a failing command's output to feed back into a repair prompt. */
const OUTPUT_TAIL_CHARS = 4000;
/** Cap on files listed in grounding so prompts stay bounded. */
const MAX_TREE_FILES = 300;

/** Human-readable DB client per scenario, for grounding prompts + AGENTS.md. */
const DB_CLIENT_BY_SCENARIO = {
  neon: "the `sql` tagged-template client exported from `config/db.ts` (Neon serverless)",
  supabase: "the Supabase client in `config/` (wiring may be incomplete)",
  mongodb: "the MongoDB driver client in `config/` (wiring may be incomplete)",
  mongoose: "the Mongoose models/connection in `config/` (wiring may be incomplete)",
};

class CodegenPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "PROJECT_TYPE",
      "DATABASE",
      "DESCRIPTION",
      "GITHUB_ORG",
      "GH_TOKEN",
      "COPILOT_GITHUB_TOKEN",
    ]);

    const opt = (key, fallback = "") => (process.env[key] ?? "").trim() || fallback;

    const scenario = deriveScenario({
      database: process.env.DATABASE,
      postgresProvider: process.env.POSTGRES_PROVIDER,
      mongoClient: process.env.MONGO_CLIENT,
    });

    const model = opt("COPILOT_MODEL", DEFAULT_MODEL);

    return {
      projectName: process.env.PROJECT_NAME.trim(),
      projectType: process.env.PROJECT_TYPE.trim(),
      org: process.env.GITHUB_ORG.trim(),
      token: process.env.GH_TOKEN.trim(),
      description: process.env.DESCRIPTION.trim(),
      scenario,
      model,
      planModel: opt("COPILOT_PLAN_MODEL", model),
      buildModel: opt("COPILOT_BUILD_MODEL", model),
      repairModel: opt("COPILOT_REPAIR_MODEL", model),
      runId: opt("GITHUB_RUN_ID", String(Date.now())),
    };
  }
}

class CodegenSetup {
  /**
   * @param {{
   *   projectName: string;
   *   projectType: string;
   *   org: string;
   *   token: string;
   *   description: string;
   *   scenario: string;
   *   model: string;
   *   runId: string;
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {import("./lib/templates").TemplateLayout | null} */
    this.template = null;
    /** @type {string} */
    this.workdir = "";
  }

  /**
   * Reads a `.github/codegen` template and substitutes `{{KEY}}` placeholders.
   * Unknown placeholders are left intact.
   *
   * @param {string} file
   * @param {Record<string, string>} vars
   * @returns {string}
   */
  render(file, vars) {
    const raw = fs.readFileSync(path.join(CODEGEN_DIR, file), "utf8");
    return raw.replace(/\{\{(\w+)\}\}/g, (match, key) =>
      key in vars ? String(vars[key]) : match,
    );
  }

  /** @returns {string} e.g. "pnpm" or "pnpm --filter web" */
  pnpmInvocation() {
    return this.template.pnpmFilter ? `pnpm --filter ${this.template.pnpmFilter}` : "pnpm";
  }

  /**
   * Inspects the cloned repo to ground the prompts in reality: the app's
   * package.json scripts and a trimmed list of tracked files.
   *
   * @returns {{ scriptNames: string[]; fileTree: string }}
   */
  readGrounding() {
    const pkgPath = path.join(this.workdir, this.template.appDir, "package.json");
    let scriptNames = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      scriptNames = Object.keys(pkg.scripts ?? {});
    } catch {
      console.log("codegen: no app package.json found for grounding.");
    }

    let fileTree = "  (none)";
    try {
      const tracked = execFileSync("git", ["ls-files"], {
        cwd: this.workdir,
        encoding: "utf8",
      })
        .split("\n")
        .filter((f) => f && !f.includes("node_modules"))
        .slice(0, MAX_TREE_FILES);
      if (tracked.length) fileTree = tracked.map((f) => `  ${f}`).join("\n");
    } catch {
      console.log("codegen: could not list tracked files.");
    }

    return { scriptNames, fileTree };
  }

  /**
   * @param {{ scriptNames: string[]; fileTree: string }} grounding
   * @returns {Record<string, string>}
   */
  buildVars(grounding) {
    const { ctx } = this;
    return {
      PROJECT_NAME: ctx.projectName,
      PROJECT_TYPE: ctx.projectType,
      APP_DIR: this.template.appDir,
      CONFIG_DIR: this.template.configDir,
      SCENARIO: ctx.scenario,
      DB_CLIENT: DB_CLIENT_BY_SCENARIO[ctx.scenario] ?? "the configured database client",
      PNPM_INVOCATION: this.pnpmInvocation(),
      PACKAGE_SCRIPTS: grounding.scriptNames.length
        ? grounding.scriptNames.join(", ")
        : "(none detected)",
      FILE_TREE: grounding.fileTree,
      DESCRIPTION_BLOCK: ctx.description,
    };
  }

  /**
   * Runs the Copilot CLI non-interactively in the working copy.
   *
   * @param {string} prompt
   * @param {string} allowTool comma-separated allow-list, e.g. "shell(pnpm:*),write"
   * @param {string} model     Copilot model id to use for this call
   */
  runCopilot(prompt, allowTool, model) {
    execFileSync(
      "copilot",
      [
        "-p",
        prompt,
        "--model",
        model,
        "--allow-tool",
        allowTool,
        "--allow-all-paths",
        "--no-ask-user",
        "-s",
        "--secret-env-vars",
        "COPILOT_GITHUB_TOKEN",
        "--secret-env-vars",
        "GH_TOKEN",
      ],
      { cwd: this.workdir, stdio: "inherit", env: process.env },
    );
  }

  /**
   * Runs one pnpm command, capturing combined output without throwing.
   *
   * @param {string[]} args
   * @returns {{ ok: boolean; output: string }}
   */
  runPnpm(args) {
    try {
      const output = execFileSync("pnpm", args, {
        cwd: this.workdir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      process.stdout.write(output);
      return { ok: true, output };
    } catch (err) {
      const output =
        `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message ?? err);
      process.stdout.write(`${output}\n`);
      return { ok: false, output };
    }
  }

  /**
   * Install, then run whichever of build/typecheck/lint the app defines.
   *
   * @param {string[]} scriptNames
   * @returns {{ ok: true } | { ok: false; failingCommand: string; output: string }}
   */
  verify(scriptNames) {
    const filter = this.template.pnpmFilter ? ["--filter", this.template.pnpmFilter] : [];

    const checks = [{ label: "pnpm install", args: ["install"] }];
    for (const name of ["build", "typecheck", "lint"]) {
      if (scriptNames.includes(name)) {
        checks.push({
          label: `${this.pnpmInvocation()} run ${name}`,
          args: [...filter, "run", name],
        });
      }
    }

    for (const check of checks) {
      console.log(`codegen: verify → ${check.label}`);
      const res = this.runPnpm(check.args);
      if (!res.ok) {
        return { ok: false, failingCommand: check.label, output: res.output };
      }
    }
    return { ok: true };
  }

  /**
   * @param {{ verified: boolean; repairs: number; failingCommand?: string; output?: string }} info
   * @returns {string} path to the written PR body file (untracked)
   */
  writePrBody(info) {
    const lines = [
      "Automated scaffold generated by **nexus-foundry codegen** (GitHub Copilot CLI).",
      "",
      "## Contents",
      "- `PLAN.md` — best-effort spec for the full app.",
      "- Feature-shaped, compiling stubs for each planned route, component, and handler.",
      "- `AGENTS.md` — conventions for future agent/human work in this repo.",
      "",
      "## Verification",
    ];

    if (info.verified) {
      const repairNote = info.repairs ? ` after ${info.repairs} repair pass(es)` : "";
      lines.push(`- ✅ Build/lint passed${repairNote}.`);
    } else {
      lines.push(
        `- ⚠️ Build/lint still failing after ${info.repairs} repair pass(es) — opened as **draft**.`,
        "",
        `Failing command: \`${info.failingCommand}\``,
        "",
        "```",
        (info.output ?? "").slice(-OUTPUT_TAIL_CHARS),
        "```",
      );
    }

    lines.push("", "> Review `PLAN.md` and the stubs, then implement features incrementally.");

    const bodyPath = path.join(this.workdir, ".foundry-pr-body.md");
    fs.writeFileSync(bodyPath, lines.join("\n"));
    return bodyPath;
  }

  async run() {
    const { ctx } = this;
    this.template = getTemplate(ctx.projectType);
    if (!this.template) {
      console.log(`codegen: no template registered for '${ctx.projectType}'; skipping.`);
      return;
    }

    const branch = `foundry/codegen-${ctx.runId}`;
    this.workdir = cloneRepo(ctx.org, ctx.projectName, ctx.token);
    createBranch(this.workdir, branch);

    const grounding = this.readGrounding();
    const vars = this.buildVars(grounding);

    // Persistent instructions must exist before any Copilot run (auto-loaded).
    fs.writeFileSync(
      path.join(this.workdir, "AGENTS.md"),
      this.render("AGENTS.template.md", vars),
    );
    console.log("codegen: wrote AGENTS.md.");

    console.log(`codegen: planning… (model: ${this.ctx.planModel})`);
    this.runCopilot(this.render("plan.prompt.md", vars), "write", this.ctx.planModel);
    const planPath = path.join(this.workdir, "PLAN.md");
    if (!fs.existsSync(planPath) || !fs.readFileSync(planPath, "utf8").trim()) {
      throw new Error("codegen: planning phase did not produce PLAN.md");
    }

    console.log(`codegen: building scaffold… (model: ${this.ctx.buildModel})`);
    this.runCopilot(this.render("build.prompt.md", vars), "shell(pnpm:*),write", this.ctx.buildModel);

    let result = this.verify(grounding.scriptNames);
    let repairs = 0;
    while (!result.ok && repairs < MAX_REPAIRS) {
      repairs += 1;
      console.log(
        `codegen: verify failed (${result.failingCommand}); repair ${repairs}/${MAX_REPAIRS}…`,
      );
      const repairPrompt = this.render("repair.prompt.md", {
        ...vars,
        FAILING_COMMAND: result.failingCommand,
        FAILING_OUTPUT: result.output.slice(-OUTPUT_TAIL_CHARS),
      });
      this.runCopilot(repairPrompt, "shell(pnpm:*),write", this.ctx.repairModel);
      result = this.verify(grounding.scriptNames);
    }

    const verified = result.ok;
    console.log(`codegen: verification ${verified ? "passed" : "FAILED after repairs"}.`);

    const committed = commitAll(
      this.workdir,
      `feat: plan + scaffold via copilot codegen${verified ? "" : " (build failing — draft)"}`,
    );
    if (!committed) {
      console.log("codegen: nothing was generated; skipping PR.");
      return;
    }

    pushBranch(this.workdir, branch);
    const bodyFile = this.writePrBody({
      verified,
      repairs,
      failingCommand: result.ok ? undefined : result.failingCommand,
      output: result.ok ? undefined : result.output,
    });
    const url = openPr(this.workdir, {
      repo: `${ctx.org}/${ctx.projectName}`,
      base: "main",
      head: branch,
      title: `feat: scaffold ${ctx.projectName} (nexus-foundry codegen)`,
      bodyFile,
      draft: !verified,
    });
    console.log(`codegen: opened ${verified ? "" : "draft "}PR → ${url}`);
  }
}

async function main() {
  const preprocessor = new CodegenPreprocessor();
  const ctx = preprocessor.prepare();
  const setup = new CodegenSetup(ctx);

  console.log(
    `Codegen for '${ctx.projectName}' (${ctx.projectType}, ${ctx.scenario}, model=${ctx.model}).`,
  );

  await setup.run();
}

module.exports = { main };
