import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { InstagramError, requireCondition } from "./errors.js";

const tokenResponse = z.object({
  access_token: z.string().min(16),
  expires_in: z.number().int().positive().optional(),
});
const pagesResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      access_token: z.string().min(16),
      tasks: z.array(z.string()).default([]),
      instagram_business_account: z
        .object({ id: z.string(), username: z.string() })
        .optional(),
    }),
  ),
});

async function requestToken(
  url: URL,
  authorization?: string,
  body?: URLSearchParams,
) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new InstagramError(
      "AUTHENTICATION_FAILED",
      "Meta returned an unreadable token response.",
    );
  }
  if (!response.ok) {
    throw new InstagramError(
      "AUTHENTICATION_FAILED",
      "Meta rejected the token operation.",
    );
  }
  return value;
}

export async function exchangeBusinessCode(input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  apiVersion: string;
  pageId?: string;
}) {
  const codeUrl = new URL(
    `https://graph.facebook.com/${input.apiVersion}/oauth/access_token`,
  );
  const codeBody = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const short = tokenResponse.parse(
    await requestToken(codeUrl, undefined, codeBody),
  );

  const longUrl = new URL(
    `https://graph.facebook.com/${input.apiVersion}/oauth/access_token`,
  );
  const longBody = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: input.appId,
    client_secret: input.appSecret,
    fb_exchange_token: short.access_token,
  });
  const long = tokenResponse.parse(
    await requestToken(longUrl, undefined, longBody),
  );

  const pagesUrl = new URL(
    `https://graph.facebook.com/${input.apiVersion}/me/accounts`,
  );
  pagesUrl.searchParams.set(
    "fields",
    "id,name,access_token,tasks,instagram_business_account{id,username}",
  );
  pagesUrl.searchParams.set("limit", "100");
  const pages = pagesResponse
    .parse(await requestToken(pagesUrl, long.access_token))
    .data.filter((page) => page.instagram_business_account);
  const page = input.pageId
    ? pages.find((candidate) => candidate.id === input.pageId)
    : pages.length === 1
      ? pages[0]
      : undefined;
  requireCondition(
    page,
    "AUTHENTICATION_FAILED",
    input.pageId
      ? "The selected Page was not granted or has no linked Instagram professional account."
      : "Set META_PAGE_ID because the login grants more than one linked Page.",
  );
  return {
    pageAccessToken: page.access_token,
    pageId: page.id,
    pageName: page.name,
    instagramAccountId: page.instagram_business_account!.id,
    instagramUsername: page.instagram_business_account!.username,
    tasks: page.tasks,
    userTokenExpiresAt: long.expires_in
      ? Date.now() + long.expires_in * 1_000
      : null,
  };
}

export async function writePageTokenEnv(
  path: string,
  value: Awaited<ReturnType<typeof exchangeBusinessCode>>,
) {
  const content = [
    `META_PAGE_ACCESS_TOKEN=${value.pageAccessToken}`,
    `META_PAGE_ID=${value.pageId}`,
    `INSTAGRAM_ACCOUNT_ID=${value.instagramAccountId}`,
  ].join("\n");
  await writeFile(path, `${content}\n`, { mode: 0o600, flag: "wx" });
}
