import { z } from "zod";
import type { Config } from "./config.js";
import { InstagramError } from "./errors.js";
const graphError = z.object({
  error: z.object({
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});
const object = z.record(z.string(), z.unknown());
export class MetaClient {
  private blockedUntil = 0;
  constructor(
    readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    params: Record<string, string> = {},
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (Date.now() < this.blockedUntil)
      throw new InstagramError(
        "RATE_LIMITED",
        "Meta cooldown is active.",
        Math.ceil((this.blockedUntil - Date.now()) / 1000),
      );
    const url = new URL(
      `https://graph.facebook.com/${this.config.META_API_VERSION}/${path}`,
    );
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    // Retry reads only. A timeout after POST may mean Meta accepted the action.
    // Repeating a write would defeat the durable idempotency ledger.
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      const usesJson = path.endsWith("/messages");
      const encodedBody = body
        ? usesJson
          ? JSON.stringify(body)
          : new URLSearchParams(
              Object.entries(body).map(([key, value]) => [key, String(value)]),
            )
        : undefined;
      try {
        response = await this.fetcher(url, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${this.config.META_PAGE_ACCESS_TOKEN}`,
            ...(body
              ? {
                  "Content-Type": usesJson
                    ? "application/json"
                    : "application/x-www-form-urlencoded",
                }
              : {}),
          },
          ...(encodedBody ? { body: encodedBody } : {}),
        });
      } catch {
        throw new InstagramError(
          method === "GET" ? "TEMPORARY_FAILURE" : "OUTCOME_UNKNOWN",
          "Meta request did not complete. Do not repeat a mutation with a new idempotency key.",
        );
      }
      let value: unknown;
      try {
        const raw = await response.text();
        if (raw.length > 2_000_000) throw new Error();
        value = JSON.parse(raw);
      } catch {
        throw new InstagramError(
          method === "GET" ? "META_API_ERROR" : "OUTCOME_UNKNOWN",
          "Meta returned an unreadable response.",
        );
      }
      const err = graphError.safeParse(value);
      const code = err.success ? err.data.error.code : undefined;
      if (response.ok && !err.success) {
        const parsed = object.safeParse(value);
        if (!parsed.success)
          throw new InstagramError(
            "META_API_ERROR",
            "Unexpected Meta response.",
          );
        return parsed.data;
      }
      if (code === 4 && err.success && err.data.error.error_subcode === 2207051)
        throw new InstagramError(
          "POLICY_BLOCKED",
          "Meta blocked this action as suspected spam. Operator review is required.",
        );
      if (response.status === 429 || [4, 9, 17, 341].includes(code ?? 0)) {
        const retry = response.headers.get("retry-after");
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.max(1, (Date.parse(retry) - Date.now()) / 1000)
              : 60;
        this.blockedUntil =
          Date.now() +
          Math.min(
            86400,
            Math.max(1, Number.isFinite(seconds) ? seconds : 60),
          ) *
            1000;
        throw new InstagramError(
          "RATE_LIMITED",
          "Meta rate limit reached.",
          Math.ceil((this.blockedUntil - Date.now()) / 1000),
        );
      }
      if (code === 190 || response.status === 401)
        throw new InstagramError(
          err.success && err.data.error.error_subcode === 463
            ? "TOKEN_EXPIRED"
            : "AUTHENTICATION_FAILED",
          "Reconnect the Instagram account.",
        );
      if (response.status === 403 || code === 10 || code === 200)
        throw new InstagramError(
          "PERMISSION_DENIED",
          "Meta denied this operation. Check granted permissions and app access.",
        );
      if (response.status === 404)
        throw new InstagramError(
          "RESOURCE_NOT_FOUND",
          "Instagram resource was not found.",
        );
      if (response.status >= 500 && method === "GET" && attempt < 2) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        continue;
      }
      throw new InstagramError(
        response.status >= 500
          ? method === "GET"
            ? "TEMPORARY_FAILURE"
            : "OUTCOME_UNKNOWN"
          : "META_API_ERROR",
        "Meta rejected the operation. Check the requested resource and account capability.",
      );
    }
    throw new InstagramError(
      "TEMPORARY_FAILURE",
      "Meta read retry limit reached.",
    );
  }
  async account() {
    const result = await this.request(this.config.META_PAGE_ID, {
      fields: "id,name,instagram_business_account{id,username}",
    });
    const account = accountSchema.parse(result);
    if (
      account.id !== this.config.META_PAGE_ID ||
      account.instagram_business_account.id !== this.config.INSTAGRAM_ACCOUNT_ID
    )
      throw new InstagramError(
        "AUTHENTICATION_FAILED",
        "The Page token is not linked to the configured Instagram professional account.",
      );
    return {
      id: account.instagram_business_account.id,
      username: account.instagram_business_account.username,
      page_id: account.id,
      page_name: account.name,
    };
  }
  async auth() {
    const [account, token] = await Promise.all([
      this.account(),
      this.debugToken(),
    ]);
    return {
      authenticated: true,
      account_id: account.id,
      page_id: account.page_id,
      username: account.username,
      permissions: token.scopes,
      permissions_source: "Meta debug_token",
      expires_at: token.expires_at
        ? new Date(token.expires_at * 1000).toISOString()
        : null,
      data_access_expires_at: token.data_access_expires_at
        ? new Date(token.data_access_expires_at * 1000).toISOString()
        : null,
    };
  }
  async capabilities() {
    const [auth, webhookFields] = await Promise.all([
      this.auth(),
      this.subscribedFields(),
    ]);
    const has = (scope: string) => auth.permissions.includes(scope);
    return {
      messaging: has("instagram_manage_messages"),
      privateReplies:
        has("instagram_manage_comments") && has("pages_messaging"),
      commentManagement: has("instagram_manage_comments"),
      publishing: has("instagram_content_publish"),
      insights: has("instagram_manage_insights"),
      webhooks: webhookFields.length > 0,
      permissions: auth.permissions,
      permissions_source: auth.permissions_source,
      webhook_subscription_verified: webhookFields.length > 0,
      webhook_fields: webhookFields,
    };
  }
  private async debugToken() {
    const url = new URL(
      `https://graph.facebook.com/${this.config.META_API_VERSION}/debug_token`,
    );
    url.searchParams.set("input_token", this.config.META_PAGE_ACCESS_TOKEN);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.config.META_APP_ID}|${this.config.META_APP_SECRET}`,
        },
      });
    } catch {
      throw new InstagramError(
        "TEMPORARY_FAILURE",
        "Meta token validation did not complete.",
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new InstagramError(
        "AUTHENTICATION_FAILED",
        "Meta returned an unreadable token status.",
      );
    }
    const parsed = debugSchema.safeParse(value);
    if (
      !response.ok ||
      !parsed.success ||
      !parsed.data.data.is_valid ||
      parsed.data.data.app_id !== this.config.META_APP_ID
    )
      throw new InstagramError(
        parsed.success &&
          parsed.data.data.expires_at &&
          parsed.data.data.expires_at * 1000 <= Date.now()
          ? "TOKEN_EXPIRED"
          : "AUTHENTICATION_FAILED",
        "The Page access token is invalid for this Meta app.",
      );
    return parsed.data.data;
  }
  private async subscribedFields() {
    try {
      const result = subscriptionSchema.parse(
        await this.request(`${this.config.META_PAGE_ID}/subscribed_apps`),
      );
      return (
        result.data.find((app) => app.id === this.config.META_APP_ID)
          ?.subscribed_fields ?? []
      );
    } catch (error) {
      // Webhook inspection needs pages_manage_metadata. Missing that optional
      // scope must report webhooks=false without disabling unrelated writes.
      if (
        error instanceof InstagramError &&
        error.code === "PERMISSION_DENIED"
      ) {
        return [];
      }
      throw error;
    }
  }
  async ownedMedia(mediaId: string) {
    const media = mediaSchema.parse(
      await this.request(mediaId, { fields: "id,owner,permalink,media_type" }),
    );
    if (media.owner.id !== this.config.INSTAGRAM_ACCOUNT_ID)
      throw new InstagramError(
        "PERMISSION_DENIED",
        "Only media owned by the connected account is supported.",
      );
    return media;
  }
  async ownedComment(commentId: string) {
    const comment = commentSchema.parse(
      await this.request(commentId, { fields: "id,media,from,text" }),
    );
    const media = await this.ownedMedia(comment.media.id);
    return { comment, media };
  }
}
const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  instagram_business_account: z.object({
    id: z.string(),
    username: z.string(),
  }),
});
const debugSchema = z.object({
  data: z.object({
    app_id: z.string(),
    is_valid: z.boolean(),
    scopes: z.array(z.string()).default([]),
    expires_at: z.number().optional(),
    data_access_expires_at: z.number().optional(),
  }),
});
const subscriptionSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      subscribed_fields: z.array(z.string()).optional(),
    }),
  ),
});
export const mediaSchema = z.object({
  id: z.string(),
  owner: z.object({ id: z.string() }),
  permalink: z.string().url(),
  media_type: z.string(),
});
const commentSchema = z.object({
  id: z.string(),
  media: z.object({ id: z.string() }),
  from: z
    .object({ id: z.string(), username: z.string().optional() })
    .optional(),
  text: z.string().optional(),
});
// Strip paging URLs because Meta may include access_token in next/previous links.
export function pageResult(result: Record<string, unknown>) {
  const parsed = z
    .object({
      data: z.array(z.unknown()),
      paging: z
        .object({
          cursors: z.object({ after: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .parse(result);
  return {
    data: parsed.data.slice(0, 50),
    after: parsed.paging?.cursors?.after ?? null,
  };
}
