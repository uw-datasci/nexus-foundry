#!/usr/bin/env node

class Infisical {
  static API_BASE = "https://us.infisical.com";
  static ROOT_PATH = "/";

  async login(clientId, clientSecret) {
    const res = await fetch(
      `${Infisical.API_BASE}/api/v1/auth/universal-auth/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ clientId, clientSecret }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Infisical Login failed: ${res.status} ${text || res.statusText}`,
      );
    }

    const data = await res.json();
    return data.accessToken;
  }

  /**
   * @param {string} pathnameWithQuery
   * @param {string} token
   * @param {{ method?: string; body?: object }} [options]
   */
  async infisicalRequest(pathnameWithQuery, token, options = {}) {
    const { method = "GET", body } = options;
    const url = `${Infisical.API_BASE}${pathnameWithQuery}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
      const err =
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        (typeof parsed.message === "string" ||
          typeof parsed.message === "object")
          ? JSON.stringify(parsed.message)
          : text || res.statusText;
      throw new Error(
        `Infisical API ${method} ${pathnameWithQuery}: ${res.status} ${err}`,
      );
    }

    return parsed;
  }

  /**
   * @param {unknown} data
   * @returns {{ folders: Array<{ name: string }> }}
   */
  parseFolderList(data) {
    if (
      typeof data === "object" &&
      data !== null &&
      "folders" in data &&
      Array.isArray(data.folders)
    ) {
      return { folders: data.folders };
    }
    return { folders: [] };
  }

  /**
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} folderPath
   */
  async listFoldersAtPath(token, projectId, environment, folderPath) {
    const params = new URLSearchParams({
      projectId,
      environment,
      path: folderPath,
    });
    const data = await this.infisicalRequest(
      `/api/v2/folders?${params.toString()}`,
      token,
    );
    return this.parseFolderList(data);
  }

  /**
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} name
   * @param {string} parentPath
   */
  async createFolder(token, projectId, environment, name, parentPath) {
    return this.infisicalRequest(`/api/v2/folders`, token, {
      method: "POST",
      body: {
        projectId,
        environment,
        name,
        path: parentPath,
      },
    });
  }

  /**
   * Creates a direct child folder under parentPath if it does not already exist.
   *
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} parentPath
   * @param {string} folderName
   * @returns {Promise<{ created: boolean }>}
   */
  async ensureChildFolder(
    token,
    projectId,
    environment,
    parentPath,
    folderName,
  ) {
    const { folders } = await this.listFoldersAtPath(
      token,
      projectId,
      environment,
      parentPath,
    );

    const exists = folders.some((f) => f.name === folderName);
    if (exists) {
      return { created: false };
    }

    await this.createFolder(
      token,
      projectId,
      environment,
      folderName,
      parentPath,
    );
    return { created: true };
  }

  /**
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} secretPath
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async listSecretsAtPath(token, projectId, environment, secretPath) {
    const params = new URLSearchParams({
      projectId,
      environment,
      secretPath,
      viewSecretValue: "false",
    });
    const data = await this.infisicalRequest(
      `/api/v4/secrets?${params.toString()}`,
      token,
    );
    if (
      typeof data === "object" &&
      data !== null &&
      "secrets" in data &&
      Array.isArray(data.secrets)
    ) {
      return data.secrets;
    }
    return [];
  }

  /**
   * @param {string} token
   * @param {string} projectId
   * @param {string} environment
   * @param {string} secretPath
   * @param {string} secretName
   * @param {string} secretValue
   */
  async upsertSecret(
    token,
    projectId,
    environment,
    secretPath,
    secretName,
    secretValue,
  ) {
    const secrets = await this.listSecretsAtPath(
      token,
      projectId,
      environment,
      secretPath,
    );
    const exists = secrets.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        "secretKey" in s &&
        s.secretKey === secretName,
    );
    const path = `/api/v4/secrets/${encodeURIComponent(secretName)}`;
    const body = { projectId, environment, secretPath, secretValue };
    if (exists) {
      await this.infisicalRequest(path, token, { method: "PATCH", body });
    } else {
      await this.infisicalRequest(path, token, { method: "POST", body });
    }
  }

  /**
   * Writes Neon branch URIs as DATABASE_URL under `/{projectName}` (the folder
   * created by the secrets setup job). Dev branch URI → dev and staging; prod
   * branch URI → prod.
   *
   * No-ops when Infisical machine-identity fields are unset.
   *
   * @param {{
   *   clientId?: string;
   *   clientSecret?: string;
   *   projectId?: string;
   *   projectName: string;
   *   devConnectionUri: string;
   *   prodConnectionUri: string;
   * }} opts
   */
  static async pushNeonDatabaseUrls(opts) {
    const clientId = opts.clientId?.trim();
    const clientSecret = opts.clientSecret?.trim();
    const projectId = opts.projectId?.trim();
    if (!clientId || !clientSecret || !projectId) {
      console.log(
        "Infisical: skipping DATABASE_URL push (INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET / INFISICAL_PROJECT_ID not set).",
      );
      return;
    }

    const { projectName, devConnectionUri, prodConnectionUri } = opts;
    const secretPath = projectName.startsWith("/")
      ? projectName
      : `/${projectName}`;

    const infisical = new Infisical();
    const token = await infisical.login(clientId, clientSecret);

    for (const environment of ["dev", "staging"]) {
      await infisical.upsertSecret(
        token,
        projectId,
        environment,
        secretPath,
        "DATABASE_URL",
        devConnectionUri,
      );
      console.log(
        `Infisical: set DATABASE_URL for environment '${environment}' at path '${secretPath}'.`,
      );
    }

    await infisical.upsertSecret(
      token,
      projectId,
      "prod",
      secretPath,
      "DATABASE_URL",
      prodConnectionUri,
    );
    console.log(
      `Infisical: set DATABASE_URL for environment 'prod' at path '${secretPath}'.`,
    );
  }
}

module.exports = { Infisical };
