/**
 * Carries a school's students, its merchants and its feature switches over from the earlier CUG
 * application (client 2026-10-23: "please migrate the other details also"), after
 * `import-cug-staff.ts` made the school and its staff in the RingPe database:
 *
 *   npm run import:cug-students -- --db ringpe_live --org 21 --out "C:\private\folder" [--dry-run]
 *     [--as-student <earlier user ids>]   (students the earlier application had under another type)
 *
 * The earlier database (`--source`, default ringpe_cug_db_prod, same server) is only read; the
 * connection is DB_MIGRATOR_URL's server and login with the database name replaced. Nothing is sent
 * to anyone. Re-running adds only what is missing (matched by wallet number).
 *
 * With the client's choices of 2026-10-23:
 * - **classes as written** in the earlier application: one class per class name (spaces tidied,
 *   upper case), its sections as given, "A" where none was; the school renames or merges them in
 *   the console. The student is enrolled in the current academic year;
 * - **every record comes over**: an admission number used twice stays with the earlier record and is
 *   kept on the other as the field "Admission no. (earlier application)", listed for the school;
 * - **one sign-in per family mobile** with a temporary password changed at first sign-in (the
 *   earlier application kept the family's mobile on each child; no parent names): brothers and sisters
 *   share it, as a child without a phone sits under the family's mobile in RingPe. A mobile that is a
 *   staff member's here joins that sign-in. Parents are added later in the console;
 * - **the feature switches as the earlier application had them** (transfers and events off there);
 *   features new in RingPe (transport, quizzes) are left as they are.
 * As for the staff: the earlier wallet and allowance numbers, the NFC card with the earlier card
 * value (migration 0087), a balance through the ledger (bank pool → wallet), the attendance history,
 * blood group, year of association and the earlier class as fields. The merchant keeps its wallet
 * number, its merchant id and its balance; it gets no sign-in when its mobile is a back-office
 * operator's (an operator account may hold no school profile).
 *
 * Not carried over (history only, all closed): meal coupons (used or expired), payment QR requests,
 * payments, bank credits and settlement runs — the balances carry their result.
 * The sign-in details go to `<out>/<SHORT>-family-sign-in-CONFIDENTIAL.csv`: hand out, then delete.
 */
import { createHash } from 'node:crypto';
import { Kysely, MysqlDialect, sql, type Transaction } from 'kysely';
import { createPool } from 'mysql2';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { cugDatabaseOf } from '../db/cug-tables';
import { CugSchemaPlugin } from '../models/cug-schema-plugin';
import type { Database } from '../models/ringpe_models';
import { recordAudit } from '../services/audit.service';
import { LedgerService } from '../services/ledger.service';
import { newPublicIdPair } from '../utils/idGenerator';
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
  splitName,
  temporaryPassword,
  titleCase,
  writeSignInSheet,
} from './cug-import-common';

// --- arguments --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(`import-cug-students: ${message}`);
  process.exit(2);
};
const target = opt('db') ?? fail('--db <name> is required (the RingPe database to fill)');
const source = opt('source') ?? 'ringpe_cug_db_prod';
const orgId = Number(opt('org') ?? fail('--org <earlier organisation id> is required'));
const outDir = opt('out');
const dryRun = argv.includes('--dry-run');
/**
 * Earlier records entered under another user type that are students (`--as-student 1343,…`, the
 * earlier user ids; client 2026-10-23: Aahaan Mittal, UKG, was entered as staff).
 */
const asStudent = (opt('as-student') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s));
if (!asStudent.length) asStudent.push('0');
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

// --- the earlier database ---------------------------------------------------------------------------
interface OldMember {
  readonly user_id: string;
  readonly kind: 'student' | 'merchant';
  readonly name: string;
  readonly merchant_name: string | null;
  readonly merchant_unique_id: string | null;
  readonly user_sub_type: string | null;
  readonly mobile: string | null;
  readonly email: string | null;
  readonly adm: string | null;
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
  const c = await createConnection({
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
    const permissions = (
      await q<Record<string, unknown>>(
        'SELECT * FROM permissions_management WHERE organization_id = ? ORDER BY permissions_management_id DESC',
        [orgId],
      )
    )[0];
    const members = await q<OldMember>(
      `SELECT u.user_id, IF(u.user_id IN (?), 'student', LOWER(t.user_type)) AS kind, u.name,
              u.merchant_name, u.merchant_unique_id,
              u.user_sub_type, u.mobile, u.email, TRIM(u.admission_number) AS adm, u.grade, u.section,
              u.blood_group, u.year_of_association, u.status, u.transaction_permission, u.created_at,
              IF(u.user_id IN (?), NULL, d.department) AS department, w.wallet_no, w.balance,
              a.allowance_wallet_no
         FROM users u
         JOIN user_type t ON t.user_type_id = u.user_type_id
         LEFT JOIN department_details d ON d.department_id = u.department_id
         LEFT JOIN wallet w ON w.user_id = u.user_id AND w.organization_id = u.organization_id
         LEFT JOIN allowance_wallet a ON a.user_id = u.user_id AND a.organization_id = u.organization_id
        WHERE u.organization_id = ? AND (LOWER(t.user_type) IN ('student', 'merchant') OR u.user_id IN (?))
        ORDER BY u.user_id`,
      [asStudent, asStudent, orgId, asStudent],
    );
    const ids = members.map((m) => m.user_id);
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
    const [top] = await q<{ campus: string | null; allowance: string | null }>(
      `SELECT (SELECT MAX(CAST(wallet_no AS UNSIGNED)) FROM wallet) AS campus,
              (SELECT MAX(CAST(allowance_wallet_no AS UNSIGNED)) FROM allowance_wallet) AS allowance`,
    );
    return { org, permissions, members, cards, days, top: top! };
  } finally {
    await c.end();
  }
}

// --- classes ----------------------------------------------------------------------------------------
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** Where a class name sits in the list: Nursery, LKG, UKG, then grade 1 to 12, then the rest. */
function classOrder(name: string) {
  const n = name.toUpperCase();
  if (/^(NURSERY|PRE-?NURSERY)/.test(n)) return 1;
  if (/^LKG/.test(n)) return 2;
  if (/^UKG/.test(n)) return 3;
  if (/^I PUC/.test(n)) return 3 + 11;
  if (/^II PUC/.test(n)) return 3 + 12;
  const digits = /^(?:GRADE\s*)?(\d{1,2})\b/.exec(n);
  if (digits) return 3 + Number(digits[1]);
  const roman = /^([IVX]+)\b/.exec(n);
  if (roman && ROMAN.includes(roman[1]!)) return 3 + ROMAN.indexOf(roman[1]!) + 1;
  return 99;
}

// --- the import -------------------------------------------------------------------------------------
const FEATURES: readonly [string, string][] = [
  ['is_coupon_active', 'coupons'],
  ['is_allowance_active', 'allowances'],
  ['is_tution_active', 'tuition'],
  ['is_nfc_active', 'nfc'],
  ['is_attendance', 'attendance'],
  ['is_wallet_to_wallet_active', 'transfers'],
  ['is_event_active', 'events'],
];
const ADMISSION_FIELD = 'Admission no. (earlier application)';
type Trx = Transaction<Database>;

async function main() {
  const old = await readSource();
  const identifier = clean(old.org['organization_unique_id']);
  const students = old.members.filter((m) => m.kind === 'student');
  const merchants = old.members.filter((m) => m.kind === 'merchant');

  // Classes as written: the earlier class name and section (A where none was given).
  const placeOf = (s: OldMember) => ({
    klass: clean(s.grade).toUpperCase().slice(0, 40) || 'UNASSIGNED',
    section: clean(s.section).toUpperCase().slice(0, 20) || 'A',
  });
  const classes = new Map<string, Map<string, number>>();
  for (const s of students) {
    const p = placeOf(s);
    const sections = classes.get(p.klass) ?? new Map<string, number>();
    sections.set(p.section, (sections.get(p.section) ?? 0) + 1);
    classes.set(p.klass, sections);
  }
  // An admission number used twice stays with the earlier record.
  const firstWithNo = new Map<string, string>();
  for (const s of students) {
    const no = clean(s.adm).toUpperCase();
    if (no && !firstWithNo.has(no)) firstWithNo.set(no, s.user_id);
  }
  const families = new Map<string, OldMember[]>();
  for (const s of students) {
    const m = digits10(s.mobile);
    if (MOBILE.test(m)) families.set(m, [...(families.get(m) ?? []), s]);
  }
  const plan = students.map((s) => {
    const no = clean(s.adm).toUpperCase();
    const keeps = !!no && firstWithNo.get(no) === s.user_id;
    const notes: string[] = [];
    if (!no) notes.push('no admission number');
    else if (!keeps)
      notes.push(`admission no. ${no} also on an earlier record: kept as a field only`);
    if (!MOBILE.test(digits10(s.mobile))) notes.push('no valid mobile: no sign-in');
    const email = correctedEmail(s.email);
    if (email && !EMAIL.test(email)) notes.push(`e-mail “${clean(s.email)}” not valid: left empty`);
    return { s, no: keeps ? no : null, email: EMAIL.test(email) ? email : null, notes };
  });

  console.log(`import-cug-students: ${clean(old.org['organization_name'])} from ${source}`);
  console.log(
    `  students ${students.length} in ${families.size} family mobiles, merchants ${merchants.length}, ` +
      `cards ${old.cards.length}, attendance days ${old.days.length}, ` +
      `balances ${old.members.filter((m) => paiseOf(m.balance ?? '0') !== 0).length}`,
  );
  const ordered = [...classes.entries()].sort(
    (a, b) => classOrder(a[0]) - classOrder(b[0]) || a[0].localeCompare(b[0]),
  );
  console.log(`  classes ${ordered.length}:`);
  for (const [k, sections] of ordered) {
    console.log(
      `    ${k} — ${[...sections.entries()].map(([sec, n]) => `${sec} (${n})`).join(', ')}`,
    );
  }
  for (const p of plan) {
    if (p.notes.length) console.log(`  ${clean(p.s.name)}: ${p.notes.join('; ')}`);
  }
  const switches = old.permissions
    ? FEATURES.map(([col, key]) => [key, Number(old.permissions![col]) === 1] as const)
    : [];
  console.log(
    `  feature switches in the earlier application: ${switches.map(([k, on]) => `${k} ${on ? 'on' : 'off'}`).join(', ') || 'none found'}`,
  );
  if (dryRun) {
    console.log('import-cug-students: dry run, nothing written');
    return;
  }

  const db = new Kysely<Database>({
    plugins: [new CugSchemaPlugin(cugDatabaseOf(target))],
    dialect: new MysqlDialect({
      pool: createPool({
        uri: urlFor(target),
        supportBigNumbers: true,
        bigNumberStrings: true,
        timezone: 'Z',
        dateStrings: ['DATE'],
        connectionLimit: 4,
      }),
    }),
  });
  const ledger = new LedgerService();
  const now = new Date();
  const errors: string[] = [];
  const counts = {
    students: 0,
    existing: 0,
    accounts: 0,
    joined: 0,
    cards: 0,
    balances: 0,
    days: 0,
    merchants: 0,
    switches: 0,
  };
  /** Sign-in rows by family mobile (or by student when there is none). */
  const sheet = new Map<
    string,
    {
      mobile: string;
      email: string;
      password: string;
      who: string[];
      nos: string[];
      classes: string[];
      wallets: string[];
      notes: string[];
    }
  >();
  let short: string | undefined;

  try {
    const inst =
      (await db
        .selectFrom('institutions')
        .select(['id', 'short_name'])
        .where('identifier', '=', identifier)
        .executeTakeFirst()) ??
      fail(`school ${identifier} not in ${target}: run import:cug-staff first`);
    const instId = String(inst.id);
    short = inst.short_name;
    const year =
      (await db
        .selectFrom('academic_years')
        .select(['id', 'starts_on', 'ends_on'])
        .where('institution_id', '=', instId)
        .where('is_current', '=', 1)
        .executeTakeFirst()) ?? fail('the school has no current academic year');
    const yearId = String(year.id);
    const inYear = (day: string) =>
      day >= String(year.starts_on).slice(0, 10) && day <= String(year.ends_on).slice(0, 10);
    const typeId = async (name: string) =>
      String(
        (
          await db
            .selectFrom('user_types')
            .select('id')
            .where('institution_id', '=', instId)
            .where('name', '=', name)
            .executeTakeFirstOrThrow()
        ).id,
      );
    const studentType = await typeId('Student');
    const merchantType = await typeId('Merchant');
    const departmentId = async (trx: Trx, type: string, name: string) => {
      const found = await trx
        .selectFrom('departments')
        .select('id')
        .where('institution_id', '=', instId)
        .where('user_type_id', '=', type)
        .where('name', '=', name)
        .executeTakeFirst();
      if (found) return String(found.id);
      const r = await trx
        .insertInto('departments')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: instId,
          user_type_id: type,
          name: name.slice(0, 60),
          created_at: now,
        })
        .executeTakeFirstOrThrow();
      return String(r.insertId);
    };

    // ---- the feature switches, as the earlier application had them -----------------------------------
    await db.transaction().execute(async (trx) => {
      for (const [key, on] of switches) {
        const row = await trx
          .selectFrom('feature_toggles')
          .select('enabled')
          .where('institution_id', '=', instId)
          .where('feature_key', '=', key)
          .executeTakeFirst();
        const was = Number(row?.enabled ?? 0) === 1;
        if (row && was === on) continue;
        if (row) {
          await trx
            .updateTable('feature_toggles')
            .set({ enabled: on ? 1 : 0 })
            .where('institution_id', '=', instId)
            .where('feature_key', '=', key)
            .execute();
        } else {
          await trx
            .insertInto('feature_toggles')
            .values({ institution_id: instId, feature_key: key, enabled: on ? 1 : 0 })
            .execute();
        }
        await trx
          .insertInto('feature_change_log')
          .values({
            institution_id: instId,
            feature_key: key,
            from_value: was ? 1 : 0,
            to_value: on ? 1 : 0,
            reason: `${CARRIED} (its setting)`,
            changed_at: now,
          })
          .execute();
        await recordAudit(trx, {
          institutionId: instId,
          action: 'FEATURE_PERMISSION_CHANGED',
          entityType: 'feature',
          before: { [key]: was },
          after: { [key]: on },
          reason: `${CARRIED} (its setting)`,
          actor: { type: 'system' },
        });
        counts.switches++;
      }
    });

    // ---- classes and sections ---------------------------------------------------------------------------
    const sectionIds = new Map<string, string>();
    await db.transaction().execute(async (trx) => {
      for (const [name, sections] of ordered) {
        let klass = await trx
          .selectFrom('classes')
          .select('id')
          .where('institution_id', '=', instId)
          .where('name', '=', name)
          .executeTakeFirst();
        if (!klass) {
          const r = await trx
            .insertInto('classes')
            .values({
              public_id: newPublicIdPair().bin,
              institution_id: instId,
              name,
              sort_order: classOrder(name),
            })
            .executeTakeFirstOrThrow();
          klass = { id: String(r.insertId) };
        }
        for (const sec of sections.keys()) {
          let s = await trx
            .selectFrom('sections')
            .select('id')
            .where('class_id', '=', String(klass.id))
            .where('name', '=', sec)
            .executeTakeFirst();
          if (!s) {
            const r = await trx
              .insertInto('sections')
              .values({
                public_id: newPublicIdPair().bin,
                institution_id: instId,
                class_id: String(klass.id),
                name: sec,
                created_at: now,
              })
              .executeTakeFirstOrThrow();
            s = { id: String(r.insertId) };
          }
          sectionIds.set(`${name}|${sec}`, String(s.id));
        }
      }
    });

    // ---- the fields the records carry ----------------------------------------------------------------------
    const fields = new Map<string, string>();
    await db.transaction().execute(async (trx) => {
      const defs = await trx
        .selectFrom('custom_field_definitions')
        .select(['id', 'label', 'position'])
        .where('institution_id', '=', instId)
        .where('entity', '=', 'MEMBER')
        .execute();
      for (const d of defs) fields.set(d.label, String(d.id));
      let position = Math.max(0, ...defs.map((d) => Number(d.position)));
      for (const [label, type] of [
        ['Blood group', 'TEXT'],
        ['Year of association', 'NUMBER'],
        ['Class (earlier application)', 'TEXT'],
        [ADMISSION_FIELD, 'TEXT'],
      ] as const) {
        if (fields.has(label)) continue;
        const r = await trx
          .insertInto('custom_field_definitions')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: instId,
            entity: 'MEMBER',
            label,
            data_type: type,
            position: ++position,
            no_id_doc_ack_at: now,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        fields.set(label, String(r.insertId));
      }
    });

    const cardsOf = new Map<string, OldCard[]>();
    for (const c of old.cards) cardsOf.set(c.user_id, [...(cardsOf.get(c.user_id) ?? []), c]);
    const daysOf = new Map<string, OldDay[]>();
    for (const d of old.days) daysOf.set(d.user_id, [...(daysOf.get(d.user_id) ?? []), d]);

    /** Steps every member shares: wallet numbers, the profile, fields, card, balance, attendance. */
    const addMember = async (
      trx: Trx,
      s: OldMember,
      v: {
        typeId: string;
        department: string;
        first: string;
        last: string | null;
        accountId: string | null;
        email: string | null;
        admissionNo: string | null;
        values: [string, { text?: string; number?: number }][];
        sectionId: string | null;
      },
    ) => {
      if (s.wallet_no) {
        await trx
          .updateTable('wallet_number_sequences')
          .set({ next_value: s.wallet_no })
          .where('kind', '=', 'CAMPUS')
          .execute();
      }
      if (s.allowance_wallet_no && s.kind !== 'merchant') {
        await trx
          .updateTable('wallet_number_sequences')
          .set({ next_value: s.allowance_wallet_no })
          .where('kind', '=', 'ALLOWANCE')
          .execute();
      }
      const pub = newPublicIdPair();
      const mobile = digits10(s.mobile);
      const r = await trx
        .insertInto('member_profiles')
        .values({
          public_id: pub.bin,
          institution_id: instId,
          account_id: v.accountId,
          user_type_id: v.typeId,
          department_id: await departmentId(trx, v.typeId, v.department),
          first_name: v.first,
          last_name: v.last,
          contact_mobile: MOBILE.test(mobile) ? mobile : null,
          contact_email: v.email,
          admission_no: v.admissionNo,
          status: Number(s.status) === 1 ? 'ACTIVE' : 'INACTIVE',
          status_reason: Number(s.status) === 1 ? null : 'Inactive in the earlier application',
          txn_permission: Number(s.transaction_permission) === 0 ? 0 : 1,
          created_at: new Date(s.created_at),
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      const profileId = String(r.insertId);
      const wallet = await trx
        .selectFrom('wallets')
        .select(['id', 'wallet_no'])
        .where('owner_profile_id', '=', profileId)
        .where('kind', 'in', ['CAMPUS', 'MERCHANT'])
        .executeTakeFirst();
      if (s.wallet_no && wallet?.wallet_no !== s.wallet_no) {
        throw new Error(`wallet ${s.wallet_no} not kept (got ${wallet?.wallet_no ?? 'none'})`);
      }
      if (v.sectionId) {
        await trx
          .insertInto('enrolments')
          .values({
            institution_id: instId,
            student_profile_id: profileId,
            year_id: yearId,
            section_id: v.sectionId,
          })
          .execute();
      }
      for (const [label, val] of v.values) {
        await trx
          .insertInto('custom_field_values')
          .values({
            institution_id: instId,
            field_id: fields.get(label)!,
            entity_ref: pub.bin,
            value_text: val.text?.slice(0, 2000) ?? null,
            value_number: val.number === undefined ? null : String(val.number),
          })
          .execute();
      }
      // The card in use: its token, and the earlier card value a tap sends (migration 0087).
      const card = (cardsOf.get(s.user_id) ?? []).filter((c) => Number(c.status) === 1).at(-1);
      if (card) {
        const value = clean(card.encrypted_token);
        await trx
          .insertInto('cards')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: instId,
            profile_id: profileId,
            token: clean(card.nfc_token_id).toUpperCase(),
            legacy_token_hash: value ? createHash('sha256').update(value, 'utf8').digest() : null,
            status: 'ACTIVE',
            issue_reason: /damag/i.test(card.reason_for_reissue ?? '')
              ? 'DAMAGED'
              : /lost/i.test(card.reason_for_reissue ?? '')
                ? 'LOST'
                : /stolen/i.test(card.reason_for_reissue ?? '')
                  ? 'STOLEN'
                  : 'NEW_REGISTRATION',
            reissue_count: Number(card.reissue_count ?? 0),
            issued_at: new Date(card.updated_at ?? card.created_at),
          })
          .execute();
      }
      // The balance, through the ledger: money the school's bank pool already holds for the wallet.
      const balance = paiseOf(s.balance ?? '0');
      if (balance < 0) throw new Error(`negative balance ${String(s.balance)}`);
      if (balance > 0 && wallet) {
        await ledger.post(trx, {
          institutionId: instId,
          type: 'ADJUSTMENT',
          channel: 'BACK_OFFICE',
          amountPaise: balance,
          idempotencyKey: `CUG-OPENING:${orgId}:${wallet.wallet_no}`,
          debit: { account: 'BANK_POOL', institutionId: instId },
          credit: { walletId: String(wallet.id) },
          narration: `Opening balance: ${CARRIED.toLowerCase()}`,
        });
      }
      // The attendance history (a student's day carries the section).
      let days = 0;
      for (const d of daysOf.get(s.user_id) ?? []) {
        const status = (d.status ?? '').replace('-', '_');
        if (!['PRESENT', 'HALF_DAY', 'LATE', 'ABSENT'].includes(status)) continue;
        const final = status as 'PRESENT' | 'HALF_DAY' | 'LATE' | 'ABSENT';
        const checkin = d.check_in_status ?? (final === 'LATE' ? 'LATE' : 'PRESENT');
        const at = d.check_in ?? d.check_out ?? new Date(`${d.att_date}T00:00:00Z`);
        const day = await trx
          .insertInto('attendance_days')
          .values({
            institution_id: instId,
            year_id: inYear(d.att_date) ? yearId : null,
            profile_id: profileId,
            section_id: inYear(d.att_date) ? v.sectionId : null,
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
        const events = [
          ...(d.check_in
            ? [
                {
                  action: 'CHECK-IN' as const,
                  old_status: null,
                  new_status: checkin,
                  at: d.check_in,
                },
              ]
            : []),
          ...(d.check_out
            ? [
                {
                  action: 'CHECK-OUT' as const,
                  old_status: checkin,
                  new_status: final,
                  at: d.check_out,
                },
              ]
            : []),
        ];
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
        days++;
      }
      return { pub, profileId, wallet: wallet?.wallet_no ?? '', card: !!card, balance, days };
    };

    /** The wallet numbers already in the database (a re-run skips those members). */
    const already = new Set(
      (
        await db
          .selectFrom('wallets')
          .select('wallet_no')
          .where('institution_id', '=', instId)
          .execute()
      ).map((w) => w.wallet_no),
    );

    // ---- students, one family at a time ---------------------------------------------------------------
    const groups = [
      ...[...families.entries()].map(([mobile, kids]) => ({ mobile, kids })),
      ...students
        .filter((s) => !MOBILE.test(digits10(s.mobile)))
        .map((s) => ({ mobile: '', kids: [s] })),
    ];
    for (const g of groups) {
      const todo = g.kids.filter((k) => !k.wallet_no || !already.has(k.wallet_no));
      counts.existing += g.kids.length - todo.length;
      if (!todo.length) continue;
      try {
        await db.transaction().execute(async (trx) => {
          let accountId: string | null = null;
          let password = '';
          let email = '';
          const notes: string[] = [];
          if (g.mobile) {
            const existing = await trx
              .selectFrom('platform_accounts as a')
              .leftJoin('operator_accounts as o', 'o.account_id', 'a.id')
              .select(['a.id', 'a.email', 'o.id as operator'])
              .where('a.mobile', '=', g.mobile)
              .executeTakeFirst();
            if (existing?.operator) {
              notes.push('the mobile is a back-office login: no sign-in');
            } else if (existing) {
              accountId = String(existing.id);
              email = existing.email ?? '';
              const holder = await trx
                .selectFrom('member_profiles')
                .select(['first_name', 'last_name'])
                .where('account_id', '=', accountId)
                .where('institution_id', '=', instId)
                .orderBy('id')
                .executeTakeFirst();
              notes.push(
                holder
                  ? `signs in with ${[holder.first_name, holder.last_name].filter(Boolean).join(' ')}’s sign-in (same mobile)`
                  : 'signs in with the sign-in already on this mobile',
              );
              counts.joined++;
            } else {
              const first = plan.find((p) => p.s.user_id === g.kids[0]!.user_id)!;
              const candidate = g.kids
                .map((k) => plan.find((p) => p.s.user_id === k.user_id)!.email)
                .find(Boolean);
              const taken = candidate
                ? await trx
                    .selectFrom('platform_accounts')
                    .select('id')
                    .where('email', '=', candidate)
                    .executeTakeFirst()
                : undefined;
              const name = splitName(first.s.name);
              const r = await trx
                .insertInto('platform_accounts')
                .values({
                  public_id: newPublicIdPair().bin,
                  mobile: g.mobile,
                  email: candidate && !taken ? candidate : null,
                  first_name: name.first.toUpperCase(),
                  last_name: name.last?.toUpperCase() ?? null,
                  created_at: new Date(first.s.created_at),
                })
                .executeTakeFirstOrThrow();
              accountId = String(r.insertId);
              email = candidate && !taken ? candidate : '';
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
              counts.accounts++;
            }
          }
          const row = {
            mobile: g.mobile,
            email,
            password,
            who: [] as string[],
            nos: [] as string[],
            classes: [] as string[],
            wallets: [] as string[],
            notes,
          };
          for (const s of todo) {
            const p = plan.find((x) => x.s.user_id === s.user_id)!;
            const place = placeOf(s);
            const name = splitName(s.name);
            const values: [string, { text?: string; number?: number }][] = [];
            const blood = bloodGroup(s.blood_group);
            if (blood) values.push(['Blood group', { text: blood }]);
            if (s.year_of_association) {
              values.push(['Year of association', { number: Number(s.year_of_association) }]);
            }
            const was = [clean(s.grade), clean(s.section)].filter(Boolean).join(' ');
            if (was) values.push(['Class (earlier application)', { text: was }]);
            if (clean(s.adm) && !p.no) values.push([ADMISSION_FIELD, { text: clean(s.adm) }]);
            const m = await addMember(trx, s, {
              typeId: studentType,
              department: clean(s.department) || 'Academics',
              first: name.first,
              last: name.last,
              accountId,
              email: p.email,
              admissionNo: p.no,
              values,
              sectionId: sectionIds.get(`${place.klass}|${place.section}`)!,
            });
            await recordAudit(trx, {
              institutionId: instId,
              action: 'MEMBER_ONBOARDED',
              entityType: 'member',
              entityRef: m.pub.id,
              after: {
                userType: 'Student',
                admissionNo: p.no,
                class: `${place.klass} ${place.section}`,
                wallet: m.wallet,
                via: 'import',
                source: `${source}#${orgId}`,
              },
              actor: { type: 'system' },
            });
            row.who.push(clean(s.name));
            row.nos.push(p.no ?? clean(s.adm));
            row.classes.push(`${place.klass} ${place.section}`);
            row.wallets.push(m.wallet);
            row.notes.push(...p.notes.map((n) => `${clean(s.name)}: ${n}`));
            counts.students++;
            if (m.card) counts.cards++;
            if (m.balance) counts.balances++;
            counts.days += m.days;
          }
          sheet.set(g.mobile || `student:${todo[0]!.user_id}`, row);
        });
      } catch (e) {
        errors.push(
          `${g.kids.map((k) => clean(k.name)).join(', ')}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // ---- merchants --------------------------------------------------------------------------------------
    for (const s of merchants) {
      if (s.wallet_no && already.has(s.wallet_no)) {
        counts.existing++;
        continue;
      }
      try {
        await db.transaction().execute(async (trx) => {
          const mobile = digits10(s.mobile);
          const notes: string[] = [];
          let accountId: string | null = null;
          if (MOBILE.test(mobile)) {
            const existing = await trx
              .selectFrom('platform_accounts as a')
              .leftJoin('operator_accounts as o', 'o.account_id', 'a.id')
              .select(['a.id', 'o.id as operator'])
              .where('a.mobile', '=', mobile)
              .executeTakeFirst();
            // An operator account may hold no school profile (the back office would refuse it).
            if (existing?.operator) notes.push('the mobile is a back-office login: no sign-in');
            else if (existing) accountId = String(existing.id);
          } else notes.push('no valid mobile: no sign-in');
          let password = '';
          const email = correctedEmail(s.email);
          if (MOBILE.test(mobile) && !accountId && !notes.length) {
            const name = splitName(s.name);
            const taken =
              EMAIL.test(email) &&
              (await trx
                .selectFrom('platform_accounts')
                .select('id')
                .where('email', '=', email)
                .executeTakeFirst());
            const r = await trx
              .insertInto('platform_accounts')
              .values({
                public_id: newPublicIdPair().bin,
                mobile,
                email: EMAIL.test(email) && !taken ? email : null,
                first_name: name.first.toUpperCase(),
                last_name: name.last?.toUpperCase() ?? null,
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
            counts.accounts++;
          }
          const name = splitName(s.name);
          const m = await addMember(trx, s, {
            typeId: merchantType,
            department: clean(s.department) || 'Merchant',
            first: name.first.toUpperCase(),
            last: name.last?.toUpperCase() ?? null,
            accountId,
            email: EMAIL.test(email) ? email : null,
            admissionNo: null,
            values: [],
            sectionId: null,
          });
          const regular = clean(s.user_sub_type).toUpperCase() !== 'VENDOR';
          const on = (col: string) => Number(old.permissions?.[col] ?? 0) === 1;
          const displayName = titleCase(clean(s.merchant_name) || clean(s.name)).slice(0, 50);
          await trx
            .insertInto('merchants')
            .values({
              profile_id: m.profileId,
              institution_id: instId,
              unique_id:
                clean(s.merchant_unique_id).toUpperCase().slice(0, 24) || `MERCUG${s.user_id}`,
              display_name: displayName,
              sub_type: regular ? 'REGULAR' : 'VENDOR',
              accepts_allowance: regular && on('is_allowance_active') ? 1 : 0,
              accepts_coupon: regular && on('is_coupon_active') ? 1 : 0,
              // The earlier application took the merchant's payments by NFC tap.
              nfc_enabled: on('is_nfc_active') ? 1 : 0,
              created_at: new Date(s.created_at),
              updated_at: now,
            })
            .execute();
          await recordAudit(trx, {
            institutionId: instId,
            action: 'MERCHANT_REGISTERED',
            entityType: 'merchant',
            entityRef: m.pub.id,
            after: {
              displayName,
              uniqueId: clean(s.merchant_unique_id),
              wallet: m.wallet,
              via: 'import',
              source: `${source}#${orgId}`,
            },
            actor: { type: 'system' },
          });
          if (m.balance) counts.balances++;
          if (m.card) counts.cards++;
          counts.merchants++;
          sheet.set(`merchant:${s.user_id}`, {
            mobile: accountId ? mobile : '',
            email: accountId && EMAIL.test(email) ? email : '',
            password,
            who: [`${displayName} (merchant)`],
            nos: [clean(s.merchant_unique_id)],
            classes: [],
            wallets: [m.wallet],
            notes: [
              ...notes,
              ...(m.balance ? [`balance ₹${(m.balance / 100).toFixed(2)} carried over`] : []),
              'no bank account for settlement in the earlier data: add it in the console',
            ],
          });
        });
      } catch (e) {
        errors.push(`${clean(s.name)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // New wallets continue after every number the earlier application gave.
    for (const [kind, top, kinds] of [
      ['CAMPUS', old.top.campus, ['CAMPUS', 'MERCHANT']],
      ['ALLOWANCE', old.top.allowance, ['ALLOWANCE']],
    ] as const) {
      await db
        .updateTable('wallet_number_sequences')
        .set({
          next_value: sql`GREATEST((SELECT m FROM (SELECT COALESCE(MAX(CAST(wallet_no AS UNSIGNED)), 0) + 1 AS m FROM wallets WHERE kind IN (${sql.join([...kinds])})) x), ${String(BigInt(top ?? '0') + 1n)})`,
        })
        .where('kind', '=', kind)
        .execute();
    }
  } finally {
    await db.destroy();
  }

  if (sheet.size) {
    const file = writeSignInSheet(
      outDir!,
      `${short ?? 'SCHOOL'}-family-sign-in-CONFIDENTIAL.csv`,
      [
        'Mobile (app sign-in)',
        'E-mail',
        'Temporary password',
        'Students',
        'Admission no.',
        'Class',
        'Wallet no.',
        'Notes',
      ],
      [...sheet.values()].map((r) => [
        r.mobile,
        r.email,
        r.password,
        r.who.join('; '),
        r.nos.join('; '),
        r.classes.join('; '),
        r.wallets.join('; '),
        r.notes.join('; '),
      ]),
    );
    console.log(
      `import-cug-students: sign-in details in ${file} (confidential: hand out, then delete)`,
    );
  }
  console.log(
    `import-cug-students: students ${counts.students} added (${counts.existing} already there), ` +
      `family sign-ins ${counts.accounts} new + ${counts.joined} joined to a staff sign-in, merchants ${counts.merchants}, ` +
      `cards ${counts.cards}, balances ${counts.balances}, attendance days ${counts.days}, feature switches changed ${counts.switches}`,
  );
  if (errors.length) {
    for (const e of errors) console.error(`  not done: ${e}`);
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(`import-cug-students: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
