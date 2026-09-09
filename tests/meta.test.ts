import { describe, expect, it, vi } from "vitest";
import { MetaClient } from "../src/meta.js";
import { testConfig } from "./helpers.js";

function response(status: number, value: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers });
}

describe("MetaClient", () => {
  it("uses the configured Graph version and bearer token", async () => {
    const config = testConfig();
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return response(200, { id: "123" });
      },
    );
    const client = new MetaClient(config, fetcher);

    await expect(client.request("123", { fields: "id" })).resolves.toEqual({
      id: "123",
    });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/123?fields=id");
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer ${config.META_PAGE_ACCESS_TOKEN}`,
    });
  });

  it.each([
    [401, { error: { code: 190 } }, "AUTHENTICATION_FAILED"],
    [401, { error: { code: 190, error_subcode: 463 } }, "TOKEN_EXPIRED"],
    [403, { error: { code: 10 } }, "PERMISSION_DENIED"],
    [404, { error: { code: 100 } }, "RESOURCE_NOT_FOUND"],
    [429, { error: { code: 4 } }, "RATE_LIMITED"],
  ])("normalizes HTTP %s as %s", async (status, body, expected) => {
    const client = new MetaClient(
      testConfig(),
      vi.fn(async () => response(Number(status), body)),
    );

    await expect(client.request("123")).rejects.toMatchObject({
      code: expected,
    });
  });

  it("retries temporary reads but never retries writes", async () => {
    const readFetcher = vi
      .fn()
      .mockResolvedValueOnce(response(500, { error: { code: 2 } }))
      .mockResolvedValueOnce(response(500, { error: { code: 2 } }))
      .mockResolvedValueOnce(response(200, { id: "123" }));
    const readClient = new MetaClient(testConfig(), readFetcher);
    await expect(readClient.request("123")).resolves.toEqual({ id: "123" });
    expect(readFetcher).toHaveBeenCalledTimes(3);

    const writeFetcher = vi.fn(async () =>
      response(500, { error: { code: 2 } }),
    );
    const writeClient = new MetaClient(testConfig(), writeFetcher);
    await expect(
      writeClient.request("123/replies", {}, "POST", { message: "Hi" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(writeFetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes transport failures and unreadable responses", async () => {
    const failedRead = new MetaClient(
      testConfig(),
      vi.fn(async () => {
        throw new Error("network details");
      }),
    );
    await expect(failedRead.request("123")).rejects.toMatchObject({
      code: "TEMPORARY_FAILURE",
    });
    await expect(
      failedRead.request("123/replies", {}, "POST", { message: "Hi" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });

    const malformed = new MetaClient(
      testConfig(),
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    await expect(malformed.request("123")).rejects.toMatchObject({
      code: "META_API_ERROR",
    });
  });

  it("does not treat missing webhook-inspection scope as a failure of other capabilities", async () => {
    const config = testConfig();
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const path = String(url);
      if (path.includes("debug_token")) {
        return response(200, {
          data: {
            app_id: config.META_APP_ID,
            is_valid: true,
            scopes: ["instagram_basic", "instagram_content_publish"],
          },
        });
      }
      if (path.includes("subscribed_apps")) {
        return response(403, { error: { code: 10 } });
      }
      return response(200, {
        id: config.META_PAGE_ID,
        name: "Neckermann Travel",
        instagram_business_account: {
          id: config.INSTAGRAM_ACCOUNT_ID,
          username: "neckermann",
        },
      });
    });
    const client = new MetaClient(config, fetcher);

    await expect(client.capabilities()).resolves.toMatchObject({
      publishing: true,
      webhooks: false,
      webhook_subscription_verified: false,
    });
  });
});
