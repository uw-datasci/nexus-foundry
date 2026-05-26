#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const { Infisical } = require("../lib/integrations/infisical.js");
const { RenderClient } = require("../lib/integrations/render.js");
const { apiUrlSecretsPath, renderSyncPath } = require("../lib/templates.js");

class RenderSetupPreprocessor {
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
      "GH_TOKEN",
      "RENDER_API_KEY",
      "RENDER_OWNER_ID",
      "RENDER_PROJECT_ID",
      "GHCR_PULL_USERNAME",
      "GHCR_PULL_TOKEN",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
      "INFISICAL_RENDER_CONNECTION_ID",
    ]);

    return {
      projectName: process.env.PROJECT_NAME.trim(),
      projectType: process.env.PROJECT_TYPE.trim(),
      githubOrg: process.env.GITHUB_ORG.trim(),
      renderApiKey: process.env.RENDER_API_KEY.trim(),
      renderOwnerId: process.env.RENDER_OWNER_ID.trim(),
      renderProjectId: process.env.RENDER_PROJECT_ID.trim(),
      ghcrUsername: process.env.GHCR_PULL_USERNAME.trim(),
      ghcrToken: process.env.GHCR_PULL_TOKEN.trim(),
      infisicalProjectId: process.env.INFISICAL_PROJECT_ID.trim(),
      infisicalRenderConnectionId: process.env.INFISICAL_RENDER_CONNECTION_ID.trim(),
    };
  }
}

class RenderSetup {
  /**
   * @param {{
   *   projectName: string;
   *   projectType: string;
   *   githubOrg: string;
   *   renderApiKey: string;
   *   renderOwnerId: string;
   *   renderProjectId: string;
   *   ghcrUsername: string;
   *   ghcrToken: string;
   *   infisicalProjectId: string;
   *   infisicalRenderConnectionId: string;
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.render = new RenderClient({ renderApiKey: ctx.renderApiKey });
  }

  /**
   * Writes a GitHub Actions secret on the generated repo so its deploy-api.yml
   * can deploy to the service we just created. `gh` performs the libsodium
   * encryption; `GH_TOKEN` is read from the environment.
   *
   * @param {string} name
   * @param {string} value
   */
  setRepoSecret(name, value) {
    const { githubOrg, projectName } = this.ctx;
    execFileSync("gh", ["secret", "set", name, "--repo", `${githubOrg}/${projectName}`], {
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
    });
    console.log(`GitHub: set Actions secret '${name}' on '${githubOrg}/${projectName}'.`);
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
  async listRenderSecretSyncs(infisical, token, projectId) {
    const params = new URLSearchParams({ projectId });
    const data = await infisical.infisicalRequest(
      `/api/v1/secret-syncs/render?${params.toString()}`,
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
   *   serviceId: string;
   * }} spec
   */
  async ensureRenderSecretSync(infisical, token, spec) {
    const existing = await this.listRenderSecretSyncs(
      infisical,
      token,
      spec.infisicalProjectId,
    );
    if (existing.some((s) => s.name === spec.name)) {
      console.log(`Infisical: Render sync '${spec.name}' already exists, skip.`);
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
      destinationConfig: {
        scope: "service",
        serviceId: spec.serviceId,
      },
    };

    await infisical.infisicalRequest(`/api/v1/secret-syncs/render`, token, {
      method: "POST",
      body,
    });
    console.log(`Infisical: created Render secret sync '${spec.name}'.`);
  }

  /**
   * Logs in once, stores the deployed API URL in the project's api folder
   * (`/{projectName}/api`) across all environments, then ensures prod + staging
   * Infisical → Render secret syncs from that same folder.
   *
   * @param {string} serviceId
   * @param {string | null} apiUrl
   */
  async setupInfisicalRender(serviceId, apiUrl) {
    const { projectName, projectType, infisicalProjectId, infisicalRenderConnectionId } =
      this.ctx;

    const renderSecretPath = renderSyncPath(projectName, projectType);
    if (!renderSecretPath) {
      throw new Error(`Template '${projectType}' has no Infisical Render sync folder.`);
    }

    const infisical = new Infisical();
    const token = await infisical.login(
      process.env.INFISICAL_CLIENT_ID.trim(),
      process.env.INFISICAL_CLIENT_SECRET.trim(),
    );

    const apiUrlPath = apiUrlSecretsPath(projectName, projectType);
    if (apiUrl) {
      if (apiUrlPath) {
        for (const environment of ["dev", "staging", "prod"]) {
          await infisical.upsertSecret(
            token,
            infisicalProjectId,
            environment,
            apiUrlPath,
            "API_URL",
            apiUrl,
          );
          console.log(`Infisical: set API_URL for '${environment}' at '${apiUrlPath}'.`);
        }
      } else {
        console.warn("Render: API URL available but template has no apiUrl folder; skipping.");
      }
    } else {
      console.warn("Render: service URL not available yet; skipping API_URL secret.");
    }

    // One free Render service runs production, so only the prod environment is
    // synced to it. (Add a staging sync here if a separate staging service is
    // ever provisioned.)
    console.log("Infisical: ensuring Render sync (prod → Render)…");
    await this.ensureRenderSecretSync(infisical, token, {
      name: `${projectName}-render-sync-prod`,
      infisicalProjectId,
      connectionId: infisicalRenderConnectionId,
      infisicalEnvironment: "prod",
      secretPath: renderSecretPath,
      serviceId,
    });
  }

  async run() {
    const {
      projectName,
      projectType,
      githubOrg,
      renderApiKey,
      renderOwnerId,
      renderProjectId,
      ghcrUsername,
      ghcrToken,
    } = this.ctx;

    const template = getTemplate(projectType);
    if (!template?.hasApi) {
      console.log(
        `Render: template '${projectType}' has no API server; skipping Render setup.`,
      );
      return;
    }

    const environmentId = await this.render.getProjectEnvironmentId(renderProjectId);

    const imagePath = `ghcr.io/${githubOrg.toLowerCase()}/${projectName.toLowerCase()}:latest`;

    const registryCredentialId = await this.render.ensureRegistryCredential({
      name: `ghcr-${githubOrg}`,
      ownerId: renderOwnerId,
      username: ghcrUsername,
      authToken: ghcrToken,
    });

    const { id: serviceId, url: apiUrl } = await this.render.ensureWebService({
      name: projectName,
      ownerId: renderOwnerId,
      environmentId,
      imagePath,
      registryCredentialId,
      healthCheckPath: template.apiHealthCheckPath ?? "/health",
    });

    this.setRepoSecret("RENDER_SERVICE_ID", serviceId);
    this.setRepoSecret("RENDER_API_KEY", renderApiKey);

    await this.setupInfisicalRender(serviceId, apiUrl);
  }
}

async function main() {
  const preprocessor = new RenderSetupPreprocessor();
  const ctx = preprocessor.prepare();
  const setup = new RenderSetup(ctx);
  await setup.run();
}

module.exports = { main };
