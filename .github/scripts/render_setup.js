#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");

const { Infisical } = require("../lib/integrations/infisical.js");
const { RenderClient } = require("../lib/integrations/render.js");
const { apiUrlSecretsPath, getTemplate, renderSyncPath } = require("../lib/templates.js");

const DEPLOY_API_WORKFLOW = "deploy-api.yml";
const DEPLOY_API_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const DEPLOY_API_POLL_INTERVAL_MS = 15 * 1000;
const INFISICAL_DEV_API_URL = "http://localhost:8000";

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
      configCommitSha: process.env.CONFIG_COMMIT_SHA?.trim() || null,
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
   *   configCommitSha: string | null;
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.render = new RenderClient({ renderApiKey: ctx.renderApiKey });
  }

  /**
   * Blocks until the `deploy-api.yml` run triggered by config's push reaches a
   * terminal state. We need the image at GHCR before Render can pull it, so a
   * successful build job is a hard prerequisite for `ensureWebService`.
   *
   * The first deploy-api.yml run skips its `deploy-render` job (no Render
   * secrets yet), so a "success" conclusion here means the image is pushed.
   * Anything else (failure, cancelled, timed_out) is fatal — creating a Render
   * service that points at a non-existent image just produces a broken
   * service.
   *
   * @param {string} commitSha
   */
  async waitForDeployApiRun(commitSha) {
    const { githubOrg, projectName } = this.ctx;
    const repo = `${githubOrg}/${projectName}`;
    const deadline = Date.now() + DEPLOY_API_WAIT_TIMEOUT_MS;

    console.log(
      `GitHub: waiting for ${DEPLOY_API_WORKFLOW} run on ${repo} for commit ${commitSha}…`,
    );

    while (Date.now() < deadline) {
      const stdout = execFileSync(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          DEPLOY_API_WORKFLOW,
          "--commit",
          commitSha,
          "--limit",
          "1",
          "--json",
          "databaseId,status,conclusion,url",
        ],
        { encoding: "utf8" },
      );

      /** @type {Array<{ databaseId: number; status: string; conclusion: string | null; url: string }>} */
      const runs = JSON.parse(stdout || "[]");
      const run = runs[0];

      if (!run) {
        console.log(`GitHub: no ${DEPLOY_API_WORKFLOW} run yet for ${commitSha}; waiting…`);
      } else if (run.status !== "completed") {
        console.log(`GitHub: run ${run.databaseId} status=${run.status}; waiting…`);
      } else if (run.conclusion === "success") {
        console.log(`GitHub: run ${run.databaseId} completed successfully (${run.url}).`);
        return;
      } else {
        throw new Error(
          `${DEPLOY_API_WORKFLOW} run ${run.databaseId} concluded '${run.conclusion}' (${run.url}); refusing to create Render service without a pushed image.`,
        );
      }

      await sleep(DEPLOY_API_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timed out after ${DEPLOY_API_WAIT_TIMEOUT_MS / 1000}s waiting for ${DEPLOY_API_WORKFLOW} run on ${repo} for commit ${commitSha}.`,
    );
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
        type: "env",
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
   * Logs in once, stores API_URL in the project's api folder (`/{projectName}/api`):
   * dev → localhost, staging/prod → deployed Render URL. Then ensures prod
   * Infisical → Render secret sync from that folder.
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
          const url = environment === "dev" ? INFISICAL_DEV_API_URL : apiUrl;
          await infisical.upsertSecret(
            token,
            infisicalProjectId,
            environment,
            apiUrlPath,
            "API_URL",
            url,
          );
          console.log(
            `Infisical: set API_URL for '${environment}' at '${apiUrlPath}' → ${url}.`,
          );
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
      configCommitSha,
    } = this.ctx;

    const template = getTemplate(projectType);
    if (!template?.hasApi) {
      console.log(
        `Render: template '${projectType}' has no API server; skipping Render setup.`,
      );
      return;
    }

    if (configCommitSha) {
      await this.waitForDeployApiRun(configCommitSha);
    } else {
      console.warn(
        "Render: CONFIG_COMMIT_SHA not provided; proceeding without waiting for deploy-api.yml. The Render service may come up before its image exists.",
      );
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
