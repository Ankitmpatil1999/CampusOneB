/**
 * Paid events (SRS 13.7–13.10, 13.16; FEE-028…033 and the job event-status; prototype c.events,
 * m.events, m.event).
 *
 * - An event has payment heads (the total is their sum), a period whose end date is inclusive to
 *   23:59:59 IST (OI-FEE-15), an optional audience (classes) and the institution's fee account as
 *   the payee (MER 12.7). Dates and amounts are checked on the server (OI-FEE-13).
 * - It is payable while Active and within its period, once per payer, through the payment engine
 *   (channel EVENT, P2) — PAY-002 with `eventId`.
 * - Members see the live events of their own institution and audience (OI-FEE-15).
 * - The 23:50 job deactivates events after their end date (OI-FEE-14, brief §7.5).
 * - The report lists the event's payments with a date range and a CSV export (OI-FEE-16).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { MessageKey } from '../config/registers';
import type { Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import type { JobContext } from '../schedulers';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { toCsv } from '../utils/csv';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { usesProfile } from './member-roles';

const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const parseIds = (v: unknown): string[] | null => {
  if (v === null || v === undefined) return null;
  const o = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(o) ? o.map(String) : null;
};

export interface EventInput {
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly startDate: string;
  readonly endDate: string;
  readonly heads: readonly { readonly name: string; readonly amountPaise: number }[];
  readonly audienceClassIds?: readonly string[] | null | undefined;
}

export class EventsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  /** The class row ids of the audience (public ids of the institution's classes). */
  private async classRows(institutionId: string, ids: readonly string[] | null | undefined) {
    if (!ids || !ids.length) return null;
    const valid = ids.filter(isUuid);
    const rows = valid.length
      ? await this.deps.db
          .selectFrom('classes')
          .select(['id', 'public_id'])
          .where('institution_id', '=', institutionId)
          .where('public_id', 'in', valid.map(uuidToBin))
          .execute()
      : [];
    if (rows.length !== ids.length) {
      throw new ValidationError([{ field: 'audienceClassIds', code: 'VALIDATION.FORMAT' }]);
    }
    return rows.map((r) => binToUuid(r.public_id));
  }

  /** Neither date given may be in the past, and the event closes on or after it opens. */
  private checkInput(input: Partial<EventInput>, today: string) {
    const errors: { field: string; code: MessageKey }[] = [];
    if (input.startDate !== undefined && input.startDate < today) {
      errors.push({ field: 'startDate', code: 'FEE.EVENT_OPENS_PAST' });
    }
    if (input.endDate !== undefined && input.endDate < today) {
      errors.push({ field: 'endDate', code: 'FEE.EVENT_CLOSES_PAST' });
    } else if (input.startDate && input.endDate && input.endDate < input.startDate) {
      errors.push({ field: 'endDate', code: 'FEE.EVENT_DATES_INVALID' });
    }
    if (errors.length) throw new ValidationError(errors);
  }

  private async view(institutionId: string, rows: readonly { id: string }[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => String(r.id));
    const [events, heads, paid, classes] = await Promise.all([
      this.deps.db
        .selectFrom('events as e')
        .innerJoin('merchants as mer', 'mer.profile_id', 'e.merchant_profile_id')
        .selectAll('e')
        .select('mer.display_name as merchant_name')
        .where('e.id', 'in', ids)
        .execute(),
      this.deps.db
        .selectFrom('event_heads')
        .select(['event_id', 'name', 'amount_paise'])
        .where('event_id', 'in', ids)
        .orderBy('sort_order')
        .execute(),
      this.deps.db
        .selectFrom('payment_attempts')
        .select([
          'event_ref',
          sql<number>`COUNT(*)`.as('n'),
          sql<string>`SUM(amount_paise)`.as('paise'),
        ])
        .where('institution_id', '=', institutionId)
        .where('channel', '=', 'EVENT')
        .where('status', '=', 'SUCCESS')
        .groupBy('event_ref')
        .execute(),
      this.deps.db
        .selectFrom('classes')
        .select(['public_id', 'name'])
        .where('institution_id', '=', institutionId)
        .execute(),
    ]);
    const className = new Map(classes.map((c) => [binToUuid(c.public_id), c.name]));
    const byRef = new Map(paid.map((p) => [p.event_ref, p]));
    const order = new Map(ids.map((id, i) => [id, i]));
    return [...events]
      .sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!)
      .map((e) => {
        const id = binToUuid(e.public_id);
        const audience = parseIds(e.audience_class_ids);
        const p = byRef.get(id);
        return {
          id,
          title: e.title,
          description: e.description,
          startDate: day(e.start_date),
          endDate: day(e.end_date),
          heads: heads
            .filter((h) => String(h.event_id) === String(e.id))
            .map((h) => ({ name: h.name, amount: toMoneyDto(Number(h.amount_paise)) })),
          total: toMoneyDto(Number(e.total_paise)),
          merchant: e.merchant_name,
          audience: audience
            ? audience.map((c) => ({ id: c, name: className.get(c) ?? '' }))
            : null,
          status: e.status,
          payments: { count: Number(p?.n ?? 0), collected: toMoneyDto(Number(p?.paise ?? 0)) },
          createdAt: iso(e.created_at)!,
          version: e.row_version,
        };
      });
  }

  // --- FEE-028 ------------------------------------------------------------------------------------
  async list(p: Principal, f: { status?: 'ACTIVE' | 'INACTIVE' | undefined }) {
    const inst = await this.own(p);
    let q = this.deps.db.selectFrom('events').select('id').where('institution_id', '=', inst.id);
    if (f.status) q = q.where('status', '=', f.status);
    const rows = await q.orderBy('start_date', 'desc').orderBy('id', 'desc').limit(500).execute();
    const items = await this.view(inst.id, rows);
    const today = istBusinessDate(this.now());
    return {
      items,
      kpis: {
        live: items.filter(
          (e) => e.status === 'ACTIVE' && e.startDate <= today && today <= e.endDate,
        ).length,
        upcoming: items.filter((e) => e.status === 'ACTIVE' && e.startDate > today).length,
        collected: toMoneyDto(
          items.reduce((a, e) => a + Math.round(Number(e.payments.collected.amount) * 100), 0),
        ),
        payments: items.reduce((a, e) => a + e.payments.count, 0),
      },
    };
  }

  private async eventRow(institutionId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const e = await this.deps.db
      .selectFrom('events')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!e) throw new NotFoundError();
    return e;
  }

  /** The institution's Events feature (7.5); off, nothing new is registered. */
  private async featureOn(institutionId: string) {
    const on = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('feature_key', '=', 'events')
      .executeTakeFirst();
    return !on || !!Number(on.enabled);
  }

  // --- FEE-029 ------------------------------------------------------------------------------------
  async create(p: Principal, input: EventInput) {
    const inst = await this.own(p);
    if (!(await this.featureOn(String(inst.id)))) throw new CustomAPIError(409, 'FEE.EVENTS_OFF');
    this.checkInput(input, istBusinessDate(this.now()));
    // The institution's designated fee account (FR-INS-06, MER 12.7) receives event payments.
    const fee = inst.fee_merchant_profile_id
      ? await this.deps.db
          .selectFrom('merchants as mer')
          .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
          .select('mer.profile_id')
          .where('mer.profile_id', '=', String(inst.fee_merchant_profile_id))
          .where('mp.status', '=', 'ACTIVE')
          .executeTakeFirst()
      : undefined;
    if (!fee) throw new CustomAPIError(409, 'FEE.NO_FEE_ACCOUNT');
    const audience = await this.classRows(inst.id, input.audienceClassIds);
    const total = input.heads.reduce((a, h) => a + h.amountPaise, 0);
    const pub = newPublicIdPair();
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('events')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          start_date: input.startDate,
          end_date: input.endDate,
          total_paise: total,
          merchant_profile_id: String(fee.profile_id),
          audience_class_ids: audience ? JSON.stringify(audience) : null,
          created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('event_heads')
        .values(
          input.heads.map((h, i) => ({
            event_id: String(r.insertId),
            name: h.name.trim(),
            amount_paise: h.amountPaise,
            sort_order: i,
          })),
        )
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'EVENT_CREATED',
        entityType: 'event',
        entityRef: pub.id,
        after: {
          title: input.title,
          total: formatInr(total),
          from: input.startDate,
          to: input.endDate,
        },
      });
    });
    const [view] = await this.view(inst.id, [
      { id: String((await this.eventRow(inst.id, pub.id)).id) },
    ]);
    return view!;
  }

  // --- FEE-030 ------------------------------------------------------------------------------------
  async update(
    p: Principal,
    id: string,
    expected: number,
    patch: Partial<EventInput> & { status?: 'ACTIVE' | 'INACTIVE' | undefined },
  ) {
    const inst = await this.own(p);
    const e = await this.eventRow(inst.id, id);
    if (e.row_version !== expected) throw new PreconditionFailedError();
    const start = patch.startDate ?? day(e.start_date);
    const end = patch.endDate ?? day(e.end_date);
    // An ended event stays closed (OI-FEE-14); a new end date in the future reopens it deliberately.
    if (patch.status === 'ACTIVE' && e.status !== 'ACTIVE' && end < istBusinessDate(this.now())) {
      throw new CustomAPIError(409, 'FEE.EVENT_ENDED');
    }
    if (patch.startDate !== undefined || patch.endDate !== undefined) {
      // A past date is refused only when it changes (an event under way keeps its start).
      this.checkInput(
        { startDate: patch.startDate, endDate: patch.endDate },
        istBusinessDate(this.now()),
      );
      if (end < start)
        throw new ValidationError([{ field: 'endDate', code: 'FEE.EVENT_DATES_INVALID' }]);
    }
    if (patch.heads !== undefined || patch.startDate !== undefined) {
      const paid = await this.deps.db
        .selectFrom('payment_attempts')
        .select('id')
        .where('institution_id', '=', inst.id)
        .where('event_ref', '=', id.toLowerCase())
        .where('status', '=', 'SUCCESS')
        .executeTakeFirst();
      if (paid) throw new CustomAPIError(409, 'FEE.EVENT_HAS_PAYMENTS');
    }
    const audience =
      patch.audienceClassIds !== undefined
        ? await this.classRows(inst.id, patch.audienceClassIds)
        : undefined;
    await this.deps.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('events')
        .set({
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.description !== undefined
            ? { description: patch.description?.trim() || null }
            : {}),
          ...(patch.startDate !== undefined ? { start_date: patch.startDate } : {}),
          ...(patch.endDate !== undefined ? { end_date: patch.endDate } : {}),
          ...(patch.heads !== undefined
            ? { total_paise: patch.heads.reduce((a, h) => a + h.amountPaise, 0) }
            : {}),
          ...(audience !== undefined
            ? { audience_class_ids: audience ? JSON.stringify(audience) : null }
            : {}),
          ...(patch.status ? { status: patch.status } : {}),
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('id', '=', e.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      if (patch.heads !== undefined) {
        await trx.deleteFrom('event_heads').where('event_id', '=', e.id).execute();
        await trx
          .insertInto('event_heads')
          .values(
            patch.heads.map((h, i) => ({
              event_id: e.id,
              name: h.name.trim(),
              amount_paise: h.amountPaise,
              sort_order: i,
            })),
          )
          .execute();
      }
      await recordAudit(trx, {
        institutionId: inst.id,
        action:
          patch.status && patch.status !== e.status ? `EVENT_${patch.status}` : 'EVENT_UPDATED',
        entityType: 'event',
        entityRef: id.toLowerCase(),
        before: { title: e.title, status: e.status },
        after: {
          ...patch,
          heads: patch.heads?.map((h) => `${h.name} ${formatInr(h.amountPaise)}`),
        },
      });
    });
    const [view] = await this.view(inst.id, [{ id: String(e.id) }]);
    return view!;
  }

  // --- FEE-031 ------------------------------------------------------------------------------------
  async report(
    p: Principal,
    id: string,
    f: {
      from?: string | undefined;
      to?: string | undefined;
      status?: 'SUCCESS' | 'FAILURE' | undefined;
    },
  ) {
    const inst = await this.own(p);
    const e = await this.eventRow(inst.id, id);
    let q = this.deps.db
      .selectFrom('payment_attempts as a')
      .innerJoin('member_profiles as m', 'm.id', 'a.payer_profile_id')
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'a.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'a.reference',
        'a.status',
        'a.amount_paise',
        'a.attempted_at',
        'a.failure_code',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'c.name as class_name',
        's.name as section_name',
      ])
      .where('a.institution_id', '=', inst.id)
      .where('a.event_ref', '=', id.toLowerCase())
      .where('a.status', 'in', ['SUCCESS', 'FAILURE']);
    if (f.status) q = q.where('a.status', '=', f.status);
    if (f.from) q = q.where('a.attempted_at', '>=', new Date(`${f.from}T00:00:00+05:30`));
    if (f.to)
      q = q.where(
        'a.attempted_at',
        '<',
        new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86_400_000),
      );
    const rows = await q.orderBy('a.id', 'desc').limit(5000).execute();
    const items = rows.map((r) => ({
      reference: r.reference,
      payer: titleCase([r.first_name, r.last_name].filter(Boolean).join(' ')),
      admissionNo: r.admission_no,
      grade: r.class_name ? `${r.class_name} ${r.section_name ?? ''}`.trim() : null,
      amount: toMoneyDto(Number(r.amount_paise)),
      status: r.status,
      failureCode: r.failure_code,
      at: iso(r.attempted_at)!,
    }));
    const ok = rows.filter((r) => r.status === 'SUCCESS');
    return {
      event: { id: id.toLowerCase(), title: e.title },
      totals: {
        paid: ok.length,
        failed: rows.length - ok.length,
        collected: toMoneyDto(ok.reduce((a, r) => a + Number(r.amount_paise), 0)),
      },
      items,
    };
  }

  async reportCsv(
    p: Principal,
    id: string,
    f: { from?: string | undefined; to?: string | undefined },
  ) {
    const r = await this.report(p, id, f);
    const csv = toCsv([
      ['Date', 'Payer', 'Admission no.', 'Class', 'Reference', 'Amount (INR)', 'Status'],
      ...r.items.map((i) => [
        istBusinessDate(new Date(i.at)),
        i.payer,
        i.admissionNo,
        i.grade,
        i.reference,
        i.amount.amount,
        i.status === 'SUCCESS' ? 'Success' : 'Failure',
      ]),
    ]);
    return { csv, filename: `${r.event.title.replace(/[^A-Za-z0-9]+/g, '_')}_payments.csv` };
  }

  // --- FEE-032 / FEE-033 --------------------------------------------------------------------------
  /** The member's profile (or a child's on the account, CR-04) and its current class. */
  private async memberOf(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as en', (j) =>
        j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'en.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select(['m.id', 'm.institution_id', 'c.public_id as class_public_id'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return {
      id: String(m.id),
      institutionId: String(m.institution_id),
      classId: m.class_public_id ? binToUuid(m.class_public_id) : null,
    };
  }

  /** Whether the event's audience includes the member's class (null audience: everyone). */
  static inAudience(audience: unknown, classId: string | null) {
    const ids = parseIds(audience);
    return !ids || (classId !== null && ids.includes(classId));
  }

  async mine(p: Principal, forProfile?: string) {
    const m = await this.memberOf(p, forProfile);
    const today = istBusinessDate(this.now());
    const rows = await this.deps.db
      .selectFrom('events')
      .select(['id', 'audience_class_ids'])
      .where('institution_id', '=', m.institutionId)
      .where('status', '=', 'ACTIVE')
      .where('end_date', '>=', today)
      .orderBy('start_date')
      .execute();
    const mineRows = rows.filter((r) => EventsService.inAudience(r.audience_class_ids, m.classId));
    const items = await this.view(m.institutionId, mineRows);
    const paid = await this.deps.db
      .selectFrom('payment_attempts')
      .select(['event_ref', 'reference'])
      .where('payer_profile_id', '=', m.id)
      .where('channel', '=', 'EVENT')
      .where('status', '=', 'SUCCESS')
      .execute();
    const paidRef = new Map(paid.map((x) => [x.event_ref, x.reference]));
    return {
      items: items.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        startDate: e.startDate,
        endDate: e.endDate,
        heads: e.heads,
        total: e.total,
        open: e.startDate <= today && today <= e.endDate,
        paid: paidRef.has(e.id),
        receipt: paidRef.get(e.id) ?? null,
      })),
    };
  }

  async detail(p: Principal, id: string, forProfile?: string) {
    const out = await this.mine(p, forProfile);
    const e = out.items.find((x) => x.id === id.toLowerCase());
    if (!e) throw new NotFoundError();
    return e;
  }

  /** The event a member pays (PAY-002 with eventId): theirs to pay, with its payee and period. */
  async payable(institutionId: string, payerProfileId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const e = await this.deps.db
      .selectFrom('events')
      .selectAll()
      .where('institution_id', '=', institutionId)
      .where('public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!e) throw new NotFoundError();
    const cls = await this.deps.db
      .selectFrom('enrolments as en')
      .innerJoin('academic_years as y', (j) =>
        j.onRef('y.id', '=', 'en.year_id').on('y.is_current', '=', 1),
      )
      .innerJoin('sections as s', 's.id', 'en.section_id')
      .innerJoin('classes as c', 'c.id', 's.class_id')
      .select('c.public_id')
      .where('en.student_profile_id', '=', payerProfileId)
      .executeTakeFirst();
    if (!EventsService.inAudience(e.audience_class_ids, cls ? binToUuid(cls.public_id) : null)) {
      throw new CustomAPIError(409, 'FEE.EVENT_NOT_FOR_YOU');
    }
    return {
      publicId: id.toLowerCase(),
      payeeProfileId: String(e.merchant_profile_id),
      totalPaise: Number(e.total_paise),
      active: e.status === 'ACTIVE',
      startDate: day(e.start_date),
      endDate: day(e.end_date),
      title: e.title,
    };
  }

  // --- job event-status (13.16) -------------------------------------------------------------------
  /** Deactivates the Active events whose end date has passed (OI-FEE-14), per institution. */
  async deactivateEnded(ctx: Pick<JobContext, 'item' | 'periodKey'>) {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    const due = await this.deps.db
      .selectFrom('events')
      .select(['institution_id', sql<number>`COUNT(*)`.as('n')])
      .where('status', '=', 'ACTIVE')
      .where('end_date', '<', today)
      .groupBy('institution_id')
      .execute();
    let total = 0;
    for (const d of due) {
      const res = await this.deps.db
        .updateTable('events')
        .set({
          status: 'INACTIVE',
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('institution_id', '=', String(d.institution_id))
        .where('status', '=', 'ACTIVE')
        .where('end_date', '<', today)
        .executeTakeFirst();
      const n = Number(res.numUpdatedRows);
      total += n;
      ctx.item({
        institutionId: String(d.institution_id),
        status: 'SUCCESS',
        processed: n,
        failed: 0,
        note: `${n} event${n === 1 ? '' : 's'} closed after the end date`,
      });
    }
    return { deactivated: total };
  }
}
