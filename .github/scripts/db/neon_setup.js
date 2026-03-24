#!/usr/bin/env node

const fs = require("node:fs");

const NEON_API_BASE = "https://console.neon.tech/api/v2";

const DEFAULT_NEON_REGION_ID = "aws-us-east-2";
const DEFAULT_NEON_PG_VERSION = 16;

const ACTIVE_OPERATION_STATUSES = new Set(["scheduling", "running"]);

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {{ method?: string; body?: object }} [options]
 */
async function neonRequest(apiKey, path, options = {}) {
  const { method = "GET", body } = options;
  const url = `${NEON_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
 * @param {string} apiKey
 * @param {string} projectId
 * @param {{ maxMs?: number }} [opts]
 */
async function waitForProjectOperationsIdle(apiKey, projectId, opts = {}) {
  const { maxMs = 180_000 } = opts;
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    const data = await neonRequest(
      apiKey,
      `/projects/${encodeURIComponent(projectId)}/operations?limit=100`,
    );
    const operations = Array.isArray(data.operations) ? data.operations : [];
    const busy = operations.some((op) =>
      ACTIVE_OPERATION_STATUSES.has(op.status),
    );
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(
    `Timeout waiting for Neon operations on project ${projectId} (${maxMs}ms)`,
  );
}

/**
 * @param {string} apiKey
 * @param {string} projectId
 * @param {string} branchId
 * @param {string} databaseName
 * @param {string} roleName
 */
async function fetchConnectionUri(
  apiKey,
  projectId,
  branchId,
  databaseName,
  roleName,
) {
  const q = new URLSearchParams({
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
  });
  const data = await neonRequest(
    apiKey,
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
function appendGithubOutput(name, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const delim = `neon_${name}_${process.pid}_${Date.now()}`;
  fs.appendFileSync(outPath, `${name}<<${delim}\n${value}\n${delim}\n`);
}

/**
 * @param {unknown} created
 * @returns {{ connectionUri: string } | null}
 */
function firstConnectionUri(created) {
  if (
    typeof created !== "object" ||
    created === null ||
    !("connection_uris" in created)
  ) {
    return null;
  }
  const uris = created.connection_uris;
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const first = uris[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "connection_uri" in first &&
    typeof first.connection_uri === "string"
  ) {
    return { connectionUri: first.connection_uri };
  }
  return null;
}

/**
 * @param {unknown} created
 * @returns {{ databaseName: string; roleName: string }}
 */
function defaultDatabaseAndRole(created) {
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
 * Requires env: NEON_API_KEY
 * Optional: NEON_ORG_ID
 *
 * @param {string} projectName Foundry project slug (kebab-case)
 * @returns {Promise<{
 *   projectId: string;
 *   prodBranchId: string;
 *   devBranchId: string;
 *   prodConnectionUri: string;
 *   devConnectionUri: string;
 * }>}
 */
async function provisionNeonProject(projectName) {
  const apiKey = process.env.NEON_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("NEON_API_KEY is required for Neon database setup");
  }

  /** @type {{ project: Record<string, unknown> }} */
  const createBody = {
    project: {
      name: projectName,
      region_id: DEFAULT_NEON_REGION_ID,
      pg_version: DEFAULT_NEON_PG_VERSION,
      branch: { name: "prod" },
    },
  };

  const orgId = process.env.NEON_ORG_ID;
  if (orgId) createBody.project.org_id = orgId;

  console.log(
    `Neon: creating project '${projectName}' (default branch: prod, region: ${DEFAULT_NEON_REGION_ID}).`,
  );

  const created = await neonRequest(apiKey, "/projects", {
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

  await waitForProjectOperationsIdle(apiKey, projectId);

  const { databaseName, roleName } = defaultDatabaseAndRole(created);

  let prodUri = firstConnectionUri(created)?.connectionUri ?? null;
  if (!prodUri) {
    prodUri = await fetchConnectionUri(
      apiKey,
      projectId,
      prodBranchId,
      databaseName,
      roleName,
    );
  }

  console.log("Neon: creating branch 'dev' from prod.");

  const devCreated = await neonRequest(
    apiKey,
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

  await waitForProjectOperationsIdle(apiKey, projectId);

  let devUri = firstConnectionUri(devCreated)?.connectionUri ?? null;
  if (!devUri) {
    devUri = await fetchConnectionUri(
      apiKey,
      projectId,
      devBranchId,
      databaseName,
      roleName,
    );
  }

  appendGithubOutput("neon_project_id", projectId);
  appendGithubOutput("neon_prod_branch_id", prodBranchId);
  appendGithubOutput("neon_dev_branch_id", devBranchId);
  appendGithubOutput("neon_database_url_prod", prodUri);
  appendGithubOutput("neon_database_url_dev", devUri);

  console.log(`Neon: project id ${projectId}`);
  console.log(`Neon: prod branch ${prodBranchId} — connection URI retrieved.`);
  console.log(`Neon: dev branch ${devBranchId} — connection URI retrieved.`);

  return {
    projectId,
    prodBranchId,
    devBranchId,
    prodConnectionUri: prodUri,
    devConnectionUri: devUri,
  };
}

module.exports = { provisionNeonProject };
