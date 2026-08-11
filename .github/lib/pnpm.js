#!/usr/bin/env node

/**
 * pnpm 11+ defaults `strictDepBuilds` to true. Template repos may lack
 * `allowBuilds` entries for packages like sharp, causing ERR_PNPM_IGNORED_BUILDS
 * during automated `pnpm add` / `pnpm install` in CI.
 */
const CI_PNPM_ARGS = ["--config.dangerouslyAllowAllBuilds=true"];

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function withCiPnpmConfig(args) {
  return [...args, ...CI_PNPM_ARGS];
}

module.exports = { CI_PNPM_ARGS, withCiPnpmConfig };
