/**
 * Direct messages between members (SRS 23.9–23.11; COM-016…021; FR-COM-05; BR-71; RNG-COM-088…128;
 * OI-COM-24…33; prototype m.inbox, m.chat, m.newchat).
 *
 * - Who may message whom follows the role matrix (RNG-COM-092; the prototype's), kept as settings
 *   `com.dm.allow.<role>` — recipient groups as flags: students, parents, teachers, staff (crew
 *   included), the principal. It is checked on every message (RNG-COM-093).
 * - Starting a conversation also needs a relationship where children are involved: a teacher starts
 *   one only with a student of a section they teach or a class they coordinate (RNG-COM-108); a student
 *   (or the family holding the child's profile) only with the child's class teacher, subject teachers
 *   and coordinator among teachers (RNG-COM-125/126). The contacts list is built the same way.
 * - Parents chat only with their children's class teachers this year, both ways (client 2026-10-23):
 *   a parent starts, replies and sees contacts only for them; a class teacher reaches the parents of
 *   the class; nobody else — another teacher, staff, the principal — chats with a parent.
 * - Chat is not for students (client 2026-10-23): a student has no inbox, and nobody writes to one.
 * - One conversation per pair of members (RNG-COM-096), each participant archiving it for themselves;
 *   sending un-archives it for the sender (RNG-COM-103). Lists are newest first and paged (OI-COM-24/31).
 * - A message is 1 to 4,000 characters (setting), never edited; it is delivered in the app — a
 *   notification and a realtime event — and recorded in the communication log without its body
 *   (RC-24). Opening the conversation marks the other side's messages read (RNG-COM-102) and tells the
 *   sender (RNG-COM-101). Other channels are not offered (OI-COM-29: example, in the app only).
 * - At most 30 messages a minute per member (setting), counted from the stored messages under a lock on
 *   the sender, so every server shares it (OI-COM-27).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { Database, DirectMessageStatus, UserTypeCategory } from '../models/ringpe_models';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { emit, rooms } from '../utils/outbox';
import type { Principal } from '../utils/principal';
import { retryOnLock } from '../utils/retry';
import { logComm } from './comm-log.service';
import { memberOf, type Member } from './member-roles';
import { notify } from './notifications.service';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

export const DM_GROUPS = ['STUDENT', 'PARENT', 'TEACHER', 'STAFF', 'PRINCIPAL'] as const;
export type DmGroup = (typeof DM_GROUPS)[number];
const BIT: Record<DmGroup, number> = { STUDENT: 1, PARENT: 2, TEACHER: 4, STAFF: 8, PRINCIPAL: 16 };
const CATEGORIES: Record<DmGroup, readonly UserTypeCategory[]> = {
  STUDENT: ['STUDENT'],
  PARENT: ['PARENT'],
  TEACHER: ['TEACHER'],
  STAFF: ['STAFF', 'CREW'],
  PRINCIPAL: ['PRINCIPAL'],
};
const groupOf = (c: UserTypeCategory): DmGroup | null =>
  (DM_GROUPS as readonly string[]).includes(c) ? (c as DmGroup) : c === 'CREW' ? 'STAFF' : null;
/** The matrix row of each sender role; a role without a row may address nobody (RNG-COM-093). */
const ROW: Partial<Record<UserTypeCategory, LimitDefinition<number>>> = {
  STUDENT: LIMITS.directMessageAllowStudent,
  PARENT: LIMITS.directMessageAllowParent,
  TEACHER: LIMITS.directMessageAllowTeacher,
  PRINCIPAL: LIMITS.directMessageAllowPrincipal,
  STAFF: LIMITS.directMessageAllowStaff,
  CREW: LIMITS.directMessageAllowCrew,
};
const PAGE = { conversations: 30, messages: 50, contacts: 50 } as const;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');

/** Keyset cursor over (last message time, conversation id), newest first. */
const listCursor = {
  encode: (at: Date | string, id: string) =>
    Buffer.from(`c:${new Date(at).getTime()}:${id}`, 'utf8').toString('base64url'),
  decode(c: string | undefined) {
    if (!c) return undefined;
    const m = /^c:(\d{1,15}):(\d{1,20})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
    if (!m?.[1] || !m[2])
      throw new ValidationError([{ field: 'cursor', code: 'VALIDATION.FORMAT' }]);
    return { at: new Date(Number(m[1])), id: m[2] };
  },
};
const msgCursor = {
  encode: (id: string) => Buffer.from(`m:${id}`, 'utf8').toString('base64url'),
  decode(c: string | undefined) {
    if (!c) return undefined;
    const m = /^m:(\d{1,20})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
    if (!m?.[1]) throw new ValidationError([{ field: 'before', code: 'VALIDATION.FORMAT' }]);
    return m[1];
  },
};

interface Person {
  readonly rowId: string;
  readonly id: string;
  readonly accountId: string | null;
  readonly name: string;
  readonly category: UserTypeCategory;
  readonly roleLabel: string;
  readonly status: string;
}

export class MessagingService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  /** The recipient groups the member's role may address (BR-71). */
  private async allowed(me: Member): Promise<DmGroup[]> {
    const row = ROW[me.category];
    if (!row) return [];
    const bits = await this.limit(row);
    return DM_GROUPS.filter((g) => (bits & BIT[g]) !== 0);
  }

  private async currentYearId(db: Db, institutionId: string) {
    const y = await db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('is_current', '=', 1 as never)
      .executeTakeFirst();
    return y ? String(y.id) : null;
  }

  /** Students a teacher teaches this year: their sections and the classes they coordinate. */
  private taughtBy(db: Db, me: Member, yearId: string) {
    return db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .select('en.student_profile_id')
      .where('en.institution_id', '=', me.institutionId)
      .where('en.year_id', '=', yearId)
      .where((eb) =>
        eb.or([
          eb(
            'en.section_id',
            'in',
            eb
              .selectFrom('teacher_assignments')
              .select('section_id')
              .where('teacher_profile_id', '=', me.rowId)
              .where('year_id', '=', yearId)
              .where('ended_at', 'is', null)
              .where('kind', 'in', ['CLASS_TEACHER', 'SUBJECT_TEACHER'])
              .where('section_id', 'is not', null) as never,
          ),
          eb(
            's.class_id',
            'in',
            eb
              .selectFrom('teacher_assignments')
              .select('class_id')
              .where('teacher_profile_id', '=', me.rowId)
              .where('year_id', '=', yearId)
              .where('ended_at', 'is', null)
              .where('kind', '=', 'COORDINATOR'),
          ),
        ]),
      );
  }

  /** A student's teachers this year with what they teach the student (RNG-COM-125). */
  private async teachersOf(db: Db, student: Member, yearId: string) {
    const en = await db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .select(['en.section_id', 's.class_id'])
      .where('en.institution_id', '=', student.institutionId)
      .where('en.student_profile_id', '=', student.rowId)
      .where('en.year_id', '=', yearId)
      .executeTakeFirst();
    const out = new Map<string, string[]>();
    if (!en) return out;
    const rows = await db
      .selectFrom('teacher_assignments as ta')
      .leftJoin('subjects as sub', 'sub.id', 'ta.subject_id')
      .select(['ta.teacher_profile_id', 'ta.kind', 'sub.name as subject'])
      .where('ta.institution_id', '=', student.institutionId)
      .where('ta.year_id', '=', yearId)
      .where('ta.ended_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('ta.kind', 'in', ['CLASS_TEACHER', 'SUBJECT_TEACHER']),
            eb('ta.section_id', '=', String(en.section_id)),
          ]),
          eb.and([eb('ta.kind', '=', 'COORDINATOR'), eb('ta.class_id', '=', String(en.class_id))]),
        ]),
      )
      .orderBy('ta.kind')
      .execute();
    for (const r of rows) {
      const k = String(r.teacher_profile_id);
      const label =
        r.kind === 'CLASS_TEACHER'
          ? 'Class teacher'
          : r.kind === 'COORDINATOR'
            ? 'Coordinator'
            : (r.subject ?? 'Subject teacher');
      out.set(k, [...(out.get(k) ?? []), label]);
    }
    return out;
  }

  /** The class teachers this year of the sections a parent's children are in. */
  private classTeachersOfWards(db: Db, institutionId: string, parentRowId: string, yearId: string) {
    return db
      .selectFrom('teacher_assignments as ta')
      .innerJoin('enrolments as en', (j) =>
        j.onRef('en.section_id', '=', 'ta.section_id').onRef('en.year_id', '=', 'ta.year_id'),
      )
      .innerJoin('guardianships as g', 'g.ward_profile_id', 'en.student_profile_id')
      .select('ta.teacher_profile_id')
      .where('ta.institution_id', '=', institutionId)
      .where('ta.year_id', '=', yearId)
      .where('ta.kind', '=', 'CLASS_TEACHER')
      .where('ta.ended_at', 'is', null)
      .where('g.guardian_profile_id', '=', parentRowId);
  }

  /** The parents of the students in the sections a teacher is class teacher of this year. */
  private parentsOfClass(db: Db, institutionId: string, teacherRowId: string, yearId: string) {
    return db
      .selectFrom('guardianships as g')
      .innerJoin('enrolments as en', 'en.student_profile_id', 'g.ward_profile_id')
      .innerJoin('teacher_assignments as ta', (j) =>
        j.onRef('ta.section_id', '=', 'en.section_id').onRef('ta.year_id', '=', 'en.year_id'),
      )
      .select('g.guardian_profile_id')
      .where('g.institution_id', '=', institutionId)
      .where('en.year_id', '=', yearId)
      .where('ta.teacher_profile_id', '=', teacherRowId)
      .where('ta.kind', '=', 'CLASS_TEACHER')
      .where('ta.ended_at', 'is', null);
  }

  /**
   * The groups a member may address, with parents' conversations kept to class teachers (client
   * 2026-10-23): a parent addresses teachers only; of the others, only a teacher addresses parents.
   */
  private async groupsFor(me: Member): Promise<DmGroup[]> {
    // Nobody chats with students (client 2026-10-23).
    const allowed = (await this.allowed(me)).filter((g) => g !== 'STUDENT');
    if (me.category === 'PARENT') return allowed.filter((g) => g === 'TEACHER');
    if (me.category !== 'TEACHER') return allowed.filter((g) => g !== 'PARENT');
    return allowed;
  }

  /**
   * The member chatting: never a student — chat is not for students (client 2026-10-23), nor for
   * the family on a child's profile.
   */
  private async chatMember(db: Db, p: Principal, forProfile?: string) {
    const me = await memberOf(db, p, forProfile);
    if (me.category === 'STUDENT') throw new CustomAPIError(403, 'COM.DM_STUDENTS');
    return me;
  }

  /**
   * For a list: whether a conversation partner is one the member may still write to as far as
   * parents go (client 2026-10-23) — one query for the whole list.
   */
  private async parentPartners(db: Db, me: Member) {
    const yearId = await this.currentYearId(db, me.institutionId);
    if (me.category === 'PARENT') {
      const teachers = yearId
        ? await this.classTeachersOfWards(db, me.institutionId, me.rowId, yearId).execute()
        : [];
      const ids = new Set(teachers.map((t) => String(t.teacher_profile_id)));
      return (otherRowId: string, category: UserTypeCategory) =>
        category !== 'STUDENT' && ids.has(otherRowId);
    }
    if (me.category === 'TEACHER') {
      const parents = yearId
        ? await this.parentsOfClass(db, me.institutionId, me.rowId, yearId).execute()
        : [];
      const ids = new Set(parents.map((g) => String(g.guardian_profile_id)));
      return (otherRowId: string, category: UserTypeCategory) =>
        category !== 'STUDENT' && (category !== 'PARENT' || ids.has(otherRowId));
    }
    return (_otherRowId: string, category: UserTypeCategory) =>
      category !== 'PARENT' && category !== 'STUDENT';
  }

  /**
   * Whether a parent is in the conversation, and the other side is not one of the parent's
   * children's class teachers this year (client 2026-10-23).
   */
  private async parentRefusal(db: Db, me: Member, other: Person) {
    // Nobody chats with students (client 2026-10-23).
    if (other.category === 'STUDENT') return 'COM.DM_STUDENTS' as const;
    const parent =
      me.category === 'PARENT' ? me.rowId : other.category === 'PARENT' ? other.rowId : null;
    if (!parent) return null;
    const teacher = parent === me.rowId ? other : { rowId: me.rowId, category: me.category };
    if (teacher.category !== 'TEACHER') return 'COM.DM_PARENT_CLASS_TEACHER' as const;
    const yearId = await this.currentYearId(db, me.institutionId);
    const hit =
      yearId &&
      (await this.classTeachersOfWards(db, me.institutionId, parent, yearId)
        .where('ta.teacher_profile_id', '=', teacher.rowId)
        .executeTakeFirst());
    return hit ? null : ('COM.DM_PARENT_CLASS_TEACHER' as const);
  }

  /** Whether `me` may start a conversation with `other` (matrix and relationship). */
  private async mayStart(db: Db, me: Member, other: Person) {
    const g = groupOf(other.category);
    if (!g || !(await this.allowed(me)).includes(g)) return 'COM.DM_NOT_PERMITTED' as const;
    const parents = await this.parentRefusal(db, me, other);
    if (parents) return parents;
    const yearId = await this.currentYearId(db, me.institutionId);
    if (me.category === 'TEACHER' && g === 'STUDENT') {
      const hit =
        yearId &&
        (await this.taughtBy(db, me, yearId)
          .where('en.student_profile_id', '=', other.rowId)
          .executeTakeFirst());
      if (!hit) return 'COM.DM_NOT_A_CONTACT' as const;
    }
    if (me.category === 'STUDENT' && g === 'TEACHER') {
      const mine = yearId ? await this.teachersOf(db, me, yearId) : new Map();
      if (!mine.has(other.rowId)) return 'COM.DM_NOT_A_CONTACT' as const;
    }
    return null;
  }

  private async person(db: Db, institutionId: string, by: { rowId?: string; id?: string }) {
    let q = db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select([
        'm.id',
        'm.public_id',
        'm.account_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'ut.category',
        'ut.name as type_name',
      ])
      .where('m.institution_id', '=', institutionId);
    if (by.rowId) q = q.where('m.id', '=', by.rowId);
    else if (by.id && isUuid(by.id)) q = q.where('m.public_id', '=', uuidToBin(by.id));
    else return null;
    const r = await q.executeTakeFirst();
    return r
      ? ({
          rowId: String(r.id),
          id: binToUuid(r.public_id),
          accountId: r.account_id === null ? null : String(r.account_id),
          name: nameOf(r.first_name, r.last_name),
          category: r.category,
          roleLabel: r.type_name,
          status: r.status,
        } satisfies Person)
      : null;
  }

  /** "Grade 6 A" for students this year, by profile row id. */
  private async classesOf(db: Db, institutionId: string, profileIds: readonly string[]) {
    const out = new Map<string, string>();
    const yearId = profileIds.length ? await this.currentYearId(db, institutionId) : null;
    if (!yearId) return out;
    const rows = await db
      .selectFrom('enrolments as en')
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select(['en.student_profile_id', 'c.name as class_name', 's.name as section_name'])
      .where('en.institution_id', '=', institutionId)
      .where('en.year_id', '=', yearId)
      .where('en.student_profile_id', 'in', profileIds as string[])
      .execute();
    for (const r of rows) {
      out.set(String(r.student_profile_id), `${r.class_name} ${r.section_name}`);
    }
    return out;
  }

  /** COM-016: the people the member may start a conversation with, by group (BR-71). */
  async contacts(p: Principal, q: { q?: string; group?: DmGroup; for?: string }) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, q.for);
    const allowed = await this.groupsFor(me);
    const yearId = await this.currentYearId(db, me.institutionId);
    const teachersOfMe =
      me.category === 'STUDENT' && yearId ? await this.teachersOf(db, me, yearId) : null;
    const text = q.q?.trim().slice(0, 60);
    const groups = [];
    for (const g of allowed) {
      if (q.group && q.group !== g) continue;
      let base = db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .leftJoin('departments as d', 'd.id', 'm.department_id')
        .where('m.institution_id', '=', me.institutionId)
        .where('m.status', '=', 'ACTIVE')
        .where('m.id', '!=', me.rowId)
        .where('ut.category', 'in', CATEGORIES[g] as UserTypeCategory[]);
      if (text) {
        const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        base = base.where((eb) =>
          eb.or([
            eb(sql<string>`CONCAT_WS(' ', m.first_name, m.last_name)`, 'like', like),
            eb('m.admission_no', 'like', like),
            eb('m.employee_no', 'like', like),
          ]),
        );
      }
      if (me.category === 'TEACHER' && g === 'STUDENT') {
        base = yearId
          ? base.where('m.id', 'in', this.taughtBy(db, me, yearId))
          : base.where(sql<boolean>`FALSE`);
      }
      // Parents and class teachers, each to the other only (client 2026-10-23).
      if (me.category === 'PARENT' && g === 'TEACHER') {
        base = yearId
          ? base.where(
              'm.id',
              'in',
              this.classTeachersOfWards(db, me.institutionId, me.rowId, yearId),
            )
          : base.where(sql<boolean>`FALSE`);
      }
      if (me.category === 'TEACHER' && g === 'PARENT') {
        base = yearId
          ? base.where('m.id', 'in', this.parentsOfClass(db, me.institutionId, me.rowId, yearId))
          : base.where(sql<boolean>`FALSE`);
      }
      if (teachersOfMe && g === 'TEACHER') {
        const ids = [...teachersOfMe.keys()];
        base = ids.length ? base.where('m.id', 'in', ids) : base.where(sql<boolean>`FALSE`);
      }
      const total = await base.select(sql<number>`COUNT(*)`.as('n')).executeTakeFirst();
      const rows = await base
        .select([
          'm.id',
          'm.public_id',
          'm.first_name',
          'm.last_name',
          'm.admission_no',
          'ut.name as type_name',
          'd.name as department',
        ])
        .orderBy('m.first_name')
        .orderBy('m.last_name')
        .orderBy('m.id')
        .limit(PAGE.contacts)
        .execute();
      const ids = rows.map((r) => String(r.id));
      const classes = g === 'STUDENT' ? await this.classesOf(db, me.institutionId, ids) : null;
      const existing = ids.length
        ? await db
            .selectFrom('conversation_participants as cp')
            .innerJoin('conversations as c', 'c.id', 'cp.conversation_id')
            .select(['cp.other_profile_id', 'c.public_id'])
            .where('cp.institution_id', '=', me.institutionId)
            .where('cp.profile_id', '=', me.rowId)
            .where('cp.other_profile_id', 'in', ids)
            .execute()
        : [];
      const conv = new Map(
        existing.map((e) => [String(e.other_profile_id), binToUuid(e.public_id)]),
      );
      groups.push({
        group: g,
        total: Number(total?.n ?? 0),
        items: rows.map((r) => {
          const id = String(r.id);
          const cls = classes?.get(id) ?? null;
          return {
            profileId: binToUuid(r.public_id),
            name: nameOf(r.first_name, r.last_name),
            roleLabel: r.type_name,
            relation:
              teachersOfMe?.get(id) ??
              (me.category === 'PARENT' && g === 'TEACHER' ? ['Class teacher'] : []),
            sub:
              g === 'STUDENT'
                ? [cls, r.admission_no].filter(Boolean).join(' · ') || null
                : (r.department ?? null),
            conversationId: conv.get(id) ?? null,
          };
        }),
      });
    }
    return {
      role: groupOf(me.category),
      allowed,
      notAllowed: DM_GROUPS.filter((g) => !allowed.includes(g)),
      perMinute: await this.limit(LIMITS.directMessagesPerMinute),
      maxChars: await this.limit(LIMITS.directMessageMaxChars),
      groups,
    };
  }

  /** COM-017: the member's conversations, newest message first, active or archived. */
  async conversations(
    p: Principal,
    q: { archived?: boolean; cursor?: string; for?: string; limit?: number },
  ) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, q.for);
    const allowed = await this.allowed(me);
    const partner = await this.parentPartners(db, me);
    const after = listCursor.decode(q.cursor);
    const limit = Math.min(Math.max(q.limit ?? PAGE.conversations, 1), 100);
    let rows = db
      .selectFrom('conversation_participants as cp')
      .innerJoin('conversations as c', 'c.id', 'cp.conversation_id')
      .innerJoin('member_profiles as o', 'o.id', 'cp.other_profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'o.user_type_id')
      .leftJoin('direct_messages as lm', 'lm.id', 'c.last_message_id')
      .select([
        'cp.conversation_id',
        'cp.last_message_at',
        'cp.archived_at',
        'c.public_id',
        'o.id as other_id',
        'o.public_id as other_public_id',
        'o.first_name',
        'o.last_name',
        'o.status as other_status',
        'ut.category',
        'ut.name as type_name',
        'lm.body as last_body',
        'lm.sender_profile_id as last_sender',
        'lm.status as last_status',
        (eb) =>
          eb
            .selectFrom('direct_messages as u')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('u.conversation_id', '=', 'cp.conversation_id')
            .where('u.status', 'in', ['SENT', 'DELIVERED'])
            .where('u.sender_profile_id', '!=', me.rowId)
            .as('unread'),
      ])
      .where('cp.institution_id', '=', me.institutionId)
      .where('cp.profile_id', '=', me.rowId)
      .where('cp.archived_at', q.archived ? 'is not' : 'is', null);
    if (after) {
      rows = rows.where((eb) =>
        eb.or([
          eb('cp.last_message_at', '<', after.at),
          eb.and([
            eb('cp.last_message_at', '=', after.at),
            eb('cp.conversation_id', '<', after.id),
          ]),
        ]),
      );
    }
    const page = await rows
      .orderBy('cp.last_message_at', 'desc')
      .orderBy('cp.conversation_id', 'desc')
      .limit(limit + 1)
      .execute();
    const shown = page.slice(0, limit);
    const classes = await this.classesOf(
      db,
      me.institutionId,
      shown.filter((r) => r.category === 'STUDENT').map((r) => String(r.other_id)),
    );
    const counts = await db
      .selectFrom('conversation_participants as cp')
      .select([
        sql<number>`SUM(cp.archived_at IS NULL)`.as('active'),
        sql<number>`SUM(cp.archived_at IS NOT NULL)`.as('archived'),
        sql<number>`SUM(cp.archived_at IS NULL AND EXISTS (SELECT 1 FROM direct_messages u WHERE u.conversation_id = cp.conversation_id AND u.status IN ('SENT','DELIVERED') AND u.sender_profile_id <> ${me.rowId}))`.as(
          'unread',
        ),
      ])
      .where('cp.institution_id', '=', me.institutionId)
      .where('cp.profile_id', '=', me.rowId)
      .executeTakeFirst();
    const last = shown.at(-1);
    return {
      counts: {
        active: Number(counts?.active ?? 0),
        archived: Number(counts?.archived ?? 0),
        unreadConversations: Number(counts?.unread ?? 0),
      },
      items: shown.map((r) => {
        const g = groupOf(r.category);
        return {
          conversationId: binToUuid(r.public_id),
          with: {
            profileId: binToUuid(r.other_public_id),
            name: nameOf(r.first_name, r.last_name),
            roleLabel: r.type_name,
            group: g,
            classSection: classes.get(String(r.other_id)) ?? null,
          },
          lastMessage: r.last_body
            ? {
                text: r.last_body.slice(0, 200),
                mine: String(r.last_sender) === me.rowId,
                status: r.last_status as DirectMessageStatus,
                at: iso(r.last_message_at),
              }
            : null,
          unread: Number(r.unread ?? 0),
          archived: r.archived_at !== null,
          canSend:
            r.other_status === 'ACTIVE' &&
            g !== null &&
            allowed.includes(g) &&
            partner(String(r.other_id), r.category),
        };
      }),
      nextCursor:
        page.length > limit && last
          ? listCursor.encode(last.last_message_at, String(last.conversation_id))
          : null,
    };
  }

  /** The member's side of a conversation, or 404 (RNG-COM-105). */
  private async participation(db: Db, me: Member, conversationId: string) {
    if (!isUuid(conversationId)) throw new CustomAPIError(404, 'COM.CONVERSATION_NOT_FOUND');
    const r = await db
      .selectFrom('conversations as c')
      .innerJoin('conversation_participants as cp', (j) =>
        j.onRef('cp.conversation_id', '=', 'c.id').on('cp.profile_id', '=', me.rowId),
      )
      .select(['c.id', 'c.public_id', 'cp.other_profile_id', 'cp.archived_at'])
      .where('c.public_id', '=', uuidToBin(conversationId))
      .where('c.institution_id', '=', me.institutionId)
      .executeTakeFirst();
    if (!r) throw new CustomAPIError(404, 'COM.CONVERSATION_NOT_FOUND');
    return {
      rowId: String(r.id),
      id: binToUuid(r.public_id),
      otherRowId: String(r.other_profile_id),
      archived: r.archived_at !== null,
    };
  }

  /** Route guard: another member's or school's conversation answers 404 before the body is read. */
  async lookup(p: Principal, conversationId: string, forProfile?: string) {
    const me = await this.chatMember(this.deps.db, p, forProfile);
    await this.participation(this.deps.db, me, conversationId);
  }

  /** COM-018: start (or continue) the conversation with a member (BR-71). */
  async start(p: Principal, b: { recipientProfileId: string; text: string; for?: string }) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, b.for);
    const other = await this.person(db, me.institutionId, { id: b.recipientProfileId });
    if (other?.rowId === me.rowId) throw new CustomAPIError(422, 'COM.DM_SELF');
    if (!other || other.status !== 'ACTIVE') throw new CustomAPIError(404, 'COM.DM_RECIPIENT');
    const [low, high] = [me.rowId, other.rowId].sort((a, b2) => Number(a) - Number(b2));
    const existing = await db
      .selectFrom('conversations')
      .select('id')
      .where('institution_id', '=', me.institutionId)
      .where('profile_low', '=', low!)
      .where('profile_high', '=', high!)
      .executeTakeFirst();
    const refusal = existing
      ? (await this.allowed(me)).includes(groupOf(other.category) as DmGroup)
        ? await this.parentRefusal(db, me, other)
        : ('COM.DM_NOT_PERMITTED' as const)
      : await this.mayStart(db, me, other);
    if (refusal) throw new CustomAPIError(403, refusal);
    return this.post(me, other, b.text, uuidToBin(p.subject));
  }

  /** COM-020: a message in an existing conversation. */
  async send(p: Principal, conversationId: string, b: { text: string; for?: string }) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, b.for);
    const c = await this.participation(db, me, conversationId);
    const other = await this.person(db, me.institutionId, { rowId: c.otherRowId });
    if (!other || other.status !== 'ACTIVE') throw new CustomAPIError(404, 'COM.DM_RECIPIENT');
    const g = groupOf(other.category);
    if (!g || !(await this.allowed(me)).includes(g)) {
      throw new CustomAPIError(403, 'COM.DM_NOT_PERMITTED');
    }
    const parents = await this.parentRefusal(db, me, other);
    if (parents) throw new CustomAPIError(403, parents);
    return this.post(me, other, b.text, uuidToBin(p.subject));
  }

  /** Stores, delivers in the app and logs one message (23.9.4). */
  private async post(me: Member, other: Person, raw: string, raiser: Buffer) {
    const text = raw.trim();
    const max = await this.limit(LIMITS.directMessageMaxChars);
    if (!text || [...text].length > max) {
      throw new CustomAPIError(422, 'COM.DM_BODY', { params: { max } });
    }
    const perMinute = await this.limit(LIMITS.directMessagesPerMinute);
    const [low, high] = [me.rowId, other.rowId].sort((a, b) => Number(a) - Number(b)) as [
      string,
      string,
    ];
    const out = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const at = this.now();
        // The sender's lock serialises their sends, so the count below holds (OI-COM-27).
        await trx
          .selectFrom('member_profiles')
          .select('id')
          .where('id', '=', me.rowId)
          .forUpdate()
          .executeTakeFirst();
        const recent = await trx
          .selectFrom('direct_messages')
          .select(sql<number>`COUNT(*)`.as('n'))
          .where('institution_id', '=', me.institutionId)
          .where('sender_profile_id', '=', me.rowId)
          .where('created_at', '>', new Date(at.getTime() - 60_000))
          .executeTakeFirst();
        if (Number(recent?.n ?? 0) >= perMinute) {
          throw new CustomAPIError(429, 'COM.DM_RATE_LIMITED', {
            headers: { 'Retry-After': '60' },
          });
        }
        await trx
          .insertInto('conversations')
          .ignore()
          .values({
            public_id: newPublicIdPair().bin,
            institution_id: me.institutionId,
            profile_low: low,
            profile_high: high,
            started_by: me.rowId,
            created_at: at,
          })
          .execute();
        const conv = await trx
          .selectFrom('conversations')
          .select(['id', 'public_id'])
          .where('institution_id', '=', me.institutionId)
          .where('profile_low', '=', low)
          .where('profile_high', '=', high)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const convId = String(conv.id);
        await trx
          .insertInto('conversation_participants')
          .ignore()
          .values([
            {
              conversation_id: convId,
              profile_id: me.rowId,
              institution_id: me.institutionId,
              other_profile_id: other.rowId,
              last_message_at: at,
            },
            {
              conversation_id: convId,
              profile_id: other.rowId,
              institution_id: me.institutionId,
              other_profile_id: me.rowId,
              last_message_at: at,
            },
          ])
          .execute();
        const publicId = newPublicIdPair().bin;
        const ins = await trx
          .insertInto('direct_messages')
          .values({
            public_id: publicId,
            institution_id: me.institutionId,
            conversation_id: convId,
            sender_profile_id: me.rowId,
            body: text,
            status: 'SENT',
            created_at: at,
          })
          .executeTakeFirstOrThrow();
        const messageId = String(ins.insertId);
        await trx
          .updateTable('conversations')
          .set({ last_message_id: messageId, last_message_at: at })
          .where('id', '=', convId)
          .execute();
        await trx
          .updateTable('conversation_participants')
          .set({ last_message_at: at })
          .where('conversation_id', '=', convId)
          .execute();
        await trx
          .updateTable('conversation_participants')
          .set({ archived_at: null })
          .where('conversation_id', '=', convId)
          .where('profile_id', '=', me.rowId)
          .execute();
        const conversationId = binToUuid(conv.public_id);
        let status: DirectMessageStatus = 'SENT';
        if (other.accountId) {
          await notify(
            trx,
            {
              institutionId: me.institutionId,
              accountIds: [other.accountId],
              surface: 'MEMBER',
              category: 'MESSAGE',
              titleKey: 'NTF.DIRECT_MESSAGE',
              params: { name: me.name },
              body: text.slice(0, 140),
              link: `/messages/${conversationId}`,
              log: false,
            },
            at,
          );
          await trx
            .updateTable('direct_messages')
            .set({ status: 'DELIVERED', delivered_at: at })
            .where('id', '=', messageId)
            .where('status', '=', 'SENT')
            .execute();
          status = 'DELIVERED';
        }
        await logComm(
          trx,
          [
            {
              institutionId: me.institutionId,
              kind: 'DIRECT_MESSAGE',
              channel: 'IN_APP',
              recipientProfileId: other.rowId,
              recipientAccountId: other.accountId,
              raiser,
              ...(other.accountId
                ? { recipient: 'In-app', outcome: 'SUCCESS' as const }
                : { outcome: 'SKIPPED' as const, reason: 'No account' }),
              refType: 'conversation',
              refId: conversationId,
            },
          ],
          at,
        );
        const to = [other.accountId, me.accountId]
          .filter((x): x is string => x !== null)
          .map((a) => rooms.account(a, 'member'));
        await emit(trx, {
          institutionId: me.institutionId,
          type: 'message.created',
          rooms: to,
          data: { conversationId },
        });
        return {
          conversationId,
          message: {
            id: binToUuid(publicId),
            mine: true,
            text,
            status,
            at: iso(at),
            deliveredAt: status === 'DELIVERED' ? iso(at) : null,
            readAt: null,
          },
        };
      }),
    );
    return out;
  }

  /**
   * COM-019: the conversation's messages, oldest first within a page of the newest (`before` pages
   * back). Opening it (no `before`) marks the other side's messages read and tells them (RNG-COM-102).
   */
  async messages(
    p: Principal,
    conversationId: string,
    q: { before?: string; limit?: number; for?: string },
  ) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, q.for);
    const c = await this.participation(db, me, conversationId);
    const other = await this.person(db, me.institutionId, { rowId: c.otherRowId });
    if (!other) throw new NotFoundError();
    const before = msgCursor.decode(q.before);
    const limit = Math.min(Math.max(q.limit ?? PAGE.messages, 1), 100);
    if (!before) {
      const at = this.now();
      await db.transaction().execute(async (trx) => {
        const read = await trx
          .updateTable('direct_messages')
          .set({ status: 'READ', read_at: at })
          .where('conversation_id', '=', c.rowId)
          .where('sender_profile_id', '=', c.otherRowId)
          .where('status', 'in', ['SENT', 'DELIVERED'])
          .executeTakeFirst();
        if (Number(read.numUpdatedRows) > 0 && other.accountId) {
          await emit(trx, {
            institutionId: me.institutionId,
            type: 'message.read',
            rooms: [rooms.account(other.accountId, 'member')],
            data: { conversationId: c.id },
          });
        }
      });
    }
    let rows = db
      .selectFrom('direct_messages')
      .select([
        'id',
        'public_id',
        'sender_profile_id',
        'body',
        'status',
        'created_at',
        'delivered_at',
        'read_at',
      ])
      .where('conversation_id', '=', c.rowId);
    if (before) rows = rows.where('id', '<', before);
    const page = await rows
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const shown = page.slice(0, limit);
    const oldest = shown.at(-1);
    const allowed = await this.allowed(me);
    const partner = await this.parentPartners(db, me);
    const g = groupOf(other.category);
    const classes =
      other.category === 'STUDENT'
        ? await this.classesOf(db, me.institutionId, [other.rowId])
        : new Map<string, string>();
    return {
      conversation: {
        id: c.id,
        with: {
          profileId: other.id,
          name: other.name,
          roleLabel: other.roleLabel,
          group: g,
          classSection: classes.get(other.rowId) ?? null,
        },
        archived: c.archived,
        canSend:
          other.status === 'ACTIVE' &&
          g !== null &&
          allowed.includes(g) &&
          partner(other.rowId, other.category),
      },
      items: shown.reverse().map((m) => ({
        id: binToUuid(m.public_id),
        mine: String(m.sender_profile_id) === me.rowId,
        text: m.body,
        status: m.status,
        at: iso(m.created_at),
        deliveredAt: iso(m.delivered_at),
        readAt: iso(m.read_at),
      })),
      olderCursor: page.length > limit && oldest ? msgCursor.encode(String(oldest.id)) : null,
    };
  }

  /** COM-021: archive or restore the conversation for the member only (RNG-COM-103/104). */
  async archive(p: Principal, conversationId: string, b: { archived: boolean; for?: string }) {
    const db = this.deps.db;
    const me = await this.chatMember(db, p, b.for);
    const c = await this.participation(db, me, conversationId);
    await db
      .updateTable('conversation_participants')
      .set({ archived_at: b.archived ? this.now() : null })
      .where('conversation_id', '=', c.rowId)
      .where('profile_id', '=', me.rowId)
      .execute();
  }
}
