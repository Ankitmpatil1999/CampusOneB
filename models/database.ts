/**
 * MySQL access (D-04, ADR-0007): mysql2 pool + Kysely, parameterised SQL only.
 * - `supportBigNumbers` + `bigNumberStrings`: BIGINT (paise, ids) never becomes a float (ADR-0004).
 * - `decimalNumbers: false`, `timezone: 'Z'`: no float decimals, UTC on the wire.
 * - Query logging records SQL text and duration only — never parameters (they may hold PII).
 * - Two databases on one server (client 2026-10-21; db/cug-tables.ts): the connection opens the CampusOne
 *   database of the URL; CugSchemaPlugin sends the school tables to its CUG database (`<name>_cug`).
 */
import { createPool, type Pool } from 'mysql2';
import { Kysely, MysqlDialect, sql } from 'kysely';
import type { Loggers } from '../controllers/logger';
import type { Metrics } from '../utils/metrics';
import { cugDatabaseOf, databaseOfUrl } from '../db/cug-tables';
import { CugSchemaPlugin } from './cug-schema-plugin';
import type { Database } from './campusone_models';

export interface DatabaseHandle {
  readonly db: Kysely<Database>;
  /** The CUG database beside the CampusOne one (`campusone` → `campusone_cug`). */
  readonly cugDatabase: string;
  ping(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly url: string;
  readonly poolSize: number;
  readonly slowQueryMs?: number;
}

export function createDatabase(
  opts: DatabaseOptions,
  loggers: Loggers,
  metrics?: Metrics,
): DatabaseHandle {
  const pool: Pool = createPool({
    uri: opts.url,
    connectionLimit: opts.poolSize,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    timezone: 'Z',
    charset: 'utf8mb4_0900_ai_ci',
    multipleStatements: false,
    connectTimeout: 10_000,
  });
  const slow = opts.slowQueryMs ?? 200;

  const cugDatabase = cugDatabaseOf(databaseOfUrl(opts.url));
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool }),
    plugins: [new CugSchemaPlugin(cugDatabase)],
    log(event) {
      const ms = event.queryDurationMillis;
      metrics?.observeDbQuery(ms / 1000, event.level === 'query');
      if (event.level === 'error') {
        loggers.database.error('query failed', {
          sql: event.query.sql,
          durationMs: ms,
          error:
            event.error instanceof Error
              ? { name: event.error.name, message: event.error.message }
              : 'error',
        });
      } else if (ms >= slow) {
        loggers.database.warn('slow query', { sql: event.query.sql, durationMs: ms });
      } else {
        loggers.database.debug('query', { sql: event.query.sql, durationMs: ms });
      }
    },
  });

  return {
    db,
    cugDatabase,
    async ping(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('mysql ping timed out')), timeoutMs);
      });
      try {
        await Promise.race([sql`SELECT 1`.execute(db), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await db.destroy();
    },
  };
}
