#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const TEAM_PERMISSIONS = new Set([
  "pull",
  "triage",
  "push",
  "maintain",
  "admin",
]);

const required = ["TARGET_ORG", "PROJECT_NAME", "PROJECT_TYPE"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const targetOrg = process.env.TARGET_ORG;
const projectName = process.env.PROJECT_NAME;
const projectType = process.env.PROJECT_TYPE;
const description = process.env.DESCRIPTION ?? "";
const teamAccess = (process.env.TEAM_ACCESS ?? "").trim();
const teamPermission = (process.env.TEAM_PERMISSION ?? "push")
  .trim()
  .toLowerCase();
if (!TEAM_PERMISSIONS.has(teamPermission)) {
  throw new Error(
    `TEAM_PERMISSION must be one of: ${[...TEAM_PERMISSIONS].join(", ")}`,
  );
}

const [templateOwner, templateRepo] = projectType.includes("/")
  ? projectType.split("/", 2)
  : [targetOrg, projectType];

console.log(
  `Creating repository '${projectName}' in org '${targetOrg}' from template '${templateOwner}/${templateRepo}'.`,
);

const args = [
  "api",
  "-X",
  "POST",
  `repos/${templateOwner}/${templateRepo}/generate`,
  "-f",
  `owner=${targetOrg}`,
  "-f",
  `name=${projectName}`,
  "-F",
  "private=false",
  "-F",
  "include_all_branches=false",
];

if (description.trim()) {
  args.push("-f", `description=${description}`);
}

execFileSync("gh", args, { stdio: "inherit" });

if (teamAccess) {
  console.log(
    `Granting team '${teamAccess}' '${teamPermission}' on '${targetOrg}/${projectName}'.`,
  );
  execFileSync(
    "gh",
    [
      "api",
      "-X",
      "PUT",
      `orgs/${targetOrg}/teams/${teamAccess}/repos/${targetOrg}/${projectName}`,
      "-f",
      `permission=${teamPermission}`,
    ],
    { stdio: "inherit" },
  );
}
