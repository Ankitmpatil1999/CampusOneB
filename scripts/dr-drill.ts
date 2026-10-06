/**
 * Backup and restore drill (Phase 9.4; docs/runbooks §5). Development and staging only — refused in
 * production. Run: `npm run dr:drill` (reads DB_MIGRATOR_URL and FIELD_KEYS_FILE from .env).
 *
 * 1. Full backup: mysqldump of the database (one consistent transaction, routines, triggers, the
 *    binary-log position) → restore into an empty scratch schema → verify: the same tables and row
 *    counts for the key tables, the ledger balanced, the migration level, and that encrypted personal
 *    fields still decrypt with the field-key file kept apart from the dump.
 * 2. Point in time: on a small scratch schema, rows written after the backup are recovered from the
 *    binary log up to just before a simulated accident (a DELETE), which is not replayed.
 *
 * The scratch schemas, the dump and the credentials file are removed at the end. Nothing is printed
 * but table names, counts and timings — no credentials, no personal data.
 */
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { loadFieldCipher } from '../utils/fieldEncryption';
import { binToUuid } from '../utils/idGenerator';

const run = promisify(execFile);
const BIN = process.env['MYSQL_BIN'] ?? 'C:/Program Files/MySQL/MySQL Server 8.0/bin';
const KEY_TABLES = [
  'institutions',
  'platform_accounts',
  'member_profiles',
  'wallets',
  'wallet_balances',
  'ledger_entries',
  'payment_attempts',
  'fee_records',
  'audit_log',
  'translations',
];

/** Stops the drill; the scratch schemas and files are still removed (finally). */
function fail(message: string): never {
  throw new Error(message);
}

async function main() {
  if ((process.env['APP_ENV'] ?? '') === 'production' || process.env['NODE_ENV'] === 'production') {
    fail('refused in production — run the drill on a staging copy');
  }
  const url = process.env['DB_MIGRATOR_URL'] ?? process.env['DATABASE_URL'];
  if (!url) fail('DB_MIGRATOR_URL is not set');
  const u = new URL(url);
  const source = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const work = await mkdtemp(join(tmpdir(), 'ringpe-dr-'));
  const creds = join(work, 'client.cnf');
  // Credentials go to the tools through a file only this run reads, never the command line.
  await writeFile(
    creds,
    `[client]\nuser=${decodeURIComponent(u.username)}\npassword=${decodeURIComponent(u.password)}\nhost=${u.hostname}\nport=${u.port || '3306'}\n`,
    { mode: 0o600 },
  );
  const tool = (name: string) => join(BIN, `${name}.exe`);
  const admin = await mysql.createConnection({ uri: url, multipleStatements: false });
  const restore = 'ringpe_dr_restore';
  const pitr = 'ringpe_dr_pitr';
  const pitrRestore = 'ringpe_dr_pitr_restore';
  const results: string[] = [];
  const timed = async <T>(label: string, fn: () => Promise<T>) => {
    const t0 = performance.now();
    const out = await fn();
    const s = (performance.now() - t0) / 1000;
    results.push(`${label}: ${s.toFixed(1)} s`);
    console.log(`${label}: ${s.toFixed(1)} s`);
    return out;
  };
  const pipeInto = (db: string, file: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(
        tool('mysql'),
        [`--defaults-extra-file=${creds}`, '--default-character-set=utf8mb4', db],
        {
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      // If the client stops early its stdin closes; its own error message is what matters.
      p.stdin.on('error', () => undefined);
      createReadStream(file).pipe(p.stdin);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 500)))));
    });
  const dumpTo = (db: string, file: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(
        tool('mysqldump'),
        [
          `--defaults-extra-file=${creds}`,
          '--single-transaction',
          '--routines',
          '--triggers',
          '--events',
          '--hex-blob',
          '--source-data=2',
          '--set-gtid-purged=OFF',
          '--default-character-set=utf8mb4',
          db,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdout.pipe(createWriteStream(file));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 500)))));
    });
  const counts = async (db: string) => {
    const out: Record<string, number> = {};
    for (const t of KEY_TABLES) {
      const [rows] = await admin.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${t}\``);
      out[t] = Number((rows as { n: number }[])[0]?.n ?? 0);
    }
    return out;
  };

  try {
    for (const db of [restore, pitr, pitrRestore])
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);

    // --- 1. Full backup and restore -------------------------------------------------------------
    const dump = join(work, 'full.sql');
    const before = await counts(source);
    await timed('full backup (mysqldump, one transaction)', () => dumpTo(source, dump));
    const size = (await stat(dump)).size;
    results.push(`dump size: ${(size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`dump size: ${(size / 1024 / 1024).toFixed(1)} MB`);
    await admin.query(
      `CREATE DATABASE \`${restore}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await timed('restore into an empty schema', () => pipeInto(restore, dump));

    const [srcTables] = await admin.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [source],
    );
    const [dstTables] = await admin.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [restore],
    );
    const nSrc = Number((srcTables as { n: number }[])[0]?.n);
    const nDst = Number((dstTables as { n: number }[])[0]?.n);
    if (nSrc !== nDst) fail(`tables ${nSrc} → ${nDst}`);
    results.push(`tables: ${nDst} of ${nSrc}`);
    const after = await counts(restore);
    for (const t of KEY_TABLES) {
      // The source may move on during the drill (the user's API is running): never fewer rows.
      if (after[t]! < before[t]!) fail(`${t}: ${before[t]} rows before, ${after[t]} restored`);
    }
    results.push(`key tables restored: ${KEY_TABLES.map((t) => `${t} ${after[t]}`).join(', ')}`);
    const [bal] = await admin.query(
      `SELECT COALESCE(SUM(IF(direction = 'D', amount_paise, 0)), 0) AS d,
              COALESCE(SUM(IF(direction = 'C', amount_paise, 0)), 0) AS c
         FROM \`${restore}\`.ledger_entries`,
    );
    const b = (bal as { d: string; c: string }[])[0]!;
    if (String(b.d) !== String(b.c)) fail(`ledger unbalanced after restore: ${b.d} vs ${b.c}`);
    results.push('ledger balanced after restore (debits = credits)');
    const [mig] = await admin.query(
      `SELECT MAX(version) AS v, COUNT(*) AS n FROM \`${restore}\`.schema_migrations`,
    );
    const m = (mig as { v: string; n: number }[])[0]!;
    results.push(`migrations: ${m.n} applied, latest ${m.v}`);
    // The field-key file is backed up apart from the dump: with it, restored ciphertext decrypts.
    const keyFile = process.env['FIELD_KEYS_FILE'];
    if (keyFile) {
      const cipher = await loadFieldCipher(keyFile);
      const [rows] = await admin.query(
        `SELECT public_id, pan_enc FROM \`${restore}\`.platform_accounts WHERE pan_enc IS NOT NULL LIMIT 20`,
      );
      let ok = 0;
      const list = rows as { public_id: Buffer; pan_enc: Buffer }[];
      for (const r of list) {
        try {
          cipher.decrypt('pan', r.pan_enc, `platform_accounts.pan:${binToUuid(r.public_id)}`);
          ok++;
        } catch {
          // counted below
        }
      }
      results.push(`encrypted PAN decrypts after restore: ${ok} of ${list.length} sampled`);
      if (list.length && ok !== list.length) fail('restored PAN ciphertext did not decrypt');
    } else {
      results.push('FIELD_KEYS_FILE not set — decryption check skipped');
    }

    // --- 2. Point in time ------------------------------------------------------------------------
    await admin.query(
      `CREATE DATABASE \`${pitr}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await admin.query(
      `CREATE TABLE \`${pitr}\`.payments (id INT PRIMARY KEY, amount_paise BIGINT NOT NULL, note VARCHAR(40) NOT NULL) ENGINE=InnoDB`,
    );
    await admin.query(
      `INSERT INTO \`${pitr}\`.payments VALUES (1, 5000, 'before the backup'), (2, 7500, 'before the backup')`,
    );
    const pitrDump = join(work, 'pitr.sql');
    await dumpTo(pitr, pitrDump);
    const header = await readFile(pitrDump, 'utf8');
    const pos = /(?:SOURCE|MASTER)_LOG_FILE='([^']+)',\s*(?:SOURCE|MASTER)_LOG_POS=(\d+)/.exec(
      header,
    );
    if (!pos) {
      const hint = header
        .split('\n')
        .filter((l) => /LOG_FILE|LOG_POS|CHANGE/i.test(l))
        .join(' | ');
      fail(`the dump has no binary-log position (is log_bin on?) ${hint.slice(0, 300)}`);
    }
    await admin.query(
      `INSERT INTO \`${pitr}\`.payments VALUES (3, 12000, 'after the backup'), (4, 3000, 'after the backup')`,
    );
    const [status] = await admin.query('SHOW MASTER STATUS');
    const stop = (status as { File: string; Position: number }[])[0]!;
    // The accident: every row deleted. Recovery must stop before it.
    await admin.query(`DELETE FROM \`${pitr}\`.payments`);
    await admin.query(
      `CREATE DATABASE \`${pitrRestore}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await timed('point-in-time restore (dump + binary log replay)', async () => {
      await pipeInto(pitrRestore, pitrDump);
      const [logs] = await admin.query('SHOW BINARY LOGS');
      const files = (logs as { Log_name: string }[]).map((l) => l.Log_name);
      const from = files.indexOf(pos[1]!);
      const to = files.indexOf(stop.File);
      if (from < 0 || to < from)
        fail('binary logs between the backup and the stop point are missing');
      const replay = join(work, 'replay.sql');
      const args = [
        `--defaults-extra-file=${creds}`,
        '--read-from-remote-server',
        `--start-position=${pos[2]}`,
        `--stop-position=${stop.Position}`,
        // mysqlbinlog applies --rewrite-db first, then --database to the new name.
        `--database=${pitrRestore}`,
        `--rewrite-db=${pitr}->${pitrRestore}`,
        ...(to > from ? ['--to-last-log'] : []),
        files[from]!,
      ];
      const { stdout } = await run(tool('mysqlbinlog'), args, { maxBuffer: 256 * 1024 * 1024 });
      await writeFile(replay, stdout);
      await pipeInto(pitrRestore, replay);
    });
    const [recovered] = await admin.query(
      `SELECT id, note FROM \`${pitrRestore}\`.payments ORDER BY id`,
    );
    const ids = (recovered as { id: number }[]).map((r) => r.id).join(',');
    if (ids !== '1,2,3,4') fail(`point in time: expected rows 1,2,3,4, found ${ids || 'none'}`);
    results.push(
      'point in time: the 2 rows written after the backup recovered; the later DELETE not replayed',
    );

    console.log('\nDRILL PASSED');
    for (const r of results) console.log(`- ${r}`);
  } finally {
    for (const db of [restore, pitr, pitrRestore]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined);
    }
    await admin.end();
    await rm(work, { recursive: true, force: true });
  }
}

void main().catch((e: unknown) => {
  console.error(`DRILL FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
