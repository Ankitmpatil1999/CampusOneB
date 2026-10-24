/**
 * Carries a school's staff over from the earlier CUG application's database (client 2026-10-23: "migrate
 * all teaching and non-teaching staff with their wallet number, NFC details and all other details";
 * SRGS first). Runs against a fresh RingPe database, which it can create:
 *
 *   npm run import:cug-staff -- --db ringpe_live --create --org 21 \
 *     --sheet "C:\path\staff.xlsx" --city Bengaluru --state Karnataka --out "C:\private\folder"
 *
 * - `--create` makes the RingPe database `--db` (it must not exist yet) and applies every migration and
 *   the reference seeds; its CUG database `<db>_cug` comes with them (ADR-0019). The connection is
 *   DB_MIGRATOR_URL's server and login with only the database name replaced; nothing from .env is printed.
 * - The earlier database (`--source`, default ringpe_cug_db_prod, same server) is only read.
 * - `--sheet` is the school's staff list (.xlsx, columns as the earlier application exported them): its
 *   Role column gives the console roles, its VAN / IFSC / Bank Name the school's bank code. Only the
 *   staff on the sheet are carried over; everything else comes from the earlier database.
 * - `--dry-run` reads both and prints what would happen, writing nothing.
 *
 * What is carried over, with the client's choices of 2026-10-23:
 * - the school (name, identifier, address, contacts, pool account, the bank code from the sheet), with
 *   the standard user types, its departments, the current academic year and every feature on;
 * - each staff member: an account (mobile, e-mail when valid) with a temporary password changed at first
 *   sign-in, the staff profile (employee number, contact, status, transaction permission), the console
 *   roles named on the sheet, blood group, year of association, the earlier role and class as fields;
 * - the campus wallet and allowance wallet with their earlier numbers (so the VAN stays code + number);
 * - the NFC card with its earlier token, and the earlier application's card value so the cards already
 *   handed out keep working (migration 0089);
 * - a non-zero balance through the ledger (ADJUSTMENT: bank pool → wallet), never written directly;
 * - the staff attendance history (one day record and its check-in / check-out events each).
 * Missing facts (gender, date of birth, joining date) stay empty, to be filled in the console. Nothing is
 * sent to anyone. Re-running adds only what is missing (staff are matched by employee number).
 *
 * The temporary passwords go to `<out>/<SHORT>-staff-sign-in-CONFIDENTIAL.csv` — hand them out and
 * delete the file. A back-office operator can be added with `--operator-email`, `--operator-mobile`
 * and `--operator-name` (Platform Administrator, temporary password in the same file).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, MysqlDialect, sql, type Transaction } from 'kysely';
import { createPool } from 'mysql2';
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import { cugDatabaseOf } from '../db/cug-tables';
import { CugSchemaPlugin } from '../models/cug-schema-plugin';
import type { Database } from '../models/ringpe_models';
import { recordAudit } from '../services/audit.service';
import { nameAddressKey } from '../services/institutions.service';
import { LedgerService } from '../services/ledger.service';
import { loadFieldCipher } from '../utils/fieldEncryption';
import { binToUuid, newPublicIdPair } from '../utils/idGenerator';
import { hashSecret } from '../utils/password';
import {
  CARRIED,
  EMAIL,
  MOBILE,
  bloodGroup,
  clean,
  correctedEmail,
  digits10,
  paiseOf,
  readXlsx,
  splitName,
  temporaryPassword,
  titleCase,
  writeSignInSheet,
} from './cug-import-common';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- arguments --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(`import-cug-staff: ${message}`);
  process.exit(2);
};

const target = opt('db') ?? fail('--db <name> is required (the RingPe database to fill)');
const source = opt('source') ?? 'ringpe_cug_db_prod';
const orgId = Number(opt('org') ?? fail('--org <earlier organisation id> is required'));
const sheetPath = opt('sheet');
const outDir = opt('out');
const dryRun = flag('dry-run');
const create = flag('create');
for (const [k, v] of [
  ['--db', target],
  ['--source', source],
] as const) {
  if (!/^[a-z0-9_]{1,56}$/.test(v)) fail(`${k} must be a lower-case database name`);
}
if (!Number.isSafeInteger(orgId) || orgId <= 0) fail('--org must be a number');
if (!dryRun && !outDir) fail('--out <folder> is required (the temporary passwords go there)');
const migratorUrl = process.env['DB_MIGRATOR_URL'] ?? fail('DB_MIGRATOR_URL is not set');

const urlFor = (database: string) => {
  const u = new URL(migratorUrl);
  u.pathname = `/${database}`;
  return u.toString();
};
const targetUrl = urlFor(target);
const cugDatabase = cugDatabaseOf(target);

interface SheetRow {
  readonly employeeNo: string;
  readonly name: string;
  readonly mobile: string;
  readonly role: string;
  readonly van: string;
  readonly ifsc: string;
  readonly bank: string;
}

function sheetRows(): SheetRow[] | null {
  if (!sheetPath) return null;
  if (!existsSync(sheetPath)) fail(`${sheetPath} not found`);
  const books = readXlsx(sheetPath);
  const rows = Object.values(books).find((r) => r[0]?.includes('Mobile Number')) ?? [];
  const head = rows[0] ?? [];
  const at = (r: string[], name: string) => r[head.indexOf(name)] ?? '';
  if (head.indexOf('Name') < 0 || head.indexOf('Admission Number') < 0) {
    fail('the sheet has no Name / Admission Number columns');
  }
  return rows
    .slice(1)
    .filter((r) => at(r, 'Name'))
    .map((r) => ({
      employeeNo: at(r, 'Admission Number'),
      name: at(r, 'Name'),
      mobile: digits10(at(r, 'Mobile Number')),
      role: at(r, 'Role'),
      van: at(r, 'VAN').toUpperCase(),
      ifsc: at(r, 'IFSC Code').toUpperCase(),
      bank: at(r, 'Bank Name'),
    }));
}

// --- the earlier database ---------------------------------------------------------------------------
interface OldStaff {
  readonly user_id: string;
  readonly name: string;
  readonly mobile: string | null;
  readonly email: string | null;
  readonly emp: string | null;
  readonly grade: string | null;
  readonly section: string | null;
  readonly blood_group: string | null;
  readonly year_of_association: number | null;
  readonly status: number | null;
  readonly transaction_permission: number | null;
  readonly created_at: Date;
  readonly department: string | null;
  readonly wallet_no: string | null;
  readonly balance: string | null;
  readonly allowance_wallet_no: string | null;
}
interface OldCard {
  readonly user_id: string;
  readonly nfc_token_id: string;
  readonly encrypted_token: string | null;
  readonly status: number;
  readonly reason_for_reissue: string | null;
  readonly reissue_count: string | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}
interface OldDay {
  readonly user_id: string;
  readonly att_date: string;
  readonly check_in: Date | null;
  readonly check_out: Date | null;
  readonly check_in_status: 'PRESENT' | 'LATE' | null;
  readonly status: string | null;
  readonly check_in_method: string | null;
  readonly remarks: string | null;
}

async function readSource() {
  const c: Connection = await createConnection({
    uri: urlFor(source),
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ['DATE'],
  });
  try {
    await c.query("SET SESSION time_zone = '+00:00'");
    await c.query('SET SESSION TRANSACTION READ ONLY');
    const q = async <T>(s: string, p: unknown[] = []) =>
      (await c.query<RowDataPacket[]>(s, p))[0] as unknown as T[];
    const org =
      (
        await q<Record<string, unknown>>(
          'SELECT * FROM organization_details WHERE organization_id = ?',
          [orgId],
        )
      )[0] ?? fail(`organisation ${orgId} not found in ${source}`);
    const staff = await q<OldStaff>(
      `SELECT u.user_id, u.name, u.mobile, u.email, TRIM(u.admission_number) AS emp, u.grade, u.section,
              u.blood_group, u.year_of_association, u.status, u.transaction_permission, u.created_at,
              d.department, w.wallet_no, w.balance, a.allowance_wallet_no
         FROM users u
         JOIN user_type t ON t.user_type_id = u.user_type_id
         LEFT JOIN department_details d ON d.department_id = u.department_id
         LEFT JOIN wallet w ON w.user_id = u.user_id AND w.organization_id = u.organization_id
         LEFT JOIN allowance_wallet a ON a.user_id = u.user_id AND a.organization_id = u.organization_id
        WHERE u.organization_id = ? AND LOWER(t.user_type) = 'staff'
        ORDER BY u.user_id`,
      [orgId],
    );
    const ids = staff.map((s) => s.user_id);
    const cards = ids.length
      ? await q<OldCard>(
          `SELECT user_id, nfc_token_id, encrypted_token, status, reason_for_reissue, reissue_count,
                  created_at, updated_at
             FROM nfc_tags WHERE organization_id = ? AND user_id IN (?) ORDER BY nfc_id`,
          [orgId, ids],
        )
      : [];
    const days = ids.length
      ? await q<OldDay>(
          `SELECT user_id, DATE_FORMAT(date, '%Y-%m-%d') AS att_date, check_in, check_out, check_in_status,
                  status, check_in_method, remarks
             FROM attendance WHERE organization_id = ? AND user_id IN (?) ORDER BY user_id, date`,
          [orgId, ids],
        )
      : [];
    // The highest numbers the earlier application gave anyone: kept free for later imports.
    const [top] = await q<{ campus: string | null; allowance: string | null }>(
      `SELECT (SELECT MAX(CAST(wallet_no AS UNSIGNED)) FROM wallet) AS campus,
              (SELECT MAX(CAST(allowance_wallet_no AS UNSIGNED)) FROM allowance_wallet) AS allowance`,
    );
    return { org, staff, cards, days, top: top! };
  } finally {
    await c.end();
  }
}

// --- helpers ----------------------------------------------------------------------------------------
/**
 * The console roles a sheet's Role names, and the kind of profile: the principal is a Principal
 * profile (the Principal role fits only that), anyone teaching or in Academics a Teacher, the rest
 * Staff. A vice principal or head of section gets the Academic Coordinator role — the administrator
 * can give more in the console. A merchant is not a staff role (merchants are their own profiles).
 */
function rolesOf(text: string, department: string) {
  const t = text.toLowerCase();
  const codes = new Set<string>();
  const notes: string[] = [];
  if (/vice\s*-?\s*principal/.test(t)) codes.add('ACADEMIC_COORDINATOR');
  else if (/principal/.test(t)) codes.add('PRINCIPAL');
  if (/\bhm\b|head\s*(mistress|master)/.test(t)) codes.add('ACADEMIC_COORDINATOR');
  if (/co-?\s*ordinator/.test(t)) codes.add('ACADEMIC_COORDINATOR');
  if (/teacher/.test(t)) codes.add('TEACHER');
  if (/\badmin\b|administrator/.test(t)) codes.add('INSTITUTION_ADMIN');
  if (/accountant|accounts/.test(t)) codes.add('ACCOUNTANT');
  if (/counsell?or/.test(t)) codes.add('COUNSELLOR');
  if (/front\s*-?\s*desk|attendance/.test(t)) codes.add('FRONT_DESK');
  if (/transport/.test(t)) codes.add('TRANSPORT_ADMIN');
  if (/merchant/.test(t))
    notes.push('“merchant” on the sheet: a merchant is set up as its own profile');
  if (/vice\s*-?\s*principal|\bhm\b/.test(t)) {
    notes.push('given Academic Coordinator; the Principal role needs a Principal profile');
  }
  if (t && !codes.size && !notes.length) notes.push(`role “${text}” not recognised: none given`);
  const category: 'PRINCIPAL' | 'TEACHER' | 'STAFF' = codes.has('PRINCIPAL')
    ? 'PRINCIPAL'
    : codes.has('TEACHER') || /academic/i.test(department)
      ? 'TEACHER'
      : 'STAFF';
  return { codes: [...codes], category, notes };
}

const USER_TYPES = [
  ['Student', 'STUDENT'],
  ['Parent', 'PARENT'],
  ['Teacher', 'TEACHER'],
  ['Staff', 'STAFF'],
  ['Principal', 'PRINCIPAL'],
  ['Management', 'MANAGEMENT'],
  ['Merchant', 'MERCHANT'],
  ['Crew', 'CREW'],
] as const;
const TYPE_OF = { PRINCIPAL: 'Principal', TEACHER: 'Teacher', STAFF: 'Staff' } as const;
const FEATURE_KEYS = [
  'tuition',
  'feeConsent',
  'nfc',
  'transfers',
  'coupons',
  'allowances',
  'events',
  'attendance',
  'transport',
  'quiz',
] as const;
const DONE_STEPS = ['details', 'plan', 'bank', 'toggles', 'usertypes', 'year', 'firstusers'];
const FIELDS = [
  { key: 'blood', label: 'Blood group', type: 'TEXT' },
  { key: 'year', label: 'Year of association', type: 'NUMBER' },
  { key: 'role', label: 'Role (earlier application)', type: 'TEXT' },
  { key: 'class', label: 'Class (earlier application)', type: 'TEXT' },
] as const;

// --- the fresh database -----------------------------------------------------------------------------
async function createDatabase() {
  const server = new URL(migratorUrl);
  server.pathname = '/';
  const c = await createConnection({ uri: server.toString() });
  try {
    const [rows] = await c.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)',
      [target, cugDatabase],
    );
    if (rows.length) {
      fail(
        `${rows.map((r) => String(r['n'])).join(' and ')} already exist: --create makes new ones only`,
      );
    }
    await c.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await c.end();
  }
  for (const step of ['migrate', 'seed-reference']) {
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/db.ts', step], {
        cwd: root,
        env: { ...process.env, DB_MIGRATOR_URL: targetUrl, DATABASE_URL: targetUrl },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? done() : reject(new Error(`db.ts ${step} exited with ${code}`)),
      );
    });
  }
  console.log(`import-cug-staff: ${target} and ${cugDatabase} created and migrated`);
}

type Trx = Transaction<Database>;

async function main() {
  const sheet = sheetRows();
  const old = await readSource();
  const org = old.org;
  const schoolName = clean(org['organization_name']);
  const short = schoolName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 6);
  const bySheet = new Map((sheet ?? []).map((r) => [r.employeeNo.toUpperCase(), r]));

  // Who comes over: the staff on the school's sheet (all staff when no sheet is given).
  const chosen = old.staff.filter((s) => !sheet || bySheet.has(clean(s.emp).toUpperCase()));
  const left = old.staff.filter((s) => !chosen.includes(s));
  // A mobile two people share signs in to one of them only (the earlier record).
  const firstWithMobile = new Map<string, string>();
  for (const s of chosen) {
    const m = digits10(s.mobile);
    if (MOBILE.test(m) && !firstWithMobile.has(m)) firstWithMobile.set(m, s.user_id);
  }
  // The bank code from the sheet: the VAN is the code + the wallet number.
  let corporate: { code: string; ifsc: string; bank: string } | null = null;
  for (const s of chosen) {
    const r = bySheet.get(clean(s.emp).toUpperCase());
    if (r?.van && s.wallet_no && r.van.endsWith(s.wallet_no)) {
      corporate = {
        code: r.van.slice(0, -s.wallet_no.length),
        ifsc: r.ifsc,
        bank: titleCase(r.bank || 'Bank'),
      };
      break;
    }
  }

  const plan = chosen.map((s) => {
    const r = bySheet.get(clean(s.emp).toUpperCase());
    const department = clean(s.department) || 'Administration';
    const roles = rolesOf(r?.role ?? '', department);
    const mobile = digits10(s.mobile);
    const email = correctedEmail(s.email);
    const notes = [...roles.notes];
    const account = MOBILE.test(mobile) && firstWithMobile.get(mobile) === s.user_id;
    if (!MOBILE.test(mobile)) notes.push('no valid mobile: no sign-in');
    else if (!account)
      notes.push('mobile shared with another staff member: no sign-in of their own');
    if (email && !EMAIL.test(email)) notes.push(`e-mail “${clean(s.email)}” not valid: left empty`);
    else if (email !== clean(s.email).toLowerCase())
      notes.push(`e-mail “${clean(s.email)}” stored as ${email}`);
    if (Number(s.status) !== 1) notes.push('inactive in the earlier application');
    if (!clean(s.emp)) notes.push('no employee number');
    if (roles.codes.length && (!EMAIL.test(email) || !account)) {
      notes.push('console role, but no e-mail sign-in: the console needs a valid e-mail');
    }
    return { s, roles, mobile, email: EMAIL.test(email) ? email : null, account, notes };
  });

  console.log(`import-cug-staff: ${schoolName} (${short}) from ${source}, organisation ${orgId}`);
  console.log(
    `  staff ${old.staff.length} in the earlier database, ${chosen.length} to carry over` +
      (sheet ? ` (on the sheet: ${sheet.length})` : ''),
  );
  for (const s of left) {
    console.log(`  not on the sheet, left out: ${clean(s.name)} (${clean(s.emp) || 'no number'})`);
  }
  console.log(
    `  bank code ${corporate ? `${corporate.code} · ${corporate.ifsc} · ${corporate.bank}` : 'none'}`,
  );
  console.log(
    `  cards ${old.cards.length}, attendance days ${old.days.length}, balances ${chosen.filter((s) => paiseOf(s.balance ?? '0') !== 0).length}`,
  );
  for (const p of plan) {
    if (p.notes.length) console.log(`  ${clean(p.s.name)}: ${p.notes.join('; ')}`);
  }
  if (dryRun) {
    console.log('import-cug-staff: dry run, nothing written');
    return;
  }

  if (create) await createDatabase();
  const db = new Kysely<Database>({
    plugins: [new CugSchemaPlugin(cugDatabase)],
    dialect: new MysqlDialect({
      pool: createPool({
        uri: targetUrl,
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: 'Z',
        dateStrings: ['DATE'],
        connectionLimit: 4,
      }),
    }),
  });
  const cipher = await loadFieldCipher(process.env['FIELD_KEYS_FILE'] ?? 'keys/field-keys.json');
  const ledger = new LedgerService();
  const now = new Date();
  const sheetOut: string[][] = [];
  const errors: string[] = [];
  const counts = { staff: 0, existing: 0, accounts: 0, cards: 0, days: 0, balances: 0, roles: 0 };

  try {
    // ---- the school ---------------------------------------------------------------------------------
    const identifier = clean(org['organization_unique_id']);
    const address = clean(org['address']) || (opt('city') ?? '');
    const city = opt('city') ?? fail('--city is required (the earlier record has no city)');
    const inst = await db.transaction().execute(async (trx) => {
      let row = await trx
        .selectFrom('institutions')
        .select(['id', 'public_id'])
        .where('identifier', '=', identifier)
        .executeTakeFirst();
      if (row) return row;
      const pub = newPublicIdPair();
      const created = new Date(org['created_at'] as string | Date);
      await trx
        .insertInto('institutions')
        .values({
          public_id: pub.bin,
          identifier,
          name: schoolName,
          short_name: short,
          address_line1: address,
          city,
          state: opt('state') ?? null,
          pin_code: opt('pin') ?? null,
          status: 'ACTIVE',
          corporate_code: corporate?.code ?? null,
          pool_account_ref: clean(org['pool_account']) || null,
          shadow_account_ref: clean(org['shadow_account']) || null,
          name_address_key: nameAddressKey(schoolName, address),
          created_at: created,
        })
        .execute();
      row = await trx
        .selectFrom('institutions')
        .select(['id', 'public_id'])
        .where('identifier', '=', identifier)
        .executeTakeFirstOrThrow();
      const id = String(row.id);
      await trx
        .insertInto('institution_settings')
        .values({ institution_id: id, consent_validity_months: 3 })
        .execute();
      for (const kind of ['PRIMARY', 'SECONDARY'] as const) {
        const p = kind.toLowerCase();
        const name = clean(org[`${p}_contact_name`]);
        if (!name) continue;
        const mobile = digits10(org[`${p}_contact_phone`]);
        const email = clean(org[`${p}_contact_email`]).toLowerCase();
        await trx
          .insertInto('institution_contacts')
          .values({
            institution_id: id,
            kind,
            name: name.slice(0, 100),
            email: EMAIL.test(email) ? email : null,
            mobile_enc: MOBILE.test(mobile)
              ? cipher.encrypt(
                  'institution_contact',
                  mobile,
                  `institution_contacts.mobile:${binToUuid(row.public_id)}:${kind}`,
                )
              : null,
            mobile_last4: MOBILE.test(mobile) ? mobile.slice(-4) : null,
          })
          .execute();
      }
      if (corporate) {
        await trx
          .insertInto('institution_corporate_codes')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: id,
            bank_name: corporate.bank.slice(0, 100),
            ifsc: corporate.ifsc || null,
            corporate_code: corporate.code,
            pool_account_ref: clean(org['pool_account']) || null,
            is_default: true,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      // The plan is the back office's to set: no renewal date, so nothing is billed until it is.
      await sql`INSERT INTO subscriptions (institution_id, plan_id, plan_version_id, status)
                SELECT ${id}, p.id, p.current_version_id, 'ACTIVE' FROM plans p WHERE p.code = ${opt('plan') ?? 'PL-PRO'}`.execute(
        trx,
      );
      for (const k of FEATURE_KEYS) {
        await trx
          .insertInto('feature_toggles')
          .values({ institution_id: id, feature_key: k, enabled: 1 })
          .execute();
      }
      for (const [channel, on] of [
        ['IN_APP', 1],
        ['EMAIL', 1],
        ['SMS', 1],
        ['WHATSAPP', 0],
      ] as const) {
        await trx
          .insertInto('notification_channel_settings')
          .values({ institution_id: id, channel, enabled: on })
          .execute();
      }
      for (const step of DONE_STEPS) {
        await trx
          .insertInto('onboarding_checklist_steps')
          .values({ institution_id: id, step_key: step })
          .execute();
      }
      for (const [action, from, to, at] of [
        ['REGISTERED', null, 'PENDING_ACTIVATION', created],
        ['ACTIVATED', 'PENDING_ACTIVATION', 'ACTIVE', now],
      ] as const) {
        await trx
          .insertInto('institution_lifecycle_events')
          .values({
            institution_id: id,
            action,
            from_status: from,
            to_status: to,
            reason: CARRIED,
            occurred_at: at,
          })
          .execute();
      }
      // The current academic year (April to March), as registration gives one.
      await sql`INSERT INTO academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current)
                SELECT UUID_TO_BIN(UUID()), ${id},
                       CONCAT(y.s, '-', LPAD(MOD(y.s + 1, 100), 2, '0')),
                       MAKEDATE(y.s, 1) + INTERVAL 3 MONTH,
                       MAKEDATE(y.s + 1, 1) + INTERVAL 3 MONTH - INTERVAL 1 DAY, 'OPEN', TRUE
                  FROM (SELECT IF(MONTH(UTC_DATE()) >= 4, YEAR(UTC_DATE()), YEAR(UTC_DATE()) - 1) AS s) y`.execute(
        trx,
      );
      for (const [name, category] of USER_TYPES) {
        await trx
          .insertInto('user_types')
          .values({ public_id: newPublicIdPair().bin, institution_id: id, name, category })
          .execute();
      }
      for (const [i, f] of FIELDS.entries()) {
        await trx
          .insertInto('custom_field_definitions')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: id,
            entity: 'MEMBER',
            label: f.label,
            data_type: f.type,
            position: i + 1,
            no_id_doc_ack_at: now,
            created_at: now,
          })
          .execute();
      }
      await recordAudit(trx, {
        institutionId: id,
        action: 'INSTITUTION_REGISTERED',
        entityType: 'institution',
        entityRef: binToUuid(row.public_id),
        after: { name: schoolName, identifier, via: 'import', source: `${source}#${orgId}` },
      });
      return row;
    });
    const instId = String(inst.id);
    console.log(`import-cug-staff: school ${schoolName} ready`);

    const types = new Map(
      (
        await db
          .selectFrom('user_types')
          .select(['id', 'name'])
          .where('institution_id', '=', instId)
          .execute()
      ).map((t) => [t.name, String(t.id)]),
    );
    const fields = new Map(
      (
        await db
          .selectFrom('custom_field_definitions')
          .select(['id', 'label'])
          .where('institution_id', '=', instId)
          .where('entity', '=', 'MEMBER')
          .execute()
      ).map((f) => [f.label, String(f.id)]),
    );
    const roleIds = new Map(
      (
        await db
          .selectFrom('roles')
          .select(['id', 'code'])
          .where('scope', '=', 'INSTITUTION')
          .execute()
      )
        .filter((r) => r.code)
        .map((r) => [r.code!, String(r.id)]),
    );
    const year = await db
      .selectFrom('academic_years')
      .select(['id', 'starts_on', 'ends_on'])
      .where('institution_id', '=', instId)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    const yearOf = (day: string) =>
      year && day >= String(year.starts_on).slice(0, 10) && day <= String(year.ends_on).slice(0, 10)
        ? String(year.id)
        : null;
    const departmentId = async (trx: Trx, typeId: string, name: string) => {
      const found = await trx
        .selectFrom('departments')
        .select('id')
        .where('institution_id', '=', instId)
        .where('user_type_id', '=', typeId)
        .where('name', '=', name)
        .executeTakeFirst();
      if (found) return String(found.id);
      const r = await trx
        .insertInto('departments')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: instId,
          user_type_id: typeId,
          name: name.slice(0, 60),
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      return String(r.insertId);
    };
    const cardsOf = new Map<string, OldCard[]>();
    for (const c of old.cards) cardsOf.set(c.user_id, [...(cardsOf.get(c.user_id) ?? []), c]);
    const daysOf = new Map<string, OldDay[]>();
    for (const d of old.days) daysOf.set(d.user_id, [...(daysOf.get(d.user_id) ?? []), d]);

    // ---- the staff, one transaction each ---------------------------------------------------------------
    for (const p of plan) {
      const s = p.s;
      const name = splitName(s.name);
      const employeeNo = clean(s.emp) || null;
      try {
        const done = await db.transaction().execute(async (trx) => {
          const there = employeeNo
            ? await trx
                .selectFrom('member_profiles')
                .select('id')
                .where('institution_id', '=', instId)
                .where('employee_no', '=', employeeNo)
                .executeTakeFirst()
            : await trx
                .selectFrom('member_profiles')
                .select('id')
                .where('institution_id', '=', instId)
                .where('first_name', '=', name.first)
                .where('contact_mobile', '=', MOBILE.test(p.mobile) ? p.mobile : null)
                .executeTakeFirst();
          if (there) return null;

          // The account (mobile sign-in on the app, e-mail on the console), unless the mobile is taken.
          let accountId: string | null = null;
          let password: string | null = null;
          if (p.account) {
            const byMobile = await trx
              .selectFrom('platform_accounts')
              .select('id')
              .where('mobile', '=', p.mobile)
              .executeTakeFirst();
            if (byMobile) {
              accountId = String(byMobile.id);
            } else {
              const emailFree =
                p.email &&
                !(await trx
                  .selectFrom('platform_accounts')
                  .select('id')
                  .where('email', '=', p.email)
                  .executeTakeFirst());
              const r = await trx
                .insertInto('platform_accounts')
                .values({
                  public_id: newPublicIdPair().bin,
                  mobile: p.mobile,
                  email: emailFree ? p.email : null,
                  first_name: name.first.toUpperCase(),
                  last_name: name.last?.toUpperCase() ?? null,
                  txn_permission: Number(s.transaction_permission) === 0 ? 0 : 1,
                  created_at: new Date(s.created_at),
                })
                .executeTakeFirstOrThrow();
              accountId = String(r.insertId);
              password = temporaryPassword();
              await trx
                .insertInto('account_credentials')
                .values({
                  account_id: accountId,
                  kind: 'PASSWORD',
                  hash: await hashSecret(password),
                  must_change: 1,
                })
                .execute();
            }
          }

          // The profile keeps the earlier wallet numbers: the wallet trigger takes the next number of
          // each sequence, so the sequences are set to them first (one profile at a time).
          if (s.wallet_no) {
            await trx
              .updateTable('wallet_number_sequences')
              .set({ next_value: s.wallet_no })
              .where('kind', '=', 'CAMPUS')
              .execute();
          }
          if (s.allowance_wallet_no) {
            await trx
              .updateTable('wallet_number_sequences')
              .set({ next_value: s.allowance_wallet_no })
              .where('kind', '=', 'ALLOWANCE')
              .execute();
          }
          const typeId = types.get(TYPE_OF[p.roles.category])!;
          const pub = newPublicIdPair();
          const active = Number(s.status) === 1;
          const r = await trx
            .insertInto('member_profiles')
            .values({
              public_id: pub.bin,
              institution_id: instId,
              account_id: accountId,
              user_type_id: typeId,
              department_id: await departmentId(
                trx,
                typeId,
                clean(s.department) || 'Administration',
              ),
              first_name: name.first,
              last_name: name.last,
              contact_mobile: MOBILE.test(p.mobile) ? p.mobile : null,
              contact_email: p.email,
              employee_no: employeeNo,
              status: active ? 'ACTIVE' : 'INACTIVE',
              status_reason: active ? null : 'Inactive in the earlier application',
              txn_permission: Number(s.transaction_permission) === 0 ? 0 : 1,
              created_at: new Date(s.created_at),
              updated_at: now,
            })
            .executeTakeFirstOrThrow();
          const profileId = String(r.insertId);
          const wallets = await trx
            .selectFrom('wallets')
            .select(['id', 'wallet_no', 'kind'])
            .where('owner_profile_id', '=', profileId)
            .execute();
          const campus = wallets.find((w) => w.kind === 'CAMPUS');
          if (s.wallet_no && campus?.wallet_no !== s.wallet_no) {
            throw new Error(`wallet ${s.wallet_no} not kept (got ${campus?.wallet_no ?? 'none'})`);
          }

          for (const code of p.roles.codes) {
            const role = roleIds.get(code);
            if (!role) continue;
            await trx
              .insertInto('profile_roles')
              .values({ institution_id: instId, profile_id: profileId, role_id: role })
              .execute();
          }

          const values: [string, { text?: string; number?: number }][] = [];
          const blood = bloodGroup(s.blood_group);
          if (blood) values.push(['Blood group', { text: blood }]);
          if (s.year_of_association) {
            values.push(['Year of association', { number: Number(s.year_of_association) }]);
          }
          const role = bySheet.get(clean(s.emp).toUpperCase())?.role;
          if (role) values.push(['Role (earlier application)', { text: role }]);
          const klass = [clean(s.grade), clean(s.section)].filter(Boolean).join(' ');
          if (klass) values.push(['Class (earlier application)', { text: klass }]);
          for (const [label, v] of values) {
            await trx
              .insertInto('custom_field_values')
              .values({
                institution_id: instId,
                field_id: fields.get(label)!,
                entity_ref: pub.bin,
                value_text: v.text?.slice(0, 2000) ?? null,
                value_number: v.number === undefined ? null : String(v.number),
              })
              .execute();
          }

          // The card handed out by the earlier application: its token, and the value it holds so a tap
          // finds it (migration 0089). Only the card in use (the last one) is carried over.
          const card = (cardsOf.get(s.user_id) ?? []).filter((c) => Number(c.status) === 1).at(-1);
          if (card) {
            const value = clean(card.encrypted_token);
            const reason = /damag/i.test(card.reason_for_reissue ?? '')
              ? 'DAMAGED'
              : /lost/i.test(card.reason_for_reissue ?? '')
                ? 'LOST'
                : /stolen/i.test(card.reason_for_reissue ?? '')
                  ? 'STOLEN'
                  : 'NEW_REGISTRATION';
            await trx
              .insertInto('cards')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: instId,
                profile_id: profileId,
                token: clean(card.nfc_token_id).toUpperCase(),
                legacy_token_hash: value
                  ? createHash('sha256').update(value, 'utf8').digest()
                  : null,
                status: 'ACTIVE',
                issue_reason: reason,
                reissue_count: Number(card.reissue_count ?? 0),
                issued_at: new Date(card.updated_at ?? card.created_at),
              })
              .execute();
          }

          // The balance, through the ledger: money the school's bank pool already holds for the wallet.
          const balance = paiseOf(s.balance ?? '0');
          if (balance < 0) throw new Error(`negative balance ${String(s.balance)}`);
          if (balance > 0 && campus) {
            await ledger.post(trx, {
              institutionId: instId,
              type: 'ADJUSTMENT',
              channel: 'BACK_OFFICE',
              amountPaise: balance,
              idempotencyKey: `CUG-OPENING:${orgId}:${campus.wallet_no}`,
              debit: { account: 'BANK_POOL', institutionId: instId },
              credit: { walletId: String(campus.id) },
              narration: `Opening balance: ${CARRIED.toLowerCase()}`,
            });
          }

          // The attendance history: one day record and its check-in / check-out events.
          const days = daysOf.get(s.user_id) ?? [];
          for (const d of days) {
            const status = (d.status ?? '').replace('-', '_');
            const final = ['PRESENT', 'HALF_DAY', 'LATE', 'ABSENT'].includes(status)
              ? (status as 'PRESENT' | 'HALF_DAY' | 'LATE' | 'ABSENT')
              : null;
            const checkin = d.check_in_status ?? (final === 'LATE' ? 'LATE' : 'PRESENT');
            if (!final) continue;
            const at = d.check_in ?? d.check_out ?? new Date(`${d.att_date}T00:00:00Z`);
            const day = await trx
              .insertInto('attendance_days')
              .values({
                institution_id: instId,
                year_id: yearOf(d.att_date),
                profile_id: profileId,
                att_date: d.att_date,
                checkin_status: checkin,
                status: final,
                method: d.check_in_method === 'MANUAL' ? 'MANUAL' : 'NFC',
                check_in_at: d.check_in,
                check_out_at: d.check_out,
                remark: (clean(d.remarks) || CARRIED).slice(0, 200),
                created_at: at,
                updated_at: d.check_out ?? at,
              })
              .executeTakeFirstOrThrow();
            const events = [];
            if (d.check_in) {
              events.push({
                action: 'CHECK-IN' as const,
                old_status: null,
                new_status: checkin,
                at: d.check_in,
              });
            }
            if (d.check_out) {
              events.push({
                action: 'CHECK-OUT' as const,
                old_status: checkin,
                new_status: final,
                at: d.check_out,
              });
            }
            if (events.length) {
              await trx
                .insertInto('attendance_events')
                .values(
                  events.map((e) => ({
                    ...e,
                    institution_id: instId,
                    day_id: String(day.insertId),
                    remark: CARRIED,
                  })),
                )
                .execute();
            }
          }

          await recordAudit(trx, {
            institutionId: instId,
            action: 'STAFF_ONBOARDED',
            entityType: 'member',
            entityRef: pub.id,
            after: {
              userType: TYPE_OF[p.roles.category],
              employeeNo,
              newAccount: password !== null,
              roles: p.roles.codes,
              wallet: campus?.wallet_no ?? null,
              via: 'import',
              source: `${source}#${orgId}`,
            },
          });
          return {
            password,
            account: accountId !== null,
            card: card !== undefined,
            days: days.length,
            balance,
            roles: p.roles.codes.length,
            wallet: campus?.wallet_no ?? '',
          };
        });
        if (!done) {
          counts.existing++;
          continue;
        }
        counts.staff++;
        if (done.account) counts.accounts++;
        if (done.card) counts.cards++;
        if (done.balance) counts.balances++;
        if (done.roles) counts.roles++;
        counts.days += done.days;
        sheetOut.push([
          clean(s.name),
          employeeNo ?? '',
          TYPE_OF[p.roles.category],
          p.roles.codes.join(' + '),
          done.account ? p.mobile : '',
          done.account ? (p.email ?? '') : '',
          done.password ?? '',
          done.wallet,
          corporate && done.wallet ? `${corporate.code}${done.wallet}` : '',
          p.notes.join('; '),
        ]);
      } catch (e) {
        errors.push(
          `${clean(s.name)} (${employeeNo ?? 'no number'}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // New wallets continue after every number the earlier application gave (students' included).
    await db
      .updateTable('wallet_number_sequences')
      .set({
        next_value: sql`GREATEST((SELECT m FROM (SELECT COALESCE(MAX(CAST(wallet_no AS UNSIGNED)), 0) + 1 AS m FROM wallets WHERE kind IN ('CAMPUS', 'MERCHANT')) x), ${String(BigInt(old.top.campus ?? '0') + 1n)})`,
      })
      .where('kind', '=', 'CAMPUS')
      .execute();
    await db
      .updateTable('wallet_number_sequences')
      .set({
        next_value: sql`GREATEST((SELECT m FROM (SELECT COALESCE(MAX(CAST(wallet_no AS UNSIGNED)), 0) + 1 AS m FROM wallets WHERE kind = 'ALLOWANCE') x), ${String(BigInt(old.top.allowance ?? '0') + 1n)})`,
      })
      .where('kind', '=', 'ALLOWANCE')
      .execute();

    // An operator for the back office, when asked for.
    const opEmail = opt('operator-email')?.toLowerCase();
    if (opEmail) {
      const opMobile = digits10(opt('operator-mobile'));
      if (!EMAIL.test(opEmail) || !MOBILE.test(opMobile)) {
        errors.push('operator: --operator-email and a 10-digit --operator-mobile are needed');
      } else {
        const opName = splitName(opt('operator-name') ?? 'Platform Administrator');
        const password = temporaryPassword();
        const added = await db.transaction().execute(async (trx) => {
          const taken = await trx
            .selectFrom('platform_accounts')
            .select('id')
            .where((eb) => eb.or([eb('email', '=', opEmail), eb('mobile', '=', opMobile)]))
            .executeTakeFirst();
          if (taken) return false;
          const r = await trx
            .insertInto('platform_accounts')
            .values({
              public_id: newPublicIdPair().bin,
              mobile: opMobile,
              email: opEmail,
              first_name: opName.first.toUpperCase(),
              last_name: opName.last?.toUpperCase() ?? null,
            })
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('account_credentials')
            .values({
              account_id: String(r.insertId),
              kind: 'PASSWORD',
              hash: await hashSecret(password),
              must_change: 1,
            })
            .execute();
          await sql`INSERT INTO operator_accounts (public_id, account_id, role_id)
                    SELECT ${newPublicIdPair().bin}, ${String(r.insertId)}, id FROM roles WHERE code = 'PLATFORM_ADMIN'`.execute(
            trx,
          );
          return true;
        });
        if (added) {
          sheetOut.push([
            opt('operator-name') ?? 'Platform Administrator',
            '',
            'Back office',
            'PLATFORM_ADMIN',
            opMobile,
            opEmail,
            password,
            '',
            '',
            'back-office sign-in',
          ]);
        } else {
          errors.push('operator: that e-mail or mobile already has an account');
        }
      }
    }
  } finally {
    await db.destroy();
  }

  if (sheetOut.length) {
    const head = [
      'Name',
      'Employee no.',
      'User type',
      'Console roles',
      'Mobile (app sign-in)',
      'E-mail (console sign-in)',
      'Temporary password',
      'Wallet no.',
      'VAN',
      'Notes',
    ];
    const file = writeSignInSheet(
      outDir!,
      `${short}-staff-sign-in-CONFIDENTIAL.csv`,
      head,
      sheetOut,
    );
    console.log(
      `import-cug-staff: sign-in details in ${file} (confidential: hand out, then delete)`,
    );
  }
  console.log(
    `import-cug-staff: staff ${counts.staff} added (${counts.existing} already there), accounts ${counts.accounts}, ` +
      `with console roles ${counts.roles}, cards ${counts.cards}, balances ${counts.balances}, attendance days ${counts.days}`,
  );
  if (errors.length) {
    for (const e of errors) console.error(`  not done: ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(`import-cug-staff: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
