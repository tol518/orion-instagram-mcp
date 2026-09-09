import { z } from "zod";
export const id = z.string().regex(/^\d{1,40}$/);
export const opaqueId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_:=+-]+$/);
export const text = z.string().trim().min(1).max(1000);
export const page = {
  limit: z.number().int().min(1).max(50).default(20),
  after: z.string().max(1024).optional(),
};
export const localPage = {
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(1000000).default(0),
};
const key = {
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[\w-]+$/),
};
const asset = z.string().url().max(2048);
const caption = z.string().trim().max(2200).default("");
export const actions = {
  reply_to_comment: z
    .object({ comment_id: id, message: text, ...key })
    .strict(),
  hide_comment: z.object({ comment_id: id, ...key }).strict(),
  unhide_comment: z.object({ comment_id: id, ...key }).strict(),
  delete_comment: z.object({ comment_id: id, ...key }).strict(),
  reply_to_message: z
    .object({ recipient_id: id, message: text, ...key })
    .strict(),
  private_reply_to_comment: z
    .object({ comment_id: id, message: text, ...key })
    .strict(),
  publish_image: z.object({ image_url: asset, caption, ...key }).strict(),
  publish_reel: z.object({ video_url: asset, caption, ...key }).strict(),
  publish_carousel: z
    .object({
      items: z
        .array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("IMAGE"), url: asset }).strict(),
            z.object({ type: z.literal("VIDEO"), url: asset }).strict(),
          ]),
        )
        .min(2)
        .max(10),
      caption,
      ...key,
    })
    .strict(),
};
export type Action = keyof typeof actions;
export type ActionInput = z.infer<(typeof actions)[Action]>;
export const actionPermission = (action: Action) =>
  action === "private_reply_to_comment" || action === "reply_to_message"
    ? "messages.write"
    : action.includes("comment")
      ? "comments.write"
      : "publishing.write";
