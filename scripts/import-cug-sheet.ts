/**
 * Applies a school's student sheet from the earlier CUG application ("unified admission upload": one
 * row per student) to the students `import-cug-students.ts` carried over (client 2026-10-23: "in that
 * sections are there please change accordingly"; fill in the rest — "no need to keep the student
 * Aadhaar and PAN card in RingPe"):
 *
 *   npm run import:cug-sheet -- --db ringpe_live --org 21 --sheet "C:\path\students.xlsx" \
 *     --out "C:\private\folder" [--dry-run]
 *
 * Each row is matched to one student, in this order (a student is matched once):
 * 1. the admission number (or the earlier one kept as a field) and a similar name — of several
 *    records on one number, the one in the sheet's class;
 * 2. the same name in the same class, then anywhere;
 * 3. the same first and last name in the same class;
 * 4. the admission number and the class with a related name ("Eshan" / "EASHAN");
 * 5. the same serial number written another way ("SRGS/24-25/2433" = "2433/24-25"), class and first name;
 * 6. the same first two names in the same class;
 * 7. a parent's mobile on the sheet is the student's family mobile, in the same class.
 * Rows it cannot place are listed, never guessed.
 *
 * For a matched student:
 * - the class and section the sheet gives, as the console's correction does (the enrolment and a
 *   CORRECTED enrolment change with the reason);
 * - gender, date of birth and blood group where the record has none;
 * - the father, the mother (and a guardian) as Parent profiles with their mobile and e-mail, linked
 *   to the child (the first one the primary contact). A brother's or sister's parent of the same
 *   relation is linked, however the sheet spells the name; so is the adult already on that mobile
 *   with that name (a staff member, say). As in the console (client 2026-10-22), a mobile belongs to
 *   the adults who hold it, so a parent whose mobile is another adult's (often the mother on the
 *   father's) — or who has none — is added with the mobile left empty and listed (the client's
 *   "leave empty, fill later"). The parent on the family's sign-in mobile joins that sign-in, which
 *   then carries the parent's name; a parent's own mobile gets no sign-in (they sign up in the app).
 * The Aadhaar and PAN columns are never read. Nothing is sent. Re-running changes only what differs.
 * What it could not do goes to `<out>/<SHORT>-sheet-to-check.csv`.
 */
import { Kysely, MysqlDialect, type Transaction } from 'kysely';
import { createPool } from 'mysql2';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { cugDatabaseOf } from '../db/cug-tables';
import { CugSchemaPlugin } from '../models/cug-schema-plugin';
import type { Database } from '../models/ringpe_models';
import { recordAudit } from '../services/audit.service';
import { sameName } from '../services/members.service';
import { istBusinessDate } from '../utils/format';
import { binToUuid, newPublicIdPair } from '../utils/idGenerator';
import {
  EMAIL,
  MOBILE,
  bloodGroup,
  clean,
  correctedEmail,
  digits10,
  readXlsx,
  splitName,
  writeSignInSheet,
} from './cug-import-common';

// --- arguments --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(`import-cug-sheet: ${message}`);
  process.exit(2);
};
const target = opt('db') ?? fail('--db <name> is required (the RingPe database)');
const source = opt('source') ?? 'ringpe_cug_db_prod';
const orgId = Number(opt('org') ?? fail('--org <earlier organisation id> is required'));
const sheetPath = opt('sheet') ?? fail('--sheet <the students .xlsx> is required');
const outDir = opt('out');
const dryRun = argv.includes('--dry-run');
for (const [k, v] of [
  ['--db', target],
  ['--source', source],
] as const) {
  if (!/^[a-z0-9_]{1,56}$/.test(v)) fail(`${k} must be a lower-case database name`);
}
if (!Number.isSafeInteger(orgId) || orgId <= 0) fail('--org must be a number');
if (!dryRun && !outDir) fail('--out <folder> is required (the list of rows to check goes there)');
const migratorUrl = process.env['DB_MIGRATOR_URL'] ?? fail('DB_MIGRATOR_URL is not set');
const urlFor = (database: string) => {
  const u = new URL(migratorUrl);
  u.pathname = `/${database}`;
  return u.toString();
};

// --- the sheet --------------------------------------------------------------------------------------
interface Parent {
  readonly relation: 'FATHER' | 'MOTHER' | 'GUARDIAN';
  readonly name: string;
  readonly mobile: string;
  readonly email: string | null;
}
interface Row {
  readonly row: number;
  readonly adm: string;
  readonly name: string;
  readonly klass: string;
  readonly section: string;
  readonly gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
  readonly dob: string | null;
  readonly dobText: string;
  readonly blood: string | null;
  readonly parents: readonly Parent[];
  /** The same person is in both the father's and the mother's columns. */
  readonly twice: boolean;
}

/** A date of birth as the sheet holds it: an Excel day number, or d-m-yyyy / yyyy-m-d text. */
function dateOf(v: string): string | null {
  const parts = (t: string): [number, number, number] | null => {
    if (/^\d{4,5}(\.\d+)?$/.test(t)) {
      const at = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000);
      return [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()];
    }
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
    if (dmy) return [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
    const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
    return ymd ? [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])] : null;
  };
  const p = parts(v.trim());
  if (!p) return null;
  const [y, m, d] = p;
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  const iso = at.toISOString().slice(0, 10);
  // A school child's: born after 1990, and before today.
  return y > 1990 && iso < istBusinessDate(new Date()) ? iso : null;
}

function readSheet(): Row[] {
  const books = readXlsx(sheetPath);
  const rows = Object.values(books).find((r) => r[0]?.includes('STUDENT NAME')) ?? [];
  const head = rows[0] ?? fail('no sheet with a STUDENT NAME column');
  // Only these columns are read: never the Aadhaar or PAN numbers (client 2026-10-23).
  const at = (r: string[], name: string) => clean(r[head.indexOf(name)] ?? '');
  const parent = (r: string[], relation: Parent['relation'], prefix: string): Parent | null => {
    const name = at(r, `${prefix} NAME`);
    if (!name) return null;
    const email = correctedEmail(at(r, `${prefix} EMAIL`));
    return {
      relation,
      name,
      mobile: digits10(at(r, `${prefix} MOBILE`)),
      email: EMAIL.test(email) ? email : null,
    };
  };
  return rows
    .slice(1)
    .map((r, i) => {
      const g = at(r, 'GENDER').toUpperCase();
      const dobText = at(r, 'DOB');
      return {
        row: i + 2,
        adm: at(r, 'ADMISSION NUMBER').toUpperCase(),
        name: at(r, 'STUDENT NAME'),
        klass: at(r, 'CLASS').toUpperCase(),
        section: at(r, 'SECTION').toUpperCase(),
        gender: g.startsWith('M')
          ? 'MALE'
          : g.startsWith('F')
            ? 'FEMALE'
            : g.startsWith('O')
              ? 'OTHER'
              : null,
        dob: dobText ? dateOf(dobText) : null,
        dobText,
        blood: bloodGroup(at(r, 'BLOOD GROUP')),
        parents: [
          parent(r, 'FATHER', 'FATHER'),
          parent(r, 'MOTHER', 'MOTHER'),
          parent(r, 'GUARDIAN', 'GUARDIAN'),
        ]
          .filter((p): p is Parent => p !== null)
          // One person in both the father's and the mother's columns (one name, as seen 2026-10-23):
          // added once, as the mother; the row is listed.
          .filter(
            (p, _i, all) =>
              !(
                p.relation === 'FATHER' &&
                all.some(
                  (o) => o.relation === 'MOTHER' && sameName(splitName(o.name), splitName(p.name)),
                )
              ),
          ),
        twice: (() => {
          const f = splitName(at(r, 'FATHER NAME'));
          const m = splitName(at(r, 'MOTHER NAME'));
          return !!f.first && !!m.first && sameName(f, m);
        })(),
      } satisfies Row;
    })
    .filter((r) => r.name);
}

// --- matching ---------------------------------------------------------------------------------------
const tokens = (s: string | null | undefined) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
/** 3 the same name (the words in any order) · 2 the same first and last word · 1 the same first word. */
function likeness(a: string, b: string) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return 0;
  if (x.join(' ') === y.join(' ') || x.join('') === y.join('')) return 3;
  if ([...x].sort().join(' ') === [...y].sort().join(' ')) return 3;
  if (x[0] === y[0] && x.length > 1 && y.length > 1 && x.at(-1) === y.at(-1)) return 2;
  if (x[0] === y[0] && x[0]!.length >= 3) return 1;
  return 0;
}
/** Some likeness at all: a shared word of 3+ letters, or the same first 3 letters. */
function related(a: string, b: string) {
  const x = tokens(a);
  const y = tokens(b);
  return (
    x.some((t) => t.length >= 3 && y.includes(t)) ||
    (!!x[0] && !!y[0] && x[0].slice(0, 3) === y[0].slice(0, 3))
  );
}
/** The serial part of an admission number ("SRGS/24-25/2433" and "2433/24-25" are both 2433). */
const serial = (a: string | null) =>
  (String(a ?? '').match(/\d+/g) ?? [])
    .filter((d) => d.length >= 3)
    .map((d) => String(Number(d)))
    .at(-1) ?? '';

interface Student {
  readonly id: string;
  readonly publicId: Buffer;
  readonly name: string;
  readonly first: string;
  readonly last: string | null;
  readonly adm: string;
  readonly oldAdm: string;
  readonly mobile: string;
  readonly accountId: string | null;
  readonly gender: string | null;
  readonly dob: string | null;
  readonly blood: boolean;
  readonly enrolmentId: string;
  readonly sectionId: string;
  readonly klass: string;
  readonly section: string;
}

function match(rows: readonly Row[], students: readonly Student[]) {
  const used = new Set<string>();
  const done = new Map<number, { student: Student; how: string }>();
  const pass = (how: string, find: (r: Row, free: Student[]) => Student[]) => {
    for (const r of rows) {
      if (done.has(r.row)) continue;
      const found = find(
        r,
        students.filter((s) => !used.has(s.id)),
      );
      if (found.length === 1) {
        used.add(found[0]!.id);
        done.set(r.row, { student: found[0]!, how });
      }
    }
  };
  const onNumber = (r: Row, s: Student) => !!r.adm && (s.adm === r.adm || s.oldAdm === r.adm);
  pass('admission no. and name', (r, free) => {
    let c = free.filter((s) => onNumber(r, s) && likeness(s.name, r.name) >= 1);
    if (c.length > 1) c = c.filter((s) => s.klass === r.klass);
    return c;
  });
  pass('same name and class', (r, free) =>
    free.filter((s) => likeness(s.name, r.name) === 3 && s.klass === r.klass),
  );
  pass('same name', (r, free) => free.filter((s) => likeness(s.name, r.name) === 3));
  pass('first and last name, class', (r, free) =>
    free.filter((s) => likeness(s.name, r.name) >= 2 && s.klass === r.klass),
  );
  pass('admission no. and class, name written differently', (r, free) => {
    const c = free.filter((s) => onNumber(r, s) && s.klass === r.klass);
    return c.length === 1 && related(c[0]!.name, r.name) ? c : [];
  });
  pass('serial no., class and first name', (r, free) =>
    serial(r.adm)
      ? free.filter(
          (s) =>
            (serial(s.adm) === serial(r.adm) || serial(s.oldAdm) === serial(r.adm)) &&
            s.klass === r.klass &&
            tokens(s.name)[0] === tokens(r.name)[0],
        )
      : [],
  );
  pass('first two names, class', (r, free) => {
    const t = tokens(r.name);
    return t.length > 1
      ? free.filter(
          (s) =>
            s.klass === r.klass && tokens(s.name).slice(0, 2).join(' ') === t.slice(0, 2).join(' '),
        )
      : [];
  });
  pass("parent's mobile is the family's, class", (r, free) => {
    const mobiles = r.parents.map((p) => p.mobile).filter((m) => MOBILE.test(m));
    return free.filter((s) => s.mobile && mobiles.includes(s.mobile) && s.klass === r.klass);
  });
  return done;
}

// --- the import -------------------------------------------------------------------------------------
type Trx = Transaction<Database>;

async function main() {
  const rows = readSheet();
  const c = await createConnection({ uri: urlFor(source) });
  const org = await c
    .query<RowDataPacket[]>(
      'SELECT organization_unique_id, organization_name FROM organization_details WHERE organization_id = ?',
      [orgId],
    )
    .then(([r]) => r[0] ?? fail(`organisation ${orgId} not found in ${source}`))
    .finally(() => c.end());
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
  const now = new Date();
  const REASON = 'Class and section from the school’s student sheet (client 2026-10-23)';
  const check: string[][] = [];
  const counts = {
    moved: 0,
    gender: 0,
    dob: 0,
    blood: 0,
    parentsAdded: 0,
    parentsLinked: 0,
    signIns: 0,
    parentsWithoutMobile: 0,
  };
  let short: string | undefined;
  try {
    const inst =
      (await db
        .selectFrom('institutions')
        .select(['id', 'public_id', 'short_name'])
        .where('identifier', '=', clean(org['organization_unique_id']))
        .executeTakeFirst()) ?? fail('the school is not in this database: run the imports first');
    const instId = String(inst.id);
    short = inst.short_name;
    const year =
      (await db
        .selectFrom('academic_years')
        .select('id')
        .where('institution_id', '=', instId)
        .where('is_current', '=', 1)
        .executeTakeFirst()) ?? fail('the school has no current academic year');
    const fieldId = async (label: string) =>
      (
        await db
          .selectFrom('custom_field_definitions')
          .select('id')
          .where('institution_id', '=', instId)
          .where('entity', '=', 'MEMBER')
          .where('label', '=', label)
          .executeTakeFirst()
      )?.id;
    const oldAdmField = await fieldId('Admission no. (earlier application)');
    const bloodField = await fieldId('Blood group');
    const values = async (field: unknown) =>
      field
        ? new Map(
            (
              await db
                .selectFrom('custom_field_values')
                .select(['entity_ref', 'value_text'])
                .where('field_id', '=', String(field))
                .execute()
            ).map((v) => [v.entity_ref.toString('hex'), clean(v.value_text).toUpperCase()]),
          )
        : new Map<string, string>();
    const oldAdms = await values(oldAdmField);
    const bloods = await values(bloodField);
    const students: Student[] = (
      await db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as t', 't.id', 'm.user_type_id')
        .innerJoin('enrolments as e', (j) =>
          j.onRef('e.student_profile_id', '=', 'm.id').on('e.year_id', '=', String(year.id)),
        )
        .innerJoin('sections as s', 's.id', 'e.section_id')
        .innerJoin('classes as c', 'c.id', 's.class_id')
        .select([
          'm.id',
          'm.public_id',
          'm.first_name',
          'm.last_name',
          'm.admission_no',
          'm.contact_mobile',
          'm.account_id',
          'm.gender',
          'm.date_of_birth',
          'e.id as enrolment_id',
          'e.section_id',
          's.name as section',
          'c.name as klass',
        ])
        .where('m.institution_id', '=', instId)
        .where('t.category', '=', 'STUDENT')
        .execute()
    ).map((s) => ({
      id: String(s.id),
      publicId: s.public_id,
      name: [s.first_name, s.last_name].filter(Boolean).join(' '),
      first: s.first_name,
      last: s.last_name,
      adm: clean(s.admission_no).toUpperCase(),
      oldAdm: oldAdms.get(s.public_id.toString('hex')) ?? '',
      mobile: s.contact_mobile ?? '',
      accountId: s.account_id === null ? null : String(s.account_id),
      gender: s.gender,
      dob: s.date_of_birth ? String(s.date_of_birth).slice(0, 10) : null,
      blood: bloods.has(s.public_id.toString('hex')),
      enrolmentId: String(s.enrolment_id),
      sectionId: String(s.section_id),
      klass: s.klass,
      section: s.section,
    }));
    const matched = match(rows, students);

    const how: Record<string, number> = {};
    for (const m of matched.values()) how[m.how] = (how[m.how] ?? 0) + 1;
    const moves = rows.filter((r) => {
      const m = matched.get(r.row);
      return m && (m.student.klass !== r.klass || m.student.section !== r.section);
    });
    console.log(
      `import-cug-sheet: ${clean(org['organization_name'])}, ${rows.length} rows in the sheet`,
    );
    console.log(
      `  matched ${matched.size}: ${Object.entries(how)
        .map(([k, n]) => `${k} ${n}`)
        .join(' · ')}`,
    );
    console.log(
      `  class or section to change ${moves.length} · gender to fill ${rows.filter((r) => r.gender && matched.get(r.row) && !matched.get(r.row)!.student.gender).length}` +
        ` · date of birth ${rows.filter((r) => r.dob && matched.get(r.row) && !matched.get(r.row)!.student.dob).length}` +
        ` · blood group ${rows.filter((r) => r.blood && matched.get(r.row) && !matched.get(r.row)!.student.blood).length}` +
        ` · parents named ${rows.filter((r) => matched.has(r.row)).reduce((a, r) => a + r.parents.length, 0)}`,
    );
    for (const r of rows.filter((x) => !matched.has(x.row))) {
      console.log(
        `  not placed: row ${r.row} ${r.adm || '(no number)'} "${r.name}" ${r.klass} ${r.section}`,
      );
      check.push([
        String(r.row),
        r.name,
        r.adm,
        `${r.klass} ${r.section}`,
        'Not found among the students carried over',
      ]);
    }
    for (const r of rows) {
      const m = matched.get(r.row);
      if (m && m.how === "parent's mobile is the family's, class") {
        console.log(
          `  placed by the parent's mobile: row ${r.row} "${r.name}" → ${m.student.name} (${m.student.adm})`,
        );
        check.push([
          String(r.row),
          r.name,
          r.adm,
          `${r.klass} ${r.section}`,
          `Placed on ${m.student.name} (${m.student.adm}) by the parent's mobile: the sheet's admission number differs`,
        ]);
      }
      if (m && r.dobText && !r.dob && !m.student.dob) {
        check.push([
          String(r.row),
          r.name,
          r.adm,
          `${r.klass} ${r.section}`,
          `Date of birth "${r.dobText}" not readable: left empty`,
        ]);
      }
      if (m && r.twice) {
        check.push([
          String(r.row),
          r.name,
          r.adm,
          `${r.klass} ${r.section}`,
          'The same name is in the father’s and the mother’s columns: added once, as the mother',
        ]);
      }
    }
    if (dryRun) {
      console.log('import-cug-sheet: dry run, nothing written');
      return;
    }

    const parentType = String(
      (
        await db
          .selectFrom('user_types')
          .select('id')
          .where('institution_id', '=', instId)
          .where('category', '=', 'PARENT')
          .where('status', '=', 'ACTIVE')
          .orderBy('id')
          .executeTakeFirstOrThrow()
      ).id,
    );
    const sections = new Map<string, string>();
    const sectionOf = async (trx: Trx, klass: string, name: string) => {
      const key = `${klass}|${name}`;
      const known = sections.get(key);
      if (known) return known;
      const cl =
        (await trx
          .selectFrom('classes')
          .select('id')
          .where('institution_id', '=', instId)
          .where('name', '=', klass)
          .executeTakeFirst()) ?? null;
      if (!cl) throw new Error(`class ${klass} is not set up`);
      let s = await trx
        .selectFrom('sections')
        .select('id')
        .where('class_id', '=', String(cl.id))
        .where('name', '=', name)
        .executeTakeFirst();
      if (!s) {
        const r = await trx
          .insertInto('sections')
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: instId,
            class_id: String(cl.id),
            name,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        s = { id: String(r.insertId) };
      }
      sections.set(key, String(s.id));
      return String(s.id);
    };

    for (const r of rows) {
      const m = matched.get(r.row);
      if (!m) continue;
      const s = m.student;
      try {
        await db.transaction().execute(async (trx) => {
          // Class and section.
          if (s.klass !== r.klass || s.section !== r.section) {
            const to = await sectionOf(trx, r.klass, r.section);
            const u = await trx
              .updateTable('enrolments')
              .set({ section_id: to })
              .where('id', '=', s.enrolmentId)
              .where('section_id', '=', s.sectionId)
              .executeTakeFirst();
            if (Number(u.numUpdatedRows) !== 1) throw new Error('the enrolment changed meanwhile');
            await trx
              .insertInto('enrolment_changes')
              .values({
                institution_id: instId,
                student_profile_id: s.id,
                year_id: String(year.id),
                kind: 'CORRECTED',
                from_section_id: s.sectionId,
                to_section_id: to,
                effective_on: istBusinessDate(now),
                reason: REASON,
                at: now,
              })
              .execute();
            await trx
              .updateTable('attendance_days')
              .set({ section_id: to })
              .where('profile_id', '=', s.id)
              .where('section_id', '=', s.sectionId)
              .execute();
            counts.moved++;
          }
          // Gender, date of birth, blood group — only where the record has none.
          const set: { gender?: 'MALE' | 'FEMALE' | 'OTHER'; date_of_birth?: string } = {};
          if (r.gender && !s.gender) set.gender = r.gender;
          if (r.dob && !s.dob) set.date_of_birth = r.dob;
          if (Object.keys(set).length) {
            await trx
              .updateTable('member_profiles')
              .set({ ...set, updated_at: now })
              .where('id', '=', s.id)
              .execute();
            await recordAudit(trx, {
              institutionId: instId,
              action: 'MEMBER_EDITED',
              entityType: 'member',
              entityRef: binToUuid(s.publicId),
              before: { gender: s.gender, dateOfBirth: s.dob },
              after: { gender: set.gender ?? s.gender, dateOfBirth: set.date_of_birth ?? s.dob },
              reason: 'From the school’s student sheet (client 2026-10-23)',
              actor: { type: 'system' },
            });
            if (set.gender) counts.gender++;
            if (set.date_of_birth) counts.dob++;
          }
          if (r.blood && !s.blood && bloodField) {
            await trx
              .insertInto('custom_field_values')
              .values({
                institution_id: instId,
                field_id: String(bloodField),
                entity_ref: s.publicId,
                value_text: r.blood,
              })
              .execute();
            counts.blood++;
          }
          // The parents. The child's own parent of that relation (a re-run), or a brother's or
          // sister's, is this one, however the sheet spells the name; else the adult already on the
          // mobile with that name. A parent is never dropped: without a usable mobile of their own
          // (none given, or it belongs to another adult here — RingPe keeps one person per mobile)
          // they are added with the mobile left empty and listed, to be filled in the console.
          const family = students
            .filter(
              (x) =>
                x.id === s.id ||
                (!!s.accountId && x.accountId === s.accountId) ||
                (!!s.mobile && x.mobile === s.mobile),
            )
            .map((x) => x.id);
          for (const p of r.parents) {
            const note = (why: string) =>
              check.push([
                String(r.row),
                r.name,
                r.adm,
                `${r.klass} ${r.section}`,
                `${p.relation.toLowerCase()} ${p.name}: ${why}`,
              ]);
            const name = splitName(p.name);
            let guardianId: string | null = null;
            if (family.length) {
              const g = await trx
                .selectFrom('guardianships')
                .select('guardian_profile_id')
                .where('ward_profile_id', 'in', family)
                .where('relation', '=', p.relation)
                .executeTakeFirst();
              if (g) guardianId = String(g.guardian_profile_id);
            }
            let mobile: string | null = MOBILE.test(p.mobile) ? p.mobile : null;
            if (!guardianId && mobile) {
              const adults = await trx
                .selectFrom('member_profiles as a')
                .innerJoin('user_types as t', 't.id', 'a.user_type_id')
                .select(['a.id', 'a.first_name', 'a.last_name'])
                .where('a.institution_id', '=', instId)
                .where('a.contact_mobile', '=', mobile)
                .where('t.category', '!=', 'STUDENT')
                .execute();
              const same = adults.find((a) =>
                sameName(
                  { first: a.first_name, last: a.last_name },
                  { first: name.first, last: name.last },
                ),
              );
              if (same) {
                guardianId = String(same.id);
              } else if (adults.length) {
                const holder = [adults[0]!.first_name, adults[0]!.last_name]
                  .filter(Boolean)
                  .join(' ');
                note(`the mobile on the sheet is ${holder}'s here: added without a mobile`);
                mobile = null;
              }
            } else if (!guardianId) {
              note('no usable mobile on the sheet: added without one');
            }
            if (guardianId) {
              counts.parentsLinked++;
            } else {
              const account = mobile
                ? await trx
                    .selectFrom('platform_accounts as a')
                    .leftJoin('operator_accounts as o', 'o.account_id', 'a.id')
                    .select(['a.id', 'a.first_name', 'o.id as operator'])
                    .where('a.mobile', '=', mobile)
                    .executeTakeFirst()
                : undefined;
              const accountId = account && !account.operator ? String(account.id) : null;
              const pub = newPublicIdPair();
              const ins = await trx
                .insertInto('member_profiles')
                .values({
                  public_id: pub.bin,
                  institution_id: instId,
                  account_id: accountId,
                  user_type_id: parentType,
                  first_name: name.first,
                  last_name: name.last,
                  gender:
                    p.relation === 'FATHER' ? 'MALE' : p.relation === 'MOTHER' ? 'FEMALE' : null,
                  contact_mobile: mobile,
                  contact_email: p.email,
                  status: 'ACTIVE',
                  created_at: now,
                  updated_at: now,
                })
                .executeTakeFirstOrThrow();
              guardianId = String(ins.insertId);
              counts.parentsAdded++;
              if (!mobile) counts.parentsWithoutMobile++;
              await recordAudit(trx, {
                institutionId: instId,
                action: 'MEMBER_ONBOARDED',
                entityType: 'member',
                entityRef: pub.id,
                after: { userType: 'Parent', ward: binToUuid(s.publicId), via: 'student sheet' },
                actor: { type: 'system' },
              });
              // The family's sign-in carried a child's name until now: it takes the parent's. Only a
              // sign-in named after one of its students is renamed (never a staff member's).
              if (
                accountId &&
                account &&
                students.some(
                  (x) =>
                    x.accountId === accountId &&
                    x.first.toUpperCase() === account.first_name.toUpperCase(),
                )
              ) {
                await trx
                  .updateTable('platform_accounts')
                  .set({
                    first_name: name.first.toUpperCase(),
                    last_name: name.last?.toUpperCase() ?? null,
                  })
                  .where('id', '=', accountId)
                  .where('first_name', '=', account.first_name)
                  .execute();
                counts.signIns++;
              }
            }
            const primary = !(await trx
              .selectFrom('guardianships')
              .select('ward_profile_id')
              .where('ward_profile_id', '=', s.id)
              .where('is_primary_contact', '=', 1)
              .executeTakeFirst());
            await trx
              .insertInto('guardianships')
              .values({
                institution_id: instId,
                guardian_profile_id: guardianId,
                ward_profile_id: s.id,
                relation: p.relation,
                is_primary_contact: primary ? 1 : 0,
              })
              .onDuplicateKeyUpdate({ relation: p.relation })
              .execute();
          }
        });
      } catch (e) {
        check.push([
          String(r.row),
          r.name,
          r.adm,
          `${r.klass} ${r.section}`,
          `Not done: ${e instanceof Error ? e.message : String(e)}`,
        ]);
      }
    }
    if (counts.moved) {
      await recordAudit(db, {
        institutionId: instId,
        action: 'ENROLMENTS_CORRECTED',
        entityType: 'institution',
        entityRef: binToUuid(inst.public_id),
        after: { students: counts.moved, source: 'student sheet (unified admission upload)' },
        reason: REASON,
        actor: { type: 'system' },
      });
    }
  } finally {
    await db.destroy();
  }
  if (check.length && outDir) {
    const file = writeSignInSheet(
      outDir,
      `${short ?? 'SCHOOL'}-sheet-to-check.csv`,
      [
        'Sheet row',
        'Student on the sheet',
        'Admission no. on the sheet',
        'Class on the sheet',
        'What to check',
      ],
      check,
    );
    console.log(`import-cug-sheet: rows to check in ${file}`);
  }
  console.log(
    `import-cug-sheet: moved ${counts.moved} · gender ${counts.gender} · date of birth ${counts.dob} · blood group ${counts.blood}` +
      ` · parents added ${counts.parentsAdded}, linked to someone already here ${counts.parentsLinked}, without a mobile ${counts.parentsWithoutMobile}` +
      ` · family sign-ins now in a parent's name ${counts.signIns}`,
  );
}

main().catch((e: unknown) => {
  console.error(`import-cug-sheet: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
