#!/usr/bin/env node

const { Infisical } = require("../lib/integrations/infisical.js");
const { VercelClient } = require("../lib/integrations/vercel.js");
const { vercelSyncPath } = require("../lib/templates.js");

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "");
  const host = s.split("/")[0].split(":")[0];
  return host || "";
}

class VercelSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "PROJECT_TYPE",
      "GITHUB_ORG",
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
      "INFISICAL_VERCEL_CONNECTION_ID",
    ]);

    const domain = normalizeDomain(process.env.DOMAIN ?? "");
    const projectType = process.env.PROJECT_TYPE.trim();

    return {
      projectName: process.env.PROJECT_NAME.trim(),
      projectType,
      githubOrg: process.env.GITHUB_ORG.trim(),
      vercelToken: process.env.VERCEL_TOKEN.trim(),
      vercelTeamId: process.env.VERCEL_TEAM_ID.trim(),
      infisicalProjectId: process.env.INFISICAL_PROJECT_ID.trim(),
      infisicalVercelConnectionId: process.env.INFISICAL_VERCEL_CONNECTION_ID.trim(),
      domain,
    };
  }
}

class VercelSetup {
  /**
   * @param {{
   *   projectName: string;
   *   githubOrg: string;
   *   vercelToken: string;
   *   vercelTeamId: string;
   *   infisicalProjectId: string;
   *   infisicalVercelConnectionId: string;
   *   domain: string;
   *   projectType: string;
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.vercel = new VercelClient({
      vercelToken: ctx.vercelToken,
      vercelTeamId: ctx.vercelTeamId,
    });
  }

  /**
   * @param {unknown} data
   * @returns {Array<{ name?: string }>}
   */
  parseSecretSyncList(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "secretSyncs" in data &&
      Array.isArray(data.secretSyncs)
    ) {
      return data.secretSyncs;
    }
    return [];
  }

  /**
   * @param {Infisical} infisical
   * @param {string} token
   * @param {string} projectId
   */
  async listVercelSecretSyncs(infisical, token, projectId) {
    const params = new URLSearchParams({ projectId });
    const data = await infisical.infisicalRequest(
      `/api/v1/secret-syncs/vercel?${params.toString()}`,
      token,
    );
    return this.parseSecretSyncList(data);
  }

  /**
   * @param {Infisical} infisical
   * @param {string} token
   * @param {{
   *   name: string;
   *   infisicalProjectId: string;
   *   connectionId: string;
   *   infisicalEnvironment: string;
   *   secretPath: string;
   *   destinationConfig: {
   *     scope: "project";
   *     app: string;
   *     appName: string;
   *     env: string;
   *     teamId: string;
   *   };
   * }} spec
   */
  async ensureVercelSecretSync(infisical, token, spec) {
    const existing = await this.listVercelSecretSyncs(
      infisical,
      token,
      spec.infisicalProjectId,
    );
    if (existing.some((s) => s.name === spec.name)) {
      console.log(`Infisical: Vercel sync '${spec.name}' already exists, skip.`);
      return;
    }

    const body = {
      name: spec.name,
      projectId: spec.infisicalProjectId,
      connectionId: spec.connectionId,
      environment: spec.infisicalEnvironment,
      secretPath: spec.secretPath,
      isAutoSyncEnabled: true,
      syncOptions: {
        initialSyncBehavior: "overwrite-destination",
      },
      destinationConfig: spec.destinationConfig,
    };

    await infisical.infisicalRequest(`/api/v1/secret-syncs/vercel`, token, {
      method: "POST",
      body,
    });
    console.log(`Infisical: created Vercel secret sync '${spec.name}'.`);
  }

  /**
   * @param {string} vercelAppId
   */
  async ensureInfisicalVercelSyncs(vercelAppId) {
    const { projectName, projectType, vercelTeamId, infisicalProjectId, infisicalVercelConnectionId } =
      this.ctx;

    const secretPath = vercelSyncPath(projectName, projectType);

    const infisical = new Infisical();
    const token = await infisical.login(
      process.env.INFISICAL_CLIENT_ID.trim(),
      process.env.INFISICAL_CLIENT_SECRET.trim(),
    );

    const syncs = [
      {
        name: `${projectName}-sync-prod`,
        infisicalEnvironment: "prod",
        vercelEnv: "production",
        label: "prod → Vercel production",
      },
      {
        name: `${projectName}-sync-staging`,
        infisicalEnvironment: "staging",
        vercelEnv: "preview",
        label: "staging → Vercel preview",
      },
    ];

    for (const s of syncs) {
      console.log(`Infisical: ensuring sync (${s.label})…`);
      await this.ensureVercelSecretSync(infisical, token, {
        name: s.name,
        infisicalProjectId,
        connectionId: infisicalVercelConnectionId,
        infisicalEnvironment: s.infisicalEnvironment,
        secretPath,
        destinationConfig: {
          scope: "project",
          app: vercelAppId,
          appName: projectName,
          env: s.vercelEnv,
          teamId: vercelTeamId,
        },
      });
    }
  }

  async run() {
    const { projectName, githubOrg, domain } = this.ctx;
    const { id: vercelAppId, name: vercelProjectName } = await this.vercel.ensureVercelProject(
      projectName,
      githubOrg,
    );
    if (domain) {
      await this.vercel.applyLaunchDomain(vercelProjectName, domain);
    }
    await this.ensureInfisicalVercelSyncs(vercelAppId);
  }
}

async function main() {
  const preprocessor = new VercelSetupPreprocessor();
  const ctx = preprocessor.prepare();
  const setup = new VercelSetup(ctx);
  await setup.run();
}

module.exports = { main };
