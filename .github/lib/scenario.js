#!/usr/bin/env node

/**
 * Canonical database scenario derivation/validation, shared by config.js,
 * db_setup.js, and codegen.js so the rules live in exactly one place.
 */

const SCENARIO_KEYS = new Set(["neon", "supabase", "mongodb", "mongoose"]);

function assertPostgresInputs({ mongoClient, postgresProvider }) {
  if (mongoClient) {
    throw new Error("MONGO_CLIENT must be empty when DATABASE is postgres");
  }
  if (postgresProvider !== "neon" && postgresProvider !== "supabase") {
    throw new Error(
      "When DATABASE is postgres, POSTGRES_PROVIDER must be neon or supabase",
    );
  }
}

function assertMongoInputs({ postgresProvider, mongoClient }) {
  if (postgresProvider) {
    throw new Error("POSTGRES_PROVIDER must be empty when DATABASE is mongodb");
  }
  if (mongoClient !== "mongodb" && mongoClient !== "mongoose") {
    throw new Error(
      "When DATABASE is mongodb, MONGO_CLIENT must be mongodb or mongoose",
    );
  }
}

/**
 * Validates the database inputs and returns the canonical scenario key.
 *
 * @param {{ database: string; postgresProvider?: string; mongoClient?: string }} inputs
 * @returns {"neon" | "supabase" | "mongodb" | "mongoose"}
 */
function deriveScenario(inputs) {
  const database = (inputs.database ?? "").trim().toLowerCase();
  const postgresProvider = (inputs.postgresProvider ?? "").trim().toLowerCase();
  const mongoClient = (inputs.mongoClient ?? "").trim().toLowerCase();

  if (database === "postgres") {
    assertPostgresInputs({ mongoClient, postgresProvider });
    return postgresProvider;
  }
  if (database === "mongodb") {
    assertMongoInputs({ postgresProvider, mongoClient });
    return mongoClient;
  }
  throw new Error(`DATABASE must be postgres or mongodb, got: ${database}`);
}

module.exports = { SCENARIO_KEYS, deriveScenario };
