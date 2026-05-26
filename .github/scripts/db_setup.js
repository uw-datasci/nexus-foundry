#!/usr/bin/env node

const { provisionNeonProject } = require("../lib/db/neon_setup");
const { SCENARIO_KEYS, deriveScenario } = require("../lib/scenario");
const {
  getInfisicalLayout,
  platformSecretsPath,
  databaseDevSecretsPath,
} = require("../lib/templates");

class DatabaseSetup {
  async neon(projectName, folders) {
    await provisionNeonProject(projectName, folders);
  }

  supabase(projectName) {
    console.log(`Flow: Supabase - provision / configure Supabase for '${projectName}'.`);
  }

  mongodb(projectName) {
    console.log(`Flow: MongoDB - use native driver wiring for '${projectName}'.`);
  }

  mongoose(projectName) {
    console.log(`Flow: Mongoose - use Mongoose ODM wiring for '${projectName}'.`);
  }

  async run(scenario, projectName, folders) {
    if (!SCENARIO_KEYS.has(scenario)) {
      throw new Error(`Unhandled scenario: ${scenario}`);
    }

    await this[scenario](projectName, folders);
  }
}

class DbSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  readDbInputs() {
    return {
      projectName: process.env.PROJECT_NAME.trim(),
      projectType: process.env.PROJECT_TYPE.trim(),
      database: process.env.DATABASE.trim().toLowerCase(),
      postgresProvider: (process.env.POSTGRES_PROVIDER ?? "").trim().toLowerCase(),
      mongoClient: (process.env.MONGO_CLIENT ?? "").trim().toLowerCase(),
    };
  }

  prepare() {
    this.assertRequiredEnv(["DATABASE", "PROJECT_NAME", "PROJECT_TYPE"]);
    const inputs = this.readDbInputs();
    const scenario = deriveScenario(inputs);
    const layout = getInfisicalLayout(inputs.projectType);
    return {
      scenario,
      projectName: inputs.projectName,
      projectType: inputs.projectType,
      folders: {
        prodFolder: layout.platform,
        devFolder: layout.databaseDev ?? layout.platform,
      },
    };
  }
}

async function main() {
  const preprocessor = new DbSetupPreprocessor();
  const setup = new DatabaseSetup();
  const { scenario, projectName, projectType, folders } = preprocessor.prepare();

  const devPath = databaseDevSecretsPath(projectName, projectType);
  const prodPath = platformSecretsPath(projectName, projectType);
  const dest =
    devPath === prodPath
      ? prodPath
      : `dev/staging → ${devPath}, prod → ${prodPath}`;

  console.log(
    `Database setup for project '${projectName}' (scenario: ${scenario}, DATABASE_URL ${dest}).`,
  );

  await setup.run(scenario, projectName, folders);
}

module.exports = { main };
