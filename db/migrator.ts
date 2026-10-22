/**
 * Forward-only SQL migration runner (D-16, brief §4.3).
 *
 * - Files `db/migrations/NNNN_description.sql`, applied in version order by the migrator user.
 * - Each applied file is recorded with its SHA-256; an applied file that has changed is refused
 *   (migrations are never edited — write a new one: expand → migrate → contract).
 * - A MySQL advisory lock serialises concurrent runs (several pods starting together).
 * - MySQL DDL is not transactional: keep each file small; a failure stops the run with the
 *   failing version named.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cugDatabaseOf } from './cug-tables';

/** Stands for the CUG database in a migration (filled in by `migrate`). */
export const CUG_PLACEHOLDER = '{{CUG}}';

export interface MigrationFile {
  readonly version: string;
  readonly description: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

/** The minimal database surface the runner needs (MySQL in production, a fake in unit tests). */
export interface MigrationExecutor {
  /** Runs one statement and returns rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a multi-statement script. */
  script(sql: string): Promise<void>;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
export const MIGRATION_LOCK = 'ringpe.schema_migrations';

export function checksumOf(sql: string): string {
  // Line endings are normalised so a Windows checkout produces the same checksum (.gitattributes).
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function parseMigrationFiles(
  files: readonly { name: string; sql: string }[],
): MigrationFile[] {
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = FILE_PATTERN.exec(f.name);
    if (!m?.[1] || !m[2]) {
      if (f.name.endsWith('.sql')) throw new Error(`Migration file name not allowed: ${f.name}`);
      continue;
    }
    out.push({
      version: m[1],
      description: m[2].replace(/_/g, ' '),
      fileName: f.name,
      sql: f.sql,
      checksum: checksumOf(f.sql),
    });
  }
  out.sort((a, b) => a.version.localeCompare(b.version));
  for (let i = 1; i < out.length; i++) {
    if (out[i]?.version === out[i - 1]?.version) {
      throw new Error(`Duplicate migration version ${out[i]?.version ?? ''}`);
    }
  }
  return out;
}

export function readMigrationDir(dir: string): MigrationFile[] {
  return parseMigrationFiles(
    readdirSync(dir)
      .filter((n) => n.endsWith('.sql'))
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
  );
}

export type MigrationState = 'applied' | 'pending' | 'changed' | 'missing-file';

export interface MigrationStatusRow {
  readonly version: string;
  readonly description: string;
  readonly state: MigrationState;
}

export function compare(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationStatusRow[] {
  const byVersion = new Map(applied.map((a) => [a.version, a]));
  const rows: MigrationStatusRow[] = files.map((f) => {
    const a = byVersion.get(f.version);
    const state: MigrationState = !a
      ? 'pending'
      : a.checksum === f.checksum
        ? 'applied'
        : 'changed';
    return { version: f.version, description: f.description, state };
  });
  const known = new Set(files.map((f) => f.version));
  for (const a of applied) {
    if (!known.has(a.version))
      rows.push({ version: a.version, description: '?', state: 'missing-file' });
  }
  return rows.sort((x, y) => x.version.localeCompare(y.version));
}

const ENSURE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version      VARCHAR(64)  NOT NULL,
  description  VARCHAR(200) NOT NULL,
  checksum     CHAR(64)     NOT NULL,
  applied_at   DATETIME(3)  NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  applied_by   VARCHAR(64)  NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

async function readApplied(ex: MigrationExecutor): Promise<AppliedMigration[]> {
  await ex.query(ENSURE_TABLE);
  return ex.query<AppliedMigration>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
}

export async function migrationStatus(
  ex: MigrationExecutor,
  files: readonly MigrationFile[],
): Promise<MigrationStatusRow[]> {
  return compare(files, await readApplied(ex));
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

export async function migrate(
  ex: MigrationExecutor,
  files: readonly MigrationFile[],
  opts: { appliedBy: string; lockTimeoutSeconds?: number; log?: (line: string) => void },
): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  // One lock per database: migrations of different databases never wait for each other.
  const [lock] = await ex.query<{ got: number | string | null }>(
    "SELECT GET_LOCK(LEFT(CONCAT(?, ':', COALESCE(DATABASE(), '')), 64), ?) AS got",
    [MIGRATION_LOCK, opts.lockTimeoutSeconds ?? 60],
  );
  if (Number(lock?.got) !== 1) throw new Error('Could not obtain the migration lock');
  try {
    const rows = compare(files, await readApplied(ex));
    const changed = rows.filter((r) => r.state === 'changed');
    if (changed.length) {
      throw new Error(
        `Applied migrations were edited: ${changed.map((r) => r.version).join(', ')}. ` +
          'Never edit an applied migration; add a new one.',
      );
    }
    const pending = files.filter(
      (f) => rows.find((r) => r.version === f.version)?.state === 'pending',
    );
    const done: string[] = [];
    // `{{CUG}}` in a migration is the CUG database beside this one (db/cug-tables.ts, client
    // 2026-10-21): `ringpe` → `ringpe_cug`. It is filled in as the file runs (its checksum is the file's).
    let cug: string | null = null;
    const cugOf = async () => {
      if (cug === null) {
        const [row] = await ex.query<{ d: string | null }>('SELECT DATABASE() AS d');
        if (!row?.d) throw new Error('{{CUG}} needs the connection to name its database');
        cug = `\`${cugDatabaseOf(row.d)}\``;
      }
      return cug;
    };
    for (const f of pending) {
      log(`applying ${f.fileName}`);
      try {
        await ex.script(
          f.sql.includes(CUG_PLACEHOLDER)
            ? f.sql.split(CUG_PLACEHOLDER).join(await cugOf())
            : f.sql,
        );
      } catch (e) {
        throw new Error(
          `Migration ${f.fileName} failed: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
      await ex.query(
        'INSERT INTO schema_migrations (version, description, checksum, applied_by) VALUES (?, ?, ?, ?)',
        [f.version, f.description, f.checksum, opts.appliedBy],
      );
      done.push(f.version);
    }
    return { applied: done, alreadyApplied: rows.filter((r) => r.state === 'applied').length };
  } finally {
    await ex.query("SELECT RELEASE_LOCK(LEFT(CONCAT(?, ':', COALESCE(DATABASE(), '')), 64))", [
      MIGRATION_LOCK,
    ]);
  }
}
