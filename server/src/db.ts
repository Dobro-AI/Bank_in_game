import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

/** Minimal query interface shared by real Postgres (prod) and PGlite (local dev, tests). */
export interface Tx {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// bigint columns come back as strings from node-postgres; game sums fit safely into JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

function pgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const res = await fn({ query: async (s, p) => (await client.query(s, p as any[])).rows });
        await client.query('commit');
        return res;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function pgliteDb(dataDir?: string): Db {
  const lite = new PGlite(dataDir);
  const norm = (rows: any[]) =>
    rows.map((r) => {
      for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
      return r;
    });
  return {
    async query(sql, params) {
      return norm((await lite.query(sql, params as any[])).rows as any[]);
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    transaction: (fn) =>
      lite.transaction((tx) => fn({ query: async (s, p) => norm((await tx.query(s, p as any[])).rows as any[]) })),
    close: () => lite.close(),
  };
}

export async function openDb(opts: { url?: string; dataDir?: string } = {}): Promise<Db> {
  const db = opts.url ? pgDb(opts.url) : pgliteDb(opts.dataDir);
  const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await db.exec(schema);
  return db;
}

/** Thrown for business-rule violations; mapped to HTTP 400/403/404 with a message for the user. */
export class AppError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function isUniqueViolation(e: unknown) {
  return (e as any)?.code === '23505';
}
