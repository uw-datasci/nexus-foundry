#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const required = ["TARGET_ORG", "PROJECT_NAME", "PROJECT_TYPE"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const targetOrg = process.env.TARGET_ORG;
const projectName = process.env.PROJECT_NAME;
const projectType = process.env.PROJECT_TYPE;
const description = process.env.DESCRIPTION ?? "";

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
  "private=true",
  "-F",
  "include_all_branches=false",
];

if (description.trim()) {
  args.push("-f", `description=${description}`);
}

execFileSync("gh", args, { stdio: "inherit" });
