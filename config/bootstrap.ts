/**
 * Shared start-up for the API and the worker (ADR-0002): validated configuration (fail fast),
 * loggers, metrics, database, optional Redis, dependency checks, the migrations-applied gate,
 * graceful shutdown and process-level handlers (brief §7.1, §7.3).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { ConfigError, loadConfig, type Config } from './config';
import { createLoggers, type Loggers } from '../controllers/logger';
import { createMetrics, setProcessMetrics, type Metrics } from '../utils/metrics';
import { registerDatabaseGauges } from '../utils/metrics-db';
import { createDatabase, type DatabaseHandle } from '../models/database';
import { compare, readMigrationDir, type AppliedMigration } from '../db/migrator';
import type { DependencyCheck } from '../services/health.service';

export interface Runtime {
  readonly config: Config;
  readonly loggers: Loggers;
  readonly metrics: Metrics;
  readonly database: DatabaseHandle;
  readonly redis?: Redis;
  readonly dependencyChecks: readonly DependencyCheck[];
}

export function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      // Logger is not configured yet; the problems name keys only, never values.
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

export function createRuntime(config: Config, processName: 'api' | 'worker'): Runtime {
  const loggers = createLoggers({
    level: config.log.level,
    ...(config.log.dir ? { dir: config.log.dir } : {}),
    retentionDays: config.log.retentionDays,
  });
  const metrics = createMetrics();
  const database = createDatabase(
    { url: config.db.url, poolSize: config.db.poolSize },
    loggers,
    metrics,
  );
  // Code without a request (payment engine, jobs, the communication log) records here.
  setProcessMetrics(metrics);
  registerDatabaseGauges(metrics, database.db);
  let redis: Redis | undefined;
  if (config.redis.url) {
    redis = new Redis(config.redis.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    redis.on('error', (e: Error) => loggers.app.warn('redis error', { error: e.message }));
  } else {
    loggers.app.warn(
      `${processName}: REDIS_URL not set — in-memory rate limits (single instance only, docs/03 §12 fallback)`,
    );
  }
  const dependencyChecks: DependencyCheck[] = [
    { name: 'mysql', required: true, check: () => database.ping(config.health.timeoutMs) },
    {
      name: 'redis',
      required: Boolean(redis),
      ...(redis ? { check: async () => void (await redis.ping()) } : {}),
    },
    // Object storage and KMS adapters arrive with files (Phase 2) and field encryption (Phase 2).
    { name: 'objectStorage', required: false },
    { name: 'kms', required: false },
  ];
  return { config, loggers, metrics, database, ...(redis ? { redis } : {}), dependencyChecks };
}

/** Finds the migrations: db/migrations next to the bundle (dist/db/migrations) or in the project. */
export function migrationsDir(): string {
  const here = import.meta.dirname;
  const candidates = [
    process.env['MIGRATIONS_DIR'],
    join(here, 'db', 'migrations'),
    resolve(here, '../db/migrations'),
    resolve(process.cwd(), 'db/migrations'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('db/migrations not found (set MIGRATIONS_DIR)');
  return found;
}

/**
 * Start-up gate (PLT-003): the API serves only once every migration file is applied unchanged.
 * Polls until true; returns a stop function.
 */
export function waitForSchema(
  runtime: Runtime,
  onReady: () => void,
  intervalMs = 15_000,
): () => void {
  const files = readMigrationDir(migrationsDir());
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const attempt = async () => {
    try {
      const applied = (await runtime.database.db
        .selectFrom('schema_migrations')
        .select(['version', 'checksum'])
        .execute()) as AppliedMigration[];
      const rows = compare(files, applied);
      const notReady = rows.filter((r) => r.state !== 'applied');
      if (notReady.length === 0) {
        runtime.loggers.app.info('schema up to date', { migrations: rows.length });
        onReady();
        return;
      }
      runtime.loggers.app.error('schema not up to date — run `npm run db:migrate`', {
        problems: notReady.map((r) => `${r.version}:${r.state}`),
      });
    } catch (e) {
      runtime.loggers.app.error('schema check failed', {
        error: e instanceof Error ? e.message : 'error',
      });
    }
    if (!stopped) timer = setTimeout(() => void attempt(), intervalMs);
  };
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** SIGTERM/SIGINT → stop accepting work, drain, close pools; force exit after the grace period. */
export function installShutdown(
  runtime: Runtime,
  stopAccepting: () => Promise<void>,
): (code?: number) => Promise<void> {
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.loggers.app.info('shutting down', { graceMs: runtime.config.shutdownGraceMs });
    const force = setTimeout(() => {
      runtime.loggers.app.error('graceful shutdown timed out — forcing exit');
      process.exit(code || 1);
    }, runtime.config.shutdownGraceMs);
    force.unref();
    try {
      await stopAccepting();
      await runtime.database.close();
      runtime.redis?.disconnect();
    } finally {
      clearTimeout(force);
      process.exit(code);
    }
  };
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
  process.on('unhandledRejection', (reason) => {
    runtime.loggers.app.error('unhandled rejection', {
      error:
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : String(reason),
    });
    void shutdown(1);
  });
  process.on('uncaughtException', (err) => {
    runtime.loggers.app.error('uncaught exception', {
      error: { name: err.name, message: err.message, stack: err.stack },
    });
    void shutdown(1);
  });
  return shutdown;
}
