import { afterEach, describe, expect, it } from "vitest";
import { InstagramError } from "../src/errors.js";
import { createHarness, principal } from "./helpers.js";

const openStores: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe("InstagramService policy boundary", () => {
  it("requires an authenticated recent comment before proposing a private reply", async () => {
    const { service, store, request } = createHarness();
    openStores.push(store);

    const result = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "123", message: "Thanks", idempotency_key: "reply-123" },
      principal,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "UNSOLICITED_MESSAGE_NOT_SUPPORTED" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("queues one private reply and sends it through the Page messages edge after approval", async () => {
    const { config, service, store, request } = createHarness();
    openStores.push(store);
    await store.db
      .insertInto("inbound_comments")
      .values({
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "123",
        sender: "111",
        media_id: "888",
        timestamp: Date.now(),
        used_at: null,
        reserved_action_id: null,
      })
      .execute();

    const proposed = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "123", message: "Thanks", idempotency_key: "reply-123" },
      principal,
    );
    expect(proposed).toMatchObject({
      success: false,
      status: "pending",
      error: { code: "APPROVAL_REQUIRED" },
    });
    const reserved = await store.db
      .selectFrom("inbound_comments")
      .select("reserved_action_id")
      .where("account", "=", config.INSTAGRAM_ACCOUNT_ID)
      .where("comment_id", "=", "123")
      .executeTakeFirstOrThrow();
    expect(reserved.reserved_action_id).toBe(proposed.action_id);

    const conflicting = await service.mutate(
      "private_reply_to_comment",
      {
        comment_id: "123",
        message: "A different reply",
        idempotency_key: "reply-456",
      },
      principal,
    );
    expect(conflicting).toMatchObject({
      success: false,
      error: { code: "DUPLICATE_ACTION" },
    });

    const repeated = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "123", message: "Thanks", idempotency_key: "reply-123" },
      principal,
    );
    expect(repeated).toEqual(proposed);

    const approved = await service.approve(String(proposed.action_id));
    expect(approved).toMatchObject({ success: true, instagram_id: "999" });
    expect(request).toHaveBeenCalledWith(
      `${config.META_PAGE_ID}/messages`,
      {},
      "POST",
      {
        recipient: { comment_id: "123" },
        message: { text: "Thanks" },
      },
    );
    const inbound = await store.db
      .selectFrom("inbound_comments")
      .select("used_at")
      .where("account", "=", config.INSTAGRAM_ACCOUNT_ID)
      .where("comment_id", "=", "123")
      .executeTakeFirstOrThrow();
    expect(inbound.used_at).toBeTypeOf("number");
  });

  it("does not allow an ordinary DM without a recent inbound message", async () => {
    const { service, store, request } = createHarness({
      INSTAGRAM_MODE: "AUTONOMOUS_SAFE",
      INSTAGRAM_AUTONOMOUS_ACTIONS: ["reply_to_message"],
    });
    openStores.push(store);

    const blocked = await service.mutate(
      "reply_to_message",
      { recipient_id: "111", message: "Hello", idempotency_key: "dm-11111" },
      principal,
    );
    expect(blocked).toMatchObject({
      success: false,
      error: { code: "UNSOLICITED_MESSAGE_NOT_SUPPORTED" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("releases an unused private-reply reservation when the operator rejects it", async () => {
    const { config, service, store } = createHarness();
    openStores.push(store);
    await store.db
      .insertInto("inbound_comments")
      .values({
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "321",
        sender: "111",
        media_id: "888",
        timestamp: Date.now(),
        used_at: null,
        reserved_action_id: null,
      })
      .execute();
    const proposed = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "321", message: "Thanks", idempotency_key: "reply-321" },
      principal,
    );

    await service.reject(String(proposed.action_id));

    const inbound = await store.db
      .selectFrom("inbound_comments")
      .select(["used_at", "reserved_action_id"])
      .where("account", "=", config.INSTAGRAM_ACCOUNT_ID)
      .where("comment_id", "=", "321")
      .executeTakeFirstOrThrow();
    expect(inbound).toEqual({ used_at: null, reserved_action_id: null });

    const repeated = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "321", message: "Thanks", idempotency_key: "reply-321" },
      principal,
    );
    expect(repeated).toEqual({
      success: false,
      action_id: proposed.action_id,
      status: "rejected",
      error: {
        code: "ACTION_TERMINAL",
        message: "Action is already recorded; do not repeat it with a new key.",
      },
    });
  });

  it("retains the private-reply reservation when Meta's outcome is uncertain", async () => {
    const { config, service, store, request } = createHarness();
    openStores.push(store);
    await store.db
      .insertInto("inbound_comments")
      .values({
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "654",
        sender: "111",
        media_id: "888",
        timestamp: Date.now(),
        used_at: null,
        reserved_action_id: null,
      })
      .execute();
    const proposed = await service.mutate(
      "private_reply_to_comment",
      { comment_id: "654", message: "Thanks", idempotency_key: "reply-654" },
      principal,
    );
    request.mockRejectedValueOnce(
      new InstagramError("OUTCOME_UNKNOWN", "Request outcome is unknown"),
    );

    const result = await service.approve(String(proposed.action_id));

    expect(result).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
    const inbound = await store.db
      .selectFrom("inbound_comments")
      .select(["used_at", "reserved_action_id"])
      .where("account", "=", config.INSTAGRAM_ACCOUNT_ID)
      .where("comment_id", "=", "654")
      .executeTakeFirstOrThrow();
    expect(inbound).toEqual({
      used_at: null,
      reserved_action_id: proposed.action_id,
    });
  });

  it("rejects publishing URLs outside the operator allowlist", async () => {
    const { service, store, request } = createHarness();
    openStores.push(store);

    const result = await service.mutate(
      "publish_image",
      {
        image_url: "https://untrusted.example/image.jpg",
        caption: "Offer",
        idempotency_key: "post-1234",
      },
      principal,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("detects duplicate publications independently of the idempotency value", async () => {
    const { service, store } = createHarness();
    openStores.push(store);

    const first = await service.mutate(
      "publish_image",
      {
        image_url: "https://media.example.com/offer.jpg",
        caption: "Offer promo-one",
        idempotency_key: "promo-one",
      },
      principal,
    );
    expect(first).toMatchObject({ error: { code: "APPROVAL_REQUIRED" } });

    const duplicate = await service.mutate(
      "publish_image",
      {
        image_url: "https://media.example.com/offer.jpg",
        caption: "Offer promo-one",
        idempotency_key: "promo-two",
      },
      principal,
    );
    expect(duplicate).toMatchObject({ error: { code: "DUPLICATE_ACTION" } });
  });

  it("revalidates an approval against the proposing credential source", async () => {
    const { config, service, store } = createHarness();
    openStores.push(store);
    const proposed = await service.mutate(
      "reply_to_comment",
      {
        comment_id: "123",
        message: "Thank you",
        idempotency_key: "source-check",
      },
      principal,
    );
    delete config.INSTAGRAM_BRIDGE_KEYS.orion;

    await expect(
      service.approve(String(proposed.action_id)),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("counts failed Meta write attempts toward local rate limits", async () => {
    const { service, store, request } = createHarness({
      INSTAGRAM_MODE: "AUTONOMOUS_SAFE",
      INSTAGRAM_AUTONOMOUS_ACTIONS: ["reply_to_comment"],
      MAX_ACTIONS_PER_MINUTE: 1,
    });
    openStores.push(store);
    request.mockRejectedValueOnce(
      new InstagramError("META_REJECTED", "Meta rejected the request"),
    );

    const failed = await service.mutate(
      "reply_to_comment",
      {
        comment_id: "123",
        message: "First reply",
        idempotency_key: "failed-attempt",
      },
      principal,
    );
    const limited = await service.mutate(
      "reply_to_comment",
      {
        comment_id: "124",
        message: "Second reply",
        idempotency_key: "next-attempt",
      },
      principal,
    );

    expect(failed).toMatchObject({ error: { code: "META_REJECTED" } });
    expect(limited).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("expires a pending private reply and releases its reservation", async () => {
    const { config, service, store } = createHarness();
    openStores.push(store);
    await store.db
      .insertInto("inbound_comments")
      .values({
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "777",
        sender: "111",
        media_id: "888",
        timestamp: Date.now(),
        used_at: null,
        reserved_action_id: null,
      })
      .execute();
    const first = await service.mutate(
      "private_reply_to_comment",
      {
        comment_id: "777",
        message: "First",
        idempotency_key: "expiring-reply",
      },
      principal,
    );
    await store.db
      .updateTable("actions")
      .set({ expires_at: Date.now() - 1 })
      .where("id", "=", String(first.action_id))
      .execute();

    const replacement = await service.mutate(
      "private_reply_to_comment",
      {
        comment_id: "777",
        message: "Replacement",
        idempotency_key: "replacement-reply",
      },
      principal,
    );

    expect(replacement).toMatchObject({
      status: "pending",
      error: { code: "APPROVAL_REQUIRED" },
    });
    const old = await store.db
      .selectFrom("actions")
      .select("status")
      .where("id", "=", String(first.action_id))
      .executeTakeFirstOrThrow();
    const inbound = await store.db
      .selectFrom("inbound_comments")
      .select("reserved_action_id")
      .where("account", "=", config.INSTAGRAM_ACCOUNT_ID)
      .where("comment_id", "=", "777")
      .executeTakeFirstOrThrow();
    expect(old.status).toBe("expired");
    expect(inbound.reserved_action_id).toBe(replacement.action_id);
  });

  it("returns the recorded action for concurrent idempotent requests", async () => {
    const { service, store, capabilities } = createHarness();
    openStores.push(store);
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    capabilities.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
      return {
        messaging: true,
        privateReplies: true,
        commentManagement: true,
        publishing: true,
        insights: true,
        webhooks: true,
      };
    });
    const input = {
      image_url: "https://media.example.com/concurrent.jpg",
      caption: "Concurrent",
      idempotency_key: "concurrent-publish",
    };

    const [first, second] = await Promise.all([
      service.mutate("publish_image", input, principal),
      service.mutate("publish_image", input, principal),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "pending",
      error: { code: "APPROVAL_REQUIRED" },
    });
    const actions = await store.db.selectFrom("actions").select("id").execute();
    expect(actions).toHaveLength(1);
  });

  it("returns the recorded result when a concurrent replay later fails preflight", async () => {
    const { config, service, store, ownedComment } = createHarness();
    openStores.push(store);
    await store.db
      .insertInto("inbound_comments")
      .values({
        account: config.INSTAGRAM_ACCOUNT_ID,
        comment_id: "909",
        sender: "111",
        media_id: "888",
        timestamp: Date.now(),
        used_at: null,
        reserved_action_id: null,
      })
      .execute();
    let invocation = 0;
    let firstReachedPreflight!: () => void;
    const firstAtPreflight = new Promise<void>((resolve) => {
      firstReachedPreflight = resolve;
    });
    let bothReachedPreflight!: () => void;
    const bothAtPreflight = new Promise<void>((resolve) => {
      bothReachedPreflight = resolve;
    });
    let releaseSecond!: () => void;
    const secondMayContinue = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    ownedComment.mockImplementation(async (commentId) => {
      invocation += 1;
      if (invocation === 1) {
        firstReachedPreflight();
        await bothAtPreflight;
      } else if (invocation === 2) {
        bothReachedPreflight();
        await secondMayContinue;
      }
      return {
        comment: {
          id: commentId,
          media: { id: "888" },
          from: { id: "111", username: "traveler" },
        },
        media: {
          id: "888",
          owner: { id: config.INSTAGRAM_ACCOUNT_ID },
          permalink: "https://www.instagram.com/p/example/",
          media_type: "IMAGE",
        },
      };
    });
    const input = {
      comment_id: "909",
      message: "Thanks",
      idempotency_key: "private-concurrent",
    };

    const firstPromise = service.mutate(
      "private_reply_to_comment",
      input,
      principal,
    );
    await firstAtPreflight;
    const replayPromise = service.mutate(
      "private_reply_to_comment",
      input,
      principal,
    );
    const first = await firstPromise;
    const approved = await service.approve(String(first.action_id));
    releaseSecond();
    const replay = await replayPromise;

    expect(replay).toEqual(approved);
  });

  it("does not record comment moderation as customer contact", async () => {
    const { service, store } = createHarness();
    openStores.push(store);
    const proposed = await service.mutate(
      "hide_comment",
      { comment_id: "123", idempotency_key: "hide-comment" },
      principal,
    );

    await service.approve(String(proposed.action_id));

    const accounts = await store.db
      .selectFrom("accounts")
      .selectAll()
      .execute();
    expect(accounts).toEqual([]);
  });
});
