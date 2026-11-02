/**
 * Writes the triggers of a migrated database pair as SQL scripts, so they can be created on another
 * server (client 2026-10-09):
 *
 * - db/triggers/create-triggers.sql     — the CampusOne database's triggers;
 * - db/triggers/create-triggers-cug.sql — the CUG database's (the school tables, migration 0081).
 *
 * Each trigger is dropped if it exists and created again exactly as MySQL stores it, without DEFINER
 * (it then runs as the user who executes the script). Tables must already exist (run the migrations
 * or load the schema first).
 *
 *   npx tsx scripts/export-triggers.ts            (reads DATABASE_URL from .env)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { cugDatabaseOf, databaseOfUrl } from '../db/cug-tables';

const DIR = join(import.meta.dirname, '..', 'db', 'triggers');

async function exportOf(db: mysql.Connection, schema: string, file: string, which: string) {
  const [rows] = (await db.query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`,
    [schema],
  )) as unknown as [{ name: string; tbl: string }[]];
  const parts: string[] = [];
  for (const r of rows) {
    const [show] = (await db.query(
      `SHOW CREATE TRIGGER \`${schema}\`.\`${r.name}\``,
    )) as unknown as [Record<string, string>[]];
    const sql = String(show[0]!['SQL Original Statement'])
      .replace(/^CREATE\s+DEFINER\s*=\s*`[^`]*`@`[^`]*`\s+TRIGGER/i, 'CREATE TRIGGER')
      // The database the script is run against: never the one it was exported from.
      .split(`\`${schema}\`.`)
      .join('')
      .trim()
      .replace(/;\s*$/, '');
    parts.push(`-- ${r.tbl}\nDROP TRIGGER IF EXISTS \`${r.name}\`$$\n${sql}$$\n`);
  }
  const header = `-- CampusOne ${which} triggers: ${rows.length} triggers, generated from a migrated database by
-- scripts/export-triggers.ts. Do not edit by hand; the migrations (db/migrations) are the source.
--
-- Before running:
--   * the tables must exist (run \`npm run migrate\`, or load the schema first);
--   * the MySQL user needs the TRIGGER privilege on the database;
--   * with binary logging on and a user without SUPER, set once as an administrator:
--       SET GLOBAL log_bin_trust_function_creators = 1;
--
-- Run (MySQL client):  mysql -u <user> -p <${which === 'CUG database' ? 'CUG database, e.g. campusone_cug' : 'CampusOne database, e.g. campusone'}> < ${file}
-- MySQL Workbench:     open this file with that database selected and run it all (Ctrl+Shift+Enter).

SET NAMES utf8mb4;
DELIMITER $$

`;
  writeFileSync(join(DIR, file), `${header}${parts.join('\n')}\nDELIMITER ;\n`);
  console.log(`${rows.length} ${which} triggers -> db/triggers/${file}`);
}

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  const campusone = databaseOfUrl(url);
  const db = await mysql.createConnection(url);
  mkdirSync(DIR, { recursive: true });
  try {
    await exportOf(db, campusone, 'create-triggers.sql', 'CampusOne database');
    await exportOf(db, cugDatabaseOf(campusone), 'create-triggers-cug.sql', 'CUG database');
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
