# Tool catalog

All tools use strict input schemas. Every mutation requires an `idempotency_key`. Write behavior also depends on server mode, the global kill switch, Meta scopes, webhook eligibility, duplicate/cooldown limits, and approval policy.

| Tool                                 | Purpose                                              | Access | Permission         | Meta capability / approval                                         |
| ------------------------------------ | ---------------------------------------------------- | ------ | ------------------ | ------------------------------------------------------------------ |
| `instagram_get_account`              | Read linked Instagram and Page identity.             | Read   | `account.read`     | `instagram_basic`                                                  |
| `instagram_auth_status`              | Validate the Page token and report scopes.           | Read   | `account.read`     | Token debug + linked Page                                          |
| `instagram_get_capabilities`         | Report actual grants and webhook fields.             | Read   | `account.read`     | Token scopes + subscriptions                                       |
| `instagram_get_media`                | List owned Instagram media.                          | Read   | `media.read`       | `instagram_basic`                                                  |
| `instagram_get_media_details`        | Read one owned media item.                           | Read   | `media.read`       | `instagram_basic`                                                  |
| `instagram_get_comments`             | Read comments on owned media.                        | Read   | `comments.read`    | `instagram_manage_comments`                                        |
| `instagram_get_comment`              | Read a comment after media ownership verification.   | Read   | `comments.read`    | `instagram_manage_comments`                                        |
| `instagram_get_conversations`        | List Instagram conversations for the Page.           | Read   | `messages.read`    | `instagram_manage_messages`                                        |
| `instagram_get_messages`             | Read a bounded verified conversation.                | Read   | `messages.read`    | `instagram_manage_messages`                                        |
| `instagram_get_insights`             | Read account reach for up to 30 days.                | Read   | `insights.read`    | `instagram_manage_insights`                                        |
| `instagram_get_media_insights`       | Read available shares and comments metrics.          | Read   | `insights.read`    | `instagram_manage_insights`                                        |
| `instagram_has_contacted_account`    | Check durable interaction history.                   | Read   | `history.read`     | Local SQLite                                                       |
| `instagram_has_commented_on_post`    | Check durable reply history.                         | Read   | `history.read`     | Local SQLite                                                       |
| `instagram_get_contacted_accounts`   | Page through contacted accounts.                     | Read   | `history.read`     | Local SQLite                                                       |
| `instagram_get_commented_posts`      | Page through replied-to posts.                       | Read   | `history.read`     | Local SQLite                                                       |
| `instagram_get_account_history`      | Read one account's reply history.                    | Read   | `history.read`     | Local SQLite                                                       |
| `instagram_get_pending_actions`      | Read the calling agent's proposals.                  | Read   | `history.read`     | Local SQLite; no approval power                                    |
| `instagram_get_events`               | Read normalized webhook event metadata.              | Read   | `events.read`      | Verified webhooks                                                  |
| `instagram_reply_to_comment`         | Publicly reply to a comment on owned media.          | Write  | `comments.write`   | `instagram_manage_comments`; approval unless allowlisted safe mode |
| `instagram_private_reply_to_comment` | Send one private reply to a verified recent comment. | Write  | `messages.write`   | `instagram_manage_comments` + `pages_messaging`; always approval   |
| `instagram_hide_comment`             | Hide a comment on owned media.                       | Write  | `comments.write`   | `instagram_manage_comments`; always approval                       |
| `instagram_unhide_comment`           | Unhide a comment on owned media.                     | Write  | `comments.write`   | `instagram_manage_comments`; always approval                       |
| `instagram_delete_comment`           | Delete a comment on owned media.                     | Write  | `comments.write`   | `instagram_manage_comments`; always approval                       |
| `instagram_reply_to_message`         | Reply to a verified recent inbound sender.           | Write  | `messages.write`   | `instagram_manage_messages`; approval unless allowlisted safe mode |
| `instagram_publish_image`            | Publish an image from an allowed host.               | Write  | `publishing.write` | `instagram_content_publish`; always approval                       |
| `instagram_publish_reel`             | Publish a Reel from an allowed host.                 | Write  | `publishing.write` | `instagram_content_publish`; always approval                       |
| `instagram_publish_carousel`         | Publish 2–10 image/video items.                      | Write  | `publishing.write` | `instagram_content_publish`; always approval                       |

## Deliberately unsupported

There is no tool for cold DMs, bulk DMs, third-party post comments, follower/following extraction, browser automation, password login, arbitrary Graph requests, or arbitrary SQL. Meta does not provide these as safe business automation capabilities for this use case.
