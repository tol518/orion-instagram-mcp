# Orion integration

Install `orion-instagram-mcp` and `orion-instagram-plugin` as separate sibling projects, following the same ownership pattern as Orion Finance Lab.

```text
/path/to/orion-instagram-mcp     Meta integration, policy, approval, webhooks, SQLite
/path/to/orion-instagram-plugin  Orion operator plugin and OpenClaw agent plugin
/path/to/orion               Generic plugin host only
/path/to/openclaw            Generic agent runtime only
```

Orion core must not import either project. Add the companion plugin path to Orion's existing plugin discovery configuration, for example:

```dotenv
ORION_PLUGIN_PATHS=/absolute/path/to/orion-instagram-plugin
ORION_INSTAGRAM_API_URL=http://127.0.0.1:4840
ORION_INSTAGRAM_OPERATOR_TOKEN=<OPERATOR_TOKEN_FROM_INSTAGRAM_MCP>
ORION_INSTAGRAM_API_TOKEN=<DIFFERENT 64+ CHARACTER ORION INGRESS TOKEN>
```

The Orion plugin contributes operator status, pending-action approval/rejection, and emergency write shutdown. Its routes require the separate ingress bearer token before the plugin attaches the MCP service's operator credential upstream. Instagram extraction is event-driven and uses the service's official read tools and authenticated webhooks. It does not automate a browser or scrape Instagram.

## OpenClaw agent tools

Link the plugin from the companion repository:

```bash
openclaw plugins install --link /absolute/path/to/orion-instagram-plugin/openclaw-plugin
```

Add the same agent token to the two private configurations:

```dotenv
# orion-instagram-mcp .env
INSTAGRAM_BRIDGE_KEYS={"orion-marketing":{"token":"<64+ CHARACTER TOKEN>","permissions":["account.read","media.read","comments.read","messages.read","history.read","events.read","comments.write","messages.write"]}}
```

```json
{
  "plugins": {
    "entries": {
      "orion-instagram": {
        "enabled": true,
        "config": {
          "serviceUrl": "http://127.0.0.1:4840",
          "agentTokens": {
            "orion-marketing": {
              "source": "env",
              "provider": "default",
              "id": "ORION_INSTAGRAM_MARKETING_TOKEN"
            }
          },
          "defaultPermissions": [
            "account.read",
            "media.read",
            "comments.read",
            "history.read",
            "events.read"
          ],
          "agentPermissions": {
            "orion-marketing": [
              "account.read",
              "media.read",
              "comments.read",
              "messages.read",
              "history.read",
              "events.read",
              "comments.write",
              "messages.write"
            ]
          }
        }
      }
    }
  }
}
```

Set `ORION_INSTAGRAM_MARKETING_TOKEN` in the private OpenClaw gateway environment to the same token used by the service. Both services enforce permissions. The OpenClaw plugin hides tools outside its configured list, and Instagram MCP checks the authenticated bridge principal again. Keep write tools optional in OpenClaw tool allowlists.

## Workflow

```text
Customer comments or sends a DM
  └── Meta signed webhook
        └── Instagram MCP records eligibility and a normalized event
              └── Orion agent reads the bounded event list
                    └── agent proposes a reply with an idempotency key
                          └── deterministic policy and approval
                                └── Instagram MCP sends through Meta
```

Holiday search and offer selection remain Orion responsibilities. The service accepts only the final bounded reply text and never receives access to Neckermann booking systems.
