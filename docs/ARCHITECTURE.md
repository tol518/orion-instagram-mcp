# Architecture

Instagram MCP is the sole owner of Meta credentials, Instagram policy, and Instagram state. Orion and OpenClaw are clients. They do not import the Meta client or read the SQLite database.

```text
orion-instagram-plugin ── authenticated local calls ──► orion-instagram-mcp ──► Meta
      │                                                │
      └── Orion workflows and operator UI              ├── policy
                                                       ├── approval
OpenClaw plugin ── agent-bound bridge token ───────────┤── rate limits
                                                       ├── idempotency
Meta ── signed webhook ────────────────────────────────┤── webhook state
                                                       └── SQLite + audit
```

## Trust boundaries

The MCP and `/tools/:name` interfaces expose only named operations. The service never accepts an arbitrary Graph path. Each bridge token maps to one principal and a fixed permission list from `INSTAGRAM_BRIDGE_KEYS`.

Approval is a different trust boundary. MCP tools can list only their own pending proposals. Approval, rejection, exports, and the write kill switch are available through the operator CLI or operator-authenticated HTTP routes.

## Write path

1. Strict schema validation.
2. Global kill switch, mode, and principal permission checks.
3. Meta capability validation.
4. Server-derived target ownership or inbound-event eligibility.
5. Durable idempotency, duplicate, cooldown, and local rate checks inside a SQLite write transaction.
6. Pending approval or Meta execution.
7. Confirmed state update and structured audit record.

Meta writes are not retried automatically. A transport failure after a write creates an uncertain result so a retry cannot accidentally duplicate a comment, message, or publication.

## Identity and state

Facebook Login for Business yields a Page access token. Content, comments, and media insights use the linked Instagram professional account ID. Instagram messaging conversations and sends use the Facebook Page ID with that Page token.

SQLite stores action reservations, approvals, audit metadata, normalized webhook eligibility, contacted accounts, and commented posts. It does not store Meta secrets, Instagram passwords, or inbound message bodies.
