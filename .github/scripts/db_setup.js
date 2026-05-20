#!/usr/bin/env node

const { provisionNeonProject } = require("./db/neon_setup");
const { SCENARIO_KEYS, deriveScenario } = require("../lib/scenario");

class DatabaseSetup {
  async neon(projectName) {
    await provisionNeonProject(projectName);
  }

  supabase(projectName) {
    console.log(
      `Flow: Supabase - provision / configure Supabase for '${projectName}'.`,
    );
  }

  mongodb(projectName) {
    console.log(
      `Flow: MongoDB - use native driver wiring for '${projectName}'.`,
    );
  }

  mongoose(projectName) {
    console.log(
      `Flow: Mongoose - use Mongoose ODM wiring for '${projectName}'.`,
    );
  }

  async run(scenario, projectName) {
    if (!SCENARIO_KEYS.has(scenario)) {
      throw new Error(`Unhandled scenario: ${scenario}`);
    }

    await this[scenario](projectName);
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
      database: process.env.DATABASE.trim().toLowerCase(),
      postgresProvider: (process.env.POSTGRES_PROVIDER ?? "")
        .trim()
        .toLowerCase(),
      mongoClient: (process.env.MONGO_CLIENT ?? "").trim().toLowerCase(),
    };
  }

  prepare() {
    this.assertRequiredEnv(["DATABASE", "PROJECT_NAME"]);
    const inputs = this.readDbInputs();
    const scenario = deriveScenario(inputs);
    return { scenario, projectName: inputs.projectName };
  }
}

async function main() {
  const preprocessor = new DbSetupPreprocessor();
  const setup = new DatabaseSetup();
  const { scenario, projectName } = preprocessor.prepare();

  console.log(
    `Database setup for project '${projectName}' (scenario: ${scenario}).`,
  );

  await setup.run(scenario, projectName);
}

module.exports = { main };
