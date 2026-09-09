import { afterEach, describe, expect, it } from "vitest";
import { createHttp } from "../src/http.js";
import { createHarness } from "./helpers.js";

const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("HTTP boundaries", () => {
  it("binds bridge credentials to the configured principal", async () => {
    const { service, store } = createHarness();
    const app = createHttp(service);
    resources.push(app, store);

    const response = await app.inject({
      method: "POST",
      url: "/tools/instagram_get_pending_actions",
      headers: {
        authorization: `Bearer ${"b".repeat(64)}`,
        "content-type": "application/json",
      },
      payload: { limit: 20, offset: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });

  it("keeps operator approvals behind a separate credential", async () => {
    const { service, store } = createHarness();
    const app = createHttp(service);
    resources.push(app, store);

    const response = await app.inject({
      method: "GET",
      url: "/operator/pending",
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
