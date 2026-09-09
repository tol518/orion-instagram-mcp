# Meta setup for Neckermann Travel

This setup uses Facebook Login for Business because the Instagram professional account is linked to a Facebook Page. The current Instagram Platform overview describes both login models; this service intentionally uses the Facebook Page-linked model.

## 1. Confirm the business assets

In Meta Business Suite, confirm that:

- Neckermann Travel's Instagram account is Business or Creator, not personal.
- The Instagram account is linked to the intended Neckermann Travel Facebook Page.
- The person completing login has full control or the Page tasks needed for content, messages, comments, and insights.
- The Meta app belongs to the same business portfolio used for App Review and access verification.

## 2. Configure the Meta app

Create or select a Meta business app. Add the Facebook Login for Business and Instagram API products. Create a Facebook Login for Business configuration, register the exact HTTPS OAuth redirect URI, and request only the capabilities you will enable.

Typical permissions for the complete service are:

| Permission                  | Used for                                                               |
| --------------------------- | ---------------------------------------------------------------------- |
| `pages_show_list`           | Discover Pages granted by the login.                                   |
| `instagram_basic`           | Read the linked professional account and media.                        |
| `pages_read_engagement`     | Read Page-linked engagement data needed by the API.                    |
| `instagram_manage_comments` | Read, reply to, hide, unhide, delete, and privately reply to comments. |
| `instagram_manage_messages` | Read and reply to Instagram conversations.                             |
| `pages_messaging`           | Required by Meta's private-reply messaging flow.                       |
| `instagram_content_publish` | Publish images, Reels, and carousels.                                  |
| `instagram_manage_insights` | Read supported account and media insights.                             |
| `pages_manage_metadata`     | Subscribe the Page/app to webhook fields.                              |

Meta may require Advanced Access, business verification, Data Use Checkup, and App Review before people without an app role can use these permissions. During development, use app-role users and test assets.

## 3. Complete business login

Open the Facebook Login for Business authorization dialog using your app ID, exact redirect URI, and login configuration ID. After the account owner selects the Neckermann Page, Meta redirects back with a short-lived authorization code.

Build and exchange the code immediately:

```bash
npm run build
META_APP_ID='<APP_ID>' \
META_APP_SECRET='<APP_SECRET>' \
META_API_VERSION='v26.0' \
npm run operator -- exchange-token '<CODE>' 'https://your.example/meta/callback' './meta-token.env'
```

If login grants more than one linked Page, add `META_PAGE_ID='<NECKERMANN_PAGE_ID>'` to the command environment. The command performs the documented long-lived user-token exchange, retrieves the selected Page token from `/me/accounts`, verifies the linked Instagram account, and creates `meta-token.env` with mode `0600`. It does not print the Page token.

Copy the three generated values into the private runtime `.env`. Do not commit either file. Meta Page tokens can be invalidated even when no expiry is reported, so monitor `instagram_auth_status` and reconnect when it becomes unhealthy.

## 4. Configure webhooks

Set a random `META_WEBHOOK_VERIFY_TOKEN` of at least 32 characters. Configure Meta's callback URL as:

```text
https://your-public-host.example/webhooks/meta
```

Subscribe the app/Page to the Instagram messaging and comment fields needed by your workflow. The callback must preserve the exact raw request body and `X-Hub-Signature-256` header. The service answers Meta's verification challenge and rejects POSTs with an invalid signature.

Expose only this webhook path publicly. Keep `/tools`, `/operator`, and `/health` behind the local network or authenticated infrastructure.

## 5. Test safely

Start with writes disabled and dry-run enabled. Call:

1. `instagram_auth_status` to confirm the Page and Instagram account mapping.
2. `instagram_get_capabilities` to inspect actual token scopes and webhook subscriptions.
3. `instagram_get_account`, media, and comments read tools.
4. Send a real test DM to the business and add a test comment to a Neckermann-owned post; confirm normalized webhook events appear.
5. Propose replies in dry-run, then use `APPROVAL_REQUIRED` in a non-production test account.

Only enable production writes after App Review and the webhook flow are complete.

## Meta restrictions represented in the service

- Public replies and moderation apply to comments on media owned by the connected account.
- Ordinary DMs are replies to people who initiated a conversation and are limited to Meta's response window.
- A comment can receive one private reply within seven days; continued messaging requires the recipient to respond and then follows the normal messaging window.
- Commenting on third-party posts, follower scraping, and cold or mass DMs are unsupported.

Official references:

- [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Instagram messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging)
- [Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
- [Content publishing](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/content-publishing)
- [Long-lived access tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived)
