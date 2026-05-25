#!/usr/bin/env node

const { CloudflareClient } = require("../lib/integrations/cloudflare.js");
const { Infisical } = require("../lib/integrations/infisical.js");
const { getTemplate } = require("../lib/templates.js");

/** Infisical environments that each get an isolated bucket + scoped token. */
const ENVIRONMENTS = ["dev", "staging", "prod"];

class S3SetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "PROJECT_TYPE",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
    ]);

    const projectType = process.env.PROJECT_TYPE.trim();
    const template = getTemplate(projectType);
    const s3SecretApp = template?.s3SecretApp ?? (template?.hasApi ? "api" : "web");

    return {
      projectName: process.env.PROJECT_NAME.trim(),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID.trim(),
      apiToken: process.env.CLOUDFLARE_API_TOKEN.trim(),
      s3SecretApp,
    };
  }
}

class S3Setup {
  /**
   * @param {{ projectName: string; accountId: string; apiToken: string; s3SecretApp: string }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.cloudflare = new CloudflareClient({
      apiToken: ctx.apiToken,
      accountId: ctx.accountId,
    });
  }

  /**
   * Creates one bucket + one bucket-scoped token per environment so dev/staging/
   * prod are fully isolated, returning the per-environment credential map.
   *
   * Note: R2 token values cannot be read back after creation, so re-running this
   * mints fresh credentials; previously created tokens remain until revoked.
   *
   * @returns {Promise<Record<string, {
   *   accountId: string;
   *   accessKeyId: string;
   *   secretAccessKey: string;
   *   bucketName: string;
   * }>>}
   */
  async provisionPerEnvironment() {
    const { projectName, accountId } = this.ctx;
    const permissionGroupIds = await this.cloudflare.resolveR2PermissionGroupIds();

    /** @type {Record<string, { accountId: string; accessKeyId: string; secretAccessKey: string; bucketName: string }>} */
    const perEnv = {};

    for (const environment of ENVIRONMENTS) {
      const bucketName = `${projectName}-${environment}`;
      await this.cloudflare.ensureBucket(bucketName);

      const { accessKeyId, secretAccessKey } = await this.cloudflare.createScopedR2Token({
        name: `${projectName}-${environment}-r2`,
        bucketName,
        permissionGroupIds,
      });
      console.log(`Cloudflare: minted R2 token for '${bucketName}'.`);

      perEnv[environment] = { accountId, accessKeyId, secretAccessKey, bucketName };
    }

    return perEnv;
  }

  async run() {
    const { projectName, s3SecretApp } = this.ctx;

    console.log(
      `S3 setup for project '${projectName}' (R2_* → /${projectName}/${s3SecretApp}, environments: ${ENVIRONMENTS.join(", ")}).`,
    );

    const perEnv = await this.provisionPerEnvironment();

    await Infisical.pushR2Credentials({
      clientId: process.env.INFISICAL_CLIENT_ID,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET,
      projectId: process.env.INFISICAL_PROJECT_ID,
      projectName,
      appFolder: s3SecretApp,
      perEnv,
    });
  }
}

async function main() {
  const preprocessor = new S3SetupPreprocessor();
  const ctx = preprocessor.prepare();
  const setup = new S3Setup(ctx);
  await setup.run();
}

module.exports = { main };
