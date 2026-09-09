# Security model

Treat every tool argument and every Instagram caption, comment, username, and message as untrusted data. Agent instructions cannot override the controls below.

## Enforced controls

- Named tools only; there is no arbitrary Graph API request tool.
- Strict IDs, bounded text, bounded pagination, and bounded HTTP bodies.
- Per-agent credentials and server-side permission lists.
- Separate operator credential for approval, rejection, export, and emergency shutdown.
- Ownership verification before comment or media operations.
- Authenticated webhook evidence before ordinary DM replies or private comment replies.
- A 24-hour inbound-message window and a single private comment reply within seven days.
- SQLite-backed idempotency, duplicate detection, cooldowns, rate limits, and action state.
- No automatic retries for Meta mutations with an uncertain outcome.
- HTTPS-only publishing URLs on an explicit hostname allowlist.
- HMAC-SHA256 verification over raw webhook bytes.
- Secret redaction by design: tools return token status, never credentials.
- Loopback network defaults and a global write kill switch.

## Deployment

Keep `.env`, the SQLite database, operator tokens, bridge tokens, and exported interaction histories out of source control. Run the HTTP service on a private host. Route only `/webhooks/meta` from the public reverse proxy and enforce a small body limit there too.

Use a different secret for each agent principal and for the operator. Remove a compromised bridge credential from `INSTAGRAM_BRIDGE_KEYS`, restart the service, and rotate the operator token independently. If a Meta credential is exposed, invalidate it in Meta, complete Facebook Login for Business again, and keep writes disabled until `instagram_auth_status` and `instagram_get_capabilities` are healthy.

The local rate limits are defensive product controls. They do not represent Meta's limits and do not replace Meta enforcement.
