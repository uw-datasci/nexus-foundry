#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { TEMPLATES, infisicalPath } = require("../lib/templates");
const { SCENARIO_KEYS, deriveScenario } = require("../lib/scenario");
const { cloneRepo } = require("../lib/git");

const DB_TS_CONTENTS = `import "server-only";
import { neon } from "@neondatabase/serverless";

import { serverConfig } from "./server";

/**
 * Neon serverless SQL client.
 *
 * Backed by \`DATABASE_URL\` (see ./server). Use the tagged-template \`sql\` helper
 * from Server Components, Route Handlers, Server Actions, and server/ code.
 */
export const sql = neon(serverConfig.databaseUrl);
`;

const R2_WEB_CONTENTS = `import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

import { serverConfig } from "./server";

/**
 * Cloudflare R2 client (S3-compatible).
 *
 * Backed by the \`R2_*\` env vars (see ./server). Use from Server Components,
 * Route Handlers, Server Actions, and server/ code.
 */
export const r2 = new S3Client({
  region: "auto",
  endpoint: \`https://\${serverConfig.r2AccountId}.r2.cloudflarestorage.com\`,
  credentials: {
    accessKeyId: serverConfig.r2AccessKeyId,
    secretAccessKey: serverConfig.r2SecretAccessKey,
  },
});
`;

const R2_API_PLUGIN_CONTENTS = `import { S3Client } from "@aws-sdk/client-s3"
import type { FastifyInstance } from "fastify"

/**
 * Cloudflare R2 client (S3-compatible) exposed as \`fastify.r2\`.
 *
 * Reads the validated \`R2_*\` values from \`fastify.config\` (see ./env) and
 * decorates the instance so routes can call \`fastify.r2.send(...)\`.
 */
export async function registerR2(fastify: FastifyInstance) {
  const c = fastify.config
  const client = new S3Client({
    region: "auto",
    endpoint: \`https://\${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,
    credentials: {
      accessKeyId: c.R2_ACCESS_KEY_ID,
      secretAccessKey: c.R2_SECRET_ACCESS_KEY,
    },
  })

  fastify.decorate("r2", client)
  fastify.addHook("onClose", () => client.destroy())
}
`;

class ConfigPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  readConfigInputs() {
    return {
      projectName: process.env.PROJECT_NAME.trim(),
      projectType: process.env.PROJECT_TYPE.trim(),
      org: process.env.GITHUB_ORG.trim(),
      token: process.env.GH_TOKEN.trim(),
      database: process.env.DATABASE.trim().toLowerCase(),
      postgresProvider: (process.env.POSTGRES_PROVIDER ?? "").trim().toLowerCase(),
      mongoClient: (process.env.MONGO_CLIENT ?? "").trim().toLowerCase(),
      s3: (process.env.S3 ?? "").trim().toLowerCase() === "true",
    };
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "PROJECT_TYPE",
      "DATABASE",
      "GITHUB_ORG",
      "GH_TOKEN",
    ]);
    const inputs = this.readConfigInputs();
    const scenario = deriveScenario(inputs);
    return {
      scenario,
      projectName: inputs.projectName,
      projectType: inputs.projectType,
      org: inputs.org,
      token: inputs.token,
      s3: inputs.s3,
    };
  }
}

class ConfigSetup {
  /**
   * Refreshes the lockfile after `pnpm add` (or other manifest edits).
   *
   * @param {string} workdir
   */
  syncLockfile(workdir) {
    execFileSync("pnpm", ["install"], { cwd: workdir, stdio: "inherit" });
    console.log("config: ran pnpm install to refresh lockfile.");
  }

  /**
   * Stages only the intended files (never node_modules), commits, and pushes to
   * main. No-ops if nothing changed.
   *
   * Returns the SHA on `main` after the push (or `null` when nothing was
   * committed) so callers can correlate downstream workflow runs with the
   * exact commit they triggered.
   *
   * @param {string} workdir
   * @param {{ appDir: string; configDir: string; hasApi?: boolean; apiDir?: string }} template
   * @param {{ s3?: boolean; workflowFiles?: string[] }} [opts]
   * @returns {string | null}
   */
  commitAndPush(workdir, template, opts = {}) {
    const filePaths = [
      "pnpm-lock.yaml",
      path.posix.join(template.configDir, "server.ts"),
      path.posix.join(template.configDir, "db.ts"),
      path.posix.join(template.appDir, "package.json"),
    ];

    if (opts.s3) {
      if (template.hasApi && template.apiDir) {
        const pluginsDir = path.posix.join(template.apiDir, "src", "plugins");
        filePaths.push(
          path.posix.join(pluginsDir, "r2.ts"),
          path.posix.join(pluginsDir, "env.ts"),
          path.posix.join(pluginsDir, "index.ts"),
          path.posix.join(template.apiDir, "src", "fastify-env.d.ts"),
          path.posix.join(template.apiDir, ".env.example"),
          path.posix.join(template.apiDir, "package.json"),
        );
      } else {
        filePaths.push(path.posix.join(template.configDir, "r2.ts"));
      }
    }

    if (opts.workflowFiles?.length) {
      filePaths.push(...opts.workflowFiles);
    }

    // Stage only files that exist (e.g. db.ts is absent for non-neon scenarios).
    const existing = filePaths.filter((p) => fs.existsSync(path.join(workdir, p)));
    execFileSync("git", ["add", "--", ...existing], { cwd: workdir });

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: workdir,
      encoding: "utf8",
    }).trim();
    if (!staged) {
      console.log("config: no changes to commit (skip).");
      return null;
    }

    execFileSync("git", ["commit", "-m", "chore: apply foundry configuration"], {
      cwd: workdir,
      stdio: "inherit",
    });
    execFileSync("git", ["push", "origin", "HEAD:main"], {
      cwd: workdir,
      stdio: "inherit",
    });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
    }).trim();
    console.log(`config: pushed configuration commit ${commitSha}.`);
    return commitSha;
  }

  /**
   * @param {string} workdir
   * @param {{ configDir: string; pnpmFilter: string | null }} template
   */
  neon(workdir, template) {
    const serverPath = path.join(workdir, template.configDir, "server.ts");
    const original = fs.readFileSync(serverPath, "utf8");
    const uncommented = original.replace(
      /^(\s*)\/\/\s*(databaseUrl:\s*requireEnv\("DATABASE_URL"\),)/m,
      "$1$2",
    );
    if (uncommented === original) {
      console.log("config: databaseUrl already uncommented in server.ts (skip).");
    } else {
      fs.writeFileSync(serverPath, uncommented);
      console.log("config: uncommented databaseUrl in server.ts.");
    }

    const pnpmArgs = ["add", "@neondatabase/serverless"];
    if (template.pnpmFilter) {
      pnpmArgs.push("--filter", template.pnpmFilter);
    }
    execFileSync("pnpm", pnpmArgs, { cwd: workdir, stdio: "inherit" });
    console.log("config: added @neondatabase/serverless.");

    const dbPath = path.join(workdir, template.configDir, "db.ts");
    fs.writeFileSync(dbPath, DB_TS_CONTENTS);
    console.log(`config: wrote ${template.configDir}/db.ts.`);
  }

  /**
   * Reads a file, applies a single find→replace, and writes it back. Idempotent:
   * skips when `presentMarker` is already in the file. Throws when `find` is
   * absent, so template drift fails loudly instead of producing broken output.
   *
   * @param {string} absPath
   * @param {string} label
   * @param {string} find
   * @param {string} replace
   * @param {string} presentMarker
   */
  applyReplace(absPath, label, find, replace, presentMarker) {
    const original = fs.readFileSync(absPath, "utf8");
    if (original.includes(presentMarker)) {
      console.log(`config: ${label} already present (skip).`);
      return;
    }
    if (!original.includes(find)) {
      throw new Error(`config: could not find anchor for "${label}" in ${absPath}`);
    }
    fs.writeFileSync(absPath, original.replace(find, replace));
    console.log(`config: ${label}.`);
  }

  /**
   * @param {string} workdir
   * @param {string | null | undefined} filter
   */
  addAwsSdk(workdir, filter) {
    const args = ["add", "@aws-sdk/client-s3"];
    if (filter) args.push("--filter", filter);
    execFileSync("pnpm", args, { cwd: workdir, stdio: "inherit" });
    console.log("config: added @aws-sdk/client-s3.");
  }

  /**
   * Generates the Cloudflare R2 client for the template: a Fastify plugin in the
   * API app, otherwise a server-config client in the web app.
   *
   * @param {string} workdir
   * @param {{ hasApi?: boolean; apiDir?: string; configDir: string; pnpmFilter: string | null; apiPnpmFilter?: string | null }} template
   */
  s3(workdir, template) {
    if (template.hasApi && template.apiDir) {
      this.s3Api(workdir, template);
    } else {
      this.s3Web(workdir, template);
    }
  }

  /**
   * Web (Next.js) R2 client: adds `R2_*` fields to `serverConfig` and writes
   * `{configDir}/r2.ts`, mirroring the neon/db.ts flow.
   *
   * @param {string} workdir
   * @param {{ configDir: string; pnpmFilter: string | null }} template
   */
  s3Web(workdir, template) {
    const serverPath = path.join(workdir, template.configDir, "server.ts");
    this.applyReplace(
      serverPath,
      "added R2_* fields to serverConfig",
      "export const serverConfig = {\n",
      "export const serverConfig = {\n" +
        '  r2AccountId: requireEnv("R2_ACCOUNT_ID"),\n' +
        '  r2AccessKeyId: requireEnv("R2_ACCESS_KEY_ID"),\n' +
        '  r2SecretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),\n' +
        '  r2BucketName: requireEnv("R2_BUCKET_NAME"),\n',
      "r2AccountId:",
    );

    this.addAwsSdk(workdir, template.pnpmFilter);

    const r2Path = path.join(workdir, template.configDir, "r2.ts");
    fs.writeFileSync(r2Path, R2_WEB_CONTENTS);
    console.log(`config: wrote ${template.configDir}/r2.ts.`);
  }

  /**
   * API (Fastify) R2 client: writes a plugin, registers it in the fixed order,
   * extends the `@fastify/env` schema and the `fastify.config` / `fastify.r2`
   * typings, and adds the AWS SDK dependency to the API package.
   *
   * @param {string} workdir
   * @param {{ apiDir: string; apiPnpmFilter?: string | null }} template
   */
  s3Api(workdir, template) {
    const apiDir = template.apiDir;
    const pluginsDir = path.posix.join(apiDir, "src", "plugins");

    // 1. The plugin itself.
    fs.writeFileSync(path.join(workdir, pluginsDir, "r2.ts"), R2_API_PLUGIN_CONTENTS);
    console.log(`config: wrote ${pluginsDir}/r2.ts.`);

    // 2. Validate the R2 vars through @fastify/env.
    const envPath = path.join(workdir, pluginsDir, "env.ts");
    this.applyReplace(
      envPath,
      "added R2_* to env schema properties",
      '    CORS_ORIGIN: { type: "string", default: "" },\n',
      '    CORS_ORIGIN: { type: "string", default: "" },\n' +
        '    R2_ACCOUNT_ID: { type: "string" },\n' +
        '    R2_ACCESS_KEY_ID: { type: "string" },\n' +
        '    R2_SECRET_ACCESS_KEY: { type: "string" },\n' +
        '    R2_BUCKET_NAME: { type: "string" },\n',
      "R2_ACCOUNT_ID:",
    );
    this.applyReplace(
      envPath,
      "marked R2_* required in env schema",
      "  },\n} as const",
      '  },\n  required: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"],\n} as const',
      "required:",
    );

    // 3. Types: fastify.config keys + the fastify.r2 decorator.
    const dtsPath = path.join(workdir, apiDir, "src", "fastify-env.d.ts");
    this.applyReplace(
      dtsPath,
      "imported S3Client type",
      'import "fastify"\n',
      'import "fastify"\nimport type { S3Client } from "@aws-sdk/client-s3"\n',
      "S3Client",
    );
    this.applyReplace(
      dtsPath,
      "added R2_* config keys to typings",
      "      CORS_ORIGIN: string\n",
      "      CORS_ORIGIN: string\n" +
        "      R2_ACCOUNT_ID: string\n" +
        "      R2_ACCESS_KEY_ID: string\n" +
        "      R2_SECRET_ACCESS_KEY: string\n" +
        "      R2_BUCKET_NAME: string\n",
      "R2_ACCOUNT_ID: string",
    );
    this.applyReplace(
      dtsPath,
      "added r2 decorator typing",
      "    }\n  }\n}",
      "    }\n    r2: S3Client\n  }\n}",
      "r2: S3Client",
    );

    // 4. Register in the fixed plugin order (env runs first, so config is set).
    const indexPath = path.join(workdir, pluginsDir, "index.ts");
    this.applyReplace(
      indexPath,
      "imported registerR2",
      'import { registerEnv } from "./env"\n',
      'import { registerEnv } from "./env"\nimport { registerR2 } from "./r2"\n',
      'from "./r2"',
    );
    this.applyReplace(
      indexPath,
      "registered R2 plugin",
      "  // Insert new plugins here\n",
      "  await registerR2(fastify)\n\n  // Insert new plugins here\n",
      "registerR2(fastify)",
    );

    // 5. Document the vars (best-effort) and add the dependency.
    const envExamplePath = path.join(workdir, apiDir, ".env.example");
    if (fs.existsSync(envExamplePath)) {
      const example = fs.readFileSync(envExamplePath, "utf8");
      if (!example.includes("R2_ACCOUNT_ID")) {
        const block =
          "\n# Cloudflare R2 (S3-compatible) — provisioned by the foundry s3 setup job\n" +
          "R2_ACCOUNT_ID=\nR2_ACCESS_KEY_ID=\nR2_SECRET_ACCESS_KEY=\nR2_BUCKET_NAME=\n";
        fs.writeFileSync(
          envExamplePath,
          example.endsWith("\n") ? example + block : `${example}\n${block}`,
        );
        console.log(`config: appended R2_* to ${apiDir}/.env.example.`);
      }
    }

    this.addAwsSdk(workdir, template.apiPnpmFilter ?? "api");
  }

  supabase(_workdir, template) {
    console.log(
      `Flow: Supabase - static config for '${template.configDir}' not yet implemented.`,
    );
  }

  mongodb(_workdir, template) {
    console.log(
      `Flow: MongoDB - static config for '${template.configDir}' not yet implemented.`,
    );
  }

  mongoose(_workdir, template) {
    console.log(
      `Flow: Mongoose - static config for '${template.configDir}' not yet implemented.`,
    );
  }

  /**
   * Resolves `INFISICAL_<NAME>_PATH: <insert-path-here> # TODO: Update this value`
   * placeholders in `.github/workflows/*.yml|*.yaml` of the generated repo.
   *
   * Mapping:
   *   - NAME == "SECRET"                   → /{projectName}                  (single-app templates)
   *   - NAME.toLowerCase() ∈ subfolders    → /{projectName}/{name.toLowerCase()}
   *   - anything else                      → throw (template drift)
   *
   * Returns the repo-relative paths it modified, so the caller can stage them.
   *
   * @param {string} workdir
   * @param {string} projectName
   * @param {{ infisical?: { subfolders?: string[] } }} template
   * @returns {string[]}
   */
  applyWorkflowInfisicalPaths(workdir, projectName, template) {
    const workflowsRel = path.posix.join(".github", "workflows");
    const workflowsAbs = path.join(workdir, workflowsRel);
    if (!fs.existsSync(workflowsAbs)) {
      console.log(`config: no ${workflowsRel} directory in generated repo (skip).`);
      return [];
    }

    const subfolders = new Set(template.infisical?.subfolders ?? []);
    const pattern =
      /^([ \t]*INFISICAL_([A-Z][A-Z0-9_]*)_PATH:[ \t]*)<insert-path-here>[ \t]*#[ \t]*TODO:[^\n]*$/gm;

    const resolve = (name) => {
      if (name === "SECRET") return infisicalPath(projectName, null);
      const folder = name.toLowerCase();
      if (subfolders.has(folder)) return infisicalPath(projectName, folder);
      throw new Error(
        `config: cannot resolve INFISICAL_${name}_PATH — '${folder}' is not in template.infisical.subfolders (${[...subfolders].join(", ") || "none"}).`,
      );
    };

    const modified = [];
    for (const entry of fs.readdirSync(workflowsAbs, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.ya?ml$/.test(entry.name)) continue;

      const relPath = path.posix.join(workflowsRel, entry.name);
      const absPath = path.join(workflowsAbs, entry.name);
      const original = fs.readFileSync(absPath, "utf8");

      const changes = [];
      const updated = original.replace(pattern, (_match, prefix, name) => {
        const resolved = resolve(name);
        changes.push({ name, resolved });
        return `${prefix}${resolved}`;
      });

      if (updated === original) continue;
      fs.writeFileSync(absPath, updated);
      for (const { name, resolved } of changes) {
        console.log(`config: resolved INFISICAL_${name}_PATH in ${relPath} → ${resolved}.`);
      }
      modified.push(relPath);
    }

    return modified;
  }

  async run(scenario, projectName, projectType, org, token, s3) {
    if (!SCENARIO_KEYS.has(scenario)) throw new Error(`Unhandled scenario: ${scenario}`);

    const template = TEMPLATES[projectType];
    if (!template) {
      console.log(`config: no template registered for '${projectType}'; skipping.`);
      return;
    }

    const workdir = cloneRepo(org, projectName, token);
    await this[scenario](workdir, template);
    if (s3) this.s3(workdir, template);
    const workflowFiles = this.applyWorkflowInfisicalPaths(workdir, projectName, template);
    this.syncLockfile(workdir);
    return this.commitAndPush(workdir, template, { s3, workflowFiles });
  }
}

async function main() {
  const preprocessor = new ConfigPreprocessor();
  const setup = new ConfigSetup();
  const { scenario, projectName, projectType, org, token, s3 } = preprocessor.prepare();

  console.log(`Config setup for '${projectName}' (${projectType}, ${scenario}, s3: ${s3}).`);

  const commitSha = await setup.run(scenario, projectName, projectType, org, token, s3);

  // Expose the pushed SHA so downstream jobs (notably render_setup) can wait
  // on the deploy-api.yml run that this push triggered.
  if (commitSha && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit_sha=${commitSha}\n`);
  }
}

module.exports = { main, ConfigSetup };
