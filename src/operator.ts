import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createService } from "./index.js";
import { safeError } from "./errors.js";
import { exchangeBusinessCode, writePageTokenEnv } from "./token.js";
import { csvCell } from "./csv.js";

async function writeExport(
  rows: Record<string, unknown>[],
  filename: string,
  format: "txt" | "csv" | "json",
  renderText: (row: Record<string, unknown>) => string,
) {
  const out = createWriteStream(filename, { mode: 0o600 });
  if (format === "json") out.write("[\n");
  if (format === "csv" && rows.length) {
    out.write(`${Object.keys(rows[0]!).map(csvCell).join(",")}\n`);
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (format === "json") {
      out.write(
        `${JSON.stringify(row)}${index === rows.length - 1 ? "" : ","}\n`,
      );
    } else if (format === "csv") {
      out.write(`${Object.values(row).map(csvCell).join(",")}\n`);
    } else {
      out.write(renderText(row));
    }
  }
  if (format === "json") out.write("]\n");
  await new Promise<void>((done, fail) => {
    out.on("error", fail);
    out.end(done);
  });
}

async function exportRows(
  service: ReturnType<typeof createService>,
  kind: "accounts" | "posts",
  format: "txt" | "csv" | "json",
  directory: string,
) {
  const targetDirectory = resolve(directory);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const filename = resolve(
    targetDirectory,
    `${kind === "accounts" ? "contacted-accounts" : "commented-posts"}.${format}`,
  );
  if (!filename.startsWith(`${targetDirectory}/`))
    throw new Error("Invalid export path");

  if (kind === "accounts") {
    const rows = await service.store.db
      .selectFrom("accounts")
      .selectAll()
      .where("account", "=", service.config.INSTAGRAM_ACCOUNT_ID)
      .orderBy("id", "asc")
      .execute();
    await writeExport(rows, filename, format, (row) => {
      const account = row as (typeof rows)[number];
      return `ACCOUNT: ${account.username ? `@${account.username}` : account.instagram_user_id}\nPROFILE: ${account.profile_url ?? "Unavailable"}\nLAST CONTACTED: ${new Date(account.last_contacted_at).toISOString()}\nINTERACTIONS: ${account.interaction_count}\n\n`;
    });
    return { success: true, file: filename, records: rows.length };
  }

  const rows = await service.store.db
    .selectFrom("commented_posts")
    .selectAll()
    .where("account", "=", service.config.INSTAGRAM_ACCOUNT_ID)
    .orderBy("id", "asc")
    .execute();
  await writeExport(rows, filename, format, (row) => {
    const post = row as (typeof rows)[number];
    return `ACCOUNT: ${post.username ? `@${post.username}` : (post.instagram_user_id ?? "Unavailable")}\nPOST: ${post.post_url}\nCOMMENT: ${post.comment_text}\nCOMMENTED: ${new Date(post.commented_at).toISOString()}\n\n`;
  });
  return { success: true, file: filename, records: rows.length };
}

async function main() {
  const [command, arg, ...rest] = process.argv.slice(2);
  if (command === "exchange-token" && arg && rest[0] && rest[1]) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret)
      throw new Error("META_APP_ID and META_APP_SECRET are required");
    const apiVersion = process.env.META_API_VERSION;
    if (!apiVersion) throw new Error("META_API_VERSION is required");
    const token = await exchangeBusinessCode({
      appId,
      appSecret,
      code: arg,
      redirectUri: rest[0],
      apiVersion,
      pageId: process.env.META_PAGE_ID,
    });
    await writePageTokenEnv(rest[1], token);
    return {
      success: true,
      token_file: resolve(rest[1]),
      page_id: token.pageId,
      page_name: token.pageName,
      instagram_account_id: token.instagramAccountId,
      instagram_username: token.instagramUsername,
      page_tasks: token.tasks,
      user_token_expires_at: token.userTokenExpiresAt
        ? new Date(token.userTokenExpiresAt).toISOString()
        : null,
    };
  }
  const service = createService();
  let result: unknown;
  try {
    if (command === "approve" && arg) result = await service.approve(arg);
    else if (command === "reject" && arg) result = await service.reject(arg);
    else if (command === "kill-writes")
      result = await service.store
        .stopWrites()
        .then(() => ({ success: true, writes_blocked: true }));
    else if (command === "pending") {
      await service.cleanupExpiredActions();
      result = {
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
    } else if (
      command === "export" &&
      (arg === "accounts" || arg === "posts")
    ) {
      const format = rest[0] === "csv" || rest[0] === "json" ? rest[0] : "txt";
      result = await exportRows(service, arg, format, rest[1] ?? "./exports");
    } else
      throw new Error(
        "Usage: operator approve <id> | reject <id> | pending | kill-writes | export accounts|posts [txt|csv|json] [directory] | exchange-token <code> <redirect-uri> <new-file>",
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await service.store.close();
  }
}

main()
  .then((result) => {
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  });
