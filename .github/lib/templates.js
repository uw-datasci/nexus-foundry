#!/usr/bin/env node

/**
 * Per-template layout. Static config and codegen both differ by where each
 * template keeps its app package and `config/` directory. Single source of
 * truth shared by config.js and codegen.js.
 *
 * @typedef {Object} TemplateLayout
 * @property {string} appDir        Repo-relative path to the app package root.
 * @property {string} configDir     Path to the app's `config/` directory.
 * @property {string | null} pnpmFilter  pnpm `--filter` for the app workspace, or null.
 * @property {boolean} [hasApi]     Whether the template ships a deployable API server (gates render_setup).
 * @property {string} [apiDir]      Repo-relative path to the API package root.
 * @property {string} [apiHealthCheckPath]  HTTP health check path for the API (Render).
 * @property {number} [apiPort]     Port the API server listens on inside the container.
 * @property {string[]} infisicalApps  Per-app secret subfolders created under `/{projectName}` (e.g. ["web", "api"]).
 * @property {string} dbSecretApp   Which `infisicalApps` subfolder receives `DATABASE_URL`.
 *
 * @type {Record<string, TemplateLayout>}
 */
const TEMPLATES = {
  "sample-next-app": {
    appDir: ".",
    configDir: "config",
    pnpmFilter: null,
    hasApi: false,
    infisicalApps: ["web"],
    dbSecretApp: "web",
  },
  "sample-web-api-monorepo": {
    appDir: "apps/web",
    configDir: "apps/web/config",
    pnpmFilter: "web",
    hasApi: true,
    apiDir: "apps/api",
    apiHealthCheckPath: "/health",
    apiPort: 8000,
    infisicalApps: ["web", "api"],
    dbSecretApp: "api",
  },
};

/**
 * @param {string} projectType
 * @returns {TemplateLayout | null}
 */
function getTemplate(projectType) {
  return TEMPLATES[projectType] ?? null;
}

module.exports = { TEMPLATES, getTemplate };
