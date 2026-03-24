#!/usr/bin/env node

const { provisionNeonProject } = require("./db/neon_setup");

const SCENARIO_KEYS = new Set(["neon", "supabase", "mongodb", "mongoose"]);

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

  assertPostgresInputs({ mongoClient, postgresProvider }) {
    if (mongoClient) {
      throw new Error("MONGO_CLIENT must be empty when DATABASE is postgres");
    }
    if (postgresProvider !== "neon" && postgresProvider !== "supabase") {
      throw new Error(
        "When DATABASE is postgres, POSTGRES_PROVIDER must be neon or supabase",
      );
    }
  }

  assertMongoInputs({ postgresProvider, mongoClient }) {
    if (postgresProvider) {
      throw new Error(
        "POSTGRES_PROVIDER must be empty when DATABASE is mongodb",
      );
    }
    if (mongoClient !== "mongodb" && mongoClient !== "mongoose") {
      throw new Error(
        "When DATABASE is mongodb, MONGO_CLIENT must be mongodb or mongoose",
      );
    }
  }

  validateDbScenarioInputs(inputs) {
    const { database, postgresProvider, mongoClient } = inputs;

    if (database === "postgres") {
      this.assertPostgresInputs({ mongoClient, postgresProvider });
      return postgresProvider;
    }
    if (database === "mongodb") {
      this.assertMongoInputs({ postgresProvider, mongoClient });
      return mongoClient;
    }
    throw new Error(`DATABASE must be postgres or mongodb, got: ${database}`);
  }

  prepare() {
    this.assertRequiredEnv(["DATABASE", "PROJECT_NAME"]);
    const inputs = this.readDbInputs();
    const scenario = this.validateDbScenarioInputs(inputs);
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
