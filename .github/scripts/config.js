#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const GIT_USER_NAME = "foundry[bot]";
const GIT_USER_EMAIL = "foundry[bot]@users.noreply.github.com";

const SCENARIO_KEYS = new Set(["neon", "supabase", "mongodb", "mongoose"]);

/**
 * Per-template layout. Static config differs by where each template keeps its
 * app package and `config/` directory.
 *
 * @type {Record<string, { appDir: string; configDir: string; pnpmFilter: string | null }>}
 */
const TEMPLATES = {
  "sample-next-app": {
    appDir: ".",
    configDir: "config",
    pnpmFilter: null,
  },
  "sample-web-api-monorepo": {
    appDir: "apps/web",
    configDir: "apps/web/config",
    pnpmFilter: "web",
  },
};

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
    };
  }

  assertPostgresInputs({ mongoClient, postgresProvider }) {
    if (mongoClient) throw new Error("MONGO_CLIENT must be empty when DATABASE is postgres");

    if (postgresProvider !== "neon" && postgresProvider !== "supabase") {
      throw new Error("When DATABASE is postgres, POSTGRES_PROVIDER must be neon or supabase");
    }
  }

  assertMongoInputs({ postgresProvider, mongoClient }) {
    if (postgresProvider) {
      throw new Error("POSTGRES_PROVIDER must be empty when DATABASE is mongodb");
    }

    if (mongoClient !== "mongodb" && mongoClient !== "mongoose") {
      throw new Error("When DATABASE is mongodb, MONGO_CLIENT must be mongodb or mongoose");
    }
  }

  validateDbScenarioInputs(inputs) {
    const { database, postgresProvider, mongoClient } = inputs;

    if (database === "postgres") {
      this.assertPostgresInputs({ mongoClient, postgresProvider });
      return postgresProvider;
    }
    if (database === "mongodb") {
      this.assertMongoInputs({ postgresProvider, mongoClient });
      return mongoClient;
    }
    throw new Error(`DATABASE must be postgres or mongodb, got: ${database}`);
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
    const scenario = this.validateDbScenarioInputs(inputs);
    return {
      scenario,
      projectName: inputs.projectName,
      projectType: inputs.projectType,
      org: inputs.org,
      token: inputs.token,
    };
  }
}

class ConfigSetup {
  /**
   * @param {string} org
   * @param {string} repo
   * @param {string} token
   * @returns {string} absolute path to the working copy
   */
  cloneRepo(org, repo, token) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `foundry-${repo}-`));
    const remote = `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
    console.log(`config: cloning ${org}/${repo}…`);
    execFileSync("git", ["clone", "--depth", "1", remote, workdir], {
      stdio: "inherit",
    });
    execFileSync("git", ["config", "user.name", GIT_USER_NAME], {
      cwd: workdir,
    });
    execFileSync("git", ["config", "user.email", GIT_USER_EMAIL], {
      cwd: workdir,
    });
    return workdir;
  }

  /**
   * Stages only the intended files (never the generated lockfile or node_modules),
   * commits, and pushes to main. No-ops if nothing changed.
   *
   * @param {string} workdir
   * @param {{ appDir: string; configDir: string }} template
   */
  commitAndPush(workdir, template) {
    const filePaths = [
      path.posix.join(template.configDir, "server.ts"),
      path.posix.join(template.configDir, "db.ts"),
      path.posix.join(template.appDir, "package.json"),
    ];
    execFileSync("git", ["add", "--", ...filePaths], { cwd: workdir });

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: workdir,
      encoding: "utf8",
    }).trim();
    if (!staged) {
      console.log("config: no changes to commit (skip).");
      return;
    }

    execFileSync("git", ["commit", "-m", "chore: configure neon postgres (nexus-foundry)"], {
      cwd: workdir,
      stdio: "inherit",
    });
    execFileSync("git", ["push", "origin", "HEAD:main"], {
      cwd: workdir,
      stdio: "inherit",
    });
    console.log("config: pushed configuration commit.");
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

  async run(scenario, projectName, projectType, org, token) {
    if (!SCENARIO_KEYS.has(scenario)) throw new Error(`Unhandled scenario: ${scenario}`);

    const template = TEMPLATES[projectType];
    if (!template) {
      console.log(`config: no template registered for '${projectType}'; skipping.`);
      return;
    }

    const workdir = this.cloneRepo(org, projectName, token);
    await this[scenario](workdir, template);
    this.commitAndPush(workdir, template);
  }
}

async function main() {
  const preprocessor = new ConfigPreprocessor();
  const setup = new ConfigSetup();
  const { scenario, projectName, projectType, org, token } = preprocessor.prepare();

  console.log(`Config setup for '${projectName}' (${projectType}, ${scenario}).`);

  await setup.run(scenario, projectName, projectType, org, token);
}

module.exports = { main };
