// Isolated stack for the web app's end-to-end journeys (Phase 9.1). DEVELOPMENT ONLY — refused when
// NODE_ENV=production or APP_ENV is uat/prod.
//
//   npm run e2e:db              drop and recreate the schema `ringpe_e2e`, apply every migration and the
//                               reference seeds, then the development seed (sample school TVPS, its staff,
//                               the operators, the sample parent)
//   npm run e2e:db -- --keep    keep the schema: apply pending migrations and re-run the (idempotent) seeds
//   npm run e2e:db -- serve     start the API on port 3021 against `ringpe_e2e` (test banner codes on)
//
// The connection details come from DB_MIGRATOR_URL / DATABASE_URL (environment, else .env) with only the
// database name replaced; nothing from .env is printed. The schema must be on the local server and its
// name must end in `_e2e` (E2E_DB_NAME), so the development database can never be the target.
// The sample accounts get fixed test passwords (E2E_STAFF_PASSWORD, E2E_OPS_PASSWORD,
// E2E_MEMBER_PASSWORD; default the prototype's demo passwords) so the journeys can sign in.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createConnection } from 'mysql2/promise';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const base = { ...fromFile, ...process.env };

const fail = (message) => {
  console.error(`e2e-db: ${message}`);
  process.exit(2);
};

if ((base.NODE_ENV ?? 'development') === 'production' || ['uat', 'prod'].includes(base.APP_ENV)) {
  fail('refused outside local and development environments');
}

const dbName = base.E2E_DB_NAME || 'ringpe_e2e';
if (!/^[a-z0-9_]+_e2e$/.test(dbName)) fail('E2E_DB_NAME must be lower-case and end in _e2e');
const apiPort = Number(base.E2E_API_PORT || 3021);
const webPort = Number(base.E2E_WEB_PORT || 4321);
const uploadDir = base.E2E_UPLOAD_DIR || join('uploads', 'e2e');

/** The same server and login as `key`, pointed at the e2e schema. */
const retarget = (key) => {
  const raw = base[key];
  if (!raw) fail(`${key} is not set (see .env.example)`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${key} is not a valid URL`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    fail(`${key} must point at the local MySQL server for the e2e schema`);
  }
  if (url.pathname.replace(/^\//, '') === dbName) fail(`${key} already names ${dbName}`);
  url.pathname = `/${dbName}`;
  return url.toString();
};

const migratorUrl = retarget('DB_MIGRATOR_URL');
const appUrl = base.DATABASE_URL ? retarget('DATABASE_URL') : migratorUrl;

const childEnv = {
  ...base,
  NODE_ENV: 'development',
  APP_ENV: 'local',
  DB_MIGRATOR_URL: migratorUrl,
  DATABASE_URL: appUrl,
  UPLOAD_DIR: uploadDir,
  DEV_STAFF_PASSWORD: base.E2E_STAFF_PASSWORD || 'Tvps@2026',
  DEV_OPS_PASSWORD: base.E2E_OPS_PASSWORD || 'Ringpe@2026',
  DEV_MEMBER_PASSWORD: base.E2E_MEMBER_PASSWORD || 'Member@2026',
};
// Never hand the user's report connection to the e2e processes.
delete childEnv.REPORT_DATABASE_URL;

const run = (args, env = childEnv) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? done() : reject(new Error(`${args.join(' ')} exited with ${code}`)),
    );
  });

async function rebuild(keep) {
  if (!keep) {
    const server = new URL(migratorUrl);
    server.pathname = '/';
    const conn = await createConnection({ uri: server.toString() });
    try {
      // The schema and its CUG database (migration 0081) reference each other: dropped together
      // with foreign-key checks off; the migrations create the CUG database again.
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await conn.query(`DROP DATABASE IF EXISTS \`${dbName}_cug\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      await conn.query(
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
    } finally {
      await conn.end();
    }
    rmSync(resolve(root, uploadDir), { recursive: true, force: true });
    console.log(`e2e-db: schema ${dbName} recreated`);
  }
  await run(['scripts/db.ts', 'migrate']);
  await run(['scripts/db.ts', 'seed-reference']);
  await run(['scripts/dev-seed.ts']);
  // The development seed writes the sample institutions straight into the tables, so on a fresh
  // database they have no current academic year (registration gives one; on older databases
  // migration 0020 did) and the seed skips classes, students, fees and admissions. Give them the
  // year exactly as migration 0020 does. (Re-running the seed then fails in its members step, which
  // reads `insertId` from a migration connection that returns no result header — reported; the
  // journeys create the classes, members and fees they need themselves.)
  await addMissingYears();
  console.log(`e2e-db: ${dbName} ready (start the API with: npm run e2e:db -- serve)`);
}

async function addMissingYears() {
  const conn = await createConnection({ uri: migratorUrl });
  try {
    const [r] = await conn.query(
      `INSERT INTO academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current)
       SELECT UUID_TO_BIN(UUID()), i.id,
              CONCAT(y.start_year, '-', LPAD(MOD(y.start_year + 1, 100), 2, '0')),
              MAKEDATE(y.start_year, 1) + INTERVAL 3 MONTH,
              MAKEDATE(y.start_year + 1, 1) + INTERVAL 3 MONTH - INTERVAL 1 DAY,
              'OPEN', TRUE
         FROM institutions i
         JOIN (SELECT IF(MONTH(UTC_DATE()) >= 4, YEAR(UTC_DATE()), YEAR(UTC_DATE()) - 1) AS start_year) y
        WHERE NOT EXISTS (SELECT 1 FROM academic_years a WHERE a.institution_id = i.id)`,
    );
    if (r.affectedRows) {
      console.log(`e2e-db: current academic year added to ${r.affectedRows} seeded institution(s)`);
    }
    return r.affectedRows > 0;
  } finally {
    await conn.end();
  }
}

function serve() {
  const env = {
    ...childEnv,
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(apiPort),
    // Only this API: one-time codes reach the apps' test banner and the log.
    OTP_TEST_SHOW_CODE: 'true',
    OTP_DEV_ECHO: 'true',
    CORS_ORIGINS: `http://localhost:${webPort}`,
    PUBLIC_WEB_URL: `http://localhost:${webPort}`,
    // The journeys sign in several times a minute from one address.
    RATE_LIMIT_AUTH_MAX: base.E2E_RATE_LIMIT_AUTH_MAX || '1000',
    LOG_DIR: '',
    LOG_LEVEL: base.E2E_LOG_LEVEL || 'warn',
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const stop = (signal) => child.kill(signal);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
  console.log(`e2e-db: API on http://127.0.0.1:${apiPort} against ${dbName}`);
}

const args = process.argv.slice(2);
if (args.includes('serve')) serve();
else
  rebuild(args.includes('--keep')).catch((e) => {
    console.error(`e2e-db: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
