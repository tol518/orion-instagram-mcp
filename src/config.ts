import { z } from "zod";
export const permissions = [
  "account.read",
  "media.read",
  "comments.read",
  "messages.read",
  "insights.read",
  "history.read",
  "events.read",
  "comments.write",
  "messages.write",
  "publishing.write",
] as const;
export type Permission = (typeof permissions)[number];
const flag = (fallback: string) =>
  z
    .enum(["true", "false"])
    .default(fallback as "true" | "false")
    .transform((v) => v === "true");
const number = (fallback: number, max = 100000) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
export const envSchema = z.object({
  META_APP_ID: z.string().regex(/^\d+$/),
  META_APP_SECRET: z.string().min(16),
  META_PAGE_ACCESS_TOKEN: z.string().min(16),
  META_PAGE_ID: z.string().regex(/^\d+$/),
  INSTAGRAM_ACCOUNT_ID: z.string().regex(/^\d+$/),
  META_API_VERSION: z.string().regex(/^v\d+\.0$/),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(32),
  INSTAGRAM_MODE: z
    .enum(["READ_ONLY", "APPROVAL_REQUIRED", "AUTONOMOUS_SAFE"])
    .default("APPROVAL_REQUIRED"),
  INSTAGRAM_WRITES_ENABLED: flag("false"),
  DRY_RUN: flag("true"),
  INSTAGRAM_DB: z.string().default("./instagram.sqlite"),
  INSTAGRAM_AGENT_ID: z.string().min(1).default("orion"),
  INSTAGRAM_AGENT_PERMISSIONS: list
    .pipe(z.array(z.enum(permissions)))
    .default(["account.read", "media.read", "comments.read", "history.read"]),
  INSTAGRAM_AUTONOMOUS_ACTIONS: list.pipe(
    z.array(z.enum(["reply_to_comment", "reply_to_message"])),
  ),
  INSTAGRAM_MEDIA_HOSTS: list,
  MAX_ACTIONS_PER_MINUTE: number(10),
  MAX_COMMENTS_PER_HOUR: number(10),
  MAX_DMS_PER_HOUR: number(20),
  MAX_POSTS_PER_DAY: number(3),
  INTERACTION_COOLDOWN_HOURS: number(24, 8760),
  APPROVAL_TTL_MINUTES: number(60, 1440),
  INSTAGRAM_PORT: number(4840, 65535),
  INSTAGRAM_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  INSTAGRAM_OPERATOR_TOKEN: z.string().min(64).optional(),
  INSTAGRAM_BRIDGE_KEYS: z
    .string()
    .default("{}")
    .transform((v, ctx) => {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid bridge key map" });
        return z.NEVER;
      }
    })
    .pipe(
      z.record(
        z.string(),
        z
          .object({
            token: z.string().min(64),
            permissions: z.array(z.enum(permissions)),
          })
          .strict(),
      ),
    ),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid Instagram configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  return result.data;
}
export interface Principal {
  id: string;
  source: "stdio" | "bridge";
  permissions: Permission[];
}
