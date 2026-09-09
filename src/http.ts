import Fastify from "fastify";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { receiveWebhook } from "./webhook.js";
import { toolCatalog, invoke } from "./tools.js";
import { safeError } from "./errors.js";
import type { InstagramService } from "./service.js";
const equal = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
export function createHttp(service: InstagramService) {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 20000,
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.get("/health", async () => ({
    ok: true,
    service: "instagram-mcp",
    writes_enabled:
      service.config.INSTAGRAM_WRITES_ENABLED &&
      !(await service.store.writesBlocked()),
    dry_run: service.config.DRY_RUN,
  }));
  app.get("/webhooks/meta", async (request, reply) => {
    const parsed = z
      .object({
        "hub.mode": z.literal("subscribe"),
        "hub.verify_token": z.string(),
        "hub.challenge": z.string().max(1024),
      })
      .safeParse(request.query);
    if (
      !parsed.success ||
      !equal(
        parsed.data["hub.verify_token"],
        service.config.META_WEBHOOK_VERIFY_TOKEN,
      )
    )
      return reply.code(403).send({ error: "VERIFICATION_FAILED" });
    return reply.type("text/plain").send(parsed.data["hub.challenge"]);
  });
  app.post("/webhooks/meta", async (request, reply) => {
    try {
      return await receiveWebhook(
        service,
        request.body as Buffer,
        request.headers["x-hub-signature-256"],
      );
    } catch (error) {
      return reply.code(400).send(safeError(error));
    }
  });
  const operator = (authorization: unknown) =>
    Boolean(
      service.config.INSTAGRAM_OPERATOR_TOKEN &&
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ") &&
      equal(authorization.slice(7), service.config.INSTAGRAM_OPERATOR_TOKEN),
    );
  app.get("/operator/pending", async (request, reply) => {
    if (!operator(request.headers.authorization))
      return reply
        .code(401)
        .send({ success: false, error: { code: "AUTHENTICATION_FAILED" } });
    await service.cleanupExpiredActions();
    return {
      data: await service.store.db
        .selectFrom("actions")
        .select([
          "id",
          "principal",
          "action",
          "target",
          "payload",
          "created_at",
          "expires_at",
        ])
        .where("account", "=", service.config.INSTAGRAM_ACCOUNT_ID)
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .limit(100)
        .execute(),
    };
  });
  app.post("/operator/actions/:id/:decision", async (request, reply) => {
    if (!operator(request.headers.authorization))
      return reply
        .code(401)
        .send({ success: false, error: { code: "AUTHENTICATION_FAILED" } });
    const params = z
      .object({
        id: z.string().uuid(),
        decision: z.enum(["approve", "reject"]),
      })
      .safeParse(request.params);
    if (!params.success)
      return reply
        .code(400)
        .send({ success: false, error: { code: "INVALID_REQUEST" } });
    try {
      return params.data.decision === "approve"
        ? await service.approve(params.data.id)
        : await service.reject(params.data.id);
    } catch (error) {
      return reply.code(400).send(safeError(error));
    }
  });
  app.post("/operator/kill-writes", async (request, reply) => {
    if (!operator(request.headers.authorization))
      return reply
        .code(401)
        .send({ success: false, error: { code: "AUTHENTICATION_FAILED" } });
    await service.store.stopWrites();
    return { success: true, writes_blocked: true };
  });
  // Bridge credentials identify one principal. An agent ID in request arguments
  // cannot change identity or permissions. Operator actions are absent here.
  app.post("/tools/:name", async (request, reply) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const entry = Object.entries(service.config.INSTAGRAM_BRIDGE_KEYS).find(
      ([, value]) => equal(token, value.token),
    );
    if (!entry)
      return reply
        .code(401)
        .send({ success: false, error: { code: "AUTHENTICATION_FAILED" } });
    const name = z.object({ name: z.string() }).parse(request.params).name;
    const tool = toolCatalog(service).find((t) => t.name === name);
    if (!tool)
      return reply
        .code(404)
        .send({ success: false, error: { code: "NOT_SUPPORTED" } });
    let body: unknown;
    try {
      body = JSON.parse((request.body as Buffer).toString("utf8"));
    } catch {
      return reply
        .code(400)
        .send({ success: false, error: { code: "INVALID_REQUEST" } });
    }
    return invoke(tool, body, {
      id: entry[0],
      source: "bridge",
      permissions: entry[1].permissions,
    });
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Request could not be processed.",
      },
    }),
  );
  return app;
}
