import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { pino, destination } from "pino";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
import { MetaClient } from "./meta.js";
import { InstagramService } from "./service.js";
import { createMcpServer } from "./tools.js";
import { createHttp } from "./http.js";
export function createService() {
  const config = readConfig();
  const logger = pino({ level: "info" }, destination(2));
  return new InstagramService(
    config,
    new Store(config.INSTAGRAM_DB),
    new MetaClient(config),
    logger,
  );
}
async function main() {
  const service = createService();
  const http = process.argv.includes("--http")
    ? createHttp(service)
    : undefined;
  let stdio: ReturnType<typeof serveStdio> | undefined;
  if (http)
    await http.listen({
      host: service.config.INSTAGRAM_HOST,
      port: service.config.INSTAGRAM_PORT,
    });
  else
    stdio = serveStdio(() =>
      createMcpServer(service, {
        id: service.config.INSTAGRAM_AGENT_ID,
        source: "stdio",
        permissions: service.config.INSTAGRAM_AGENT_PERMISSIONS,
      }),
    );
  const close = async () => {
    await http?.close();
    await stdio?.close();
    await service.store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  if (!http) process.stdin.once("end", () => void close());
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  main().catch(() => {
    process.stderr.write(
      "Instagram MCP could not start. Check configuration and state directory permissions.\n",
    );
    process.exitCode = 1;
  });
