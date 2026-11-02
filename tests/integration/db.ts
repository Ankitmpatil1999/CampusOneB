/**
 * Throwaway MySQL schemas for integration tests (brief §7.6). Needs TEST_DB_MIGRATOR_URL with
 * CREATE/DROP DATABASE; each call creates `campusone_it_<random>` holding every migration and the
 * reference seeds, and drops the schema afterwards.
 *
 * Applying all the migrations takes most of a minute, so it is done once per set of migration files
 * into a template schema (`campusone_it_tpl_<hash>`, built under a MySQL lock so parallel workers wait for
 * one build); each test schema is then copied from it — tables (with their keys, checks, partitions and
 * auto-increment positions), rows, then triggers. The migrations suite still migrates from scratch.
 *
 * Since migration 0081 each schema has its CUG database beside it (`<name>_cug`, db/cug-tables.ts):
 * both are built, copied (the database names inside cross-database keys and triggers follow) and
 * dropped together — with foreign-key checks off, as each references the other.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { sql } from 'kysely';
import { cugDatabaseOf } from '../../db/cug-tables';
import { migrate, readMigrationDir } from '../../db/migrator';
import { openMigrationConnection } from '../../db/mysql-executor';
import { renderReferenceSeedSql } from '../../db/reference-seed';
import { createDatabase, type DatabaseHandle } from '../../models/database';
import { capturingLoggers } from '../helpers';
import { newPublicIdPair } from '../../utils/idGenerator';

export const adminUrl = process.env['TEST_DB_MIGRATOR_URL'];

export interface TestDatabase {
  readonly url: string;
  readonly handle: DatabaseHandle;
  readonly db: DatabaseHandle['db'];
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!adminUrl) throw new Error('TEST_DB_MIGRATOR_URL is not set');
  const name = `campusone_it_${randomBytes(4).toString('hex')}`;
  const admin = await createConnection({ uri: adminUrl });
  for (const db of [name, cugDatabaseOf(name)]) {
    await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  }
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();

  await copyTemplate(await template(), url);

  const handle = createDatabase({ url, poolSize: 5 }, capturingLoggers().loggers);
  return {
    url,
    handle,
    db: handle.db,
    async drop() {
      await handle.close();
      await dropPair(name);
    },
  };
}

const withDb = (name: string) => {
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  return u.toString();
};

/** The migrated and seeded template schema for the current migration files (built once). */
async function template(): Promise<string> {
  const files = readMigrationDir(join(import.meta.dirname, '../../db/migrations'));
  const seed = renderReferenceSeedSql();
  const hash = createHash('sha256')
    .update(files.map((f) => `${f.fileName}:${f.checksum}`).join('|'))
    .update(seed)
    .digest('hex')
    .slice(0, 12);
  const name = `campusone_it_tpl_${hash}`;
  const admin = await createConnection({ uri: adminUrl! });
  try {
    await admin.query('SELECT GET_LOCK(?, 900)', [name]);
    try {
      const [ready] = await admin.query<RowDataPacket[]>(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = '_template_ready'`,
        [name],
      );
      if (!ready.length) {
        await dropPair(name);
        await admin.query(
          `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        const conn = await openMigrationConnection(withDb(name));
        try {
          await migrate(conn, files, { appliedBy: 'integration-test' });
          await conn.script(seed);
        } finally {
          await conn.close();
        }
        await admin.query(`CREATE TABLE \`${name}\`._template_ready (id INT PRIMARY KEY)`);
        // Templates of earlier migration sets are no longer needed.
        const [old] = await admin.query<RowDataPacket[]>(
          `SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'campusone\\_it\\_tpl\\_%' AND SCHEMA_NAME <> ?`,
          [name],
        );
        for (const o of old) {
          const s = String(o['s']);
          if (!s.endsWith('_cug')) await dropPair(s);
        }
      }
    } finally {
      await admin.query('SELECT RELEASE_LOCK(?)', [name]);
    }
  } finally {
    await admin.end();
  }
  return name;
}

/** Drops a schema and its CUG database (each references the other: foreign-key checks off). */
async function dropPair(name: string) {
  const a = await createConnection({ uri: adminUrl!, multipleStatements: true });
  try {
    await a.query(
      `SET FOREIGN_KEY_CHECKS = 0; DROP DATABASE IF EXISTS \`${name}\`; DROP DATABASE IF EXISTS \`${cugDatabaseOf(name)}\`; SET FOREIGN_KEY_CHECKS = 1;`,
    );
  } finally {
    await a.end();
  }
}

/**
 * Copies the template's tables, rows and triggers into the (empty) schema at `url` and its CUG
 * database; the template's database names inside keys and triggers become the copy's.
 */
async function copyTemplate(tpl: string, url: string) {
  const c = await createConnection({ uri: url, multipleStatements: true });
  try {
    const [[me]] = await c.query<RowDataPacket[]>('SELECT DATABASE() AS d');
    const target = String(me!['d']);
    const pairs = [
      { from: tpl, to: target },
      { from: cugDatabaseOf(tpl), to: cugDatabaseOf(target) },
    ];
    const rename = (text: string) =>
      pairs.reduce((t, p) => t.split(`\`${p.from}\`.`).join(`\`${p.to}\`.`), text);
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { from, to } of pairs) {
      const [tables] = await c.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS t FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '_template_ready'
          ORDER BY TABLE_NAME`,
        [from],
      );
      for (const { t } of tables) {
        const [[row]] = await c.query<RowDataPacket[]>(
          `SHOW CREATE TABLE \`${from}\`.\`${String(t)}\``,
        );
        const ddl = rename(String(row!['Create Table'])).replace(
          /^CREATE TABLE `[^`]+`/,
          `CREATE TABLE \`${to}\`.\`${String(t)}\``,
        );
        await c.query(ddl);
      }
      const [cols] = await c.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, EXTRA AS x FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [from],
      );
      const byTable = new Map<string, string[]>();
      for (const col of cols) {
        if (/\b(VIRTUAL|STORED) GENERATED\b/i.test(String(col['x'] ?? ''))) continue;
        const list = byTable.get(String(col['t'])) ?? [];
        list.push(`\`${String(col['c'])}\``);
        byTable.set(String(col['t']), list);
      }
      const inserts = tables
        .map(({ t }) => {
          const list = (byTable.get(String(t)) ?? []).join(', ');
          return `INSERT INTO \`${to}\`.\`${String(t)}\` (${list}) SELECT ${list} FROM \`${from}\`.\`${String(t)}\`;`;
        })
        .join('\n');
      if (inserts) await c.query(inserts);
    }
    for (const { from, to } of pairs) {
      // A trigger's stored statement names its table without the database: create it from there.
      await c.query(`USE \`${to}\``);
      const [triggers] = await c.query<RowDataPacket[]>(
        `SELECT TRIGGER_NAME AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
          ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
        [from],
      );
      for (const { t } of triggers) {
        const [[row]] = await c.query<RowDataPacket[]>(
          `SHOW CREATE TRIGGER \`${from}\`.\`${String(t)}\``,
        );
        await c.query(rename(String(row!['SQL Original Statement'])));
      }
    }
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await c.end();
  }
}

let counter = 0;

/** An institution row (minimum columns). Returns its internal and public ids. */
export async function insertInstitution(db: TestDatabase['db']) {
  counter += 1;
  const p = newPublicIdPair();
  const tag = `${process.pid % 1000}${counter}`.padStart(5, '0').slice(-5);
  const r = await db
    .insertInto('institutions' as never)
    .values({
      public_id: p.bin,
      identifier: `RPETST${tag}1026`,
      name: `Test School ${tag}`,
      short_name: 'TST',
      address_line1: 'Road',
      city: 'Bengaluru',
      state: 'KA',
      pin_code: '560001',
      name_address_key: sql`SHA2(${`${tag}-${Math.random()}`}, 256)`,
    } as never)
    .executeTakeFirstOrThrow();
  return { id: String(r.insertId), publicId: p.id };
}

/** A platform account (member-style mobile). Returns its internal and public ids. */
export async function insertAccount(db: TestDatabase['db'], mobile?: string) {
  counter += 1;
  const p = newPublicIdPair();
  const m = mobile ?? `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const r = await db
    .insertInto('platform_accounts')
    .values({ public_id: p.bin, mobile: m, first_name: 'Asha' })
    .executeTakeFirstOrThrow();
  return { id: String(r.insertId), publicId: p.id, mobile: m };
}
