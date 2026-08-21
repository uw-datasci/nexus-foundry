#!/usr/bin/env node

/**
 * @typedef {Object} InfisicalLayout
 * @property {string[]} subfolders  Folders under `/{projectName}` (`[]` = none).
 * @property {string | null} platform  Prod DB / S3 / Redis → `/{projectName}` or `/{projectName}/{platform}`.
 * @property {string | null} [databaseDev]  Dev/staging `DATABASE_URL` folder; defaults to `platform`.
 * @property {string | null} apiUrl  `API_URL` folder; `null` = not pushed by Foundry.
 * @property {string | null} vercelSync  Infisical → Vercel sync source folder.
 * @property {string | null} renderSync  Infisical → Render sync source folder.
 */

/**
 * Per-template layout. Static config differs by where each template keeps
 * its app package and `config/` directory.
 *
 * @typedef {Object} TemplateLayout
 * @property {string} appDir
 * @property {string} configDir
 * @property {string | null} pnpmFilter
 * @property {boolean} [hasApi]
 * @property {string} [apiDir]
 * @property {string} [apiHealthCheckPath]
 * @property {number} [apiPort]
 * @property {string | null} [apiPnpmFilter]
 * @property {boolean} [usesRaftSdk]  Whether generated repos consume the Raft SDK and
 *   should be auto-registered in `.github/context/raft-consumers.json`.
 * @property {InfisicalLayout} infisical
 *
 * @type {Record<string, TemplateLayout>}
 */
const TEMPLATES = {
  "sample-next-app": {
    appDir: ".",
    configDir: "config",
    pnpmFilter: null,
    hasApi: false,
    usesRaftSdk: true,
    infisical: {
      subfolders: [],
      platform: null,
      apiUrl: null,
      vercelSync: null,
      renderSync: null,
    },
  },
  "sample-web-api-monorepo": {
    appDir: "apps/web",
    configDir: "apps/web/config",
    pnpmFilter: "web",
    hasApi: true,
    apiDir: "apps/api",
    apiHealthCheckPath: "/health",
    apiPort: 8000,
    apiPnpmFilter: "api",
    usesRaftSdk: true,
    infisical: {
      subfolders: ["web", "api", "db"],
      platform: "api",
      databaseDev: "db",
      apiUrl: "web",
      vercelSync: "web",
      renderSync: "api",
    },
  },
};

/** @type {InfisicalLayout} */
const DEFAULT_INFISICAL = {
  subfolders: ["web"],
  platform: "web",
  apiUrl: null,
  vercelSync: "web",
  renderSync: null,
};

/**
 * @param {string} projectName
 * @param {string | null | undefined} folder
 * @returns {string}
 */
function infisicalPath(projectName, folder) {
  const base = projectName.startsWith("/") ? projectName : `/${projectName}`;
  if (!folder) return base;
  return `${base}/${folder}`;
}

/**
 * @param {string} projectType
 * @returns {InfisicalLayout}
 */
function getInfisicalLayout(projectType) {
  return getTemplate(projectType)?.infisical ?? DEFAULT_INFISICAL;
}

/**
 * @param {string} projectName
 * @param {string} projectType
 * @returns {string}
 */
function platformSecretsPath(projectName, projectType) {
  return infisicalPath(projectName, getInfisicalLayout(projectType).platform);
}

/**
 * @param {string} projectName
 * @param {string} projectType
 * @returns {string}
 */
function databaseDevSecretsPath(projectName, projectType) {
  const layout = getInfisicalLayout(projectType);
  const folder = layout.databaseDev ?? layout.platform;
  return infisicalPath(projectName, folder);
}

/**
 * @param {string} projectName
 * @param {string} projectType
 * @returns {string | null}
 */
function apiUrlSecretsPath(projectName, projectType) {
  const folder = getInfisicalLayout(projectType).apiUrl;
  if (!folder) return null;
  return infisicalPath(projectName, folder);
}

/**
 * @param {string} projectName
 * @param {string} projectType
 * @returns {string}
 */
function vercelSyncPath(projectName, projectType) {
  return infisicalPath(projectName, getInfisicalLayout(projectType).vercelSync);
}

/**
 * @param {string} projectName
 * @param {string} projectType
 * @returns {string | null}
 */
function renderSyncPath(projectName, projectType) {
  const folder = getInfisicalLayout(projectType).renderSync;
  if (!folder) return null;
  return infisicalPath(projectName, folder);
}

/**
 * @param {string} projectType
 * @returns {TemplateLayout | null}
 */
function getTemplate(projectType) {
  return TEMPLATES[projectType] ?? null;
}

/**
 * Vercel project settings applied when Foundry creates a linked project.
 *
 * @param {string} projectType
 * @returns {{ framework: "nextjs"; rootDirectory?: string }}
 */
function getVercelProjectCreateOptions(projectType) {
  const appDir = getTemplate(projectType)?.appDir;
  const opts = { framework: "nextjs" };
  if (appDir && appDir !== ".") {
    opts.rootDirectory = appDir;
  }
  return opts;
}

module.exports = {
  TEMPLATES,
  getTemplate,
  getInfisicalLayout,
  infisicalPath,
  platformSecretsPath,
  databaseDevSecretsPath,
  apiUrlSecretsPath,
  vercelSyncPath,
  renderSyncPath,
  getVercelProjectCreateOptions,
};
