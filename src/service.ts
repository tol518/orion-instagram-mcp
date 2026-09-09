import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import type { Config, Principal } from "./config.js";
import {
  actions,
  actionPermission,
  type Action,
  type ActionInput,
} from "./schemas.js";
import { InstagramError, requireCondition, safeError } from "./errors.js";
import { MetaClient } from "./meta.js";
import { Store, type ActionRow, type DbConnection } from "./store.js";
export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
}
type Context = {
  target: string;
  user?: string;
  username?: string;
  media?: string;
  permalink?: string;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const contactActions = new Set<Action>([
  "reply_to_comment",
  "private_reply_to_comment",
  "reply_to_message",
]);
export class InstagramService {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly meta: MetaClient,
    readonly logger: Logger,
  ) {}
  async policy(action: Action, principal: Principal): Promise<PolicyDecision> {
    const reasons: string[] = [];
    if (
      !this.config.INSTAGRAM_WRITES_ENABLED ||
      (await this.store.writesBlocked())
    )
      reasons.push("WRITES_DISABLED");
    if (this.config.INSTAGRAM_MODE === "READ_ONLY") reasons.push("READ_ONLY");
    if (!principal.permissions.includes(actionPermission(action)))
      reasons.push("PERMISSION_DENIED");
    return {
      allowed: reasons.length === 0,
      requiresApproval:
        this.config.INSTAGRAM_MODE !== "AUTONOMOUS_SAFE" ||
        !this.config.INSTAGRAM_AUTONOMOUS_ACTIONS.includes(
          action as "reply_to_comment" | "reply_to_message",
        ),
      reasons,
    };
  }
  private async context(action: Action, input: ActionInput): Promise<Context> {
    if ("comment_id" in input) {
      const { comment, media } = await this.meta.ownedComment(input.comment_id);
      if (action === "private_reply_to_comment") {
        const inbound = await this.store.db
          .selectFrom("inbound_comments")
          .selectAll()
          .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
          .where("comment_id", "=", input.comment_id)
          .executeTakeFirst();
        requireCondition(
          inbound &&
            inbound.timestamp <= Date.now() &&
            Date.now() - inbound.timestamp < 7 * 86400000 &&
            !inbound.used_at,
          "UNSOLICITED_MESSAGE_NOT_SUPPORTED",
          "A verified, unused comment webhook from the last seven days is required for a private reply.",
        );
      }
      return {
        target: input.comment_id,
        user: comment.from?.id,
        username: comment.from?.username,
        media: media.id,
        permalink: media.permalink,
      };
    }
    if ("recipient_id" in input) {
      const event = await this.store.db
        .selectFrom("inbound")
        .selectAll()
        .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
        .where("sender", "=", input.recipient_id)
        .executeTakeFirst();
      requireCondition(
        event &&
          event.timestamp <= Date.now() &&
          Date.now() - event.timestamp < 24 * 3600000,
        "UNSOLICITED_MESSAGE_NOT_SUPPORTED",
        "A verified inbound message within the last 24 hours is required.",
      );
      return { target: input.recipient_id, user: input.recipient_id };
    }
    const urls =
      "items" in input
        ? input.items.map((i) => i.url)
        : "image_url" in input
          ? [input.image_url]
          : "video_url" in input
            ? [input.video_url]
            : [];
    for (const address of urls) {
      const url = new URL(address);
      requireCondition(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          this.config.INSTAGRAM_MEDIA_HOSTS.includes(url.hostname),
        "INVALID_REQUEST",
        "Media must use HTTPS on an operator-approved public media host.",
      );
    }
    return { target: this.config.INSTAGRAM_ACCOUNT_ID };
  }
  private async checkCapability(action: Action) {
    const c = await this.meta.capabilities();
    const enabled =
      action === "private_reply_to_comment"
        ? c.privateReplies
        : actionPermission(action) === "comments.write"
          ? c.commentManagement
          : actionPermission(action) === "messages.write"
            ? c.messaging
            : c.publishing;
    requireCondition(
      enabled,
      "PERMISSION_DENIED",
      "The connected Page token has not granted the required Meta permission.",
    );
  }
  private findIdempotentAction(
    db: DbConnection,
    principal: Principal,
    idempotencyKey: string,
  ) {
    return db
      .selectFrom("actions")
      .selectAll()
      .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
      .where("principal", "=", principal.id)
      .where("principal_source", "=", principal.source)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
  }
  async mutate(action: Action, raw: unknown, principal: Principal) {
    const actionId = randomUUID();
    const start = Date.now();
    let target = "unvalidated";
    let request: { idempotencyKey: string; serialized: string } | undefined;
    try {
      const parsed = actions[action].safeParse(raw);
      requireCondition(
        parsed.success,
        "INVALID_REQUEST",
        "Tool arguments do not match the action schema.",
      );
      const input = parsed.data;
      const serialized = JSON.stringify(input);
      request = {
        idempotencyKey: input.idempotency_key,
        serialized,
      };
      const decision = await this.policy(action, principal);
      requireCondition(
        decision.allowed,
        decision.reasons[0] ?? "POLICY_BLOCKED",
        "Instagram writes are blocked by deterministic policy.",
      );
      const existing = await this.findIdempotentAction(
        this.store.db,
        principal,
        input.idempotency_key,
      );
      if (existing) {
        requireCondition(
          existing.action === action && existing.payload === serialized,
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key is already bound to another request.",
        );
        return this.result(existing);
      }
      await this.checkCapability(action);
      const ctx = await this.context(action, input);
      target = ctx.target;
      const fingerprintInput = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "idempotency_key"),
      );
      const normalized =
        "message" in input
          ? input.message.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")
          : JSON.stringify(fingerprintInput);
      const fingerprint = digest(
        `${this.config.INSTAGRAM_ACCOUNT_ID}:${action}:${ctx.target}:${normalized}`,
      );
      const row: ActionRow = {
        id: actionId,
        account: this.config.INSTAGRAM_ACCOUNT_ID,
        principal: principal.id,
        principal_source: principal.source,
        action,
        target,
        fingerprint,
        idempotency_key: input.idempotency_key,
        payload: serialized,
        status: decision.requiresApproval ? "pending" : "executing",
        created_at: Date.now(),
        expires_at: Date.now() + this.config.APPROVAL_TTL_MINUTES * 60000,
        result: null,
        error: null,
      };
      const concurrent = await this.store.atomic(async (db) => {
        await this.expirePending(db, Date.now());
        const recorded = await this.findIdempotentAction(
          db,
          principal,
          row.idempotency_key,
        );
        if (recorded) {
          requireCondition(
            recorded.action === action && recorded.payload === serialized,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key is already bound to another request.",
          );
          return recorded;
        }
        await this.safeguards(db, row, ctx, !this.config.DRY_RUN);
        if (!this.config.DRY_RUN)
          await db.insertInto("actions").values(row).execute();
        return undefined;
      });
      if (concurrent) return this.result(concurrent);
      if (this.config.DRY_RUN) {
        await this.audit(
          actionId,
          principal.id,
          action,
          target,
          "allowed",
          "dry_run",
          start,
        );
        return {
          success: true,
          dry_run: true,
          would_execute: true,
          requires_approval: decision.requiresApproval,
          action,
          payload_preview: input,
        };
      }
      if (decision.requiresApproval) {
        await this.audit(
          actionId,
          principal.id,
          action,
          target,
          "approval_required",
          "pending",
          start,
        );
        return this.result(row);
      }
      return await this.execute(row, input, ctx, principal);
    } catch (error) {
      if (request) {
        const recorded = await this.findIdempotentAction(
          this.store.db,
          principal,
          request.idempotencyKey,
        );
        if (
          recorded &&
          recorded.action === action &&
          recorded.payload === request.serialized
        )
          return this.result(recorded);
      }
      await this.audit(
        actionId,
        principal.id,
        action,
        target,
        "blocked",
        "failed",
        start,
        error,
      );
      return { ...safeError(error), action_id: actionId };
    }
  }
  private async safeguards(
    db: DbConnection,
    row: ActionRow,
    ctx: Context,
    reserve: boolean,
  ) {
    const now = Date.now();
    const active = db
      .selectFrom("actions")
      .selectAll()
      .where("account", "=", row.account)
      .where("id", "!=", row.id)
      .where("status", "in", [
        "pending",
        "executing",
        "succeeded",
        "uncertain",
      ]);
    const same = await active
      .where("fingerprint", "=", row.fingerprint)
      .where((eb) =>
        eb.or([
          eb(
            "created_at",
            ">",
            now - this.config.INTERACTION_COOLDOWN_HOURS * 3600000,
          ),
          eb("status", "in", ["executing", "uncertain"]),
        ]),
      )
      .executeTakeFirst();
    requireCondition(
      !same,
      "DUPLICATE_ACTION",
      "An equivalent action was already reserved or performed.",
    );
    if (row.action === "reply_to_comment") {
      const posts = ctx.media
        ? await db
            .selectFrom("commented_posts")
            .select("id")
            .where("account", "=", row.account)
            .where("instagram_media_id", "=", ctx.media)
            .where(
              "commented_at",
              ">",
              now - this.config.INTERACTION_COOLDOWN_HOURS * 3600000,
            )
            .executeTakeFirst()
        : undefined;
      const account = ctx.user
        ? await db
            .selectFrom("accounts")
            .select("id")
            .where("account", "=", row.account)
            .where("instagram_user_id", "=", ctx.user)
            .where(
              "last_contacted_at",
              ">",
              now - this.config.INTERACTION_COOLDOWN_HOURS * 3600000,
            )
            .executeTakeFirst()
        : undefined;
      requireCondition(
        !posts && !account,
        "DUPLICATE_ACTION",
        "Account or post interaction cooldown is active.",
      );
      // Reserve across different comments on the same post/account, including pending
      // approvals. JSON context is server-derived and never supplied by the model.
      const recent = await active
        .where("action", "=", "reply_to_comment")
        .where(
          "created_at",
          ">",
          now - this.config.INTERACTION_COOLDOWN_HOURS * 3600000,
        )
        .execute();
      for (const other of recent) {
        const context = other.result
          ? (JSON.parse(other.result) as Context)
          : null;
        requireCondition(
          !(
            context &&
            (context.media === ctx.media ||
              (ctx.user && context.user === ctx.user))
          ),
          "DUPLICATE_ACTION",
          "A reply for this account or post is already reserved.",
        );
      }
    }
    const attempts = db
      .selectFrom("actions")
      .selectAll()
      .where("account", "=", row.account)
      .where("id", "!=", row.id);
    const perMinute = await attempts
      .where("created_at", ">", now - 60000)
      .execute();
    requireCondition(
      perMinute.length < this.config.MAX_ACTIONS_PER_MINUTE,
      "RATE_LIMITED",
      "Local global action limit reached.",
    );
    const family = actionPermission(row.action as Action);
    const window = family === "publishing.write" ? 86400000 : 3600000;
    const recent = await attempts
      .where("created_at", ">", now - window)
      .execute();
    const count = recent.filter(
      (r) => actionPermission(r.action as Action) === family,
    ).length;
    const max =
      family === "comments.write"
        ? this.config.MAX_COMMENTS_PER_HOUR
        : family === "messages.write"
          ? this.config.MAX_DMS_PER_HOUR
          : this.config.MAX_POSTS_PER_DAY;
    requireCondition(
      count < max,
      "RATE_LIMITED",
      "Local action-family limit reached.",
    );
    if (reserve && row.action === "private_reply_to_comment") {
      const reservation = await db
        .updateTable("inbound_comments")
        .set({ reserved_action_id: row.id })
        .where("account", "=", row.account)
        .where("comment_id", "=", row.target)
        .where("used_at", "is", null)
        .where((eb) =>
          eb.or([
            eb("reserved_action_id", "is", null),
            eb("reserved_action_id", "=", row.id),
          ]),
        )
        .executeTakeFirst();
      requireCondition(
        reservation.numUpdatedRows === 1n,
        "DUPLICATE_ACTION",
        "This comment already has a reserved private reply.",
      );
    }
    row.result = JSON.stringify(ctx);
  }
  private async expirePending(db: DbConnection, now: number) {
    const expired = await db
      .selectFrom("actions")
      .select(["id", "account", "action", "target"])
      .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
      .where("status", "=", "pending")
      .where("expires_at", "<=", now)
      .execute();
    for (const row of expired) {
      const changed = await db
        .updateTable("actions")
        .set({ status: "expired", result: null, error: "APPROVAL_EXPIRED" })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .where("expires_at", "<=", now)
        .executeTakeFirst();
      if (
        changed.numUpdatedRows === 1n &&
        row.action === "private_reply_to_comment"
      ) {
        await db
          .updateTable("inbound_comments")
          .set({ reserved_action_id: null })
          .where("account", "=", row.account)
          .where("comment_id", "=", row.target)
          .where("reserved_action_id", "=", row.id)
          .where("used_at", "is", null)
          .execute();
      }
    }
  }
  async cleanupExpiredActions() {
    await this.store.atomic((db) => this.expirePending(db, Date.now()));
  }
  async approve(actionId: string) {
    const row = await this.store.atomic(async (db) => {
      await this.expirePending(db, Date.now());
      return db
        .selectFrom("actions")
        .selectAll()
        .where("id", "=", actionId)
        .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
        .executeTakeFirst();
    });
    requireCondition(row, "INVALID_REQUEST", "Action does not exist.");
    requireCondition(
      row.status !== "expired",
      "APPROVAL_EXPIRED",
      "This proposal has expired.",
    );
    requireCondition(
      row.status === "pending",
      "INVALID_REQUEST",
      "Only a pending action can be approved.",
    );
    // Operator approval cannot grant permissions revoked since proposal creation.
    const permissions =
      row.principal_source === "bridge"
        ? (this.config.INSTAGRAM_BRIDGE_KEYS[row.principal]?.permissions ?? [])
        : row.principal === this.config.INSTAGRAM_AGENT_ID
          ? this.config.INSTAGRAM_AGENT_PERMISSIONS
          : [];
    const principal: Principal = {
      id: row.principal,
      source: row.principal_source,
      permissions,
    };
    const action = z
      .enum(Object.keys(actions) as [Action, ...Action[]])
      .parse(row.action);
    const input = actions[action].parse(JSON.parse(row.payload));
    const decision = await this.policy(action, principal);
    requireCondition(
      decision.allowed,
      decision.reasons[0] ?? "POLICY_BLOCKED",
      "Current policy blocks the approved action.",
    );
    requireCondition(
      !this.config.DRY_RUN,
      "DRY_RUN",
      "Approvals cannot execute while dry-run is enabled.",
    );
    await this.checkCapability(action);
    const ctx = await this.context(action, input);
    await this.store.atomic(async (db) => {
      await this.expirePending(db, Date.now());
      const current = await db
        .selectFrom("actions")
        .select("status")
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      requireCondition(
        current.status !== "expired",
        "APPROVAL_EXPIRED",
        "This proposal expired before execution.",
      );
      requireCondition(
        current.status === "pending",
        "INVALID_REQUEST",
        "Action was already claimed.",
      );
      await this.safeguards(db, row, ctx, true);
      const claimed = await db
        .updateTable("actions")
        .set({ status: "executing", created_at: Date.now() })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      requireCondition(
        claimed.numUpdatedRows === 1n,
        "INVALID_REQUEST",
        "Action was already claimed.",
      );
    });
    return this.execute(row, input, ctx, principal);
  }
  async reject(actionId: string) {
    await this.store.atomic(async (db) => {
      await this.expirePending(db, Date.now());
      const row = await db
        .selectFrom("actions")
        .select(["action", "target"])
        .where("id", "=", actionId)
        .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
        .where("status", "=", "pending")
        .executeTakeFirst();
      requireCondition(
        row,
        "INVALID_REQUEST",
        "Only pending actions can be rejected.",
      );
      await db
        .updateTable("actions")
        .set({ status: "rejected", result: null })
        .where("id", "=", actionId)
        .where("status", "=", "pending")
        .execute();
      if (row.action === "private_reply_to_comment") {
        await db
          .updateTable("inbound_comments")
          .set({ reserved_action_id: null })
          .where("account", "=", this.config.INSTAGRAM_ACCOUNT_ID)
          .where("comment_id", "=", row.target)
          .where("reserved_action_id", "=", actionId)
          .where("used_at", "is", null)
          .execute();
      }
    });
    await this.audit(
      actionId,
      "operator",
      "reject",
      actionId,
      "rejected",
      "rejected",
      Date.now(),
    );
    return { success: true, action_id: actionId };
  }
  private async execute(
    row: ActionRow,
    input: ActionInput,
    ctx: Context,
    principal: Principal,
  ) {
    const start = Date.now();
    let confirmed = false;
    try {
      requireCondition(
        (await this.policy(row.action as Action, principal)).allowed,
        "WRITES_DISABLED",
        "Writes were disabled before execution.",
      );
      let result: Record<string, unknown>;
      if (
        row.action === "private_reply_to_comment" &&
        "comment_id" in input &&
        "message" in input
      ) {
        result = await this.meta.request(
          `${this.config.META_PAGE_ID}/messages`,
          {},
          "POST",
          {
            recipient: { comment_id: input.comment_id },
            message: { text: input.message },
          },
        );
      } else if ("comment_id" in input) {
        result = await this.meta.request(
          input.comment_id +
            (row.action === "reply_to_comment" ? "/replies" : ""),
          {},
          row.action === "delete_comment" ? "DELETE" : "POST",
          "message" in input
            ? { message: input.message }
            : row.action === "delete_comment"
              ? undefined
              : { hide: row.action === "hide_comment" },
        );
      } else if ("recipient_id" in input) {
        await this.context("reply_to_message", input);
        result = await this.meta.request(
          `${this.config.META_PAGE_ID}/messages`,
          {},
          "POST",
          {
            recipient: { id: input.recipient_id },
            message: { text: input.message },
          },
        );
      } else result = await this.publish(input, principal);
      const instagramId = z
        .string()
        .optional()
        .parse(result.id ?? result.message_id);
      requireCondition(
        instagramId || result.success === true,
        "OUTCOME_UNKNOWN",
        "Meta response did not confirm the mutation.",
      );
      confirmed = true;
      const outcome = {
        success: true,
        action_id: row.id,
        instagram_id: instagramId ?? null,
        timestamp: new Date().toISOString(),
        policy: { allowed: true },
      };
      await this.store.atomic(async (db) => {
        await db
          .updateTable("actions")
          .set({ status: "succeeded", result: JSON.stringify(outcome) })
          .where("id", "=", row.id)
          .execute();
        if (ctx.user && contactActions.has(row.action as Action)) {
          const now = Date.now();
          const existing = await db
            .selectFrom("accounts")
            .selectAll()
            .where("account", "=", row.account)
            .where("instagram_user_id", "=", ctx.user)
            .executeTakeFirst();
          const profile = ctx.username
            ? `https://www.instagram.com/${encodeURIComponent(ctx.username)}/`
            : null;
          if (existing)
            await db
              .updateTable("accounts")
              .set({
                last_contacted_at: now,
                interaction_count: existing.interaction_count + 1,
                ...(ctx.username
                  ? { username: ctx.username, profile_url: profile }
                  : {}),
              })
              .where("id", "=", existing.id)
              .execute();
          else
            await db
              .insertInto("accounts")
              .values({
                account: row.account,
                instagram_user_id: ctx.user,
                username: ctx.username ?? null,
                profile_url: profile,
                first_contacted_at: now,
                last_contacted_at: now,
                interaction_count: 1,
              })
              .execute();
        }
        if (
          row.action === "reply_to_comment" &&
          "message" in input &&
          ctx.media &&
          ctx.permalink &&
          instagramId
        )
          await db
            .insertInto("commented_posts")
            .values({
              account: row.account,
              instagram_media_id: ctx.media,
              instagram_user_id: ctx.user ?? null,
              username: ctx.username ?? null,
              post_url: ctx.permalink,
              comment_id: instagramId,
              comment_text: input.message,
              commented_at: Date.now(),
              action_id: row.id,
            })
            .execute();
        if (row.action === "private_reply_to_comment" && "comment_id" in input)
          await db
            .updateTable("inbound_comments")
            .set({ used_at: Date.now() })
            .where("account", "=", row.account)
            .where("comment_id", "=", input.comment_id)
            .where("reserved_action_id", "=", row.id)
            .where("used_at", "is", null)
            .execute();
      });
      await this.audit(
        row.id,
        row.principal,
        row.action,
        row.target,
        "allowed",
        "succeeded",
        start,
      );
      return outcome;
    } catch (error) {
      const normalized = safeError(error);
      const uncertain =
        confirmed ||
        normalized.error.code === "OUTCOME_UNKNOWN" ||
        normalized.error.code === "INTERNAL_ERROR";
      await this.store.atomic(async (db) => {
        await db
          .updateTable("actions")
          .set({
            status: uncertain ? "uncertain" : "failed",
            error: normalized.error.code,
          })
          .where("id", "=", row.id)
          .execute();
        if (!uncertain && row.action === "private_reply_to_comment") {
          await db
            .updateTable("inbound_comments")
            .set({ reserved_action_id: null })
            .where("account", "=", row.account)
            .where("comment_id", "=", row.target)
            .where("reserved_action_id", "=", row.id)
            .where("used_at", "is", null)
            .execute();
        }
      });
      await this.audit(
        row.id,
        row.principal,
        row.action,
        row.target,
        "allowed",
        uncertain ? "uncertain" : "failed",
        start,
        error,
      );
      return { ...normalized, action_id: row.id };
    }
  }
  private async publish(input: ActionInput, principal: Principal) {
    const create = async (payload: Record<string, unknown>) => {
      requireCondition(
        (await this.policy("publish_image", principal)).allowed,
        "WRITES_DISABLED",
        "Writes disabled during publishing.",
      );
      const result = await this.meta.request(
        `${this.config.INSTAGRAM_ACCOUNT_ID}/media`,
        {},
        "POST",
        payload,
      );
      return z.object({ id: z.string() }).parse(result).id;
    };
    const wait = async (container: string) => {
      for (let n = 0; n < 5; n++) {
        const result = await this.meta.request(container, {
          fields: "status_code",
        });
        if (result.status_code === "FINISHED") return;
        if (result.status_code === "ERROR" || result.status_code === "EXPIRED")
          throw new InstagramError(
            "MEDIA_PROCESSING_FAILED",
            "Meta media processing failed.",
          );
        await new Promise((r) => setTimeout(r, 60000));
      }
      throw new InstagramError(
        "OUTCOME_UNKNOWN",
        "Media processing deadline reached. Operator reconciliation is required before retrying.",
      );
    };
    let container: string;
    if ("items" in input) {
      const children: string[] = [];
      for (const item of input.items) {
        const child = await create({
          is_carousel_item: true,
          ...(item.type === "IMAGE"
            ? { image_url: item.url }
            : { media_type: "VIDEO", video_url: item.url }),
        });
        await wait(child);
        children.push(child);
      }
      container = await create({
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: input.caption,
      });
    } else if ("image_url" in input)
      container = await create({
        image_url: input.image_url,
        caption: input.caption,
      });
    else if ("video_url" in input)
      container = await create({
        media_type: "REELS",
        video_url: input.video_url,
        caption: input.caption,
      });
    else throw new InstagramError("INVALID_REQUEST", "Invalid publication.");
    await wait(container);
    requireCondition(
      (await this.policy("publish_image", principal)).allowed,
      "WRITES_DISABLED",
      "Writes disabled before publishing.",
    );
    return this.meta.request(
      `${this.config.INSTAGRAM_ACCOUNT_ID}/media_publish`,
      {},
      "POST",
      { creation_id: container },
    );
  }
  private result(row: ActionRow) {
    if (row.status === "succeeded" && row.result)
      return JSON.parse(row.result) as Record<string, unknown>;
    return {
      success: false,
      action_id: row.id,
      status: row.status,
      error: {
        code:
          row.status === "pending"
            ? "APPROVAL_REQUIRED"
            : row.status === "uncertain" || row.status === "executing"
              ? "OUTCOME_UNKNOWN"
              : "ACTION_TERMINAL",
        message:
          row.status === "pending"
            ? "Human approval is required through the separate operator interface."
            : "Action is already recorded; do not repeat it with a new key.",
      },
    };
  }
  private async audit(
    actionId: string,
    principal: string,
    tool: string,
    target: string,
    decision: string,
    status: string,
    start: number,
    error?: unknown,
  ) {
    const category = error ? safeError(error).error.code : null;
    const record = {
      action_id: actionId,
      timestamp: Date.now(),
      principal,
      tool,
      target,
      decision,
      status,
      latency_ms: Date.now() - start,
      error: category,
    };
    await this.store.db.insertInto("audit").values(record).execute();
    this.logger.info(record, "instagram_action");
  }
}
