class RenderClient {
  static API_BASE = "https://api.render.com";

  /**
   * @param {{ renderApiKey: string }} opts
   */
  constructor(opts) {
    this.renderApiKey = opts.renderApiKey;
  }

  /**
   * @param {string} pathWithQuery
   * @param {{ method?: string; body?: object }} [options]
   */
  async renderRequest(pathWithQuery, options = {}) {
    const { method = "GET", body } = options;
    const url = `${RenderClient.API_BASE}${pathWithQuery}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.renderApiKey}`,
        Accept: "application/json",
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
      const apiError = new Error(`Render API ${method} ${pathWithQuery}: ${res.status} ${err}`);
      Object.assign(apiError, { status: res.status, body: parsed });
      throw apiError;
    }

    return parsed;
  }

  /**
   * Render list endpoints return either a bare array of resources or a cursor
   * wrapper: `[{ <key>: {...}, cursor }]`. Normalize to the unwrapped objects.
   *
   * @param {unknown} data
   * @param {string} key wrapper property name (e.g. "service", "environment")
   * @returns {Array<Record<string, unknown>>}
   */
  unwrapList(data, key) {
    if (!Array.isArray(data)) return [];
    /** @type {Array<Record<string, unknown>>} */
    const out = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const inner =
        key in entry && typeof entry[key] === "object" && entry[key] !== null
          ? entry[key]
          : entry;
      out.push(inner);
    }
    return out;
  }

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  readId(value) {
    if (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string"
    ) {
      return value.id;
    }
    return null;
  }

  /**
   * Resolves the environment id to nest a new service under, given an existing
   * Render Project. Prefers the `production` environment, else the first one.
   *
   * @param {string} projectId
   * @returns {Promise<string>}
   */
  async getProjectEnvironmentId(projectId) {
    const q = new URLSearchParams({ projectId, limit: "100" });
    const data = await this.renderRequest(`/v1/environments?${q.toString()}`);
    const envs = this.unwrapList(data, "environment");
    if (envs.length === 0) {
      throw new Error(`Render: no environments found for project '${projectId}'.`);
    }
    const prod = envs.find((e) => e.name === "production");
    const chosen = prod ?? envs[0];
    const id = this.readId(chosen);
    if (!id) {
      throw new Error(`Render: environment for project '${projectId}' missing string id.`);
    }
    const envLabel = typeof chosen.name === "string" ? chosen.name : id;
    console.log(
      `Render: using environment '${envLabel}' (id: ${id}) of project '${projectId}'.`,
    );
    return id;
  }

  /**
   * Find-or-create a registry credential (e.g. for pulling private GHCR images).
   *
   * @param {{ name: string; ownerId: string; username: string; authToken: string }} spec
   * @returns {Promise<string>} registry credential id (rc-…)
   */
  async ensureRegistryCredential(spec) {
    const q = new URLSearchParams({ ownerId: spec.ownerId, limit: "100" });
    const existingData = await this.renderRequest(`/v1/registrycredentials?${q.toString()}`);
    const existing = this.unwrapList(existingData, "registryCredential");
    const match = existing.find((c) => c.name === spec.name);
    if (match) {
      const id = this.readId(match);
      if (id) {
        console.log(
          `Render: registry credential '${spec.name}' already exists (id: ${id}), reusing.`,
        );
        return id;
      }
    }

    const created = await this.renderRequest(`/v1/registrycredentials`, {
      method: "POST",
      body: {
        name: spec.name,
        ownerId: spec.ownerId,
        registry: "GITHUB",
        username: spec.username,
        authToken: spec.authToken,
      },
    });
    const id = this.readId(created);
    if (!id) {
      throw new Error("Render registry credential response missing string id");
    }
    console.log(`Render: created registry credential '${spec.name}' (id: ${id}).`);
    return id;
  }

  /**
   * @param {string} name
   * @returns {Promise<Record<string, unknown> | null>} service object or null when absent
   */
  async getServiceByName(name) {
    const q = new URLSearchParams({
      name,
      type: "web_service",
      limit: "1",
    });
    const data = await this.renderRequest(`/v1/services?${q.toString()}`);
    const services = this.unwrapList(data, "service");
    return services.find((s) => s.name === name) ?? services[0] ?? null;
  }

  /**
   * Reads the public service URL (e.g. https://my-api.onrender.com) off a
   * service object.
   *
   * @param {unknown} service
   * @returns {string | null}
   */
  readServiceUrl(service) {
    if (typeof service !== "object" || service === null) return null;
    const sd = "serviceDetails" in service ? service.serviceDetails : null;
    if (typeof sd === "object" && sd !== null && "url" in sd && typeof sd.url === "string") {
      return sd.url;
    }
    if ("url" in service && typeof service.url === "string") return service.url;
    return null;
  }

  /**
   * Find-or-create an image-backed web service nested in the given environment.
   *
   * @param {{
   *   name: string;
   *   ownerId: string;
   *   environmentId: string;
   *   imagePath: string;
   *   registryCredentialId: string;
   *   healthCheckPath: string;
   *   plan?: string;
   *   region?: string;
   * }} spec
   * @returns {Promise<{ id: string; url: string | null }>} service id (srv-…) and public URL
   */
  async ensureWebService(spec) {
    const existing = await this.getServiceByName(spec.name);
    if (existing) {
      const existingId = this.readId(existing);
      if (existingId) {
        console.log(
          `Render: web service '${spec.name}' already exists (id: ${existingId}), reusing.`,
        );
        return { id: existingId, url: this.readServiceUrl(existing) };
      }
    }

    const body = {
      type: "web_service",
      name: spec.name,
      ownerId: spec.ownerId,
      environmentId: spec.environmentId,
      autoDeploy: "no",
      image: {
        ownerId: spec.ownerId,
        imagePath: spec.imagePath,
        registryCredentialId: spec.registryCredentialId,
      },
      serviceDetails: {
        runtime: "image",
        plan: spec.plan ?? "free",
        region: spec.region ?? "oregon",
        healthCheckPath: spec.healthCheckPath,
      },
    };

    const created = await this.renderRequest(`/v1/services`, {
      method: "POST",
      body,
    });
    // Create returns either the service object directly or `{ service: {...} }`.
    const service =
      typeof created === "object" &&
      created !== null &&
      "service" in created &&
      typeof created.service === "object" &&
      created.service !== null
        ? created.service
        : created;
    const id = this.readId(service);
    if (!id) {
      throw new Error("Render create service response missing string id");
    }
    console.log(
      `Render: created web service '${spec.name}' (id: ${id}) from '${spec.imagePath}'.`,
    );
    return { id, url: this.readServiceUrl(service) };
  }
}

module.exports = { RenderClient };
