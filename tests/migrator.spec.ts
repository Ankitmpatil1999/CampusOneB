import { join } from 'node:path';
import {
  checksumOf,
  compare,
  migrate,
  migrationStatus,
  parseMigrationFiles,
  readMigrationDir,
  type MigrationExecutor,
} from '../db/migrator';

/** In-memory executor that understands the runner's few statements. */
function fakeExecutor(opts: { lock?: number; failOn?: string } = {}) {
  const applied: { version: string; checksum: string }[] = [];
  const scripts: string[] = [];
  const queries: string[] = [];
  const ex: MigrationExecutor = {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      queries.push(sql);
      if (sql.startsWith('SELECT GET_LOCK')) return [{ got: opts.lock ?? 1 }] as T[];
      if (sql.startsWith('SELECT version, checksum')) return [...applied] as T[];
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        applied.push({ version: String(params[0]), checksum: String(params[2]) });
      }
      return [];
    },
    async script(sql: string) {
      if (opts.failOn && sql.includes(opts.failOn)) throw new Error('boom');
      scripts.push(sql);
    },
  };
  return { ex, applied, scripts, queries };
}

const files = parseMigrationFiles([
  { name: '0002_second.sql', sql: 'CREATE TABLE b (id INT);' },
  { name: '0001_first.sql', sql: 'CREATE TABLE a (id INT);' },
  { name: 'README.txt', sql: 'ignored' },
]);

describe('migration files', () => {
  it('orders by version and checksums with normalised line endings', () => {
    expect(files.map((f) => f.version)).toEqual(['0001', '0002']);
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
  });

  it('refuses bad names and duplicate versions', () => {
    expect(() => parseMigrationFiles([{ name: '1_bad.sql', sql: '' }])).toThrow(/not allowed/);
    expect(() =>
      parseMigrationFiles([
        { name: '0001_a.sql', sql: '' },
        { name: '0001_b.sql', sql: '' },
      ]),
    ).toThrow(/Duplicate/);
  });

  it('keeps parentheses and quotes balanced in every repository migration', () => {
    const repo = readMigrationDir(join(import.meta.dirname, '../db/migrations'));
    for (const f of repo) {
      const code = f.sql
        .split('\n')
        .map((l) => l.replace(/--\s.*$/, ''))
        .join('\n')
        .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
      expect({ file: f.fileName, quotes: (code.match(/'/g) ?? []).length % 2 }).toEqual({
        file: f.fileName,
        quotes: 0,
      });
      let depth = 0;
      let negative = false;
      for (const ch of code) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth < 0) negative = true;
      }
      expect({ file: f.fileName, negative, depth }).toEqual({
        file: f.fileName,
        negative: false,
        depth: 0,
      });
    }
  });

  it('reads the repository migrations, numbered without gaps', () => {
    const repo = readMigrationDir(join(import.meta.dirname, '../db/migrations'));
    expect(repo.length).toBeGreaterThanOrEqual(5);
    expect(repo.map((f) => f.version)).toEqual(repo.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(repo[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
  });
});

describe('migrate', () => {
  it('applies pending files in order under the lock and records them', async () => {
    const { ex, applied, scripts, queries } = fakeExecutor();
    const result = await migrate(ex, files, { appliedBy: 'test' });
    expect(result.applied).toEqual(['0001', '0002']);
    expect(scripts).toEqual(['CREATE TABLE a (id INT);', 'CREATE TABLE b (id INT);']);
    expect(applied.map((a) => a.version)).toEqual(['0001', '0002']);
    expect(queries.at(-1)).toContain('RELEASE_LOCK');
  });

  it('is idempotent: a second run applies nothing', async () => {
    const { ex } = fakeExecutor();
    await migrate(ex, files, { appliedBy: 'test' });
    const again = await migrate(ex, files, { appliedBy: 'test' });
    expect(again).toEqual({ applied: [], alreadyApplied: 2 });
  });

  it('refuses when an applied migration was edited', async () => {
    const { ex } = fakeExecutor();
    await migrate(ex, files, { appliedBy: 'test' });
    const edited = parseMigrationFiles([
      { name: '0001_first.sql', sql: 'CREATE TABLE a (id BIGINT);' },
      { name: '0002_second.sql', sql: 'CREATE TABLE b (id INT);' },
    ]);
    await expect(migrate(ex, edited, { appliedBy: 'test' })).rejects.toThrow(/were edited: 0001/);
  });

  it('stops at a failing file, names it, and still releases the lock', async () => {
    const { ex, applied, queries } = fakeExecutor({ failOn: 'TABLE b' });
    await expect(migrate(ex, files, { appliedBy: 'test' })).rejects.toThrow(
      /0002_second.sql failed/,
    );
    expect(applied.map((a) => a.version)).toEqual(['0001']);
    expect(queries.at(-1)).toContain('RELEASE_LOCK');
  });

  it('refuses without the lock', async () => {
    const { ex } = fakeExecutor({ lock: 0 });
    await expect(migrate(ex, files, { appliedBy: 'test' })).rejects.toThrow(/lock/);
  });

  it('reports status including files missing from disk', async () => {
    const { ex } = fakeExecutor();
    await migrate(ex, files, { appliedBy: 'test' });
    const rows = await migrationStatus(ex, files.slice(0, 1));
    expect(rows).toEqual([
      { version: '0001', description: 'first', state: 'applied' },
      { version: '0002', description: '?', state: 'missing-file' },
    ]);
    expect(compare(files, [])[0]?.state).toBe('pending');
  });
});
