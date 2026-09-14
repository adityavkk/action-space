import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { Fault, type Context, type Work } from "./domain.js";
import { ContextSchema, WorkSchema, checkOutput } from "./schemas.js";

export interface Sql {
  query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}
export class Tx {
  constructor(readonly sql: Sql) {}
  async work(id: string): Promise<Work | undefined> {
    const row = (
      await this.sql.query<{ data: unknown }>(
        "SELECT data FROM work WHERE id=$1",
        [id],
      )
    ).rows[0];
    return row ? Schema.decodeUnknownSync(WorkSchema)(row.data) : undefined;
  }
  async byKey(tenant: string, key: string): Promise<Work | undefined> {
    const row = (
      await this.sql.query<{ data: unknown }>(
        "SELECT data FROM work WHERE tenant=$1 AND request_key=$2",
        [tenant, key],
      )
    ).rows[0];
    return row ? Schema.decodeUnknownSync(WorkSchema)(row.data) : undefined;
  }
  async works(): Promise<Work[]> {
    return (
      await this.sql.query<{ data: unknown }>("SELECT data FROM work")
    ).rows.map((x) => Schema.decodeUnknownSync(WorkSchema)(x.data));
  }
  async save(work: Work): Promise<void> {
    Schema.decodeUnknownSync(WorkSchema)(work);
    checkOutput(work);
    await this.sql.query(
      "INSERT INTO work(id,tenant,request_key,digest,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [work.id, work.tenant, work.key, work.digest, JSON.stringify(work)],
    );
    await this.sql.query(
      "INSERT INTO event(work_id,tenant,data) VALUES($1,$2,$3)",
      [
        work.id,
        work.tenant,
        JSON.stringify({ state: work.state, placement: work.placement }),
      ],
    );
  }
  async context(id: string): Promise<Context | undefined> {
    const row = (
      await this.sql.query<{ data: unknown }>(
        "SELECT data FROM context WHERE id=$1",
        [id],
      )
    ).rows[0];
    return row ? Schema.decodeUnknownSync(ContextSchema)(row.data) : undefined;
  }
  async contexts(): Promise<Context[]> {
    return (
      await this.sql.query<{ data: unknown }>("SELECT data FROM context")
    ).rows.map((x) => Schema.decodeUnknownSync(ContextSchema)(x.data));
  }
  async saveContext(context: Context): Promise<void> {
    await this.sql.query(
      "INSERT INTO context(id,tenant,owner,name,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [
        context.id,
        context.tenant,
        context.owner,
        context.name,
        JSON.stringify(context),
      ],
    );
  }
  async enqueue(id: string): Promise<void> {
    await this.sql.query(
      "INSERT INTO outbox(work_id,state) VALUES($1,'pending') ON CONFLICT(work_id) DO UPDATE SET state='pending'",
      [id],
    );
  }
}

/** One control-plane coordinator per database. Transactions also serialize independent claim loops. */
export class Journal {
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly sql: Sql,
    private readonly closeDb: () => Promise<void>,
    private readonly postgres: boolean,
  ) {}
  static async open(
    location: string,
    migrate = !location.startsWith("postgres"),
  ): Promise<Journal> {
    let journal: Journal;
    if (location.startsWith("postgres")) {
      const client = new pg.Client({ connectionString: location });
      await client.connect();
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(19487322) AS locked",
      );
      if (!lock.rows[0]?.locked) {
        await client.end();
        throw new Error("A coordinator already owns this database");
      }
      journal = new Journal(
        {
          query: async <T>(sql: string, args?: unknown[]) => ({
            rows: (await client.query(sql, args)).rows as T[],
          }),
        },
        () => client.end(),
        true,
      );
    } else {
      const db = new PGlite(location === ":memory:" ? undefined : location);
      await db.waitReady;
      journal = new Journal(
        { query: (sql, args) => db.query(sql, args) },
        () => db.close(),
        false,
      );
    }
    // Pre-release wire break: never reinterpret frozen submissions or mutate old evidence.
    try {
      const existing = await journal.sql.query<{ name: string | null }>(
        "SELECT to_regclass('public.work')::text AS name",
      );
      if (existing.rows[0]?.name) {
        const legacy = await journal.sql.query<{ found: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM work WHERE data->'demand' ? 'offering') AS found",
        );
        if (legacy.rows[0]?.found) {
          throw new Fault(
            "LEGACY_JOURNAL",
            "This database uses the retired offering API. Preserve it and select a fresh ACTION_SPACE_DATA or DATABASE_URL; no automatic evidence migration is performed.",
          );
        }
      }
      const migration = await readFile(
        new URL("../migrations/001_core.sql", import.meta.url).pathname.replace(
          "/dist/migrations/",
          "/migrations/",
        ),
        "utf8",
      );
      // Explicit local initializer only for PostgreSQL. All DDL commits or rolls back together.
      if (migrate)
        await journal.transaction(async (tx) => {
          for (const statement of migration.split(";").filter((x) => x.trim()))
            await tx.sql.query(statement);
        });
      return journal;
    } catch (error) {
      await journal.closeDb();
      throw error;
    }
  }
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      await this.sql.query("BEGIN");
      try {
        if (this.postgres)
          await this.sql.query("SELECT pg_advisory_xact_lock(19487323)");
        const value = await fn(new Tx(this.sql));
        await this.sql.query("COMMIT");
        return value;
      } catch (error) {
        await this.sql.query("ROLLBACK");
        throw error;
      }
    });
    this.chain = result.catch(() => {});
    return result;
  }
  async close(): Promise<void> {
    await this.chain;
    await this.closeDb();
  }
}
