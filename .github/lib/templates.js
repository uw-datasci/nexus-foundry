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
 *
 * @type {Record<string, TemplateLayout>}
 */
const TEMPLATES = {
  "sample-next-app": {
    appDir: ".",
    configDir: "config",
    pnpmFilter: null,
  },
  "sample-web-api-monorepo": {
    appDir: "apps/web",
    configDir: "apps/web/config",
    pnpmFilter: "web",
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
