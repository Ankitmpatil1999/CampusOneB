/**
 * The CampusOne and CUG databases (client 2026-10-21; migration 0081, db/cug-tables.ts): which queries
 * go to the CUG database, how migrations name it, and that later migrations keep naming it.
 */
import { join } from 'node:path';
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  sql,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  CUG_TABLES,
  cugDatabaseOf,
  databaseOfUrl,
  isCugTable,
  qualifyCugSql,
} from '../db/cug-tables';
import {
  CUG_PLACEHOLDER,
  migrate,
  parseMigrationFiles,
  readMigrationDir,
  type MigrationExecutor,
} from '../db/migrator';
import { CugSchemaPlugin } from '../models/cug-schema-plugin';
import type { Database } from '../models/campusone_models';

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new MysqlIntrospector(k),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  },
  plugins: [new CugSchemaPlugin('campusone_cug')],
});

describe('CUG tables in queries', () => {
  it('sends school tables to the CUG database and leaves CampusOne tables as written', () => {
    const q = db
      .selectFrom('wallets as w')
      .innerJoin('member_profiles as m', 'm.id', 'w.owner_profile_id')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['w.id', 'a.mobile'])
      .where('w.kind', '=', 'CAMPUS')
      .compile().sql;
    expect(q).toContain('from `campusone_cug`.`wallets` as `w`');
    expect(q).toContain('inner join `campusone_cug`.`member_profiles` as `m`');
    expect(q).toContain('inner join `platform_accounts` as `a`');
    expect(q).toContain('`w`.`kind`');
  });

  it('qualifies inserts, updates, deletes and table.column references', () => {
    expect(
      db
        .insertInto('cards')
        .values({} as never)
        .compile().sql,
    ).toMatch(/^insert into `campusone_cug`\.`cards`/);
    expect(
      db
        .updateTable('fee_records')
        .set({ remarks: 'x' })
        .where('fee_records.id', '=', '1')
        .compile().sql,
    ).toBe(
      'update `campusone_cug`.`fee_records` set `remarks` = ? where `campusone_cug`.`fee_records`.`id` = ?',
    );
    expect(db.deleteFrom('sessions').where('id', '=', '1').compile().sql).toBe(
      'delete from `sessions` where `id` = ?',
    );
  });

  it('leaves a common table expression of the same name alone', () => {
    const q = db
      .with('cards', (w) => w.selectFrom('cards').select('id'))
      .selectFrom('cards')
      .select('id')
      .compile().sql;
    expect(q).toBe(
      'with `cards` as (select `id` from `campusone_cug`.`cards`) select `id` from `cards`',
    );
  });

  it('qualifies table names in raw sql, never columns or qualified names', () => {
    const raw = sql`SELECT COUNT(*) FROM fee_records r JOIN classes c ON c.id = r.class_id
      WHERE EXISTS (SELECT 1 FROM approval_requests ar) AND r.year_id = ${1}`;
    const q = db.selectNoFrom(raw.as('n')).compile().sql;
    expect(q).toContain('FROM `campusone_cug`.`fee_records` r JOIN `campusone_cug`.`classes` c');
    expect(q).toContain('FROM approval_requests ar');
    expect(
      qualifyCugSql(
        'INSERT INTO marks (a) VALUES (1) ON DUPLICATE KEY UPDATE marks = 2, cards=3',
        'x_cug',
      ),
    ).toBe('INSERT INTO `x_cug`.`marks` (a) VALUES (1) ON DUPLICATE KEY UPDATE marks = 2, cards=3');
    expect(qualifyCugSql('UPDATE other.wallets SET a = 1', 'x_cug')).toBe(
      'UPDATE other.wallets SET a = 1',
    );
    expect(qualifyCugSql('SELECT x FROM `wallets` w FOR UPDATE', 'x_cug')).toBe(
      'SELECT x FROM `x_cug`.`wallets` w FOR UPDATE',
    );
  });

  it('names the CUG database after the CampusOne one', () => {
    expect(databaseOfUrl('mysql://u:p@db.local:3306/campusone?charset=utf8mb4')).toBe('campusone');
    expect(cugDatabaseOf('campusone')).toBe('campusone_cug');
    expect(() => databaseOfUrl('mysql://u:p@db.local:3306/')).toThrow();
    expect(new Set(CUG_TABLES).size).toBe(CUG_TABLES.length);
    expect(isCugTable('institutions') && !isCugTable('platform_accounts')).toBe(true);
  });
});

describe('migrations and the CUG database', () => {
  it('fills in {{CUG}} with the database beside the connection’s', async () => {
    const scripts: string[] = [];
    const ex: MigrationExecutor = {
      async query<T>(q: string): Promise<T[]> {
        if (q.startsWith('SELECT GET_LOCK')) return [{ got: 1 }] as T[];
        if (q.startsWith('SELECT DATABASE()')) return [{ d: 'campusone_it_x' }] as T[];
        return [];
      },
      async script(s: string) {
        scripts.push(s);
      },
    };
    await migrate(
      ex,
      parseMigrationFiles([
        { name: '0001_a.sql', sql: 'CREATE TABLE a (id INT);' },
        { name: '0002_b.sql', sql: `RENAME TABLE a TO ${CUG_PLACEHOLDER}.a;` },
      ]),
      { appliedBy: 'test' },
    );
    expect(scripts).toEqual(['CREATE TABLE a (id INT);', 'RENAME TABLE a TO `campusone_it_x_cug`.a;']);
  });

  it('every migration after 0081 names the CUG database for school tables', () => {
    const files = readMigrationDir(join(import.meta.dirname, '..', 'db', 'migrations')).filter(
      (f) => f.version > '0081',
    );
    const wrong: string[] = [];
    for (const f of files) {
      const text = f.sql.replace(/--.*$/gm, '');
      for (const m of text.matchAll(
        /\b(FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|ON)\s+(\{\{CUG\}\}\.)?`?([a-z_0-9]+)`?/gi,
      )) {
        if (!m[2] && isCugTable(m[3]!)) wrong.push(`${f.fileName}: ${m[0]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
