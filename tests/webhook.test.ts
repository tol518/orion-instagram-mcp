import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { receiveWebhook, validSignature } from "../src/webhook.js";
import { createHarness } from "./helpers.js";

const openStores: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe("Meta webhooks", () => {
  it("compares the SHA-256 signature over the exact request bytes", () => {
    const body = Buffer.from('{"object":"instagram","entry":[]}');
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(validSignature(body, signature, secret)).toBe(true);
    expect(validSignature(Buffer.from("changed"), signature, secret)).toBe(
      false,
    );
  });

  it("records inbound eligibility from authenticated messages and comments", async () => {
    const { config, service, store } = createHarness();
    openStores.push(store);
    const now = Date.now();
    const payload = {
      object: "instagram",
      entry: [
        {
          id: config.INSTAGRAM_ACCOUNT_ID,
          time: Math.floor(now / 1000),
          messaging: [
            {
              sender: { id: "111" },
              recipient: { id: config.INSTAGRAM_ACCOUNT_ID },
              timestamp: now,
              message: { mid: "message-1" },
            },
            {
              sender: { id: config.INSTAGRAM_ACCOUNT_ID },
              recipient: { id: "111" },
              timestamp: now,
              message: { mid: "message-echo", is_echo: true },
            },
            {
              sender: { id: "222" },
              recipient: { id: config.INSTAGRAM_ACCOUNT_ID },
              timestamp: now,
              message: { mid: "message-deleted", is_deleted: true },
            },
          ],
          changes: [
            {
              field: "comments",
              value: {
                id: "123",
                from: { id: "111" },
                media: { id: "888" },
                created_time: Math.floor(now / 1000),
              },
            },
          ],
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", config.META_APP_SECRET).update(raw).digest("hex")}`;

    await expect(receiveWebhook(service, raw, signature)).resolves.toEqual({
      received: true,
    });
    expect(
      await store.db.selectFrom("inbound").selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await store.db.selectFrom("inbound_comments").selectAll().execute(),
    ).toMatchObject([
      {
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "123",
        sender: "111",
      },
    ]);
    expect(
      await store.db.selectFrom("events").selectAll().execute(),
    ).toHaveLength(2);
  });
});
