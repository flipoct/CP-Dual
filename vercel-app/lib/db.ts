import { Pool, types } from 'pg';

// Timestamps are stored as BIGINT milliseconds. node-postgres hands int8 back as
// a string by default, which would break every arithmetic comparison we do.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

let pool: Pool | null = null;

function connectionString() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL;
  if (!url) throw new Error('데이터베이스 연결이 설정되지 않았습니다. DATABASE_URL 환경변수를 확인해주세요.');
  return url;
}

function getPool() {
  if (pool) return pool;
  const url = connectionString();
  const local = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    // Serverless invocations are short-lived; a small pool keeps the database
    // from running out of connections when many of them are warm at once.
    // Lower it via PGPOOL_MAX when the plan has a tight connection limit.
    max: Number(process.env.PGPOOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: local || url.includes('sslmode=disable') ? undefined : { rejectUnauthorized: true },
  });
  return pool;
}

/**
 * Rewrites `?` placeholders into Postgres `$n` positions. None of our statements
 * contain a literal question mark inside a string literal, so a plain scan is enough.
 */
function toPositional(text: string) {
  let index = 0;
  return text.replace(/\?/g, () => `$${(index += 1)}`);
}

export class Statement {
  constructor(readonly text: string, readonly values: unknown[] = []) {}

  bind(...values: unknown[]) {
    return new Statement(this.text, values);
  }

  async first<T>(): Promise<T | null> {
    const result = await getPool().query(toPositional(this.text), this.values);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const result = await getPool().query(toPositional(this.text), this.values);
    return { results: result.rows as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = await getPool().query(toPositional(this.text), this.values);
    return { meta: { changes: result.rowCount ?? 0 } };
  }
}

export const db = {
  prepare(text: string) {
    return new Statement(text);
  },
  /** Runs the statements in one transaction, mirroring D1's all-or-nothing batch. */
  async batch(statements: Statement[]) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const statement of statements) {
        results.push(await client.query(toPositional(statement.text), statement.values));
      }
      await client.query('COMMIT');
      return results.map((result) => ({ meta: { changes: result.rowCount ?? 0 } }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
};
