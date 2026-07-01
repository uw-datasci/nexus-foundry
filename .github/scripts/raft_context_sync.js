#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { cloneRepo, createBranch, commitAll, pushBranch, openPr } = require("../lib/git");

/** Stable, source-scoped branch name — NOT sha-scoped. Re-dispatches force-push
 * this same branch instead of opening a second PR, which is what makes the
 * sync idempotent per consumer. */
const SYNC_BRANCH = "foundry/raft-context-sync";
/** Default location of the consumer repo list, relative to the repo root. */
const DEFAULT_CONSUMERS_FILE = path.join(__dirname, "..", "context", "raft-consumers.json");
/** Matches a bare "owner/repo" slug. */
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** Placeholder marker filtered out of an unpopulated consumer list. */
const PLACEHOLDER_MARKER = "REPLACE-ME";

class RaftContextSyncPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "RAW_URL",
      "SOURCE_SHA",
      "SOURCE_REF",
      "SOURCE_FILE",
      "TARGET_PATH",
      "GH_TOKEN",
    ]);

    const rawUrl = process.env.RAW_URL.trim();
    const { owner, repo } = RaftContextSyncPreprocessor.parseSourceRepo(rawUrl);

    return {
      rawUrl,
      sourceSha: process.env.SOURCE_SHA.trim(),
      sourceRef: process.env.SOURCE_REF.trim(),
      sourceFile: process.env.SOURCE_FILE.trim(),
      targetPath: process.env.TARGET_PATH.trim(),
      token: process.env.GH_TOKEN.trim(),
      sourceOwner: owner,
      sourceRepo: repo,
      consumersFile: (process.env.CONSUMERS_FILE ?? "").trim() || DEFAULT_CONSUMERS_FILE,
    };
  }

  /**
   * Pulls "owner/repo" out of a raw.githubusercontent.com URL
   * (`.../<owner>/<repo>/<sha-or-ref>/<path...>`).
   *
   * @param {string} rawUrl
   * @returns {{ owner: string; repo: string }}
   */
  static parseSourceRepo(rawUrl) {
    const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const [owner, repo] = segments;
    if (!owner || !repo) {
      throw new Error(`could not derive owner/repo from raw_url: ${rawUrl}`);
    }
    return { owner, repo };
  }
}

class RaftContextSync {
  /**
   * @param {ReturnType<RaftContextSyncPreprocessor["prepare"]>} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {string[]} */
    this.failures = [];
  }

  /** @returns {string[]} validated "owner/repo" consumer slugs */
  loadConsumers() {
    const { consumersFile } = this.ctx;
    if (!fs.existsSync(consumersFile)) {
      console.log(`raft-context-sync: no consumers file at ${consumersFile}; nothing to sync.`);
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(consumersFile, "utf8"));
    const repos = Array.isArray(parsed.repos) ? parsed.repos : [];

    const valid = repos.filter(
      (r) => typeof r === "string" && OWNER_REPO_RE.test(r) && !r.includes(PLACEHOLDER_MARKER),
    );

    const skipped = repos.length - valid.length;
    if (skipped > 0) {
      console.log(
        `raft-context-sync: skipped ${skipped} placeholder/invalid entr${skipped === 1 ? "y" : "ies"} in ${consumersFile}.`,
      );
    }
    return valid;
  }

  /** Fetches the synced file's content once, from the source repo. */
  async fetchSourceContent() {
    const { rawUrl, token } = this.ctx;
    const res = await fetch(rawUrl, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "nexus-foundry-raft-context-sync",
      },
    });
    if (!res.ok) {
      throw new Error(`fetching ${rawUrl} failed: ${res.status} ${res.statusText}`);
    }
    const content = await res.text();
    if (!content.trim()) {
      throw new Error(`fetched content from ${rawUrl} was empty; refusing to sync.`);
    }
    return content;
  }

  /**
   * Reads `targetPath` as it exists in the freshly-cloned default branch
   * working copy. Returns `null` if the file doesn't exist there yet.
   *
   * @param {string} workdir
   * @returns {string | null}
   */
  readDefaultBranchContent(workdir) {
    try {
      return fs.readFileSync(path.join(workdir, this.ctx.targetPath), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Reads `targetPath` as it exists on a remote branch, without disturbing
   * the working copy's own checkout. Returns `null` if the branch or file
   * doesn't exist.
   *
   * @param {string} workdir
   * @param {string} branch
   * @returns {string | null}
   */
  readRemoteBranchContent(workdir, branch) {
    try {
      execFileSync("git", ["fetch", "--depth", "1", "origin", branch], {
        cwd: workdir,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return execFileSync("git", ["show", `FETCH_HEAD:${this.ctx.targetPath}`], {
        cwd: workdir,
        encoding: "utf8",
      });
    } catch {
      return null;
    }
  }

  /**
   * @param {string} repoSlug
   * @returns {{ number: number; url: string } | null} the open sync PR, if any
   */
  findOpenPr(repoSlug) {
    const stdout = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repoSlug,
        "--head",
        SYNC_BRANCH,
        "--state",
        "open",
        "--json",
        "number,url",
        "--limit",
        "1",
      ],
      { encoding: "utf8" },
    );
    /** @type {Array<{ number: number; url: string }>} */
    const prs = JSON.parse(stdout || "[]");
    return prs[0] ?? null;
  }

  /**
   * @param {string} workdir
   * @returns {string} path to the written PR body file (untracked)
   */
  writePrBody(workdir) {
    const { sourceOwner, sourceRepo, sourceRef, sourceSha, sourceFile, targetPath } = this.ctx;
    const lines = [
      "Automated context sync — **not** written by a human.",
      "",
      `- Source: \`${sourceOwner}/${sourceRepo}\` @ \`${sourceRef}\` (\`${sourceSha}\`)`,
      `- File: \`${sourceFile}\` → \`${targetPath}\``,
      "",
      "Re-running the sync for the same commit is a no-op; a new upstream commit updates this PR in place.",
    ];
    const bodyPath = path.join(workdir, ".raft-context-sync-pr-body.md");
    fs.writeFileSync(bodyPath, lines.join("\n"));
    return bodyPath;
  }

  /**
   * @param {string} repoSlug
   * @param {string} content
   */
  syncOne(repoSlug, content) {
    const { targetPath, sourceRepo, sourceSha } = this.ctx;
    const shortSha = sourceSha.slice(0, 7);

    const [owner, repo] = repoSlug.split("/");
    const workdir = cloneRepo(owner, repo, this.ctx.token);
    // Cloning checks out the default branch, so its name is the current HEAD —
    // capture it now, before createBranch below moves HEAD to the sync branch.
    const defaultBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workdir,
      encoding: "utf8",
    }).trim();

    const openPrBefore = this.findOpenPr(repoSlug);
    const existing = openPrBefore
      ? this.readRemoteBranchContent(workdir, SYNC_BRANCH)
      : this.readDefaultBranchContent(workdir);

    if (existing !== null && existing === content) {
      console.log(`raft-context-sync: ${repoSlug} already up to date; skipping.`);
      return;
    }

    createBranch(workdir, SYNC_BRANCH);

    const absTargetPath = path.join(workdir, targetPath);
    fs.mkdirSync(path.dirname(absTargetPath), { recursive: true });
    fs.writeFileSync(absTargetPath, content);

    const committed = commitAll(
      workdir,
      `chore: sync raft-reference.md from ${sourceRepo}@${shortSha}`,
    );
    if (!committed) {
      console.log(`raft-context-sync: ${repoSlug} — no diff after write; skipping.`);
      return;
    }

    pushBranch(workdir, SYNC_BRANCH, { force: true });

    if (openPrBefore) {
      console.log(`raft-context-sync: ${repoSlug} — updated existing PR ${openPrBefore.url}.`);
      return;
    }

    const bodyFile = this.writePrBody(workdir);
    const url = openPr(workdir, {
      repo: repoSlug,
      base: defaultBranch,
      head: SYNC_BRANCH,
      title: `chore: sync raft-reference.md from ${sourceRepo}@${shortSha}`,
      bodyFile,
    });
    console.log(`raft-context-sync: ${repoSlug} — opened ${url}.`);
  }

  async run() {
    const consumers = this.loadConsumers();
    if (!consumers.length) {
      console.log("raft-context-sync: no consumers configured; nothing to sync.");
      return;
    }

    const content = await this.fetchSourceContent();
    console.log(
      `raft-context-sync: fetched ${this.ctx.sourceFile} (${content.length} bytes) from ${this.ctx.sourceRepo}@${this.ctx.sourceSha.slice(0, 7)}.`,
    );

    for (const repoSlug of consumers) {
      try {
        this.syncOne(repoSlug, content);
      } catch (err) {
        console.error(`raft-context-sync: ${repoSlug} failed — ${err.message ?? err}`);
        this.failures.push(repoSlug);
      }
    }

    if (this.failures.length) {
      throw new Error(`raft-context-sync: failed for: ${this.failures.join(", ")}`);
    }
  }
}

async function main() {
  const preprocessor = new RaftContextSyncPreprocessor();
  const ctx = preprocessor.prepare();
  const sync = new RaftContextSync(ctx);

  console.log(
    `raft-context-sync: ${ctx.sourceRepo}@${ctx.sourceSha.slice(0, 7)} (${ctx.sourceFile} → ${ctx.targetPath}).`,
  );

  await sync.run();
}

module.exports = { main };
