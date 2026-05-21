#!/usr/bin/env node

const fs = require("node:fs");

const { Infisical } = require("../integrations/infisical.js");

class NeonSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv(["NEON_API_KEY"]);
    const orgId = process.env.NEON_ORG_ID?.trim();
    return {
      apiKey: process.env.NEON_API_KEY.trim(),
      ...(orgId ? { orgId } : {}),
    };
  }
}

class NeonSetup {
  static API_BASE = "https://console.neon.tech/api/v2";
  static DEFAULT_REGION_ID = "aws-us-east-1";
  static DEFAULT_PG_VERSION = 17;
  static ACTIVE_OPERATION_STATUSES = new Set(["scheduling", "running"]);

  /**
   * @param {string} path
   * @param {{ method?: string; body?: object }} [options]
   */
  async neonRequest(path, options = {}) {
    const { method = "GET", body } = options;
    const url = `${NeonSetup.API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    /** @type {unknown} */
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      const err =
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
          ? parsed.message
          : text || res.statusText;
      throw new Error(`Neon API ${method} ${path}: ${res.status} ${err}`);
    }

    return parsed;
  }

  /**
   * @param {{ maxMs?: number }} [opts]
   */
  async waitForProjectOperationsIdle(projectId, opts = {}) {
    const { maxMs = 180_000 } = opts;
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      const data = await this.neonRequest(
        `/projects/${encodeURIComponent(projectId)}/operations?limit=100`,
      );
      const operations = Array.isArray(data.operations) ? data.operations : [];
      const busy = operations.some((op) =>
        NeonSetup.ACTIVE_OPERATION_STATUSES.has(op.status),
      );
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(
      `Timeout waiting for Neon operations on project ${projectId} (${maxMs}ms)`,
    );
  }

  /**
   * @param {string} projectId
   * @param {string} branchId
   * @param {string} databaseName
   * @param {string} roleName
   * @param {boolean} [pooled=true] When true, matches Neon console “Pooled connection” (`-pooler` host).
   */
  async fetchConnectionUri(
    projectId,
    branchId,
    databaseName,
    roleName,
    pooled = true,
  ) {
    const q = new URLSearchParams({
      branch_id: branchId,
      database_name: databaseName,
      role_name: roleName,
    });
    if (pooled) q.set("pooled", "true");

    const data = await this.neonRequest(
      `/projects/${encodeURIComponent(projectId)}/connection_uri?${q.toString()}`,
    );
    if (
      typeof data === "object" &&
      data !== null &&
      "uri" in data &&
      typeof data.uri === "string"
    ) {
      return data.uri;
    }
    throw new Error("Neon connection_uri response missing uri");
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  appendGithubOutput(name, value) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) return;
    const delim = `neon_${name}_${process.pid}_${Date.now()}`;
    fs.appendFileSync(outPath, `${name}<<${delim}\n${value}\n${delim}\n`);
  }

  /**
   * @param {unknown} created
   * @returns {{ databaseName: string; roleName: string }}
   */
  defaultDatabaseAndRole(created) {
    let databaseName = "neondb";
    let roleName = "neondb_owner";

    if (
      typeof created === "object" &&
      created !== null &&
      "databases" in created &&
      Array.isArray(created.databases) &&
      created.databases.length > 0
    ) {
      const d = created.databases[0];
      if (
        typeof d === "object" &&
        d !== null &&
        "name" in d &&
        typeof d.name === "string"
      ) {
        databaseName = d.name;
      }
    }

    if (
      typeof created === "object" &&
      created !== null &&
      "roles" in created &&
      Array.isArray(created.roles) &&
      created.roles.length > 0
    ) {
      const r = created.roles[0];
      if (
        typeof r === "object" &&
        r !== null &&
        "name" in r &&
        typeof r.name === "string"
      ) {
        roleName = r.name;
      }
    }

    return { databaseName, roleName };
  }

  /**
   * Creates a Neon project with default branch `prod`, branches `dev` from prod,
   * and resolves connection URIs for both.
   *
   * @param {string} projectName Foundry project slug (kebab-case)
   * @param {{ apiKey: string; orgId?: string }} ctx
   * @returns {Promise<{
   *   projectId: string;
   *   prodBranchId: string;
   *   devBranchId: string;
   *   prodConnectionUri: string;
   *   devConnectionUri: string;
   * }>}
   */
  async provisionProject(projectName, ctx) {
    this.apiKey = ctx.apiKey;

    /** @type {{ project: Record<string, unknown> }} */
    const createBody = {
      project: {
        name: projectName,
        region_id: NeonSetup.DEFAULT_REGION_ID,
        pg_version: NeonSetup.DEFAULT_PG_VERSION,
        branch: { name: "prod" },
      },
    };

    if (ctx.orgId) createBody.project.org_id = ctx.orgId;

    console.log(
      `Neon: creating project '${projectName}' (default branch: prod, region: ${NeonSetup.DEFAULT_REGION_ID}).`,
    );

    const created = await this.neonRequest("/projects", {
      method: "POST",
      body: createBody,
    });

    if (
      typeof created !== "object" ||
      created === null ||
      !("project" in created) ||
      typeof created.project !== "object" ||
      created.project === null ||
      !("id" in created.project) ||
      typeof created.project.id !== "string"
    ) {
      throw new Error("Neon create project response missing project.id");
    }

    const projectId = created.project.id;

    if (
      !("branch" in created) ||
      typeof created.branch !== "object" ||
      created.branch === null ||
      !("id" in created.branch) ||
      typeof created.branch.id !== "string"
    ) {
      throw new Error("Neon create project response missing branch.id");
    }

    const prodBranchId = created.branch.id;

    await this.waitForProjectOperationsIdle(projectId);

    const { databaseName, roleName } = this.defaultDatabaseAndRole(created);

    const prodUri = await this.fetchConnectionUri(
      projectId,
      prodBranchId,
      databaseName,
      roleName,
    );

    console.log("Neon: creating branch 'dev' from prod.");

    const devCreated = await this.neonRequest(
      `/projects/${encodeURIComponent(projectId)}/branches`,
      {
        method: "POST",
        body: {
          branch: {
            name: "dev",
            parent_id: prodBranchId,
          },
          endpoints: [{ type: "read_write" }],
        },
      },
    );

    if (
      typeof devCreated !== "object" ||
      devCreated === null ||
      !("branch" in devCreated) ||
      typeof devCreated.branch !== "object" ||
      devCreated.branch === null ||
      !("id" in devCreated.branch) ||
      typeof devCreated.branch.id !== "string"
    ) {
      throw new Error("Neon create branch response missing branch.id");
    }

    const devBranchId = devCreated.branch.id;

    await this.waitForProjectOperationsIdle(projectId);

    const devUri = await this.fetchConnectionUri(
      projectId,
      devBranchId,
      databaseName,
      roleName,
    );

    this.appendGithubOutput("neon_project_id", projectId);
    this.appendGithubOutput("neon_prod_branch_id", prodBranchId);
    this.appendGithubOutput("neon_dev_branch_id", devBranchId);
    this.appendGithubOutput("neon_database_url_prod", prodUri);
    this.appendGithubOutput("neon_database_url_dev", devUri);

    console.log(`Neon: project id ${projectId}`);
    console.log(
      `Neon: prod branch ${prodBranchId} - pooled connection URI retrieved.`,
    );
    console.log(
      `Neon: dev branch ${devBranchId} - pooled connection URI retrieved.`,
    );

    return {
      projectId,
      prodBranchId,
      devBranchId,
      prodConnectionUri: prodUri,
      devConnectionUri: devUri,
    };
  }
}

/**
 * Provisions Neon, then pushes `DATABASE_URL` to Infisical when machine-identity
 * env vars are set (optional): INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET,
 * INFISICAL_PROJECT_ID.
 *
 * @param {string} projectName Foundry project slug (kebab-case)
 * @param {string} [dbSecretApp] App subfolder that receives DATABASE_URL (e.g. "api").
 */
async function provisionNeonProject(projectName, dbSecretApp) {
  const preprocessor = new NeonSetupPreprocessor();
  const ctx = preprocessor.prepare();

  const setup = new NeonSetup();
  const result = await setup.provisionProject(projectName, ctx);

  await Infisical.pushNeonDatabaseUrls({
    clientId: process.env.INFISICAL_CLIENT_ID,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET,
    projectId: process.env.INFISICAL_PROJECT_ID,
    projectName,
    appFolder: dbSecretApp,
    devConnectionUri: result.devConnectionUri,
    prodConnectionUri: result.prodConnectionUri,
  });

  return result;
}

module.exports = { provisionNeonProject };
