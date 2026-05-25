#!/usr/bin/env node

const crypto = require("node:crypto");

/**
 * Minimal Cloudflare REST client for provisioning R2 storage.
 *
 * Creates buckets and mints bucket-scoped R2 API tokens, then derives the
 * S3-compatible credentials Cloudflare expects:
 *   - Access Key ID     = the API token `id`
 *   - Secret Access Key = SHA-256 hex digest of the API token `value`
 * (see https://developers.cloudflare.com/r2/api/tokens/).
 *
 * Authenticated with an account-owned API token (`CLOUDFLARE_API_TOKEN`) that
 * holds "Workers R2 Storage" edit (bucket create) and "Account API Tokens" edit
 * (mint scoped tokens / list permission groups).
 */
class CloudflareClient {
  static API_BASE = "https://api.cloudflare.com/client/v4";

  /** Default jurisdiction segment in a bucket resource key. */
  static DEFAULT_JURISDICTION = "default";

  /** Cloudflare error code returned when a bucket you own already exists. */
  static BUCKET_EXISTS_CODE = 10004;

  /**
   * @param {{ apiToken: string; accountId: string }} ctx
   */
  constructor(ctx) {
    this.apiToken = ctx.apiToken;
    this.accountId = ctx.accountId;
  }

  /**
   * @param {string} path
   * @param {{ method?: string; body?: object }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async cfRequest(path, options = {}) {
    const { method = "GET", body } = options;
    const url = `${CloudflareClient.API_BASE}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    /** @type {Record<string, unknown>} */
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok || parsed.success === false) {
      const errs = Array.isArray(parsed.errors)
        ? JSON.stringify(parsed.errors)
        : text || res.statusText;
      const err = new Error(`Cloudflare API ${method} ${path}: ${res.status} ${errs}`);
      // Attach structured errors so callers (e.g. ensureBucket) can inspect codes.
      err.cfErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
      throw err;
    }

    return parsed;
  }

  /**
   * Creates an R2 bucket, treating an already-owned bucket as success.
   *
   * @param {string} name
   */
  async ensureBucket(name) {
    try {
      await this.cfRequest(`/accounts/${this.accountId}/r2/buckets`, {
        method: "POST",
        body: { name },
      });
      console.log(`Cloudflare: created R2 bucket '${name}'.`);
    } catch (error) {
      const codes = Array.isArray(error?.cfErrors) ? error.cfErrors.map((e) => e.code) : [];
      const alreadyExists =
        codes.includes(CloudflareClient.BUCKET_EXISTS_CODE) ||
        /already exists/i.test(error?.message ?? "");
      if (!alreadyExists) throw error;
      console.log(`Cloudflare: R2 bucket '${name}' already exists, skip.`);
    }
  }

  /**
   * Lists every account-token permission group (paginated).
   *
   * @returns {Promise<Array<{ id: string; name: string }>>}
   */
  async listPermissionGroups() {
    /** @type {Array<{ id: string; name: string }>} */
    const all = [];
    const perPage = 100;
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
      const data = await this.cfRequest(
        `/accounts/${this.accountId}/tokens/permission_groups?${params.toString()}`,
      );
      const result = Array.isArray(data.result) ? data.result : [];
      all.push(...result);
      if (result.length < perPage) break;
    }
    return all;
  }

  /**
   * Resolves the read + write R2 bucket-item permission group ids by name.
   * Names are cosmetic but stable enough to look up; ids are not hard-coded
   * because Cloudflare does not guarantee them.
   *
   * @returns {Promise<{ read: string; write: string }>}
   */
  async resolveR2PermissionGroupIds() {
    const groups = await this.listPermissionGroups();
    const findId = (name) => {
      const group = groups.find((g) => g.name === name);
      if (!group) throw new Error(`Cloudflare: permission group '${name}' not found`);
      return group.id;
    };
    return {
      read: findId("Workers R2 Storage Bucket Item Read"),
      write: findId("Workers R2 Storage Bucket Item Write"),
    };
  }

  /**
   * Mints an account-owned API token scoped to a single R2 bucket and derives
   * the S3 Access Key ID / Secret Access Key from the response.
   *
   * @param {{
   *   name: string;
   *   bucketName: string;
   *   permissionGroupIds: { read: string; write: string };
   * }} spec
   * @returns {Promise<{ accessKeyId: string; secretAccessKey: string }>}
   */
  async createScopedR2Token(spec) {
    const { name, bucketName, permissionGroupIds } = spec;
    const resourceKey = `com.cloudflare.edge.r2.bucket.${this.accountId}_${CloudflareClient.DEFAULT_JURISDICTION}_${bucketName}`;

    const body = {
      name,
      policies: [
        {
          effect: "allow",
          resources: { [resourceKey]: "*" },
          permission_groups: [
            { id: permissionGroupIds.read },
            { id: permissionGroupIds.write },
          ],
        },
      ],
    };

    const data = await this.cfRequest(`/accounts/${this.accountId}/tokens`, {
      method: "POST",
      body,
    });

    const result = data.result;
    const id =
      typeof result === "object" && result !== null && typeof result.id === "string"
        ? result.id
        : null;
    const value =
      typeof result === "object" && result !== null && typeof result.value === "string"
        ? result.value
        : null;
    if (!id || !value) {
      throw new Error("Cloudflare create token response missing result.id / result.value");
    }

    return {
      accessKeyId: id,
      secretAccessKey: crypto.createHash("sha256").update(value).digest("hex"),
    };
  }
}

module.exports = { CloudflareClient };
