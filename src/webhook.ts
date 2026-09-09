import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { requireCondition } from "./errors.js";
import type { InstagramService } from "./service.js";
const envelope = z.object({
  object: z.literal("instagram"),
  entry: z
    .array(
      z.object({
        id: z.string(),
        time: z.number().optional(),
        messaging: z
          .array(
            z
              .object({
                sender: z.object({ id: z.string() }),
                recipient: z.object({ id: z.string() }),
                timestamp: z.number(),
                message: z
                  .object({
                    mid: z.string(),
                    is_echo: z.boolean().optional(),
                    is_self: z.boolean().optional(),
                    is_deleted: z.boolean().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          )
          .max(100)
          .optional(),
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.record(z.string(), z.unknown()),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .max(100),
});
export function validSignature(
  raw: Buffer,
  signature: unknown,
  secret: string,
) {
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  return timingSafeEqual(
    createHmac("sha256", secret).update(raw).digest(),
    Buffer.from(signature.slice(7), "hex"),
  );
}
export async function receiveWebhook(
  service: InstagramService,
  raw: Buffer,
  signature: unknown,
) {
  requireCondition(
    validSignature(raw, signature, service.config.META_APP_SECRET),
    "INVALID_SIGNATURE",
    "Webhook signature is invalid.",
  );
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    requireCondition(false, "INVALID_REQUEST", "Invalid webhook JSON.");
  }
  const parsed = envelope.safeParse(value);
  requireCondition(
    parsed.success,
    "INVALID_REQUEST",
    "Unsupported webhook envelope.",
  );
  await service.store.atomic(async (db) => {
    for (const entry of parsed.data.entry) {
      if (entry.id !== service.config.INSTAGRAM_ACCOUNT_ID) continue;
      for (const event of entry.messaging ?? []) {
        if (
          !event.message ||
          event.message.is_echo ||
          event.message.is_self ||
          event.message.is_deleted ||
          event.recipient.id !== entry.id ||
          event.sender.id === entry.id ||
          event.timestamp > Date.now()
        )
          continue;
        const eventId = `message:${entry.id}:${event.message.mid}`;
        const inserted = await db
          .insertInto("events")
          .values({
            id: eventId,
            account: entry.id,
            kind: "message",
            sender: event.sender.id,
            target: entry.id,
            timestamp: event.timestamp,
          })
          .onConflict((c) => c.column("id").doNothing())
          .executeTakeFirst();
        if (inserted.numInsertedOrUpdatedRows === 0n) continue;
        const old = await db
          .selectFrom("inbound")
          .select("timestamp")
          .where("account", "=", entry.id)
          .where("sender", "=", event.sender.id)
          .executeTakeFirst();
        if (!old || event.timestamp > old.timestamp)
          await db
            .insertInto("inbound")
            .values({
              account: entry.id,
              sender: event.sender.id,
              timestamp: event.timestamp,
            })
            .onConflict((c) =>
              c
                .columns(["account", "sender"])
                .doUpdateSet({ timestamp: event.timestamp }),
            )
            .execute();
      }
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments") continue;
        const comment = z
          .object({
            id: z.string(),
            from: z.object({ id: z.string() }).optional(),
            media: z.object({ id: z.string() }).optional(),
            created_time: z.number().optional(),
          })
          .safeParse(change.value);
        if (!comment.success) continue;
        const receivedAt = entry.time ? entry.time * 1000 : Date.now();
        const timestamp = comment.data.created_time
          ? comment.data.created_time * 1000
          : receivedAt;
        if (timestamp > Date.now()) continue;
        const eventId = `comment:${entry.id}:${createHash("sha256").update(JSON.stringify(change.value)).digest("hex")}`;
        const inserted = await db
          .insertInto("events")
          .values({
            id: eventId,
            account: entry.id,
            kind: "comment",
            sender: comment.data.from?.id ?? null,
            target: comment.data.media?.id ?? comment.data.id,
            timestamp,
          })
          .onConflict((c) => c.column("id").doNothing())
          .executeTakeFirst();
        if (inserted.numInsertedOrUpdatedRows === 0n) continue;
        await db
          .insertInto("inbound_comments")
          .values({
            account: entry.id,
            comment_id: comment.data.id,
            sender: comment.data.from?.id ?? null,
            media_id: comment.data.media?.id ?? null,
            timestamp,
            used_at: null,
            reserved_action_id: null,
          })
          .onConflict((c) => c.columns(["account", "comment_id"]).doNothing())
          .execute();
      }
    }
  });
  return { received: true };
}
