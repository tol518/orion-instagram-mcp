import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/tools.js";
import { createHarness, principal } from "./helpers.js";

const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

describe("MCP contract", () => {
  it("initializes, filters tools by permission, and invokes read and dry-run writes", async () => {
    const { service, store } = createHarness({ DRY_RUN: true });
    const limitedPrincipal = {
      ...principal,
      permissions: ["history.read", "comments.write"] as const,
    };
    const server = createMcpServer(service, {
      id: limitedPrincipal.id,
      source: "stdio",
      permissions: [...limitedPrincipal.permissions],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    resources.push(client, server, store);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "instagram_get_pending_actions",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "instagram_reply_to_comment",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "instagram_get_messages",
    );

    const read = await client.callTool({
      name: "instagram_get_pending_actions",
      arguments: { limit: 20, offset: 0 },
    });
    expect(read.structuredContent).toEqual({ data: [] });

    const write = await client.callTool({
      name: "instagram_reply_to_comment",
      arguments: {
        comment_id: "123",
        message: "Thank you",
        idempotency_key: "mcp-reply-123",
      },
    });
    expect(write.structuredContent).toMatchObject({
      success: true,
      dry_run: true,
      would_execute: true,
    });
  });
});
