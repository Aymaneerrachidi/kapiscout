import { createClient, type Client, type InValue } from "@libsql/client";

/**
 * Async SQLite driver backed by libSQL (Turso).
 *
 * Mirrors the slice of the `node:sqlite` API that {@link Store} uses, so the
 * existing SQL carries over verbatim — libSQL speaks the same dialect. The one
 * unavoidable difference is that every call returns a promise, because the
 * database now lives across the network instead of on local disk.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PreparedStatement {
  run(...args: unknown[]): Promise<RunResult>;
  get(...args: unknown[]): Promise<unknown>;
  all(...args: unknown[]): Promise<unknown[]>;
}

function toArgs(args: unknown[]): InValue[] {
  return args.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "bigint") return value;
    if (value instanceof Uint8Array) return value;
    if (value === null) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" || typeof value === "string") return value;
    return String(value);
  }) as InValue[];
}

/**
 * libSQL rows carry both positional and named keys plus a null prototype.
 * Flatten to a plain object so downstream `as SomeRow` casts behave the way
 * they did under node:sqlite.
 */
function plain(row: Record<string, unknown> | undefined): unknown {
  if (!row) return undefined;
  return { ...row };
}

export class SqlDatabase {
  private readonly client: Client;

  constructor(url: string, authToken?: string) {
    this.client = createClient(authToken ? { url, authToken } : { url });
  }

  async exec(sql: string): Promise<void> {
    const trimmed = sql.trim();
    // executeMultiple() rejects standalone transaction control, so route
    // single statements (BEGIN IMMEDIATE / COMMIT / ROLLBACK / PRAGMA) through
    // execute() instead.
    const withoutTrailing = trimmed.replace(/;$/, "");
    if (!withoutTrailing.includes(";")) {
      await this.client.execute(withoutTrailing);
      return;
    }
    await this.client.executeMultiple(trimmed);
  }

  prepare(sql: string): PreparedStatement {
    const client = this.client;
    return {
      async run(...args: unknown[]): Promise<RunResult> {
        const result = await client.execute({ sql, args: toArgs(args) });
        return {
          changes: Number(result.rowsAffected),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        };
      },
      async get(...args: unknown[]): Promise<unknown> {
        const result = await client.execute({ sql, args: toArgs(args) });
        return plain(result.rows[0] as Record<string, unknown> | undefined);
      },
      async all(...args: unknown[]): Promise<unknown[]> {
        const result = await client.execute({ sql, args: toArgs(args) });
        return result.rows.map((row) => plain(row as unknown as Record<string, unknown>));
      },
    };
  }

  close(): void {
    this.client.close();
  }
}

/**
 * Local file path (dev) or a Turso URL (production). `DB_PATH` keeps working
 * for local runs; set `TURSO_DATABASE_URL` to point at the hosted database.
 */
export function resolveDatabaseUrl(dbPath: string): { url: string; authToken?: string } {
  const remote = process.env.TURSO_DATABASE_URL?.trim();
  if (remote) {
    return { url: remote, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined };
  }
  return { url: dbPath.startsWith("file:") ? dbPath : `file:${dbPath}` };
}
