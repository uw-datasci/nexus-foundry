#!/usr/bin/env node

class GitHubActionsClient {
  static API_BASE = "https://api.github.com";

  /**
   * @param {string} token
   */
  constructor(token) {
    this.token = token;
  }

  /**
   * @param {string} pathnameWithQuery
   * @param {{ method?: string; body?: object }} [options]
   */
  async githubRequest(pathnameWithQuery, options = {}) {
    const { method = "GET", body } = options;
    const url = `${GitHubActionsClient.API_BASE}${pathnameWithQuery}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    /** @type {unknown} */
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      let err = text || res.statusText;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
      ) {
        err = parsed.message;
      }
      const apiError = new Error(
        `GitHub API ${method} ${pathnameWithQuery}: ${res.status} ${err}`,
      );
      Object.assign(apiError, { status: res.status, body: parsed });
      throw apiError;
    }

    return parsed;
  }

  /**
   * @param {string} owner
   * @param {string} repo
   * @param {string} workflowFile e.g. `deploy-api.yml`
   * @returns {Promise<number>}
   */
  async getWorkflowId(owner, repo, workflowFile) {
    const data = await this.githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}`,
    );
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof data.id !== "number"
    ) {
      throw new Error(
        `GitHub Actions: workflow '${workflowFile}' response missing numeric id.`,
      );
    }
    return data.id;
  }

  /**
   * Polls until the latest push-triggered run of a workflow on `branch` completes
   * successfully (e.g. the template's initial GHCR build after repo generation).
   *
   * @param {{
   *   owner: string;
   *   repo: string;
   *   workflowFile?: string;
   *   branch?: string;
   *   timeoutMs?: number;
   *   pollIntervalMs?: number;
   * }} spec
   */
  async waitForWorkflowSuccess(spec) {
    const {
      owner,
      repo,
      workflowFile = "deploy-api.yml",
      branch = "main",
      timeoutMs = 45 * 60 * 1000,
      pollIntervalMs = 15_000,
    } = spec;
    const deadline = Date.now() + timeoutMs;
    /** @type {number | null} */
    let workflowId = null;

    console.log(
      `GitHub Actions: waiting for '${workflowFile}' on ${owner}/${repo} (branch: ${branch})…`,
    );

    while (Date.now() < deadline) {
      if (workflowId === null) {
        try {
          workflowId = await this.getWorkflowId(owner, repo, workflowFile);
          console.log(
            `GitHub Actions: resolved workflow '${workflowFile}' (id: ${workflowId}).`,
          );
        } catch (err) {
          if (err && typeof err === "object" && "status" in err && err.status === 404) {
            console.log(
              `GitHub Actions: workflow '${workflowFile}' not visible yet, retrying…`,
            );
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            continue;
          }
          throw err;
        }
      }

      const q = new URLSearchParams({
        branch,
        event: "push",
        per_page: "5",
      });
      const data = await this.githubRequest(
        `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?${q.toString()}`,
      );
      const runs =
        typeof data === "object" &&
        data !== null &&
        "workflow_runs" in data &&
        Array.isArray(data.workflow_runs)
          ? data.workflow_runs
          : [];

      if (runs.length === 0) {
        console.log(`GitHub Actions: no '${workflowFile}' runs on '${branch}' yet, retrying…`);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      const latest = runs[0];
      const status = typeof latest.status === "string" ? latest.status : "unknown";
      const conclusion = typeof latest.conclusion === "string" ? latest.conclusion : null;
      const runId = typeof latest.id === "number" ? latest.id : "unknown";
      const runUrl = typeof latest.html_url === "string" ? latest.html_url : "";

      if (status === "completed") {
        if (conclusion === "success") {
          console.log(`GitHub Actions: run ${runId} succeeded${runUrl ? ` (${runUrl})` : ""}.`);
          return latest;
        }
        throw new Error(
          `GitHub Actions: run ${runId} finished with conclusion '${conclusion ?? "unknown"}'${runUrl ? ` (${runUrl})` : ""}.`,
        );
      }

      console.log(
        `GitHub Actions: run ${runId} is '${status}'${runUrl ? ` (${runUrl})` : ""}, retrying…`,
      );
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `Timeout waiting for '${workflowFile}' on ${owner}/${repo} after ${timeoutMs}ms.`,
    );
  }
}

module.exports = { GitHubActionsClient };
