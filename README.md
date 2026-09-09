# Instagram MCP

Instagram MCP is a standalone service that gives MCP clients a fixed set of tools for a Meta-linked Instagram professional account. It uses Meta's official APIs, applies deterministic permissions and policy before every write, and keeps its audit, approval, webhook, and interaction state in SQLite.

It is independent from Orion. The companion `orion-instagram-plugin` repository connects Orion and OpenClaw to this service without moving Meta credentials into either agent runtime.

## Supported business interactions

The service can manage comments on media owned by the connected Instagram account, reply to an inbound Instagram conversation while Meta permits the reply, and send Meta's one private reply to a recent comment. It cannot comment on other accounts' posts, discover or scrape followers, or start cold DMs. Those operations are absent from the tool catalog.

## Architecture

```text
MCP client ───── stdio ─────┐
                            │
Orion/OpenClaw plugin ─ HTTP bridge ─► Instagram MCP
                                      ├── strict tools and permissions
Meta webhooks ─────────────── HTTPS ─►├── policy, approval, limits
                                      ├── SQLite state and audit
Operator CLI/API ───────────── auth ─►└── Meta Graph API
```

Meta credentials exist only in the Instagram MCP process. Agent bridge tokens identify one configured principal and cannot call approval endpoints. The operator credential cannot be supplied through an MCP tool.

## Requirements

- Node.js 24.14 or newer.
- npm.
- A Facebook Page linked to the Neckermann Instagram professional account.
- A Meta app configured with Facebook Login for Business and the Instagram API products needed by the enabled tools.
- A publicly reachable HTTPS URL for Meta webhooks.

## Install and configure

```bash
npm ci
cp .env.example .env
```

Fill the Meta identifiers and secrets in `.env`. Generate separate webhook, operator, and agent bridge secrets with a cryptographically secure password generator. Each operator or bridge token must contain at least 64 characters.

The default configuration is safe for connection testing:

```dotenv
INSTAGRAM_MODE=APPROVAL_REQUIRED
INSTAGRAM_WRITES_ENABLED=false
DRY_RUN=true
```

See [Meta setup](docs/META_SETUP.md) for the business login, Page token, permissions, and webhook steps.

## Run

Use stdio when a single MCP client launches the process:

```bash
npm run dev
```

Use the loopback HTTP bridge for Orion/OpenClaw and the webhook receiver:

```bash
npm run build
npm start -- --http
```

The bridge listens on `127.0.0.1:4840` by default. Expose only `/webhooks/meta` through a trusted HTTPS reverse proxy. Keep `/tools/*` and `/operator/*` private.

For Docker:

```bash
docker compose up --build
```

The container runs without root privileges, uses a read-only filesystem, and persists only its SQLite volume.

## Facebook Login for Business token exchange

After receiving an authorization code at the registered redirect URI, build the project and exchange it immediately:

```bash
npm run build
npm run operator -- exchange-token '<CODE>' 'https://your.example/meta/callback' './meta-token.env'
```

This exchanges the short-lived user token for a long-lived user token, retrieves the granted Page token, verifies the linked Instagram account, and creates a new mode-`0600` env fragment. It never prints the token. Set `META_PAGE_ID` before the command when the login grants multiple linked Pages.

## Permissions and modes

Permissions are assigned server-side per bridge credential. Available permissions are:

`account.read`, `media.read`, `comments.read`, `messages.read`, `insights.read`, `history.read`, `events.read`, `comments.write`, `messages.write`, and `publishing.write`.

- `READ_ONLY` blocks all mutations.
- `APPROVAL_REQUIRED` records every valid mutation as a pending action.
- `AUTONOMOUS_SAFE` executes only `reply_to_comment` or `reply_to_message` when explicitly listed in `INSTAGRAM_AUTONOMOUS_ACTIONS`. Publishing, moderation, and private comment replies still require approval.

`INSTAGRAM_WRITES_ENABLED=false` is the global kill switch. `DRY_RUN=true` validates and reports the proposed outcome without storing a pending action or calling Meta.

Operator commands:

```bash
npm run operator -- pending
npm run operator -- approve '<ACTION_ID>'
npm run operator -- reject '<ACTION_ID>'
npm run operator -- kill-writes
npm run operator -- export accounts csv ./exports
npm run operator -- export posts json ./exports
```

SQLite remains the source of truth. TXT, CSV, and JSON files are exports only.

## Webhooks

- Verification: `GET /webhooks/meta`
- Events: `POST /webhooks/meta`

The POST handler validates `X-Hub-Signature-256` over the exact raw body. Only authenticated inbound messages and comment events establish the eligibility needed for replies. Message bodies are not kept in the event log.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Tests mock Meta and require no live Instagram account. A live account is still required for final Meta App Review and staging verification.

Further references:

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Tool catalog](docs/TOOLS.md)
- [Orion integration](docs/ORION_INTEGRATION.md)
- [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Instagram messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
