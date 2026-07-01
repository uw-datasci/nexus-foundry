#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const GIT_USER_NAME = "foundry[bot]";
const GIT_USER_EMAIL = "foundry[bot]@users.noreply.github.com";

/**
 * @param {string[]} args
 * @param {string} workdir
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 */
function git(args, workdir, opts = {}) {
  return execFileSync("git", args, { cwd: workdir, ...opts });
}

/**
 * Shallow-clones org/repo into a fresh tmp dir over a token-authenticated
 * remote, sets the foundry[bot] identity, and returns the working copy path.
 *
 * @param {string} org
 * @param {string} repo
 * @param {string} token
 * @returns {string} absolute path to the working copy
 */
function cloneRepo(org, repo, token) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `foundry-${repo}-`));
  const remote = `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
  console.log(`git: cloning ${org}/${repo}…`);
  execFileSync("git", ["clone", "--depth", "1", remote, workdir], {
    stdio: "inherit",
  });
  git(["config", "user.name", GIT_USER_NAME], workdir);
  git(["config", "user.email", GIT_USER_EMAIL], workdir);
  return workdir;
}

/**
 * @param {string} workdir
 * @param {string} branch
 */
function createBranch(workdir, branch) {
  git(["checkout", "-b", branch], workdir, { stdio: "inherit" });
}

/**
 * Stages everything and commits. No-ops (returns false) if nothing changed.
 *
 * @param {string} workdir
 * @param {string} message
 * @returns {boolean} whether a commit was made
 */
function commitAll(workdir, message) {
  git(["add", "-A"], workdir);
  const staged = git(["diff", "--cached", "--name-only"], workdir, {
    encoding: "utf8",
  }).trim();
  if (!staged) {
    console.log("git: no changes to commit.");
    return false;
  }
  git(["commit", "-m", message], workdir, { stdio: "inherit" });
  return true;
}

/**
 * @param {string} workdir
 * @param {string} branch
 * @param {{ force?: boolean }} [opts] Force-push when the branch is recreated
 *   from a moving base each run, e.g. a long-lived bot branch that mirrors an
 *   upstream source rather than accumulating history. Plain `--force` (not
 *   `--force-with-lease`) because these clones never fetch the remote branch
 *   being replaced, so there is no local tracking ref to lease against, and
 *   the branch is exclusively bot-owned.
 */
function pushBranch(workdir, branch, opts = {}) {
  const args = ["push"];
  if (opts.force) args.push("--force");
  args.push("origin", `HEAD:${branch}`);
  git(args, workdir, { stdio: "inherit" });
}

/**
 * Opens a PR via the gh CLI (reads GH_TOKEN from env).
 *
 * @param {string} workdir
 * @param {{
 *   repo: string;
 *   base: string;
 *   head: string;
 *   title: string;
 *   bodyFile: string;
 *   draft?: boolean;
 * }} spec
 * @returns {string} the created PR URL
 */
function openPr(workdir, spec) {
  const args = [
    "pr",
    "create",
    "--repo",
    spec.repo,
    "--base",
    spec.base,
    "--head",
    spec.head,
    "--title",
    spec.title,
    "--body-file",
    spec.bodyFile,
  ];
  if (spec.draft) args.push("--draft");
  const out = execFileSync("gh", args, { cwd: workdir, encoding: "utf8" });
  return out.trim();
}

module.exports = {
  GIT_USER_NAME,
  GIT_USER_EMAIL,
  cloneRepo,
  createBranch,
  commitAll,
  pushBranch,
  openPr,
};
