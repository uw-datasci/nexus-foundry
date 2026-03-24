#!/usr/bin/env node

const INFISICAL_ENVIRONMENT_SLUGS = ["dev", "staging", "prod"];

class SecretsSetupPreprocessor {
  assertRequiredEnv(keys) {
    for (const key of keys) {
      if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
    }
  }

  prepare() {
    this.assertRequiredEnv([
      "PROJECT_NAME",
      "INFISICAL_TOKEN",
      "INFISICAL_PROJECT_ID",
    ]);

    const projectName = process.env.PROJECT_NAME.trim();

    return {
      projectName,
      token: process.env.INFISICAL_TOKEN.trim(),
      projectId: process.env.INFISICAL_PROJECT_ID.trim(),
    };
  }
}

class InfisicalFolderSetup {
  static API_BASE = "https://us.infisical.com";
  static ROOT_PATH = "/";

  /**
   * @param {string} pathnameWithQuery
   * @param {string} token
   * @param {{ method?: string; body?: object }} [options]
   */
  async infisicalRequest(pathnameWithQuery, token, options = {}) {
    const { method = "GET", body } = options;
    const url = `${InfisicalFolderSetup.API_BASE}${pathnameWithQuery}`;

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

  async configureProjectFolder(ctx) {
    const { token, projectId, environment, projectName } = ctx;
    const root = InfisicalFolderSetup.ROOT_PATH;

    const { folders } = await this.listFoldersAtPath(
      token,
      projectId,
      environment,
      root,
    );

    const exists = folders.some((f) => f.name === projectName);
    if (exists) {
      console.log(
        `Infisical: folder '${projectName}' already exists at path '${root}' (environment: ${environment}).`,
      );
      return;
    }

    await this.createFolder(token, projectId, environment, projectName, root);
    console.log(
      `Infisical: created folder '${projectName}' at root path '${root}' (environment: ${environment}).`,
    );
  }
}

async function main() {
  const preprocessor = new SecretsSetupPreprocessor();
  const { projectName, token, projectId } = preprocessor.prepare();

  const infisical = new InfisicalFolderSetup();
  for (const environment of INFISICAL_ENVIRONMENT_SLUGS) {
    await infisical.configureProjectFolder({
      token,
      projectId,
      environment,
      projectName,
    });
  }
}

module.exports = { main };
