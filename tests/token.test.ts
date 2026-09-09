import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeBusinessCode, writePageTokenEnv } from "../src/token.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Facebook Login for Business token setup", () => {
  it("exchanges the code, selects a linked Page, and writes a new private env file", async () => {
    const responses = [
      { access_token: "s".repeat(32), expires_in: 3_600 },
      { access_token: "u".repeat(64), expires_in: 5_184_000 },
      {
        data: [
          {
            id: "555",
            name: "Neckermann Travel",
            access_token: "p".repeat(64),
            tasks: ["MESSAGING", "CREATE_CONTENT"],
            instagram_business_account: { id: "777", username: "neckermann" },
          },
        ],
      },
    ];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetcher);

    const token = await exchangeBusinessCode({
      appId: "123456789",
      appSecret: "a".repeat(32),
      code: "authorization-code",
      redirectUri: "https://orion.example/meta/callback",
      apiVersion: "v26.0",
    });
    expect(token).toMatchObject({
      pageId: "555",
      pageName: "Neckermann Travel",
      instagramAccountId: "777",
      instagramUsername: "neckermann",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [codeUrl, codeRequest] = fetcher.mock.calls[0]!;
    const [longUrl, longRequest] = fetcher.mock.calls[1]!;
    expect(String(codeUrl)).not.toContain("a".repeat(32));
    expect(String(codeUrl)).not.toContain("authorization-code");
    expect(codeRequest?.method).toBe("POST");
    expect(String(longUrl)).not.toContain("a".repeat(32));
    expect(String(longUrl)).not.toContain("s".repeat(32));
    expect(longRequest?.method).toBe("POST");

    const directory = await mkdtemp(join(tmpdir(), "instagram-mcp-token-"));
    directories.push(directory);
    const target = join(directory, "meta.env");
    await writePageTokenEnv(target, token);
    const content = await readFile(target, "utf8");
    expect(content).toContain(`META_PAGE_ACCESS_TOKEN=${"p".repeat(64)}`);
    expect(content).toContain("META_PAGE_ID=555");
    expect(content).toContain("INSTAGRAM_ACCOUNT_ID=777");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await expect(writePageTokenEnv(target, token)).rejects.toThrow();
  });
});
