/**
 * Announcements (SRS 23.2–23.6; COM-001…006, COM-011…013, COM-022…024; FR-COM-01…04; BR-70; CR-16;
 * RC-24; OI-COM-02…17; prototype c.announcements, m.announcements, m.ann, m.t.announce, m.pr.announce).
 *
 * - An announcement has a category, an explicit high-importance flag (OI-COM-03), several target
 *   groups — everyone, students, parents, teachers, staff — narrowed to classes, sections or user types
 *   (OI-COM-04), and the channels chosen from those the platform and the institution have on (BR-70,
 *   OI-COM-09). It is sent at once or at a chosen time; until then it can be edited, afterwards only
 *   withdrawn (OI-COM-08).
 * - Dispatch (27.2 QUEUED → PROCESSING → COMPLETED / FAILED) resolves the recipients once and keeps
 *   them (OI-COM-10), sends one message per account and channel, and logs every attempt with its
 *   outcome — never the body (CR-16). It runs right after the request and, as a safety net, in the job
 *   `announcement-dispatch`.
 * - A member sees only announcements sent to them (OI-COM-13) and acknowledges for themselves
 *   (OI-COM-11/12). Authors see who has and hasn't acknowledged and can remind the rest.
 * - The principal announces like the console; a class teacher announces to a class they teach — its
 *   students and their families, in the app (OI-COM-15…17).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { eventSwitches } from './comm-events.service';
import { LIMITS, type LimitDefinition } from '../config/registers';
import type { MessageSender } from '../integrations/sms.provider';
import type { AnnouncementSource, CommChannel, Database } from '../models/ringpe_models';
import type { JobContext } from '../schedulers';
import { CustomAPIError, PreconditionFailedError, ValidationError } from '../utils/CustomAPIError';
import { istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { institutionOf } from './academic-year';
import { recordAudit } from './audit.service';
import { logComm, maskEmail, maskMobile, type CommLogRow } from './comm-log.service';
import { memberOf, teacherOf } from './member-roles';
import { notify } from './notifications.service';
import type { SettingsService } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

export const TARGET_GROUPS = ['ALL', 'STUDENTS', 'PARENTS', 'TEACHERS', 'STAFF'] as const;
export type TargetGroup = (typeof TARGET_GROUPS)[number];
export interface Targets {
  readonly groups: readonly TargetGroup[];
  readonly classIds?: readonly string[] | undefined;
  readonly sectionIds?: readonly string[] | undefined;
  readonly userTypeIds?: readonly string[] | undefined;
}
export interface AnnouncementInput {
  readonly title: string;
  readonly text: string;
  readonly category: string;
  readonly important?: boolean | undefined;
  readonly ackRequired?: boolean | undefined;
  readonly targets: Targets;
  readonly channels: readonly CommChannel[];
  readonly sendAt?: string | null | undefined;
  readonly attachmentFileId?: string | null | undefined;
}

const CHANNEL_ORDER: readonly CommChannel[] = ['IN_APP', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH'];
/** A dispatch left sending this long (a stopped worker) is claimed again; each chunk refreshes it. */
const STALE_MS = 10 * 60_000;
const nameOf = (first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter(Boolean).join(' ');
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const parseTargets = (v: unknown): Targets => {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Targets;
  return {
    groups: o?.groups ?? [],
    classIds: o?.classIds ?? [],
    sectionIds: o?.sectionIds ?? [],
    userTypeIds: o?.userTypeIds ?? [],
  };
};

export class AnnouncementsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly sms?: MessageSender;
      readonly email?: MessageSender;
      readonly onError?: (e: unknown) => void;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private async limit(l: LimitDefinition<number>) {
    return this.deps.settings ? this.deps.settings.get(l) : l.value;
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  // --- channels (BR-70) -------------------------------------------------------------------------------------
  /** The channels this institution can use now: on for the platform, on for the school, integrated. */
  async allowedChannels(db: Db, institutionId: string): Promise<CommChannel[]> {
    const [platform, school] = await Promise.all([
      db.selectFrom('messaging_channels').select(['channel', 'enabled']).execute(),
      db
        .selectFrom('notification_channel_settings')
        .select(['channel', 'enabled'])
        .where('institution_id', '=', institutionId)
        .execute(),
    ]);
    const integrated = new Set<CommChannel>([
      'IN_APP',
      ...(this.deps.sms ? (['SMS'] as const) : []),
      ...(this.deps.email ? (['EMAIL'] as const) : []),
    ]);
    return CHANNEL_ORDER.filter(
      (c) =>
        integrated.has(c) &&
        !!Number(platform.find((x) => x.channel === c)?.enabled ?? 0) &&
        (c === 'IN_APP' || !!Number(school.find((x) => x.channel === c)?.enabled ?? 0)),
    );
  }

  async categories() {
    const rows = await this.deps.db
      .selectFrom('announcement_categories')
      .selectAll()
      .orderBy('sort_order')
      .execute();
    return rows.map((c) => ({ code: c.code, label: c.label, colour: c.colour }));
  }

  // --- recipients (OI-COM-10, OI-COM-13) --------------------------------------------------------------------
  /** The member profiles the targets reach, resolved now (active members of the institution). */
  async resolve(db: Db, institutionId: string, targets: Targets): Promise<string[]> {
    const groups = new Set(targets.groups);
    const year = await db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    const classIds = (targets.classIds ?? []).filter(isUuid);
    const sectionIds = (targets.sectionIds ?? []).filter(isUuid);
    const scoped = classIds.length > 0 || sectionIds.length > 0;
    let sections: string[] = [];
    if (scoped) {
      sections = (
        await db
          .selectFrom('sections as s')
          .innerJoin('classes as c', 'c.id', 's.class_id')
          .select('s.id')
          .where('s.institution_id', '=', institutionId)
          .where((eb) =>
            eb.or([
              ...(classIds.length
                ? [
                    eb(
                      'c.public_id',
                      'in',
                      classIds.map((x) => uuidToBin(x)),
                    ),
                  ]
                : []),
              ...(sectionIds.length
                ? [
                    eb(
                      's.public_id',
                      'in',
                      sectionIds.map((x) => uuidToBin(x)),
                    ),
                  ]
                : []),
            ]),
          )
          .execute()
      ).map((s) => String(s.id));
      if (!sections.length) return [];
    }
    const out = new Set<string>();
    const active = () =>
      db
        .selectFrom('member_profiles as m')
        .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
        .select('m.id')
        .where('m.institution_id', '=', institutionId)
        .where('m.status', '=', 'ACTIVE');
    const all = groups.has('ALL');
    const students = scoped
      ? year
        ? (
            await db
              .selectFrom('enrolments as en')
              .innerJoin('member_profiles as m', 'm.id', 'en.student_profile_id')
              .select('m.id')
              .where('en.year_id', '=', String(year.id))
              .where('en.section_id', 'in', sections)
              .where('m.status', '=', 'ACTIVE')
              .execute()
          ).map((r) => String(r.id))
        : []
      : (await active().where('ut.category', '=', 'STUDENT').execute()).map((r) => String(r.id));
    if (all || groups.has('STUDENTS')) students.forEach((s) => out.add(s));
    if (all || groups.has('PARENTS')) {
      if (scoped) {
        if (students.length) {
          const guardians = await db
            .selectFrom('guardianships as g')
            .innerJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
            .select('gm.id')
            .where('g.ward_profile_id', 'in', students)
            .where('gm.status', '=', 'ACTIVE')
            .execute();
          guardians.forEach((g) => out.add(String(g.id)));
        }
      } else {
        (await active().where('ut.category', '=', 'PARENT').execute()).forEach((r) =>
          out.add(String(r.id)),
        );
      }
    }
    if (all || groups.has('TEACHERS')) {
      if (scoped && year) {
        const teachers = await db
          .selectFrom('teacher_assignments as ta')
          .innerJoin('member_profiles as m', 'm.id', 'ta.teacher_profile_id')
          .select('m.id')
          .where('ta.year_id', '=', String(year.id))
          .where('ta.section_id', 'in', sections)
          .where('ta.ended_at', 'is', null)
          .where('m.status', '=', 'ACTIVE')
          .execute();
        teachers.forEach((t) => out.add(String(t.id)));
      } else if (!scoped) {
        (await active().where('ut.category', 'in', ['TEACHER', 'PRINCIPAL']).execute()).forEach(
          (r) => out.add(String(r.id)),
        );
      }
    }
    if ((all && !scoped) || groups.has('STAFF')) {
      (await active().where('ut.category', '=', 'STAFF').execute()).forEach((r) =>
        out.add(String(r.id)),
      );
    }
    const types = (targets.userTypeIds ?? []).filter(isUuid);
    if (types.length) {
      const rows = await active()
        .where(
          'ut.public_id',
          'in',
          types.map((x) => uuidToBin(x)),
        )
        .execute();
      rows.forEach((r) => out.add(String(r.id)));
    }
    return [...out];
  }

  // --- creating --------------------------------------------------------------------------------------------
  private async check(db: Db, institutionId: string, input: AnnouncementInput) {
    const title = input.title.trim();
    const text = input.text.trim();
    const [tMin, tMax, xMin, xMax] = await Promise.all(
      [
        LIMITS.announcementTitleMin,
        LIMITS.announcementTitleMax,
        LIMITS.announcementTextMin,
        LIMITS.announcementTextMax,
      ].map((l) => this.limit(l)),
    );
    if ([...title].length < tMin! || [...title].length > tMax!) {
      throw new ValidationError([
        { field: 'title', code: 'COM.TITLE', params: { min: tMin!, max: tMax! } },
      ]);
    }
    if ([...text].length < xMin! || [...text].length > xMax!) {
      throw new ValidationError([
        { field: 'text', code: 'COM.BODY', params: { min: xMin!, max: xMax! } },
      ]);
    }
    const cat = await db
      .selectFrom('announcement_categories')
      .select('code')
      .where('code', '=', input.category)
      .executeTakeFirst();
    if (!cat) throw new ValidationError([{ field: 'category', code: 'COM.CATEGORY' }]);
    const groups = [...new Set(input.targets.groups)];
    if (!groups.length && !(input.targets.userTypeIds ?? []).length)
      throw new ValidationError([{ field: 'targets', code: 'COM.TARGETS' }]);
    const channels = [
      ...new Set(input.channels.length ? input.channels : (['IN_APP'] as CommChannel[])),
    ];
    if (!channels.includes('IN_APP')) channels.unshift('IN_APP');
    const allowed = await this.allowedChannels(db, institutionId);
    const off = channels.find((c) => !allowed.includes(c));
    if (off) throw new CustomAPIError(409, 'COM.CHANNEL_DISABLED', { params: { channel: off } });
    let sendAt = this.now();
    if (input.sendAt) {
      const t = new Date(input.sendAt);
      if (Number.isNaN(t.getTime()) || t.getTime() > this.now().getTime() + 30 * 86_400_000) {
        throw new ValidationError([{ field: 'sendAt', code: 'COM.SEND_AT' }]);
      }
      if (t > sendAt) sendAt = t;
    }
    return { title, text, channels: CHANNEL_ORDER.filter((c) => channels.includes(c)), sendAt };
  }

  private async create(
    institutionId: string,
    by: { account: Buffer | null; profileRowId: string | null },
    source: AnnouncementSource,
    input: AnnouncementInput,
    sectionRowId: string | null = null,
  ) {
    const at = this.now();
    const pub = newPublicIdPair();
    let estimated = 0;
    let sendAt = at;
    await this.deps.db.transaction().execute(async (trx) => {
      const c = await this.check(trx, institutionId, input);
      sendAt = c.sendAt;
      estimated = (await this.resolve(trx, institutionId, input.targets)).length;
      if (!estimated) throw new CustomAPIError(422, 'COM.NO_RECIPIENTS');
      await trx
        .selectFrom('institutions')
        .select('id')
        .where('id', '=', institutionId)
        .forUpdate()
        .execute();
      const last = await trx
        .selectFrom('announcements')
        .select(sql<number>`MAX(seq)`.as('n'))
        .where('institution_id', '=', institutionId)
        .executeTakeFirst();
      const year = await trx
        .selectFrom('academic_years')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('is_current', '=', 1)
        .executeTakeFirst();
      let fileRow: string | null = null;
      if (input.attachmentFileId) {
        const f = isUuid(input.attachmentFileId)
          ? await trx
              .selectFrom('files')
              .select(['id', 'scan_status'])
              .where('public_id', '=', uuidToBin(input.attachmentFileId))
              .where('created_by', '=', by.account)
              .executeTakeFirst()
          : undefined;
        if (!f || f.scan_status === 'INFECTED')
          throw new ValidationError([{ field: 'attachmentFileId', code: 'ACA.HW_FILE' }]);
        fileRow = String(f.id);
      }
      await trx
        .insertInto('announcements')
        .values({
          public_id: pub.bin,
          institution_id: institutionId,
          year_id: year ? String(year.id) : null,
          seq: Number(last?.n ?? 0) + 1,
          source,
          section_id: sectionRowId,
          title: c.title,
          body: c.text,
          category_code: input.category,
          important: input.important ? 1 : 0,
          ack_required: input.ackRequired ? 1 : 0,
          channels: c.channels.join(','),
          targets: JSON.stringify({
            groups: input.targets.groups,
            classIds: input.targets.classIds ?? [],
            sectionIds: input.targets.sectionIds ?? [],
            userTypeIds: input.targets.userTypeIds ?? [],
          }),
          attachment_file_id: fileRow,
          send_at: c.sendAt,
          created_by: by.account,
          created_by_profile_id: by.profileRowId,
          created_at: at,
          updated_at: at,
        })
        .execute();
      await recordAudit(trx, {
        institutionId,
        action: 'ANNOUNCEMENT_CREATED',
        entityType: 'announcement',
        entityRef: pub.id,
        after: { title: c.title, channels: c.channels, recipients: estimated },
      });
    });
    if (sendAt.getTime() <= this.now().getTime()) this.dispatchSoon(pub.id);
    return { announcementId: pub.id, recipientsEstimated: estimated, sendAt: sendAt.toISOString() };
  }

  /** Dispatch after the request, off its path; the job catches anything left behind. */
  private dispatchSoon(id: string) {
    setImmediate(() => {
      this.dispatch(id).catch((e: unknown) => this.deps.onError?.(e));
    });
  }

  /** COM-002: the console's announcement. */
  async createFromConsole(p: Principal, input: AnnouncementInput) {
    const inst = await institutionOf(this.deps.db, p);
    return this.create(inst.id, { account: this.by(p), profileRowId: null }, 'CONSOLE', input);
  }

  /** COM-024: the principal's announcement (same rules as the console). */
  async createFromPrincipal(p: Principal, input: AnnouncementInput) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL') throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
    return this.create(
      me.institutionId,
      { account: this.by(p), profileRowId: me.rowId },
      'PRINCIPAL',
      input,
    );
  }

  /** COM-022: a class teacher's or subject teacher's announcement to a class they teach (in the app). */
  async createForClass(
    p: Principal,
    input: { sectionId: string; title: string; text: string; ackRequired?: boolean | undefined },
  ) {
    const me = await teacherOf(this.deps.db, p);
    const year = await this.deps.db
      .selectFrom('academic_years')
      .select('id')
      .where('institution_id', '=', me.institutionId)
      .where('is_current', '=', 1)
      .executeTakeFirst();
    const section = isUuid(input.sectionId)
      ? await this.deps.db
          .selectFrom('sections')
          .select('id')
          .where('public_id', '=', uuidToBin(input.sectionId))
          .where('institution_id', '=', me.institutionId)
          .executeTakeFirst()
      : undefined;
    const assigned =
      section && year
        ? await this.deps.db
            .selectFrom('teacher_assignments')
            .select('id')
            .where('teacher_profile_id', '=', me.rowId)
            .where('section_id', '=', String(section.id))
            .where('year_id', '=', String(year.id))
            .where('ended_at', 'is', null)
            .executeTakeFirst()
        : undefined;
    if (!section || !assigned) throw new CustomAPIError(403, 'ACA.NOT_ASSIGNED');
    return this.create(
      me.institutionId,
      { account: this.by(p), profileRowId: me.rowId },
      'TEACHER',
      {
        title: input.title,
        text: input.text,
        category: 'ACA',
        ackRequired: input.ackRequired,
        targets: { groups: ['STUDENTS', 'PARENTS'], sectionIds: [input.sectionId] },
        channels: ['IN_APP'],
      },
      String(section.id),
    );
  }

  // --- dispatch --------------------------------------------------------------------------------------------
  /** Sends a due announcement once: QUEUED → PROCESSING → COMPLETED (or FAILED). */
  /**
   * Claims a due announcement (or one left sending for 10 minutes: it stays sending) and sends it in
   * chunks; each chunk is marked delivered with its counts, so a re-claim reaches only those not yet reached.
   */
  async dispatch(id: string) {
    const db = this.deps.db;
    const at = this.now();
    const a = await db
      .selectFrom('announcements')
      .selectAll()
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!a) return;
    const claim = await db
      .updateTable('announcements')
      .set({ status: 'PROCESSING', updated_at: at })
      .where('id', '=', a.id)
      .where('withdrawn_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'QUEUED'), eb('send_at', '<=', at)]),
          eb.and([
            eb('status', '=', 'PROCESSING'),
            eb('updated_at', '<', new Date(at.getTime() - STALE_MS)),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (Number(claim.numUpdatedRows) !== 1) return;
    try {
      const profiles = await this.resolve(db, String(a.institution_id), parseTargets(a.targets));
      for (let i = 0; i < profiles.length; i += 500) {
        await db
          .insertInto('announcement_recipients')
          .ignore()
          .values(
            profiles.slice(i, i + 500).map((pid) => ({
              announcement_id: a.id,
              profile_id: pid,
              institution_id: String(a.institution_id),
            })),
          )
          .execute();
      }
      // Accounts already reached (a re-claim) are not messaged again on any channel.
      const reached = await db
        .selectFrom('announcement_recipients as r')
        .innerJoin('member_profiles as m', 'm.id', 'r.profile_id')
        .select(['r.profile_id', 'm.account_id'])
        .where('r.announcement_id', '=', a.id)
        .where('r.delivered_at', 'is not', null)
        .execute();
      const seen = new Set<string>();
      for (const r of reached) {
        for (const c of a.channels.split(','))
          seen.add(`${r.account_id ?? `p${r.profile_id}`}|${c}`);
      }
      const pending = (
        await db
          .selectFrom('announcement_recipients')
          .select('profile_id')
          .where('announcement_id', '=', a.id)
          .where('delivered_at', 'is', null)
          .orderBy('profile_id')
          .execute()
      ).map((r) => String(r.profile_id));
      for (let i = 0; i < pending.length; i += 200) {
        const chunk = pending.slice(i, i + 200);
        const out = await this.send(db, a, 'NTF.ANNOUNCEMENT', chunk, this.now(), undefined, seen);
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('announcement_recipients')
            .set({ delivered_at: this.now() })
            .where('announcement_id', '=', a.id)
            .where('profile_id', 'in', chunk)
            .where('delivered_at', 'is', null)
            .execute();
          await trx
            .updateTable('announcements')
            .set({
              sent_success: sql<number>`sent_success + ${out.success}`,
              sent_skipped: sql<number>`sent_skipped + ${out.skipped}`,
              sent_failed: sql<number>`sent_failed + ${out.failed}`,
              updated_at: this.now(),
            })
            .where('id', '=', a.id)
            .execute();
        });
      }
      await db
        .updateTable('announcements')
        .set({
          status: 'COMPLETED',
          recipients: profiles.length,
          dispatched_at: at,
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .where('status', '=', 'PROCESSING')
        .execute();
    } catch (e) {
      await db
        .updateTable('announcements')
        .set({
          status: 'FAILED',
          failure_reason: (e instanceof Error ? e.message : String(e)).slice(0, 300),
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .where('status', '=', 'PROCESSING')
        .execute();
      throw e;
    }
  }

  /** One message per account and channel; every attempt logged (CR-16, never the body). */
  private async send(
    db: Db,
    a: {
      id: string;
      public_id: Buffer;
      institution_id: string;
      title: string;
      body: string;
      channels: string;
      created_by: Buffer | null;
    },
    titleKey: 'NTF.ANNOUNCEMENT' | 'NTF.ANNOUNCEMENT_REMINDER',
    profileRowIds: readonly string[],
    at: Date,
    channelsOverride?: readonly CommChannel[],
    seen = new Set<string>(),
  ) {
    const channels = (channelsOverride ?? (a.channels.split(',') as CommChannel[])).filter(Boolean);
    const ref = binToUuid(a.public_id);
    const rows: CommLogRow[] = [];
    const people = profileRowIds.length
      ? await db
          .selectFrom('member_profiles as m')
          .leftJoin('platform_accounts as acc', 'acc.id', 'm.account_id')
          .select(['m.id', 'm.account_id', 'acc.mobile', 'acc.email'])
          .where('m.id', 'in', profileRowIds as string[])
          .execute()
      : [];
    const allowed = await this.allowedChannels(db, String(a.institution_id));
    // Client 2026-10-16: the school's "Announcements" event switch decides whether they are e-mailed.
    const emailEvent =
      (await eventSwitches(db, String(a.institution_id))).get('ANNOUNCEMENT')?.email ?? true;
    const school = await db
      .selectFrom('institutions')
      .select(['name', 'office_email'])
      .where('id', '=', String(a.institution_id))
      .executeTakeFirst();
    const accounts: string[] = [];
    for (const person of people) {
      for (const channel of channels) {
        const base = {
          institutionId: String(a.institution_id),
          kind: 'ANNOUNCEMENT' as const,
          channel,
          recipientProfileId: String(person.id),
          recipientAccountId: person.account_id ? String(person.account_id) : null,
          raiser: a.created_by,
          refType: 'announcement',
          refId: ref,
          subject: a.title,
        };
        const key = `${person.account_id ?? `p${person.id}`}|${channel}`;
        if (seen.has(key)) continue; // one message per account and channel
        seen.add(key);
        if (!allowed.includes(channel)) {
          rows.push({ ...base, outcome: 'SKIPPED', reason: 'Channel switched off' });
          continue;
        }
        if (channel === 'EMAIL' && !emailEvent) {
          rows.push({ ...base, outcome: 'SKIPPED', reason: 'E-mail switched off for announcements' });
          continue;
        }
        if (channel === 'IN_APP') {
          if (person.account_id) {
            accounts.push(String(person.account_id));
            rows.push({ ...base, recipient: 'In-app', outcome: 'SUCCESS' });
          } else rows.push({ ...base, outcome: 'SKIPPED', reason: 'No account' });
          continue;
        }
        const sender =
          channel === 'SMS' ? this.deps.sms : channel === 'EMAIL' ? this.deps.email : undefined;
        const to = channel === 'SMS' ? person.mobile : channel === 'EMAIL' ? person.email : null;
        if (!sender) {
          rows.push({ ...base, outcome: 'SKIPPED', reason: 'Channel not available' });
          continue;
        }
        if (!to) {
          rows.push({
            ...base,
            outcome: 'SKIPPED',
            reason: channel === 'SMS' ? 'No mobile number' : 'No e-mail address',
          });
          continue;
        }
        const masked = channel === 'SMS' ? maskMobile(to) : maskEmail(to);
        try {
          await sender.send({
            to,
            purpose: 'announcement',
            log: false,
            ...(channel === 'EMAIL'
              ? {
                  subject: `${titleKey === 'NTF.ANNOUNCEMENT_REMINDER' ? 'Reminder: ' : ''}${a.title}`,
                  ...(school ? { fromName: school.name, replyTo: school.office_email } : {}),
                }
              : {}),
            text: `${titleKey === 'NTF.ANNOUNCEMENT_REMINDER' ? 'Reminder: ' : ''}${a.title} — ${a.body}`.slice(
              0,
              channel === 'SMS' ? 320 : 5000,
            ),
          });
          rows.push({ ...base, recipient: masked, outcome: 'SUCCESS' });
        } catch (e) {
          rows.push({
            ...base,
            recipient: masked,
            outcome: 'FAILED',
            reason: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          });
        }
      }
    }
    if (accounts.length) {
      await notify(
        db,
        {
          institutionId: String(a.institution_id),
          accountIds: accounts,
          surface: 'MEMBER',
          category: 'ACCOUNT',
          titleKey,
          params: { title: a.title },
          body: a.body.slice(0, 140),
          link: `/announcements/${ref}`,
          log: false,
          email: false,
        },
        at,
      );
    }
    await logComm(db, rows, at);
    return {
      success: rows.filter((r) => r.outcome === 'SUCCESS').length,
      skipped: rows.filter((r) => r.outcome === 'SKIPPED').length,
      failed: rows.filter((r) => r.outcome === 'FAILED').length,
    };
  }

  /** The job `announcement-dispatch`: due announcements, and any left processing for 10 minutes. */
  async run(ctx: Pick<JobContext, 'item'> & { scope?: { institutionId: string } | undefined }) {
    const at = this.now();
    let q = this.deps.db
      .selectFrom('announcements')
      .select(['public_id', 'institution_id'])
      .where('withdrawn_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([eb('status', '=', 'QUEUED'), eb('send_at', '<=', at)]),
          eb.and([
            eb('status', '=', 'PROCESSING'),
            eb('updated_at', '<', new Date(at.getTime() - STALE_MS)),
          ]),
        ]),
      )
      .orderBy('important', 'desc')
      .orderBy('send_at')
      .limit(50);
    if (ctx.scope) q = q.where('institution_id', '=', ctx.scope.institutionId);
    const due = await q.execute();
    const per = new Map<string, { sent: number; failed: number }>();
    for (const d of due) {
      const k = String(d.institution_id);
      const x = per.get(k) ?? { sent: 0, failed: 0 };
      try {
        await this.dispatch(binToUuid(d.public_id));
        x.sent++;
      } catch {
        x.failed++;
      }
      per.set(k, x);
    }
    for (const [institutionId, x] of per) {
      ctx.item({
        institutionId,
        status: x.failed ? 'FAILED' : 'SUCCESS',
        processed: x.sent,
        failed: x.failed,
        note: `${x.sent} announcements sent, ${x.failed} failed`,
      });
    }
  }

  // --- reading (console) -----------------------------------------------------------------------------------
  private rows(db: Db) {
    return db
      .selectFrom('announcements as a')
      .innerJoin('announcement_categories as c', 'c.code', 'a.category_code')
      .leftJoin('platform_accounts as acc', 'acc.public_id', 'a.created_by')
      .leftJoin('sections as s', 's.id', 'a.section_id')
      .leftJoin('classes as cl', 'cl.id', 's.class_id')
      .selectAll('a')
      .select([
        'c.label as category_label',
        'c.colour as category_colour',
        'acc.first_name as author_first',
        'acc.last_name as author_last',
        's.name as section_name',
        'cl.name as class_name',
        (eb) =>
          eb
            .selectFrom('announcement_recipients as r')
            .select(sql<number>`COUNT(*)`.as('n'))
            .whereRef('r.announcement_id', '=', 'a.id')
            .where('r.acknowledged_at', 'is not', null)
            .as('acks'),
      ]);
  }

  private view(
    a: Awaited<ReturnType<ReturnType<AnnouncementsService['rows']>['execute']>>[number],
  ) {
    const created = new Date(a.created_at);
    const sendAt = new Date(a.send_at);
    return {
      id: binToUuid(a.public_id),
      code: `ANN-${istBusinessDate(created).slice(0, 4)}-${String(a.seq).padStart(4, '0')}`,
      title: a.title,
      text: a.body,
      category: { code: a.category_code, label: a.category_label, colour: a.category_colour },
      important: !!Number(a.important),
      ackRequired: !!Number(a.ack_required),
      channels: a.channels.split(',').filter(Boolean),
      targets: parseTargets(a.targets),
      source: a.source,
      classSection: a.class_name ? `${a.class_name} ${a.section_name ?? ''}`.trim() : null,
      author: nameOf(a.author_first, a.author_last) || null,
      sendAt: sendAt.toISOString(),
      scheduled: a.status === 'QUEUED' && sendAt.getTime() > this.now().getTime(),
      dispatch: {
        status: a.status,
        recipients: a.recipients,
        success: a.sent_success,
        skipped: a.sent_skipped,
        failed: a.sent_failed,
        at: iso(a.dispatched_at),
        reason: a.failure_reason,
      },
      acknowledgements: Number(a.ack_required)
        ? { acknowledged: Number(a.acks ?? 0), of: a.recipients }
        : null,
      withdrawn: a.withdrawn_at ? { at: iso(a.withdrawn_at), reason: a.withdraw_reason } : null,
      createdAt: created.toISOString(),
      version: a.row_version,
    };
  }

  private async one(db: Db, institutionId: string, id: string) {
    if (!isUuid(id)) throw new CustomAPIError(404, 'COM.NOT_FOUND');
    const a = await this.rows(db)
      .where('a.public_id', '=', uuidToBin(id))
      .where('a.institution_id', '=', institutionId)
      .executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'COM.NOT_FOUND');
    return a;
  }

  /** COM-001: the year's announcements with outcome and acknowledgements. */
  async list(
    p: Principal,
    f: {
      yearId?: string | undefined;
      category?: string | undefined;
      importantOnly?: boolean | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    return this.listOf(inst.id, f);
  }

  private async listOf(
    institutionId: string,
    f: {
      yearId?: string | undefined;
      category?: string | undefined;
      importantOnly?: boolean | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = { id: institutionId };
    let q = this.rows(this.deps.db).where('a.institution_id', '=', inst.id);
    if (f.yearId && isUuid(f.yearId)) {
      q = q.where('a.year_id', '=', (eb) =>
        eb
          .selectFrom('academic_years')
          .select('id')
          .where('public_id', '=', uuidToBin(f.yearId!))
          .where('institution_id', '=', inst.id),
      );
    }
    if (f.category) q = q.where('a.category_code', '=', f.category);
    if (f.importantOnly) q = q.where('a.important', '=', 1);
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('a.id', '<', f.cursor);
    const rows = await q.orderBy('a.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    return {
      categories: await this.categories(),
      channels: await this.allowedChannels(this.deps.db, inst.id),
      items: page.map((a) => this.view(a)),
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  /** COM-003: one announcement with its per-channel outcome. */
  async detail(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    const a = await this.one(this.deps.db, inst.id, id);
    const perChannel = await this.deps.db
      .selectFrom('comm_log')
      .select(['channel', 'outcome', sql<number>`COUNT(*)`.as('n')])
      .where('ref_type', '=', 'announcement')
      .where('ref_id', '=', binToUuid(a.public_id))
      .groupBy(['channel', 'outcome'])
      .execute();
    return {
      ...this.view(a),
      perChannel: CHANNEL_ORDER.filter((c) => perChannel.some((x) => x.channel === c)).map((c) => ({
        channel: c,
        success: Number(perChannel.find((x) => x.channel === c && x.outcome === 'SUCCESS')?.n ?? 0),
        skipped: Number(perChannel.find((x) => x.channel === c && x.outcome === 'SKIPPED')?.n ?? 0),
        failed: Number(perChannel.find((x) => x.channel === c && x.outcome === 'FAILED')?.n ?? 0),
      })),
    };
  }

  /** COM-004: edit until it is sent; afterwards only withdraw (kept on record). */
  async update(
    p: Principal,
    id: string,
    expected: number,
    input: Partial<AnnouncementInput> & {
      withdrawn?: boolean | undefined;
      reason?: string | undefined;
    },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    await this.deps.db.transaction().execute(async (trx) => {
      const a = await this.one(trx, inst.id, id);
      await trx
        .selectFrom('announcements')
        .select('id')
        .where('id', '=', a.id)
        .forUpdate()
        .execute();
      if (a.row_version !== expected) throw new PreconditionFailedError();
      if (input.withdrawn) {
        if (a.withdrawn_at) throw new CustomAPIError(409, 'COM.ALREADY_WITHDRAWN');
        const reason = (input.reason ?? '').trim();
        if (reason.length < 5 || reason.length > 300)
          throw new ValidationError([{ field: 'reason', code: 'COM.WITHDRAW_REASON' }]);
        await trx
          .updateTable('announcements')
          .set({
            withdrawn_at: this.now(),
            withdraw_reason: reason,
            updated_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', a.id)
          .execute();
        await recordAudit(trx, {
          institutionId: inst.id,
          action: 'ANNOUNCEMENT_WITHDRAWN',
          entityType: 'announcement',
          entityRef: id,
          reason,
        });
        return;
      }
      if (
        a.status !== 'QUEUED' ||
        new Date(a.send_at).getTime() <= this.now().getTime() ||
        a.withdrawn_at
      ) {
        throw new CustomAPIError(409, 'COM.ALREADY_DISPATCHED');
      }
      const merged: AnnouncementInput = {
        title: input.title ?? a.title,
        text: input.text ?? a.body,
        category: input.category ?? a.category_code,
        important: input.important ?? !!Number(a.important),
        ackRequired: input.ackRequired ?? !!Number(a.ack_required),
        targets: input.targets ?? parseTargets(a.targets),
        channels: input.channels ?? (a.channels.split(',') as CommChannel[]),
        sendAt: input.sendAt ?? new Date(a.send_at).toISOString(),
      };
      const c = await this.check(trx, inst.id, merged);
      if (!(await this.resolve(trx, inst.id, merged.targets)).length)
        throw new CustomAPIError(422, 'COM.NO_RECIPIENTS');
      await trx
        .updateTable('announcements')
        .set({
          title: c.title,
          body: c.text,
          category_code: merged.category,
          important: merged.important ? 1 : 0,
          ack_required: merged.ackRequired ? 1 : 0,
          channels: c.channels.join(','),
          targets: JSON.stringify({
            groups: merged.targets.groups,
            classIds: merged.targets.classIds ?? [],
            sectionIds: merged.targets.sectionIds ?? [],
            userTypeIds: merged.targets.userTypeIds ?? [],
          }),
          send_at: c.sendAt,
          updated_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', a.id)
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'ANNOUNCEMENT_EDITED',
        entityType: 'announcement',
        entityRef: id,
      });
    });
    const out = await this.detail(p, id);
    if (!out.withdrawn && !out.scheduled && out.dispatch.status === 'QUEUED') this.dispatchSoon(id);
    return out;
  }

  /** COM-005: who has and hasn't acknowledged (CR-09 columns for students). */
  async acknowledgements(
    p: Principal,
    id: string,
    f: { acked?: boolean | undefined; sectionId?: string | undefined; cursor?: string | undefined },
  ) {
    const inst = await institutionOf(this.deps.db, p);
    return this.acksOf(await this.one(this.deps.db, inst.id, id), f);
  }

  private async acksOf(
    a: Awaited<ReturnType<AnnouncementsService['one']>>,
    f: { acked?: boolean | undefined; sectionId?: string | undefined; cursor?: string | undefined },
  ) {
    let q = this.deps.db
      .selectFrom('announcement_recipients as r')
      .innerJoin('member_profiles as m', 'm.id', 'r.profile_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').on('en.year_id', '=', a.year_id ?? '0'),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'ut.name as type_name',
        'c.name as class_name',
        's.name as section_name',
        'r.acknowledged_at',
        'r.ack_channel',
      ])
      .where('r.announcement_id', '=', a.id);
    if (f.acked === true) q = q.where('r.acknowledged_at', 'is not', null);
    if (f.acked === false) q = q.where('r.acknowledged_at', 'is', null);
    if (f.sectionId && isUuid(f.sectionId)) q = q.where('s.public_id', '=', uuidToBin(f.sectionId));
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('m.id', '>', f.cursor);
    const rows = await q.orderBy('m.id').limit(101).execute();
    const page = rows.slice(0, 100);
    return {
      announcement: this.view(a),
      items: page.map((r) => ({
        member: {
          id: binToUuid(r.public_id),
          name: nameOf(r.first_name, r.last_name),
          admissionNo: r.admission_no,
          class: r.class_name ?? null,
          section: r.section_name ?? null,
          type: r.type_name,
        },
        acknowledgedAt: iso(r.acknowledged_at),
        channel: r.ack_channel,
      })),
      nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null,
    };
  }

  /** COM-006: remind those who haven't acknowledged (in the app and the chosen channels). */
  async remind(p: Principal, id: string, input: { channels: readonly CommChannel[] }) {
    const inst = await institutionOf(this.deps.db, p);
    return this.remindOf(p, inst.id, await this.one(this.deps.db, inst.id, id), id, input);
  }

  private async remindOf(
    p: Principal,
    institutionId: string,
    a: Awaited<ReturnType<AnnouncementsService['one']>>,
    id: string,
    input: { channels: readonly CommChannel[] },
  ) {
    const inst = { id: institutionId };
    if (!Number(a.ack_required)) throw new CustomAPIError(409, 'COM.ACK_NOT_REQUIRED');
    if (a.withdrawn_at || a.status !== 'COMPLETED') throw new CustomAPIError(409, 'COM.NOT_SENT');
    const allowed = await this.allowedChannels(this.deps.db, inst.id);
    const channels = [...new Set(['IN_APP', ...input.channels] as CommChannel[])];
    const off = channels.find((c) => !allowed.includes(c));
    if (off) throw new CustomAPIError(409, 'COM.CHANNEL_DISABLED', { params: { channel: off } });
    const pending = await this.deps.db
      .selectFrom('announcement_recipients')
      .select('profile_id')
      .where('announcement_id', '=', a.id)
      .where('acknowledged_at', 'is', null)
      .execute();
    const at = this.now();
    const out = await this.deps.db.transaction().execute((trx) =>
      this.send(
        trx,
        { ...a, created_by: this.by(p) },
        'NTF.ANNOUNCEMENT_REMINDER',
        pending.map((r) => String(r.profile_id)),
        at,
        channels,
      ),
    );
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'ANNOUNCEMENT_REMINDED',
      entityType: 'announcement',
      entityRef: id,
      after: { members: pending.length, channels },
    });
    return { reminded: pending.length, ...out };
  }

  /** For the tenant check before a body is read. */
  async lookup(p: Principal, id: string) {
    const inst = await institutionOf(this.deps.db, p);
    await this.one(this.deps.db, inst.id, id);
  }

  // --- the member (COM-011…013) and the teacher (COM-023) ---------------------------------------------------
  private memberRows(db: Db, profileRowId: string) {
    return this.rows(db)
      .innerJoin('announcement_recipients as me', (j) =>
        j.onRef('me.announcement_id', '=', 'a.id').on('me.profile_id', '=', profileRowId),
      )
      .select(['me.acknowledged_at as my_ack'])
      .where('me.delivered_at', 'is not', null)
      .where('a.withdrawn_at', 'is', null);
  }

  private memberView(
    a: Awaited<ReturnType<ReturnType<AnnouncementsService['memberRows']>['execute']>>[number],
  ) {
    const v = this.view(a);
    return {
      id: v.id,
      code: v.code,
      title: v.title,
      text: v.text,
      category: v.category,
      important: v.important,
      ackRequired: v.ackRequired,
      acknowledged: !!a.my_ack,
      acknowledgedAt: iso(a.my_ack),
      author: v.author,
      source: v.source,
      classSection: v.classSection,
      sentAt: v.dispatch.at ?? v.sendAt,
    };
  }

  async mine(p: Principal, f: { for?: string | undefined; cursor?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    let q = this.memberRows(this.deps.db, me.rowId).where(
      'a.institution_id',
      '=',
      me.institutionId,
    );
    if (f.cursor && /^\d+$/.test(f.cursor)) q = q.where('a.id', '<', f.cursor);
    const rows = await q.orderBy('a.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const items = page.map((a) => this.memberView(a));
    return {
      unacknowledged: items.filter((i) => i.ackRequired && !i.acknowledged).length,
      items,
      nextCursor: rows.length > 50 ? String(page.at(-1)!.id) : null,
    };
  }

  async mineOne(p: Principal, id: string, f: { for?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    if (!isUuid(id)) throw new CustomAPIError(404, 'COM.NOT_FOUND');
    const a = await this.memberRows(this.deps.db, me.rowId)
      .where('a.public_id', '=', uuidToBin(id))
      .where('a.institution_id', '=', me.institutionId)
      .executeTakeFirst();
    if (!a) throw new CustomAPIError(404, 'COM.NOT_FOUND');
    return this.memberView(a);
  }

  /** COM-013: the member's own acknowledgement (once; again is harmless). */
  async acknowledge(p: Principal, id: string, f: { for?: string | undefined }) {
    const me = await memberOf(this.deps.db, p, f.for);
    const a = await this.mineOne(p, id, f);
    if (!a.ackRequired) throw new CustomAPIError(409, 'COM.ACK_NOT_REQUIRED');
    if (!a.acknowledged) {
      await this.deps.db
        .updateTable('announcement_recipients')
        .set({ acknowledged_at: this.now(), ack_channel: 'IN-APP' })
        .where('profile_id', '=', me.rowId)
        .where('acknowledged_at', 'is', null)
        .where('announcement_id', '=', (eb) =>
          eb.selectFrom('announcements').select('id').where('public_id', '=', uuidToBin(id)),
        )
        .execute();
    }
    return this.mineOne(p, id, f);
  }

  /** COM-023: the teacher's class announcements with acknowledgement counts. */
  async mineAsTeacher(p: Principal) {
    const me = await teacherOf(this.deps.db, p);
    const rows = await this.rows(this.deps.db)
      .where('a.institution_id', '=', me.institutionId)
      .where('a.created_by_profile_id', '=', me.rowId)
      .where('a.source', '=', 'TEACHER')
      .orderBy('a.id', 'desc')
      .limit(100)
      .execute();
    return { items: rows.map((a) => this.view(a)) };
  }

  /** The teacher's own class announcement, or 404 (another's answers the same). */
  private async ownClassAnnouncement(p: Principal, id: string) {
    const me = await teacherOf(this.deps.db, p);
    const a = await this.one(this.deps.db, me.institutionId, id);
    if (a.source !== 'TEACHER' || String(a.created_by_profile_id) !== String(me.rowId)) {
      throw new CustomAPIError(404, 'COM.NOT_FOUND');
    }
    return { me, a };
  }

  /** COM-028: who has and hasn't acknowledged the teacher's class announcement. */
  async classAcknowledgements(
    p: Principal,
    id: string,
    f: { acked?: boolean | undefined; cursor?: string | undefined },
  ) {
    const { a } = await this.ownClassAnnouncement(p, id);
    return this.acksOf(a, f);
  }

  /** COM-029: remind those who haven't acknowledged the teacher's class announcement (in the app). */
  async classRemind(p: Principal, id: string) {
    const { me, a } = await this.ownClassAnnouncement(p, id);
    return this.remindOf(p, me.institutionId, a, id, { channels: ['IN_APP'] });
  }

  /** The principal's view of one of the school's announcements, or 404. */
  private async principalAnnouncement(p: Principal, id: string) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL') throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
    return { me, a: await this.one(this.deps.db, me.institutionId, id) };
  }

  /** COM-030: who has and hasn't acknowledged one of the school's announcements (the principal). */
  async principalAcknowledgements(
    p: Principal,
    id: string,
    f: { acked?: boolean | undefined; sectionId?: string | undefined; cursor?: string | undefined },
  ) {
    const { a } = await this.principalAnnouncement(p, id);
    return this.acksOf(a, f);
  }

  /** COM-031: the principal reminds those who haven't acknowledged (in the app and chosen channels). */
  async principalRemind(p: Principal, id: string, input: { channels: readonly CommChannel[] }) {
    const { me, a } = await this.principalAnnouncement(p, id);
    return this.remindOf(p, me.institutionId, a, id, input);
  }

  /** COM-026: the school's announcements for the principal, with outcome and acknowledgements. */
  async principalList(
    p: Principal,
    f: {
      category?: string | undefined;
      importantOnly?: boolean | undefined;
      cursor?: string | undefined;
    },
  ) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL') throw new CustomAPIError(403, 'ACA.PRINCIPAL_ONLY');
    return this.listOf(me.institutionId, f);
  }

  /**
   * COM-027: what a teacher's or the principal's new announcement may use — categories, the channels the
   * school has on (BR-70), target groups and the length limits (settings).
   */
  async composeOptions(p: Principal) {
    const me = await memberOf(this.deps.db, p);
    if (me.category !== 'PRINCIPAL' && me.category !== 'TEACHER') {
      throw new CustomAPIError(403, 'ACA.TEACHERS_ONLY');
    }
    const [titleMin, titleMax, textMin, textMax] = await Promise.all([
      this.limit(LIMITS.announcementTitleMin),
      this.limit(LIMITS.announcementTitleMax),
      this.limit(LIMITS.announcementTextMin),
      this.limit(LIMITS.announcementTextMax),
    ]);
    const principal = me.category === 'PRINCIPAL';
    return {
      categories: await this.categories(),
      // A class announcement goes in the app only; the principal uses the school's channels.
      channels: principal ? await this.allowedChannels(this.deps.db, me.institutionId) : ['IN_APP'],
      groups: principal ? [...TARGET_GROUPS] : ['STUDENTS', 'PARENTS'],
      limits: { titleMin, titleMax, textMin, textMax },
    };
  }
}
