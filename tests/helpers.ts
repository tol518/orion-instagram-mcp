import pino from "pino";
import { vi } from "vitest";
import type { Config, Principal } from "../src/config.js";
import type { MetaClient } from "../src/meta.js";
import { InstagramService } from "../src/service.js";
import { Store } from "../src/store.js";

export const principal: Principal = {
  id: "orion",
  source: "bridge",
  permissions: [
    "account.read",
    "media.read",
    "comments.read",
    "messages.read",
    "insights.read",
    "history.read",
    "events.read",
    "comments.write",
    "messages.write",
    "publishing.write",
  ],
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    META_APP_ID: "123456789",
    META_APP_SECRET: "a".repeat(32),
    META_PAGE_ACCESS_TOKEN: "p".repeat(64),
    META_PAGE_ID: "555",
    INSTAGRAM_ACCOUNT_ID: "777",
    META_API_VERSION: "v26.0",
    META_WEBHOOK_VERIFY_TOKEN: "v".repeat(64),
    INSTAGRAM_MODE: "APPROVAL_REQUIRED",
    INSTAGRAM_WRITES_ENABLED: true,
    DRY_RUN: false,
    INSTAGRAM_DB: ":memory:",
    INSTAGRAM_AGENT_ID: "orion",
    INSTAGRAM_AGENT_PERMISSIONS: principal.permissions,
    INSTAGRAM_AUTONOMOUS_ACTIONS: [],
    INSTAGRAM_MEDIA_HOSTS: ["media.example.com"],
    MAX_ACTIONS_PER_MINUTE: 10,
    MAX_COMMENTS_PER_HOUR: 10,
    MAX_DMS_PER_HOUR: 20,
    MAX_POSTS_PER_DAY: 3,
    INTERACTION_COOLDOWN_HOURS: 24,
    APPROVAL_TTL_MINUTES: 60,
    INSTAGRAM_PORT: 4840,
    INSTAGRAM_HOST: "127.0.0.1",
    INSTAGRAM_OPERATOR_TOKEN: "o".repeat(64),
    INSTAGRAM_BRIDGE_KEYS: {
      orion: { token: "b".repeat(64), permissions: principal.permissions },
    },
    ...overrides,
  };
}

export function createHarness(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const store = new Store(":memory:");
  const request = vi.fn(async () => ({ id: "999" }));
  const capabilities = vi.fn(async () => ({
    messaging: true,
    privateReplies: true,
    commentManagement: true,
    publishing: true,
    insights: true,
    webhooks: true,
  }));
  const ownedComment = vi.fn(async (commentId: string) => ({
    comment: {
      id: commentId,
      media: { id: "888" },
      from: { id: "111", username: "traveler" },
    },
    media: {
      id: "888",
      owner: { id: config.INSTAGRAM_ACCOUNT_ID },
      permalink: "https://www.instagram.com/p/example/",
      media_type: "IMAGE",
    },
  }));
  const meta = {
    request,
    capabilities,
    ownedComment,
  } as unknown as MetaClient;
  const service = new InstagramService(
    config,
    store,
    meta,
    pino({ enabled: false }),
  );
  return {
    config,
    store,
    meta,
    request,
    capabilities,
    ownedComment,
    service,
  };
}
