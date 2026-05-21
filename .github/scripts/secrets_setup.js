#!/usr/bin/env node

const { Infisical } = require("./integrations/infisical.js");
const { getTemplate } = require("../lib/templates.js");

class SecretsSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "PROJECT_TYPE",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
    ]);

    const projectName = process.env.PROJECT_NAME.trim();
    const projectType = process.env.PROJECT_TYPE.trim();
    const template = getTemplate(projectType);
    const appFolders = template?.infisicalApps ?? [];

    return {
      projectName,
      appFolders,
      clientId: process.env.INFISICAL_CLIENT_ID.trim(),
      clientSecret: process.env.INFISICAL_CLIENT_SECRET.trim(),
      projectId: process.env.INFISICAL_PROJECT_ID.trim(),
    };
  }
}

class InfisicalSetup extends Infisical {
  /** Environments where the Foundry launch workflow creates the project folder. */
  static ENVIRONMENTS = ["dev", "staging", "prod"];

  /**
   * Logs in and ensures the project folder `/{projectName}` plus a per-app
   * subfolder (e.g. `/{projectName}/web`, `/{projectName}/api`) exists for each
   * configured environment (secrets_setup GitHub job).
   *
   * @param {{
   *   clientId: string;
   *   clientSecret: string;
   *   projectId: string;
   *   projectName: string;
   *   appFolders: string[];
   * }} ctx
   */
  async runFoundryProjectFolders(ctx) {
    const { clientId, clientSecret, projectId, projectName, appFolders } = ctx;

    console.log("Infisical: Exchanging Machine Identity for Access Token...");
    const token = await this.login(clientId, clientSecret);
    const root = Infisical.ROOT_PATH;
    const projectPath = `/${projectName}`;

    for (const environment of InfisicalSetup.ENVIRONMENTS) {
      await this.ensureFolderLogged(token, projectId, environment, root, projectName);

      for (const app of appFolders) {
        await this.ensureFolderLogged(token, projectId, environment, projectPath, app);
      }
    }
  }

  /**
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} parentPath
   * @param {string} folderName
   */
  async ensureFolderLogged(token, projectId, environment, parentPath, folderName) {
    const { created } = await this.ensureChildFolder(
      token,
      projectId,
      environment,
      parentPath,
      folderName,
    );
    const fullPath =
      parentPath === Infisical.ROOT_PATH ? `/${folderName}` : `${parentPath}/${folderName}`;
    console.log(
      created
        ? `Infisical: created folder '${fullPath}' (environment: ${environment}).`
        : `Infisical: folder '${fullPath}' already exists (environment: ${environment}).`,
    );
  }
}

async function main() {
  const preprocessor = new SecretsSetupPreprocessor();
  const { projectName, appFolders, clientId, clientSecret, projectId } = preprocessor.prepare();

  const setup = new InfisicalSetup();
  await setup.runFoundryProjectFolders({
    clientId,
    clientSecret,
    projectId,
    projectName,
    appFolders,
  });
}

module.exports = { main };
