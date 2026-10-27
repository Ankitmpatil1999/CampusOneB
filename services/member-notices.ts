/**
 * Telling members of what was done for them (client 2026-10-22: "any action taken needs to inform the
 * person concerned"): each member's own account and — for a student — every parent's, in the app,
 * with the phone alert and the e-mail as the school's notification settings choose for the notice's
 * event (comm-events.ts). One notice per account, whatever the number of members it is about.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { familyAccountsByStudent } from './fee-notices.service';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

/** Students named in a class teacher's notice before "and N more". */
const NAMED = 10;

export async function tellMembers(
  db: Db,
  n: {
    readonly institutionId: string;
    /** member_profiles row ids. */
    readonly profileRowIds: readonly string[];
    readonly titleKey: string;
    readonly params?: Readonly<Record<string, string | number>>;
    readonly body: string;
    readonly link?: string | null;
    readonly category?: 'ACCOUNT' | 'PAYMENT';
  },
  at: Date,
) {
  const ids = [...new Set(n.profileRowIds.map(String))];
  if (!ids.length) return;
  const families = await familyAccountsByStudent(db, ids);
  const accounts = [...new Set([...families.values()].flat())];
  if (!accounts.length) return;
  await notify(
    db,
    {
      institutionId: n.institutionId,
      accountIds: accounts,
      about: ids,
      surface: 'MEMBER',
      category: n.category ?? 'ACCOUNT',
      titleKey: n.titleKey as Parameters<typeof notify>[1]['titleKey'],
      params: n.params ?? {},
      body: n.body,
      link: n.link ?? null,
    },
    at,
  );
}

/**
 * Tells each section's class teacher of the students placed in it (client 2026-10-26): admitted,
 * enrolled, onboarded or uploaded, moved from another section, or rolled over into the new year. One
 * notice per section, whatever the number of students; a section without a class teacher that year
 * tells nobody. The caller passes only real placements — a student already in the section is no news.
 */
export async function tellClassTeachers(
  db: Db,
  n: {
    readonly institutionId: string;
    /** academic_years row id: the year the students are placed in. */
    readonly yearId: string;
    /** member_profiles and sections row ids. */
    readonly placements: readonly { readonly studentId: string; readonly sectionId: string }[];
  },
  at: Date,
) {
  const sectionIds = [...new Set(n.placements.map((x) => String(x.sectionId)))];
  if (!sectionIds.length) return;
  const teachers = await db
    .selectFrom('teacher_assignments')
    .select(['section_id', 'teacher_profile_id'])
    .where('institution_id', '=', n.institutionId)
    .where('year_id', '=', n.yearId)
    .where('kind', '=', 'CLASS_TEACHER')
    .where('ended_at', 'is', null)
    .where('section_id', 'in', sectionIds)
    .execute();
  if (!teachers.length) return;
  const studentIds = [...new Set(n.placements.map((x) => String(x.studentId)))];
  // One after another: this usually runs on the placing transaction's single connection.
  const sections = await db
    .selectFrom('sections as s')
    .innerJoin('classes as c', 'c.id', 's.class_id')
    .select(['s.id', 's.name', 'c.name as class_name'])
    .where('s.id', 'in', sectionIds)
    .execute();
  const students = await db
    .selectFrom('member_profiles')
    .select(['id', 'first_name', 'last_name'])
    .where('id', 'in', studentIds)
    .execute();
  const year = await db
    .selectFrom('academic_years')
    .select('label')
    .where('id', '=', n.yearId)
    .executeTakeFirst();
  const labelOf = new Map(sections.map((s) => [String(s.id), `${s.class_name} ${s.name}`]));
  const nameOf = new Map(
    students.map((s) => [String(s.id), [s.first_name, s.last_name].filter(Boolean).join(' ')]),
  );
  for (const t of teachers) {
    const section = labelOf.get(String(t.section_id));
    const placed = new Set(
      n.placements
        .filter((x) => String(x.sectionId) === String(t.section_id))
        .map((x) => String(x.studentId)),
    );
    const names = [...placed].map((id) => nameOf.get(id)).filter((x): x is string => !!x);
    if (!section || !names.length) continue;
    const more = names.length - NAMED;
    const listed = `${names.slice(0, NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    await tellMembers(
      db,
      {
        institutionId: n.institutionId,
        profileRowIds: [String(t.teacher_profile_id)],
        titleKey: 'NTF.CLASS_STUDENT_ADDED',
        params: { name: names.length === 1 ? names[0]! : `${names.length} students`, section },
        body:
          names.length === 1
            ? `${section}${year ? ` · ${year.label}` : ''}.`
            : `${listed}${year ? ` · ${year.label}` : ''}.`,
        link: '/teacher/timetable',
      },
      at,
    );
  }
}
