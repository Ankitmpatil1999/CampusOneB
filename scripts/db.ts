/**
 * Database CLI (run as the migrator user, DB_MIGRATOR_URL):
 *   migrate         apply pending migrations (forward-only, checksummed, locked)
 *   status          list applied / pending / changed migrations
 *   seed-reference  apply reference seeds generated from the registers (idempotent)
 */
import { hostname, userInfo } from 'node:os';
import { migrate, migrationStatus, readMigrationDir } from '../db/migrator';
import { openMigrationConnection } from '../db/mysql-executor';
import { renderReferenceSeedSql } from '../db/reference-seed';
import { migrationsDir } from '../config/bootstrap';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !['migrate', 'status', 'seed-reference'].includes(command)) {
    console.error('usage: db.ts <migrate|status|seed-reference>');
    process.exit(2);
  }
  const url = process.env['DB_MIGRATOR_URL'];
  if (!url) {
    console.error('DB_MIGRATOR_URL is not set (the migrator user; see .env.example)');
    process.exit(2);
  }
  const files = readMigrationDir(migrationsDir());
  const conn = await openMigrationConnection(url);
  try {
    if (command === 'status') {
      const rows = await migrationStatus(conn, files);
      for (const r of rows) console.log(`${r.version}  ${r.state.padEnd(12)}  ${r.description}`);
      if (rows.some((r) => r.state === 'changed' || r.state === 'missing-file'))
        process.exitCode = 1;
    } else if (command === 'migrate') {
      const result = await migrate(conn, files, {
        appliedBy: `${userInfo().username}@${hostname()}`.slice(0, 64),
        log: (line) => console.log(line),
      });
      console.log(
        `migrations: ${result.applied.length} applied (${result.applied.join(', ') || 'none'}), ` +
          `${result.alreadyApplied} already applied`,
      );
    } else {
      await conn.script(renderReferenceSeedSql());
      console.log('reference seeds applied');
    }
  } finally {
    await conn.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
