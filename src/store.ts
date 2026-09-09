import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Kysely,
  SqliteDialect,
  type Generated,
  type Transaction,
} from "kysely";
export interface ActionRow {
  id: string;
  account: string;
  principal: string;
  principal_source: "stdio" | "bridge";
  action: string;
  target: string;
  fingerprint: string;
  idempotency_key: string;
  payload: string;
  status:
    | "pending"
    | "executing"
    | "succeeded"
    | "rejected"
    | "failed"
    | "uncertain"
    | "expired";
  created_at: number;
  expires_at: number;
  result: string | null;
  error: string | null;
}
export interface AccountRow {
  id: Generated<number>;
  account: string;
  instagram_user_id: string;
  username: string | null;
  profile_url: string | null;
  first_contacted_at: number;
  last_contacted_at: number;
  interaction_count: number;
}
export interface PostRow {
  id: Generated<number>;
  account: string;
  instagram_media_id: string;
  instagram_user_id: string | null;
  username: string | null;
  post_url: string;
  comment_id: string;
  comment_text: string;
  commented_at: number;
  action_id: string;
}
interface Db {
  actions: ActionRow;
  accounts: AccountRow;
  commented_posts: PostRow;
  audit: {
    id: Generated<number>;
    action_id: string;
    timestamp: number;
    principal: string;
    tool: string;
    target: string;
    decision: string;
    status: string;
    latency_ms: number;
    error: string | null;
  };
  inbound: { account: string; sender: string; timestamp: number };
  inbound_comments: {
    account: string;
    comment_id: string;
    sender: string | null;
    media_id: string | null;
    timestamp: number;
    used_at: number | null;
    reserved_action_id: string | null;
  };
  events: {
    id: string;
    account: string;
    kind: string;
    sender: string | null;
    target: string | null;
    timestamp: number;
  };
  locks: { id: number; stamp: number };
  settings: { name: string; value: string };
}
export type DbConnection = Kysely<Db> | Transaction<Db>;
export class Store {
  readonly db: Kysely<Db>;
  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    }
    const sqlite = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS locks(id INTEGER PRIMARY KEY,stamp INTEGER NOT NULL); INSERT OR IGNORE INTO locks VALUES(1,0);
 CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,account TEXT NOT NULL,principal TEXT NOT NULL,principal_source TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,fingerprint TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,result TEXT,error TEXT,UNIQUE(account,principal,principal_source,idempotency_key));
 CREATE INDEX IF NOT EXISTS action_history ON actions(account,created_at,status);
 CREATE INDEX IF NOT EXISTS action_fingerprint ON actions(account,fingerprint,created_at);
 CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,account TEXT NOT NULL,instagram_user_id TEXT NOT NULL,username TEXT,profile_url TEXT,first_contacted_at INTEGER NOT NULL,last_contacted_at INTEGER NOT NULL,interaction_count INTEGER NOT NULL,UNIQUE(account,instagram_user_id));
 CREATE TABLE IF NOT EXISTS commented_posts(id INTEGER PRIMARY KEY,account TEXT NOT NULL,instagram_media_id TEXT NOT NULL,instagram_user_id TEXT,username TEXT,post_url TEXT NOT NULL,comment_id TEXT NOT NULL,comment_text TEXT NOT NULL,commented_at INTEGER NOT NULL,action_id TEXT UNIQUE NOT NULL);
 CREATE INDEX IF NOT EXISTS post_history ON commented_posts(account,instagram_media_id,commented_at);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action_id TEXT NOT NULL,timestamp INTEGER NOT NULL,principal TEXT NOT NULL,tool TEXT NOT NULL,target TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,latency_ms INTEGER NOT NULL,error TEXT);
 CREATE TABLE IF NOT EXISTS inbound(account TEXT NOT NULL,sender TEXT NOT NULL,timestamp INTEGER NOT NULL,PRIMARY KEY(account,sender));
 CREATE TABLE IF NOT EXISTS inbound_comments(account TEXT NOT NULL,comment_id TEXT NOT NULL,sender TEXT,media_id TEXT,timestamp INTEGER NOT NULL,used_at INTEGER,reserved_action_id TEXT,PRIMARY KEY(account,comment_id));
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,account TEXT NOT NULL,kind TEXT NOT NULL,sender TEXT,target TEXT,timestamp INTEGER NOT NULL);`);
    // Kysely's SQLite dialect expects the better-sqlite3 statement shape. Node's
    // native driver exposes column metadata instead; this adapter owns that seam.
    this.db = new Kysely<Db>({
      dialect: new SqliteDialect({
        database: {
          close: () => sqlite.close(),
          prepare: (sql: string) => {
            const stmt = sqlite.prepare(sql);
            return {
              reader: stmt.columns().length > 0,
              all: (parameters: ReadonlyArray<unknown>) =>
                stmt.all(...(parameters as Parameters<typeof stmt.all>)),
              run: (parameters: ReadonlyArray<unknown>) =>
                stmt.run(...(parameters as Parameters<typeof stmt.run>)),
              iterate: (parameters: ReadonlyArray<unknown>) =>
                stmt.iterate(
                  ...(parameters as Parameters<typeof stmt.iterate>),
                ),
            };
          },
        },
      }),
    });
  }
  async atomic<T>(fn: (db: Transaction<Db>) => Promise<T>) {
    return this.db.transaction().execute(async (db) => {
      // Acquire SQLite's write lock before reading policy state. Concurrent service
      // processes cannot both pass duplicate/rate checks against the same snapshot.
      await db
        .updateTable("locks")
        .set({ stamp: Date.now() })
        .where("id", "=", 1)
        .execute();
      return fn(db);
    });
  }
  async writesBlocked() {
    return (
      (
        await this.db
          .selectFrom("settings")
          .select("value")
          .where("name", "=", "writes_blocked")
          .executeTakeFirst()
      )?.value === "true"
    );
  }
  async stopWrites() {
    await this.db
      .insertInto("settings")
      .values({ name: "writes_blocked", value: "true" })
      .onConflict((c) => c.column("name").doUpdateSet({ value: "true" }))
      .execute();
  }
  async close() {
    await this.db.destroy();
  }
}
