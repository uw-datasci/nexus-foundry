#!/usr/bin/env node

const { Infisical } = require("./infisical.js");

class SecretsSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_PROJECT_ID",
    ]);

    const projectName = process.env.PROJECT_NAME.trim();

    return {
      projectName,
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
   * Logs in and ensures the Foundry project folder exists at workspace root for
   * each configured environment (secrets_setup GitHub job).
   *
   * @param {{
   *   clientId: string;
   *   clientSecret: string;
   *   projectId: string;
   *   projectName: string;
   * }} ctx
   */
  async runFoundryProjectFolders(ctx) {
    const { clientId, clientSecret, projectId, projectName } = ctx;

    console.log("Infisical: Exchanging Machine Identity for Access Token...");
    const token = await this.login(clientId, clientSecret);
    const root = Infisical.ROOT_PATH;

    for (const environment of InfisicalSetup.ENVIRONMENTS) {
      const { created } = await this.ensureChildFolder(
        token,
        projectId,
        environment,
        root,
        projectName,
      );
      if (created) {
        console.log(
          `Infisical: created folder '${projectName}' at root path '${root}' (environment: ${environment}).`,
        );
      } else {
        console.log(
          `Infisical: folder '${projectName}' already exists at path '${root}' (environment: ${environment}).`,
        );
      }
    }
  }
}

async function main() {
  const preprocessor = new SecretsSetupPreprocessor();
  const { projectName, clientId, clientSecret, projectId } =
    preprocessor.prepare();

  const setup = new InfisicalSetup();
  await setup.runFoundryProjectFolders({
    clientId,
    clientSecret,
    projectId,
    projectName,
  });
}

module.exports = { main };
