#!/usr/bin/env node

const { Infisical } = require("./infisical.js");

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
      "GITHUB_ORG",
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
      "INFISICAL_VERCEL_CONNECTION_ID",
    ]);

    const domain = normalizeDomain(process.env.DOMAIN ?? "");

    return {
      projectName: process.env.PROJECT_NAME.trim(),
      githubOrg: process.env.GITHUB_ORG.trim(),
      vercelToken: process.env.VERCEL_TOKEN.trim(),
      vercelTeamId: process.env.VERCEL_TEAM_ID.trim(),
      infisicalProjectId: process.env.INFISICAL_PROJECT_ID.trim(),
      infisicalVercelConnectionId:
        process.env.INFISICAL_VERCEL_CONNECTION_ID.trim(),
      domain,
    };
  }
}

class VercelSetup {
  static API_BASE = "https://api.vercel.com";

  /**
   * @param {{
   *   projectName: string;
   *   githubOrg: string;
   *   vercelToken: string;
   *   vercelTeamId: string;
   *   infisicalProjectId: string;
   *   infisicalVercelConnectionId: string;
   *   domain: string;
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
   * @param {string} pathWithQuery
   * @param {{ method?: string; body?: object }} [options]
   */
  async vercelRequest(pathWithQuery, options = {}) {
    const { method = "GET", body } = options;
    const url = `${VercelSetup.API_BASE}${pathWithQuery}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.ctx.vercelToken}`,
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
      let err = text || res.statusText;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error
      ) {
        const m = parsed.error.message;
        err = typeof m === "string" ? m : JSON.stringify(m);
      }
      const apiError = new Error(
        `Vercel API ${method} ${pathWithQuery}: ${res.status} ${err}`,
      );
      Object.assign(apiError, { status: res.status, body: parsed });
      throw apiError;
    }

    return parsed;
  }

  /**
   * @param {unknown} data
   * @returns {string}
   */
  readVercelProjectId(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "id" in data &&
      typeof data.id === "string"
    ) {
      return data.id;
    }
    throw new Error("Vercel project response missing string id");
  }

  /**
   * @param {string} name
   */
  async getVercelProjectByName(name) {
    const q = new URLSearchParams({ teamId: this.ctx.vercelTeamId });
    const data = await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(name)}?${q.toString()}`,
    );
    return this.readVercelProjectId(data);
  }

  async ensureVercelProject() {
    const { projectName, githubOrg, vercelTeamId } = this.ctx;
    const teamQuery = new URLSearchParams({ teamId: vercelTeamId }).toString();

    try {
      const id = await this.getVercelProjectByName(projectName);
      console.log(
        `Vercel: project '${projectName}' already exists (id: ${id}), reusing.`,
      );
      return { id, name: projectName };
    } catch (e) {
      const status =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        typeof e.status === "number"
          ? e.status
          : Number.NaN;
      if (status !== 404) {
        throw e;
      }
    }

    const body = {
      name: projectName,
      gitRepository: {
        type: "github",
        repo: `${githubOrg}/${projectName}`,
      },
    };

    const created = await this.vercelRequest(`/v11/projects?${teamQuery}`, {
      method: "POST",
      body,
    });
    const id = this.readVercelProjectId(created);
    console.log(`Vercel: created project '${projectName}' (id: ${id}).`);
    return { id, name: projectName };
  }

  /**
   * @param {unknown} data
   * @returns {Array<{ name: string }>}
   */
  parseProjectDomains(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "domains" in data &&
      Array.isArray(data.domains)
    ) {
      /** @type {Array<{ name: string }>} */
      const out = [];
      for (const d of data.domains) {
        if (
          typeof d === "object" &&
          d !== null &&
          "name" in d &&
          typeof d.name === "string" &&
          d.name
        ) {
          out.push({ name: d.name });
        }
      }
      return out;
    }
    return [];
  }

  /**
   * @param {string} projectIdOrName
   */
  async listProjectDomains(projectIdOrName) {
    const q = new URLSearchParams({ teamId: this.ctx.vercelTeamId });
    const data = await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains?${q.toString()}`,
    );
    return this.parseProjectDomains(data);
  }

  /**
   * @param {string} projectIdOrName
   * @param {string} domainName
   */
  async addProjectDomain(projectIdOrName, domainName) {
    const q = new URLSearchParams({ teamId: this.ctx.vercelTeamId });
    await this.vercelRequest(
      `/v10/projects/${encodeURIComponent(projectIdOrName)}/domains?${q.toString()}`,
      { method: "POST", body: { name: domainName } },
    );
  }

  /**
   * @param {string} projectIdOrName
   * @param {string} domainName
   */
  async removeProjectDomain(projectIdOrName, domainName) {
    const q = new URLSearchParams({ teamId: this.ctx.vercelTeamId });
    await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domainName)}?${q.toString()}`,
      { method: "DELETE" },
    );
  }

  /**
   * Drops every domain that is not the launch hostname, then adds it if absent.
   * @param {string} projectIdOrName
   * @param {string} canonicalDomain normalized hostname
   */
  async applyLaunchDomain(projectIdOrName, canonicalDomain) {
    const targetLc = canonicalDomain.toLowerCase();
    const attached = await this.listProjectDomains(projectIdOrName);

    for (const d of attached) {
      if (d.name.toLowerCase() === targetLc) continue;
      console.log(`Vercel: removing domain '${d.name}'…`);
      try {
        await this.removeProjectDomain(projectIdOrName, d.name);
      } catch (e) {
        const status =
          typeof e === "object" &&
          e !== null &&
          "status" in e &&
          typeof e.status === "number"
            ? e.status
            : Number.NaN;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `Vercel: could not remove domain '${d.name}' (HTTP ${String(status)}): ${msg}`,
        );
      }
    }

    const after = await this.listProjectDomains(projectIdOrName);
    const hasTarget = after.some((d) => d.name.toLowerCase() === targetLc);
    if (hasTarget) {
      console.log(`Vercel: domain '${canonicalDomain}' is on project.`);
      return;
    }
    console.log(`Vercel: adding domain '${canonicalDomain}'…`);
    await this.addProjectDomain(projectIdOrName, canonicalDomain);
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
      console.log(
        `Infisical: Vercel sync '${spec.name}' already exists, skip.`,
      );
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
    const {
      projectName,
      vercelTeamId,
      infisicalProjectId,
      infisicalVercelConnectionId,
    } = this.ctx;

    const secretPath = projectName.startsWith("/")
      ? projectName
      : `/${projectName}`;

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
          app: vercelAppId,
          appName: projectName,
          env: s.vercelEnv,
          teamId: vercelTeamId,
        },
      });
    }
  }

  async run() {
    const { id: vercelAppId, name: vercelProjectName } =
      await this.ensureVercelProject();
    const { domain } = this.ctx;
    if (domain) {
      await this.applyLaunchDomain(vercelProjectName, domain);
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
