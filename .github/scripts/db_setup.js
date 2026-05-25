#!/usr/bin/env node

const { provisionNeonProject } = require("../lib/db/neon_setup");
const { SCENARIO_KEYS, deriveScenario } = require("../lib/scenario");
const { getTemplate } = require("../lib/templates");

class DatabaseSetup {
  async neon(projectName, dbSecretApp) {
    await provisionNeonProject(projectName, dbSecretApp);
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

  async run(scenario, projectName, dbSecretApp) {
    if (!SCENARIO_KEYS.has(scenario)) {
      throw new Error(`Unhandled scenario: ${scenario}`);
    }

    await this[scenario](projectName, dbSecretApp);
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
    const template = getTemplate(inputs.projectType);
    const dbSecretApp = template?.dbSecretApp ?? (template?.hasApi ? "api" : "web");
    return { scenario, projectName: inputs.projectName, dbSecretApp };
  }
}

async function main() {
  const preprocessor = new DbSetupPreprocessor();
  const setup = new DatabaseSetup();
  const { scenario, projectName, dbSecretApp } = preprocessor.prepare();

  console.log(
    `Database setup for project '${projectName}' (scenario: ${scenario}, DATABASE_URL → /${projectName}/${dbSecretApp}).`,
  );

  await setup.run(scenario, projectName, dbSecretApp);
}

module.exports = { main };
