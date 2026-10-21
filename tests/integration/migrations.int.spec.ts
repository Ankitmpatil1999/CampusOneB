/**
 * Integration test on a real MySQL (brief §7.6). Runs only when TEST_DB_MIGRATOR_URL is set; the
 * user needs CREATE/DROP DATABASE. A throwaway schema `ringpe_it_<random>` is created and dropped, with
 * the CUG database migration 0081 creates beside it (`<name>_cug`).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { CUG_TABLES, cugDatabaseOf } from '../../db/cug-tables';
import { migrate, migrationStatus, readMigrationDir } from '../../db/migrator';
import { openMigrationConnection } from '../../db/mysql-executor';
import { renderReferenceSeedSql } from '../../db/reference-seed';

const adminUrl = process.env['TEST_DB_MIGRATOR_URL'];
const files = readMigrationDir(join(import.meta.dirname, '../../db/migrations'));

describe.skipIf(!adminUrl)('migrations on real MySQL', () => {
  const dbName = `ringpe_it_${randomBytes(4).toString('hex')}`;
  let url = '';

  beforeAll(async () => {
    const admin = await createConnection({ uri: adminUrl as string });
    await admin.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await admin.end();
    const u = new URL(adminUrl as string);
    u.pathname = `/${dbName}`;
    url = u.toString();
  });

  afterAll(async () => {
    const admin = await createConnection({ uri: adminUrl as string, multipleStatements: true });
    // Each database references the other: foreign-key checks off to drop them.
    await admin.query(
      `SET FOREIGN_KEY_CHECKS = 0; DROP DATABASE IF EXISTS \`${dbName}\`; DROP DATABASE IF EXISTS \`${cugDatabaseOf(dbName)}\`; SET FOREIGN_KEY_CHECKS = 1;`,
    );
    await admin.end();
  });

  it('applies every repository migration in order, then is idempotent', async () => {
    const conn = await openMigrationConnection(url);
    try {
      const first = await migrate(conn, files, { appliedBy: 'integration-test' });
      expect(first.applied).toEqual(files.map((f) => f.version));
      const second = await migrate(conn, files, { appliedBy: 'integration-test' });
      expect(second.applied).toEqual([]);
      const status = await migrationStatus(conn, files);
      expect(status.every((r) => r.state === 'applied')).toBe(true);
    } finally {
      await conn.close();
    }
  }, 300_000);

  it('applies the reference seeds twice without error (idempotent)', async () => {
    const conn = await openMigrationConnection(url);
    try {
      await conn.script(renderReferenceSeedSql());
      await conn.script(renderReferenceSeedSql());
      const [row] = await conn.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM ref_status_values WHERE domain = 'institution'",
      );
      expect(Number(row?.n)).toBe(4);
      const [t] = await conn.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM ref_status_transitions WHERE domain = 'institution'",
      );
      expect(Number(t?.n)).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  }, 300_000);

  it('seeds machine-draft translations and never overwrites an edited one', async () => {
    const conn = await openMigrationConnection(url);
    try {
      const [drafts] = await conn.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM translations WHERE lang_code = 'kn' AND source = 'MACHINE'",
      );
      expect(Number(drafts?.n)).toBeGreaterThan(200);
      // A reviewer's edit (HUMAN) survives the next seed.
      await conn.script(
        "UPDATE translations SET text = 'ಪರಿಶೀಲಿಸಿದ ಪಠ್ಯ', source = 'HUMAN' WHERE lang_code = 'kn' AND msg_key = 'ui.welcome.signIn';",
      );
      await conn.script(renderReferenceSeedSql());
      const [kept] = await conn.query<{ text: string; source: string }>(
        "SELECT text, source FROM translations WHERE lang_code = 'kn' AND msg_key = 'ui.welcome.signIn'",
      );
      expect(kept).toEqual({ text: 'ಪರಿಶೀಲಿಸಿದ ಪಠ್ಯ', source: 'HUMAN' });
    } finally {
      await conn.close();
    }
  }, 300_000);

  it('keeps audit_log append-only (triggers refuse UPDATE and DELETE)', async () => {
    const conn = await openMigrationConnection(url);
    try {
      await conn.query(
        `INSERT INTO audit_log (occurred_on, occurred_at, actor_type, action, entity_type, correlation_id)
         VALUES (CURRENT_DATE, UTC_TIMESTAMP(3), 'system', 'TEST', 'test', UUID_TO_BIN(UUID()))`,
      );
      await expect(conn.query("UPDATE audit_log SET action = 'CHANGED'")).rejects.toThrow(
        /append-only/,
      );
      await expect(conn.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    } finally {
      await conn.close();
    }
  });

  it('keeps the school tables in the CUG database and the platform tables in RingPe (0081)', async () => {
    const conn = await openMigrationConnection(url);
    try {
      const tablesOf = async (db: string) =>
        (
          await conn.query<{ t: string }>(
            "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
            [db],
          )
        ).map((r) => r.t);
      const cug = await tablesOf(cugDatabaseOf(dbName));
      const ringpe = await tablesOf(dbName);
      expect([...cug].sort()).toEqual([...CUG_TABLES].sort());
      expect(ringpe.filter((t) => CUG_TABLES.includes(t))).toEqual([]);
      expect(ringpe).toEqual(
        expect.arrayContaining(['platform_accounts', 'sessions', 'schema_migrations']),
      );
      // The school tables' triggers moved with them.
      const [moved] = await conn.query<{ n: number | string }>(
        'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?',
        [cugDatabaseOf(dbName)],
      );
      expect(Number(moved?.n)).toBe(19);
      // A key across the two databases is still enforced.
      await expect(
        conn.query(
          `INSERT INTO \`${cugDatabaseOf(dbName)}\`.member_profiles (public_id, institution_id, user_type_id, account_id, first_name, status)
           VALUES (UUID_TO_BIN(UUID()), 999999, 1, 999999, 'X', 'ACTIVE')`,
        ),
      ).rejects.toThrow(/foreign key/i);
    } finally {
      await conn.close();
    }
  });

  it('stores no trigger body ending in a semicolon, so a dump restores (DR drill, 0063)', async () => {
    const conn = await openMigrationConnection(url);
    try {
      const rows = await conn.query<{ name: string }>(
        `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA IN (DATABASE(), CONCAT(DATABASE(), '_cug'))
            AND ACTION_STATEMENT REGEXP ';[[:space:]]*$'`,
      );
      expect(rows.map((r) => r.name)).toEqual([]);
    } finally {
      await conn.close();
    }
  });

  it('enforces the 27.4 postal-code rule and the register FK on transitions', async () => {
    const conn = await openMigrationConnection(url);
    try {
      await expect(
        conn.query(
          `INSERT INTO \`${cugDatabaseOf(dbName)}\`.institutions (public_id, identifier, name, short_name, address_line1, city, state, pin_code, name_address_key)
           VALUES (UUID_TO_BIN(UUID()), 'RPETST00001', 'Test', 'TST', 'Road', 'City', 'KA', '5600A1', SHA2('x', 256))`,
        ),
      ).rejects.toThrow();
      await expect(
        conn.query(
          "INSERT INTO ref_status_transitions (domain, from_code, to_code, operation) VALUES ('institution', 'ACTIVE', 'TRIAL', 'x')",
        ),
      ).rejects.toThrow();
    } finally {
      await conn.close();
    }
  });
});
