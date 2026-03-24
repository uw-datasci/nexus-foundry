#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

event="$GITHUB_EVENT_PATH"

jq_expr() {
  jq -r "$1" "$event"
}

{
  echo "project_name=$(jq_expr '.client_payload.projectName // empty')"
  echo "team_access=$(jq_expr '.client_payload.teamAccess // empty')"
  echo "project_type=$(jq_expr '.client_payload.projectType // empty')"
  echo "database=$(jq_expr '.client_payload.database // empty')"
  echo "postgres_provider=$(jq_expr '.client_payload.postgresProvider // empty')"
  echo "mongo_client=$(jq_expr '.client_payload.mongoClient // empty')"
  echo "redis=$(jq_expr '(.client_payload.extras // {}) | .redis // empty')"
  echo "s3=$(jq_expr '(.client_payload.extras // {}) | .s3 // empty')"
  echo "description=$(jq_expr '.client_payload.description // empty')"
} >>"$GITHUB_OUTPUT"

echo "Project: $(jq_expr '.client_payload.projectName // empty')"
echo "Team: $(jq_expr '.client_payload.teamAccess // empty')"
echo "Template: $(jq_expr '.client_payload.projectType // empty')"
echo "Database: $(jq_expr '.client_payload.database // empty')"
echo "Postgres provider: $(jq_expr '.client_payload.postgresProvider // empty')"
echo "Mongo client: $(jq_expr '.client_payload.mongoClient // empty')"
echo "Redis: $(jq_expr '(.client_payload.extras // {}) | .redis // empty')"
echo "S3: $(jq_expr '(.client_payload.extras // {}) | .s3 // empty')"
echo "Description: $(jq_expr '.client_payload.description // empty')"
