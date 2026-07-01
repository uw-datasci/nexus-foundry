#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { getTemplate } = require("../lib/templates");
const { GIT_USER_NAME, GIT_USER_EMAIL } = require("../lib/git");

const CONSUMERS_FILE = path.join(__dirname, "..", "context", "raft-consumers.json");
const PLACEHOLDER_MARKER = "REPLACE-ME";

const required = ["TARGET_ORG", "PROJECT_NAME", "PROJECT_TYPE"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const targetOrg = process.env.TARGET_ORG;
const projectName = process.env.PROJECT_NAME;
const projectType = process.env.PROJECT_TYPE;

const template = getTemplate(projectType);
if (!template?.usesRaftSdk) {
  console.log(
    `register-raft-consumer: template '${projectType}' does not use the Raft SDK; skipping.`,
  );
  process.exit(0);
}

const repoSlug = `${targetOrg}/${projectName}`;

// This file can be edited by concurrent launches, so re-sync with the tip of
// main (this repo, nexus-foundry's own default branch) right before editing.
execFileSync("git", ["fetch", "origin", "main"], { stdio: "inherit" });
execFileSync("git", ["checkout", "main"], { stdio: "inherit" });
execFileSync("git", ["reset", "--hard", "origin/main"], { stdio: "inherit" });

const parsed = JSON.parse(fs.readFileSync(CONSUMERS_FILE, "utf8"));
const repos = Array.isArray(parsed.repos) ? parsed.repos : [];

if (repos.includes(repoSlug)) {
  console.log(`register-raft-consumer: ${repoSlug} already registered; skipping.`);
  process.exit(0);
}

const cleaned = repos.filter((r) => typeof r !== "string" || !r.includes(PLACEHOLDER_MARKER));
cleaned.push(repoSlug);
parsed.repos = cleaned;

fs.writeFileSync(CONSUMERS_FILE, `${JSON.stringify(parsed, null, 2)}\n`);

execFileSync("git", ["config", "user.name", GIT_USER_NAME], { stdio: "inherit" });
execFileSync("git", ["config", "user.email", GIT_USER_EMAIL], { stdio: "inherit" });
execFileSync("git", ["add", CONSUMERS_FILE], { stdio: "inherit" });
execFileSync(
  "git",
  ["commit", "-m", `chore: register ${repoSlug} as raft-context-sync consumer`],
  { stdio: "inherit" },
);
execFileSync("git", ["push", "origin", "main"], { stdio: "inherit" });

console.log(`register-raft-consumer: registered ${repoSlug}.`);
