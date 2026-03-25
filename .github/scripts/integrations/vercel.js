class VercelClient {
  static API_BASE = "https://api.vercel.com";

  /**
   * @param {{ vercelToken: string; vercelTeamId: string }} opts
   */
  constructor(opts) {
    this.vercelToken = opts.vercelToken;
    this.vercelTeamId = opts.vercelTeamId;
  }

  /**
   * @param {string} pathWithQuery
   * @param {{ method?: string; body?: object }} [options]
   */
  async vercelRequest(pathWithQuery, options = {}) {
    const { method = "GET", body } = options;
    const url = `${VercelClient.API_BASE}${pathWithQuery}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.vercelToken}`,
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
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error
      ) {
        const m = parsed.error.message;
        err = typeof m === "string" ? m : JSON.stringify(m);
      }
      const apiError = new Error(
        `Vercel API ${method} ${pathWithQuery}: ${res.status} ${err}`,
      );
      Object.assign(apiError, { status: res.status, body: parsed });
      throw apiError;
    }

    return parsed;
  }

  /**
   * @param {unknown} data
   * @returns {string}
   */
  readVercelProjectId(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "id" in data &&
      typeof data.id === "string"
    ) {
      return data.id;
    }
    throw new Error("Vercel project response missing string id");
  }

  /**
   * @param {string} name
   */
  async getVercelProjectByName(name) {
    const q = new URLSearchParams({ teamId: this.vercelTeamId });
    const data = await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(name)}?${q.toString()}`,
    );
    return this.readVercelProjectId(data);
  }

  /**
   * @param {string} projectName
   * @param {string} githubOrg
   */
  async ensureVercelProject(projectName, githubOrg) {
    const teamQuery = new URLSearchParams({
      teamId: this.vercelTeamId,
    }).toString();

    try {
      const id = await this.getVercelProjectByName(projectName);
      console.log(
        `Vercel: project '${projectName}' already exists (id: ${id}), reusing.`,
      );
      return { id, name: projectName };
    } catch (e) {
      const status =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        typeof e.status === "number"
          ? e.status
          : Number.NaN;
      if (status !== 404) {
        throw e;
      }
    }

    const body = {
      name: projectName,
      gitRepository: {
        type: "github",
        repo: `${githubOrg}/${projectName}`,
      },
    };

    const created = await this.vercelRequest(`/v11/projects?${teamQuery}`, {
      method: "POST",
      body,
    });
    const id = this.readVercelProjectId(created);
    console.log(`Vercel: created project '${projectName}' (id: ${id}).`);
    return { id, name: projectName };
  }

  /**
   * @param {unknown} data
   * @returns {Array<{ name: string }>}
   */
  parseProjectDomains(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "domains" in data &&
      Array.isArray(data.domains)
    ) {
      /** @type {Array<{ name: string }>} */
      const out = [];
      for (const d of data.domains) {
        if (
          typeof d === "object" &&
          d !== null &&
          "name" in d &&
          typeof d.name === "string" &&
          d.name
        ) {
          out.push({ name: d.name });
        }
      }
      return out;
    }
    return [];
  }

  /**
   * @param {string} projectIdOrName
   */
  async listProjectDomains(projectIdOrName) {
    const q = new URLSearchParams({ teamId: this.vercelTeamId });
    const data = await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains?${q.toString()}`,
    );
    return this.parseProjectDomains(data);
  }

  /**
   * @param {string} projectIdOrName
   * @param {string} domainName
   */
  async addProjectDomain(projectIdOrName, domainName) {
    const q = new URLSearchParams({ teamId: this.vercelTeamId });
    await this.vercelRequest(
      `/v10/projects/${encodeURIComponent(projectIdOrName)}/domains?${q.toString()}`,
      { method: "POST", body: { name: domainName } },
    );
  }

  /**
   * @param {string} projectIdOrName
   * @param {string} domainName
   */
  async removeProjectDomain(projectIdOrName, domainName) {
    const q = new URLSearchParams({ teamId: this.vercelTeamId });
    await this.vercelRequest(
      `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domainName)}?${q.toString()}`,
      { method: "DELETE" },
    );
  }

  /**
   * Drops every domain that is not the launch hostname, then adds it if absent.
   * @param {string} projectIdOrName
   * @param {string} canonicalDomain normalized hostname
   */
  async applyLaunchDomain(projectIdOrName, canonicalDomain) {
    const targetLc = canonicalDomain.toLowerCase();
    const attached = await this.listProjectDomains(projectIdOrName);

    for (const d of attached) {
      if (d.name.toLowerCase() === targetLc) continue;
      console.log(`Vercel: removing domain '${d.name}'…`);
      try {
        await this.removeProjectDomain(projectIdOrName, d.name);
      } catch (e) {
        const status =
          typeof e === "object" &&
          e !== null &&
          "status" in e &&
          typeof e.status === "number"
            ? e.status
            : Number.NaN;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `Vercel: could not remove domain '${d.name}' (HTTP ${String(status)}): ${msg}`,
        );
      }
    }

    const after = await this.listProjectDomains(projectIdOrName);
    const hasTarget = after.some((d) => d.name.toLowerCase() === targetLc);
    if (hasTarget) {
      console.log(`Vercel: domain '${canonicalDomain}' is on project.`);
      return;
    }
    console.log(`Vercel: adding domain '${canonicalDomain}'…`);
    await this.addProjectDomain(projectIdOrName, canonicalDomain);
  }
}

module.exports = { VercelClient };
