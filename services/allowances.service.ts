/**
 * Allowances (SRS 10; ALW-001…005 and the job allowance-cycle; prototype c.allowances, m.allowance).
 *
 * - Issuing (ALW-003): the console gives active students an amount from the 1st of a coming month to
 *   an expiry date, with optional daily limits. One allowance per student at a time (BR-40): a
 *   student's grants don't overlap, checked under the allowance wallet's row lock. Per-student
 *   results list what was created, what was a duplicate and what was refused (OI-ALW-04); the
 *   request is one transaction.
 * - No money moves at issue. The 00:05 job (10.6) first expires the grants that end today — the
 *   unspent balance goes back to the institution's allowance funding account (ALLOWANCE_EXPIRY) and
 *   the grant becomes Inactive — then credits the grants that start today (ALLOWANCE_CREDIT) and
 *   activates the allowance wallet (RC-02). Each step posts once per grant (idempotency key), so a
 *   re-run or a catch-up after missed days changes nothing twice; a failing grant is reported and
 *   the others still run (OI-ALW-08).
 * - Paying is the payment engine's (10.7, instrument ALLOWANCE): PIN, pending guard, daily limits.
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import type { JobContext } from '../schedulers';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { formatInr, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { retryOnLock } from '../utils/retry';
import { recordAudit } from './audit.service';
import type { LedgerService } from './ledger.service';
import { notify } from './notifications.service';
import { defaultValues, type SettingValues } from './settings.service';
import { usesProfile } from './member-roles';

type GrantState = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const nameOf = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));

/** What the console shows: issued and not yet credited, in force, expired or cancelled. */
const stateOf = (g: {
  status: string;
  ended_reason: string | null;
  credited_at: Date | null;
}): GrantState =>
  g.status === 'ACTIVE'
    ? g.credited_at
      ? 'ACTIVE'
      : 'SCHEDULED'
    : g.ended_reason === 'CANCELLED'
      ? 'CANCELLED'
      : 'EXPIRED';

/** IST midnight of a business date, as a UTC instant. */
const istStart = (date: string) => new Date(`${date}T00:00:00+05:30`);

export interface IssueInput {
  readonly studentIds: readonly string[];
  readonly name?: string | null | undefined;
  readonly amountPaise: number;
  readonly startDate: string;
  readonly expiryDate: string;
  readonly dailyLimits?:
    { readonly count: number; readonly amountPaise: number } | null | undefined;
}

export class AllowancesService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly ledger: LedgerService;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async setting(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private async featureOn(institutionId: string) {
    const on = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('feature_key', '=', 'allowances')
      .executeTakeFirst();
    return !!on && !!Number(on.enabled);
  }

  // --- ALW-003 ------------------------------------------------------------------------------------
  async issue(p: Principal, input: IssueInput) {
    const inst = await this.own(p);
    if (!(await this.featureOn(inst.id))) throw new CustomAPIError(409, 'ALW.FEATURE_OFF');
    const today = istBusinessDate(this.now());
    const errors: {
      field: string;
      code:
        | 'ALW.START_NOT_FUTURE'
        | 'ALW.START_NOT_FIRST'
        | 'ALW.EXPIRY_BEFORE_START'
        | 'ALW.AMOUNT_RANGE';
    }[] = [];
    if (input.startDate <= today) errors.push({ field: 'startDate', code: 'ALW.START_NOT_FUTURE' });
    else if (!input.startDate.endsWith('-01')) {
      errors.push({ field: 'startDate', code: 'ALW.START_NOT_FIRST' });
    }
    if (input.expiryDate <= input.startDate) {
      errors.push({ field: 'expiryDate', code: 'ALW.EXPIRY_BEFORE_START' });
    }
    const [min, max] = [
      await this.setting(LIMITS.allowanceMinPaise),
      await this.setting(LIMITS.allowanceMaxPaise),
    ];
    if (input.amountPaise < min || input.amountPaise > max) {
      errors.push({ field: 'amount', code: 'ALW.AMOUNT_RANGE' });
    }
    if (errors.length) throw new ValidationError(errors);

    const wanted = [...new Set(input.studentIds.map((x) => x.toLowerCase()))];
    const ids = wanted.filter(isUuid);
    const students = ids.length
      ? await this.deps.db
          .selectFrom('member_profiles as m')
          .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
          .leftJoin('wallets as w', (j) =>
            j.onRef('w.owner_profile_id', '=', 'm.id').on('w.kind', '=', 'ALLOWANCE'),
          )
          .select([
            'm.id',
            'm.public_id',
            'm.status',
            'm.first_name',
            'm.last_name',
            'ut.category',
            'w.id as wallet_id',
          ])
          .where('m.institution_id', '=', inst.id)
          .where('m.public_id', 'in', ids.map(uuidToBin))
          .execute()
      : [];
    const byId = new Map(students.map((s) => [binToUuid(s.public_id), s]));
    const created: { studentId: string; grantId: string; name: string }[] = [];
    const duplicates: { studentId: string; name: string }[] = [];
    const refused: { studentId: string; code: string }[] = [];
    const now = this.now();

    await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        created.length = duplicates.length = refused.length = 0;
        for (const id of wanted) {
          const s = byId.get(id);
          if (!s) {
            refused.push({ studentId: id, code: 'GEN.NOT_FOUND' });
            continue;
          }
          const name = nameOf(s.first_name, s.last_name);
          if (s.category !== 'STUDENT' || s.status !== 'ACTIVE') {
            refused.push({ studentId: id, code: 'ALW.NOT_STUDENT' });
            continue;
          }
          if (!s.wallet_id) {
            refused.push({ studentId: id, code: 'ALW.NO_WALLET' });
            continue;
          }
          // The student's allowance wallet row serialises issuing for that student.
          await trx
            .selectFrom('wallets')
            .select('id')
            .where('id', '=', String(s.wallet_id))
            .forUpdate()
            .executeTakeFirst();
          const overlap = await trx
            .selectFrom('allowance_grants')
            .select('id')
            .where('profile_id', '=', String(s.id))
            .where('status', '=', 'ACTIVE')
            .where('start_date', '<', input.expiryDate)
            .where('expiry_date', '>', input.startDate)
            .executeTakeFirst();
          if (overlap) {
            duplicates.push({ studentId: id, name });
            continue;
          }
          const pub = newPublicIdPair();
          await trx
            .insertInto('allowance_grants')
            .values({
              public_id: pub.bin,
              institution_id: inst.id,
              profile_id: String(s.id),
              wallet_id: String(s.wallet_id),
              name: input.name?.trim() || null,
              amount_paise: input.amountPaise,
              start_date: input.startDate,
              expiry_date: input.expiryDate,
              daily_count_limit: input.dailyLimits?.count ?? null,
              daily_amount_limit_paise: input.dailyLimits?.amountPaise ?? null,
              created_by: this.by(p),
              created_at: now,
              updated_at: now,
            })
            .execute();
          created.push({ studentId: id, grantId: pub.id, name });
        }
        if (created.length) {
          await recordAudit(trx, {
            institutionId: inst.id,
            action: 'ALLOWANCE_ISSUED',
            entityType: 'allowance_grant',
            entityRef: created[0]!.grantId,
            after: {
              grants: created.map((c) => c.grantId),
              amount: formatInr(input.amountPaise),
              startDate: input.startDate,
              expiryDate: input.expiryDate,
              dailyLimits: input.dailyLimits
                ? {
                    count: input.dailyLimits.count,
                    amount: formatInr(input.dailyLimits.amountPaise),
                  }
                : null,
            },
          });
        }
      }),
    );
    return { created, duplicates, refused };
  }

  /** The grants of the institution with the student, class and wallet. */
  private grantsQuery(institutionId: string) {
    return this.deps.db
      .selectFrom('allowance_grants as g')
      .innerJoin('member_profiles as m', 'm.id', 'g.profile_id')
      .innerJoin('wallets as w', 'w.id', 'g.wallet_id')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'g.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').onRef('e.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .leftJoin('platform_accounts as iss', 'iss.public_id', 'g.created_by')
      .select([
        'g.id',
        'g.public_id',
        'g.name',
        'g.amount_paise',
        'g.start_date',
        'g.expiry_date',
        'g.daily_count_limit',
        'g.daily_amount_limit_paise',
        'g.status',
        'g.ended_reason',
        'g.credited_at',
        'g.expired_at',
        'g.expired_paise',
        'g.cancel_reason',
        'g.row_version',
        'g.created_at',
        'g.profile_id',
        'm.public_id as student_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
        'w.wallet_no',
        'w.status as wallet_status',
        'b.available_paise',
        'iss.first_name as issuer_first',
        'iss.last_name as issuer_last',
        'c.name as class_name',
        's.name as section_name',
        'c.public_id as class_public_id',
      ])
      .where('g.institution_id', '=', institutionId);
  }

  private async spentBy(profileIds: readonly string[], from?: Date, to?: Date) {
    if (!profileIds.length) return new Map<string, number>();
    let q = this.deps.db
      .selectFrom('payment_attempts')
      .select(['payer_profile_id', sql<string>`SUM(amount_paise)`.as('paise')])
      .where('payer_profile_id', 'in', [...profileIds])
      .where('instrument', '=', 'ALLOWANCE')
      .where('status', '=', 'SUCCESS');
    if (from) q = q.where('attempted_at', '>=', from);
    if (to) q = q.where('attempted_at', '<', to);
    const rows = await q.groupBy('payer_profile_id').execute();
    return new Map(rows.map((r) => [String(r.payer_profile_id), Number(r.paise)]));
  }

  /** Today's (IST) allowance payments per payer: amount and count. */
  private async todayBy(profileIds: readonly string[]) {
    if (!profileIds.length) return new Map<string, { paise: number; count: number }>();
    const rows = await this.deps.db
      .selectFrom('payment_attempts')
      .select([
        'payer_profile_id',
        sql<string>`SUM(amount_paise)`.as('paise'),
        sql<number>`COUNT(*)`.as('n'),
      ])
      .where('payer_profile_id', 'in', [...profileIds])
      .where('instrument', '=', 'ALLOWANCE')
      .where('status', '=', 'SUCCESS')
      .where('attempted_at', '>=', istStart(istBusinessDate(this.now())))
      .groupBy('payer_profile_id')
      .execute();
    return new Map(
      rows.map((r) => [String(r.payer_profile_id), { paise: Number(r.paise), count: Number(r.n) }]),
    );
  }

  private view(
    g: Awaited<ReturnType<ReturnType<AllowancesService['grantsQuery']>['execute']>>[number],
    spentPaise: number,
    today: { paise: number; count: number } = { paise: 0, count: 0 },
  ) {
    const state = stateOf(g);
    return {
      id: binToUuid(g.public_id),
      student: {
        id: binToUuid(g.student_public_id),
        name: nameOf(g.first_name, g.last_name),
        grade: g.class_name ? `${g.class_name} ${g.section_name ?? ''}`.trim() : null,
        admissionNo: g.admission_no,
      },
      name: g.name,
      amount: toMoneyDto(Number(g.amount_paise)),
      startDate: day(g.start_date),
      expiryDate: day(g.expiry_date),
      dailyLimits:
        g.daily_count_limit !== null || g.daily_amount_limit_paise !== null
          ? {
              count: g.daily_count_limit,
              amount:
                g.daily_amount_limit_paise !== null
                  ? toMoneyDto(Number(g.daily_amount_limit_paise))
                  : null,
            }
          : null,
      status: g.status,
      state,
      walletNo: g.wallet_no,
      walletStatus: g.wallet_status,
      balance: state === 'ACTIVE' ? toMoneyDto(Number(g.available_paise)) : null,
      spent: toMoneyDto(spentPaise),
      today: { spent: toMoneyDto(today.paise), count: today.count },
      issuedBy: g.issuer_first ? { name: nameOf(g.issuer_first, g.issuer_last) } : null,
      issuedAt: iso(g.created_at)!,
      expired: g.expired_paise !== null ? toMoneyDto(Number(g.expired_paise)) : null,
      creditedAt: iso(g.credited_at),
      endedAt: iso(g.expired_at),
      cancelReason: g.cancel_reason,
      version: g.row_version,
    };
  }

  // --- ALW-002 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      state?: GrantState | undefined;
      classId?: string | undefined;
      q?: string | undefined;
    },
  ) {
    const inst = await this.own(p);
    let q = this.grantsQuery(inst.id);
    if (f.state === 'SCHEDULED') {
      q = q.where('g.status', '=', 'ACTIVE').where('g.credited_at', 'is', null);
    } else if (f.state === 'ACTIVE') {
      q = q.where('g.status', '=', 'ACTIVE').where('g.credited_at', 'is not', null);
    } else if (f.state === 'EXPIRED' || f.state === 'CANCELLED') {
      q = q.where('g.status', '=', 'INACTIVE').where('g.ended_reason', '=', f.state);
    }
    if (f.classId && isUuid(f.classId)) q = q.where('c.public_id', '=', uuidToBin(f.classId));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('m.first_name', 'like', like),
          eb('m.last_name', 'like', like),
          eb('m.admission_no', 'like', like),
          eb('g.name', 'like', like),
        ]),
      );
    }
    const rows = await q.orderBy('g.id', 'desc').limit(1000).execute();
    const ids = rows.map((r) => String(r.profile_id));
    const [spent, today] = [await this.spentBy(ids), await this.todayBy(ids)];
    const items = rows.map((r) =>
      this.view(r, spent.get(String(r.profile_id)) ?? 0, today.get(String(r.profile_id))),
    );

    const all = await this.grantsQuery(inst.id).execute();
    const year = istBusinessDate(this.now()).slice(0, 4);
    const kpi = all.map((g) => ({ g, state: stateOf(g) }));
    return {
      items,
      kpis: {
        active: kpi.filter((x) => x.state === 'ACTIVE').length,
        scheduled: kpi.filter((x) => x.state === 'SCHEDULED').length,
        issuedThisYear: toMoneyDto(
          kpi
            .filter((x) => x.state !== 'CANCELLED' && day(x.g.start_date).startsWith(year))
            .reduce((a, x) => a + Number(x.g.amount_paise), 0),
        ),
        balanceHeld: toMoneyDto(
          kpi
            .filter((x) => x.state === 'ACTIVE')
            .reduce((a, x) => a + Number(x.g.available_paise), 0),
        ),
      },
      defaults: {
        dailyCount: await this.setting(LIMITS.allowanceDefaultDailyCount),
        dailyAmount: toMoneyDto(await this.setting(LIMITS.allowanceDefaultDailyAmountPaise)),
      },
    };
  }

  private async grantOf(institutionId: string, grantId: string) {
    if (!isUuid(grantId)) throw new NotFoundError();
    const g = await this.grantsQuery(institutionId)
      .where('g.public_id', '=', uuidToBin(grantId))
      .executeTakeFirst();
    if (!g) throw new NotFoundError();
    return g;
  }

  async get(p: Principal, grantId: string) {
    const inst = await this.own(p);
    const g = await this.grantOf(inst.id, grantId);
    const spent = await this.spentBy([String(g.profile_id)]);
    const today = await this.todayBy([String(g.profile_id)]);
    return this.view(g, spent.get(String(g.profile_id)) ?? 0, today.get(String(g.profile_id)));
  }

  // --- ALW-004 ------------------------------------------------------------------------------------
  async update(
    p: Principal,
    grantId: string,
    expected: number,
    patch: {
      dailyLimits?: { count: number; amountPaise: number } | null | undefined;
      status?: 'INACTIVE' | undefined;
      reason?: string | undefined;
    },
  ) {
    const inst = await this.own(p);
    const g = await this.grantOf(inst.id, grantId);
    if (g.row_version !== expected) throw new PreconditionFailedError();
    const cancel = patch.status === 'INACTIVE';
    // Only an allowance not yet credited can be cancelled (no money to take back, OQ-08).
    if (cancel && stateOf(g) !== 'SCHEDULED') {
      throw new CustomAPIError(409, 'ALW.TRANSITION_INVALID');
    }
    if (!cancel && g.status !== 'ACTIVE') throw new CustomAPIError(409, 'ALW.TRANSITION_INVALID');
    const now = this.now();
    const res = await this.deps.db
      .updateTable('allowance_grants')
      .set({
        ...(patch.dailyLimits !== undefined
          ? {
              daily_count_limit: patch.dailyLimits?.count ?? null,
              daily_amount_limit_paise: patch.dailyLimits?.amountPaise ?? null,
            }
          : {}),
        ...(cancel
          ? {
              status: 'INACTIVE' as const,
              ended_reason: 'CANCELLED' as const,
              expired_at: now,
              cancel_reason: patch.reason?.trim() || null,
            }
          : {}),
        row_version: sql<number>`row_version + 1`,
        updated_at: now,
      })
      .where('id', '=', g.id)
      .where('row_version', '=', expected)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new PreconditionFailedError();
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: cancel ? 'ALLOWANCE_CANCELLED' : 'ALLOWANCE_LIMITS_CHANGED',
      entityType: 'allowance_grant',
      entityRef: grantId.toLowerCase(),
      before: {
        dailyCount: g.daily_count_limit,
        dailyAmountPaise: g.daily_amount_limit_paise,
        state: stateOf(g),
      },
      after: { ...patch },
    });
    return this.get(p, grantId);
  }

  // --- ALW-005 ------------------------------------------------------------------------------------
  async reports(p: Principal, f: { from?: string | undefined; to?: string | undefined }) {
    const inst = await this.own(p);
    const today = istBusinessDate(this.now());
    const to = f.to ?? today;
    const from = f.from ?? istBusinessDate(new Date(istStart(to).getTime() - 13 * 86_400_000));
    const [start, end] = [istStart(from), new Date(istStart(to).getTime() + 86_400_000)];
    const grants = await this.grantsQuery(inst.id).execute();
    const payments = await this.deps.db
      .selectFrom('payment_attempts as a')
      .innerJoin('merchants as mer', 'mer.profile_id', 'a.payee_profile_id')
      .select(['a.payer_profile_id', 'a.amount_paise', 'a.attempted_at', 'mer.display_name'])
      .where('a.institution_id', '=', inst.id)
      .where('a.instrument', '=', 'ALLOWANCE')
      .where('a.status', '=', 'SUCCESS')
      .where('a.attempted_at', '>=', start)
      .where('a.attempted_at', '<', end)
      .execute();
    const credited = grants.filter((g) => g.credited_at !== null);
    const issued = credited.reduce((a, g) => a + Number(g.amount_paise), 0);
    const spent = payments.reduce((a, x) => a + Number(x.amount_paise), 0);
    const expired = grants.reduce((a, g) => a + Number(g.expired_paise ?? 0), 0);
    const scheduled = grants
      .filter((g) => stateOf(g) === 'SCHEDULED')
      .reduce((a, g) => a + Number(g.amount_paise), 0);

    const days: string[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
      days.push(istBusinessDate(new Date(t)));
    }
    const byDay = new Map(days.map((d) => [d, 0]));
    const byMerchant = new Map<string, number>();
    for (const x of payments) {
      const d = istBusinessDate(new Date(x.attempted_at));
      byDay.set(d, (byDay.get(d) ?? 0) + Number(x.amount_paise));
      byMerchant.set(
        x.display_name,
        (byMerchant.get(x.display_name) ?? 0) + Number(x.amount_paise),
      );
    }
    const allSpent = await this.spentBy(credited.map((g) => String(g.profile_id)));
    const perStudent = new Map<
      string,
      {
        student: { id: string; name: string; grade: string | null };
        issued: number;
        spent: number;
        balance: number;
        expired: number;
        cls: string;
      }
    >();
    for (const g of credited) {
      const k = String(g.profile_id);
      const cur = perStudent.get(k) ?? {
        student: {
          id: binToUuid(g.student_public_id),
          name: nameOf(g.first_name, g.last_name),
          grade: g.class_name ? `${g.class_name} ${g.section_name ?? ''}`.trim() : null,
        },
        issued: 0,
        spent: allSpent.get(k) ?? 0,
        balance: stateOf(g) === 'ACTIVE' ? Number(g.available_paise) : 0,
        expired: 0,
        cls: g.class_name ?? '—',
      };
      cur.issued += Number(g.amount_paise);
      cur.expired += Number(g.expired_paise ?? 0);
      if (stateOf(g) === 'ACTIVE') cur.balance = Number(g.available_paise);
      perStudent.set(k, cur);
    }
    const byClass = new Map<string, { issued: number; spent: number }>();
    for (const s of perStudent.values()) {
      const c = byClass.get(s.cls) ?? { issued: 0, spent: 0 };
      c.issued += s.issued;
      c.spent += s.spent;
      byClass.set(s.cls, c);
    }
    return {
      from,
      to,
      kpis: {
        issued: toMoneyDto(issued),
        spent: toMoneyDto(spent),
        expired: toMoneyDto(expired),
        scheduled: toMoneyDto(scheduled),
      },
      byDay: days.map((d) => ({ date: d, spent: toMoneyDto(byDay.get(d) ?? 0) })),
      byMerchant: [...byMerchant]
        .sort((a, b) => b[1] - a[1])
        .map(([merchant, v]) => ({ merchant, spent: toMoneyDto(v) })),
      byClass: [...byClass]
        .sort((a, b) => b[1].issued - a[1].issued)
        .map(([cls, v]) => ({
          class: cls,
          issued: toMoneyDto(v.issued),
          spent: toMoneyDto(v.spent),
        })),
      perStudent: [...perStudent.values()]
        .sort((a, b) => a.student.name.localeCompare(b.student.name))
        .map((s) => ({
          student: s.student,
          issued: toMoneyDto(s.issued),
          spent: toMoneyDto(s.spent),
          balance: toMoneyDto(s.balance),
          expired: toMoneyDto(s.expired),
        })),
    };
  }

  // --- ALW-001 ------------------------------------------------------------------------------------
  /** The member's allowance (or a child's with `for`, CR-04): balance, limits, today, history. */
  async mine(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const db = this.deps.db;
    const m = await db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .select(['m.id', 'm.institution_id', 'm.first_name', 'm.last_name'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    const w = await db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select(['w.id', 'w.wallet_no', 'w.status', 'b.available_paise'])
      .where('w.owner_profile_id', '=', m.id)
      .where('w.kind', '=', 'ALLOWANCE')
      .executeTakeFirst();
    // The grant in force, else the next one scheduled, else the latest.
    const grants = await db
      .selectFrom('allowance_grants')
      .selectAll()
      .where('profile_id', '=', m.id)
      .orderBy('start_date', 'desc')
      .limit(12)
      .execute();
    const live = grants.filter((g) => g.status === 'ACTIVE');
    const grant =
      live.find((g) => g.credited_at !== null) ??
      [...live].sort((a, b) => day(a.start_date).localeCompare(day(b.start_date)))[0] ??
      grants[0] ??
      null;
    const now = this.now();
    const todayStart = istStart(istBusinessDate(now));
    const [todayRows, periodRows] = await Promise.all([
      this.spentBy([String(m.id)], todayStart),
      grant?.credited_at ? this.spentBy([String(m.id)], new Date(grant.credited_at)) : null,
    ]);
    const todayCount = Number(
      (
        await db
          .selectFrom('payment_attempts')
          .select(sql<number>`COUNT(*)`.as('n'))
          .where('payer_profile_id', '=', m.id)
          .where('instrument', '=', 'ALLOWANCE')
          .where('status', '=', 'SUCCESS')
          .where('attempted_at', '>=', todayStart)
          .executeTakeFirst()
      )?.n ?? 0,
    );
    const spentToday = todayRows.get(String(m.id)) ?? 0;
    const limits =
      grant &&
      grant.status === 'ACTIVE' &&
      (grant.daily_count_limit !== null || grant.daily_amount_limit_paise !== null)
        ? {
            count: grant.daily_count_limit,
            amount:
              grant.daily_amount_limit_paise !== null
                ? Number(grant.daily_amount_limit_paise)
                : null,
          }
        : null;
    const merchants = await db
      .selectFrom('merchants as mer')
      .innerJoin('member_profiles as mp', 'mp.id', 'mer.profile_id')
      .select(['mp.public_id', 'mer.display_name'])
      .where('mp.institution_id', '=', m.institution_id)
      .where('mp.status', '=', 'ACTIVE')
      .where('mer.sub_type', '=', 'REGULAR')
      .where('mer.accepts_allowance', '=', 1)
      .orderBy('mer.display_name')
      .execute();
    const history = w
      ? await db
          .selectFrom('ledger_entries as e')
          .innerJoin('ledger_transactions as t', (j) =>
            j.onRef('t.id', '=', 'e.ledger_txn_id').onRef('t.posted_on', '=', 'e.posted_on'),
          )
          .select(['e.direction', 'e.amount_paise', 't.reference', 't.type', 't.posted_at'])
          .where('e.wallet_id', '=', String(w.id))
          .orderBy('e.id', 'desc')
          .limit(20)
          .execute()
      : [];
    const refs = history.filter((h) => h.type === 'ALLOWANCE_PAYMENT').map((h) => h.reference);
    const payees = refs.length
      ? await db
          .selectFrom('payment_attempts as a')
          .innerJoin('merchants as mer', 'mer.profile_id', 'a.payee_profile_id')
          .select(['a.reference', 'mer.display_name'])
          .where('a.reference', 'in', refs)
          .execute()
      : [];
    const payee = new Map(payees.map((x) => [x.reference, x.display_name]));
    return {
      profile: { id: wanted.toLowerCase(), name: nameOf(m.first_name, m.last_name) },
      wallet: w
        ? {
            walletNo: w.wallet_no,
            status: w.status,
            balance: toMoneyDto(Number(w.available_paise)),
          }
        : null,
      grant: grant
        ? {
            id: binToUuid(grant.public_id),
            name: grant.name,
            amount: toMoneyDto(Number(grant.amount_paise)),
            startDate: day(grant.start_date),
            expiryDate: day(grant.expiry_date),
            state: stateOf(grant),
            creditedAt: iso(grant.credited_at),
          }
        : null,
      limits: limits
        ? {
            count: limits.count,
            amount: limits.amount !== null ? toMoneyDto(limits.amount) : null,
          }
        : null,
      today: {
        count: todayCount,
        spent: toMoneyDto(spentToday),
        countLeft: limits?.count != null ? Math.max(0, limits.count - todayCount) : null,
        amountLeft:
          limits?.amount != null ? toMoneyDto(Math.max(0, limits.amount - spentToday)) : null,
      },
      periodSpent: toMoneyDto(periodRows?.get(String(m.id)) ?? 0),
      merchants: merchants.map((x) => ({ id: binToUuid(x.public_id), name: x.display_name })),
      history: history.map((h) => ({
        kind:
          h.type === 'ALLOWANCE_CREDIT'
            ? ('CREDIT' as const)
            : h.type === 'ALLOWANCE_EXPIRY'
              ? ('EXPIRY' as const)
              : ('PAYMENT' as const),
        reference: h.reference,
        title:
          h.type === 'ALLOWANCE_PAYMENT'
            ? (payee.get(h.reference) ?? 'Allowance payment')
            : h.type === 'ALLOWANCE_CREDIT'
              ? 'Allowance credited'
              : 'Allowance lapsed',
        amount: toMoneyDto(Number(h.amount_paise)),
        direction: h.direction === 'C' ? ('IN' as const) : ('OUT' as const),
        at: iso(h.posted_at)!,
      })),
    };
  }

  // --- job allowance-cycle (10.6) -----------------------------------------------------------------
  /**
   * Expires, then credits, for the run date (IST). A missed day is caught up: every grant whose
   * expiry date or start date is on or before the date and that is still open is processed. Each
   * grant is its own transaction and posts once (ALW-EXPIRY:<grant> / ALW-CREDIT:<grant>).
   */
  async runCycle(ctx: Pick<JobContext, 'item' | 'periodKey'>) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    const db = this.deps.db;
    const tally = new Map<string, { expired: number; credited: number; failed: number }>();
    const bump = (inst: string, k: 'expired' | 'credited' | 'failed') => {
      const t = tally.get(inst) ?? { expired: 0, credited: 0, failed: 0 };
      t[k] += 1;
      tally.set(inst, t);
    };

    const ending = await db
      .selectFrom('allowance_grants')
      .select(['id', 'institution_id'])
      .where('status', '=', 'ACTIVE')
      .where('expiry_date', '<=', date)
      .orderBy('id')
      .execute();
    for (const g of ending) {
      try {
        if (await this.expireOne(String(g.id), date)) bump(String(g.institution_id), 'expired');
      } catch {
        bump(String(g.institution_id), 'failed');
      }
    }

    const starting = await db
      .selectFrom('allowance_grants')
      .select(['id', 'institution_id'])
      .where('status', '=', 'ACTIVE')
      .where('credited_at', 'is', null)
      .where('start_date', '<=', date)
      .where('expiry_date', '>', date)
      .orderBy('id')
      .execute();
    for (const g of starting) {
      try {
        if (await this.creditOne(String(g.id), date)) bump(String(g.institution_id), 'credited');
      } catch {
        bump(String(g.institution_id), 'failed');
      }
    }

    for (const [institutionId, t] of tally) {
      ctx.item({
        institutionId,
        status: t.failed ? 'FAILED' : 'SUCCESS',
        processed: t.expired + t.credited,
        failed: t.failed,
        note: `${t.credited} credited · ${t.expired} expired${t.failed ? ` · ${t.failed} failed` : ''}`,
        ...(t.failed ? { errorCode: 'ALW.CYCLE_FAILED' } : {}),
      });
    }
    return {
      credited: [...tally.values()].reduce((a, t) => a + t.credited, 0),
      expired: [...tally.values()].reduce((a, t) => a + t.expired, 0),
      failed: [...tally.values()].reduce((a, t) => a + t.failed, 0),
    };
  }

  /** The grant's holder and guardians (for the notices). */
  private async audience(trx: Transaction<Database>, profileId: string) {
    const m = await trx
      .selectFrom('member_profiles')
      .select(['account_id', 'first_name', 'last_name'])
      .where('id', '=', profileId)
      .executeTakeFirstOrThrow();
    const guardians = await trx
      .selectFrom('guardianships as g')
      .innerJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
      .select('gm.account_id')
      .where('g.ward_profile_id', '=', profileId)
      .where('gm.account_id', 'is not', null)
      .execute();
    return {
      name: nameOf(m.first_name, m.last_name),
      accounts: [m.account_id, ...guardians.map((g) => g.account_id)].filter(
        (a): a is string => a !== null && a !== undefined,
      ),
    };
  }

  private async creditOne(grantId: string, date: string) {
    return retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const g = await trx
          .selectFrom('allowance_grants')
          .selectAll()
          .where('id', '=', grantId)
          .forUpdate()
          .executeTakeFirst();
        if (!g || g.status !== 'ACTIVE' || g.credited_at !== null) return false;
        const at = this.now();
        const posted = await this.deps.ledger.post(trx, {
          institutionId: String(g.institution_id),
          type: 'ALLOWANCE_CREDIT',
          channel: 'JOB',
          amountPaise: Number(g.amount_paise),
          idempotencyKey: `ALW-CREDIT:${g.id}`,
          debit: { account: 'ALLOWANCE_FUNDING', institutionId: String(g.institution_id) },
          credit: { walletId: String(g.wallet_id) },
          narration: g.name ? `Allowance: ${g.name}` : 'Allowance credited',
          businessRef: { type: 'allowance_grant', id: String(g.id) },
          at,
        });
        // RC-02: the allowance wallet becomes Active with its first credit.
        await trx
          .updateTable('wallets')
          .set({ status: 'ACTIVE' })
          .where('id', '=', String(g.wallet_id))
          .where('status', '=', 'INACTIVE')
          .execute();
        await trx
          .updateTable('allowance_grants')
          .set({
            credited_at: at,
            credit_txn_id: posted.txnId,
            row_version: sql<number>`row_version + 1`,
            updated_at: at,
          })
          .where('id', '=', g.id)
          .execute();
        const who = await this.audience(trx, String(g.profile_id));
        await notify(
          trx,
          {
            institutionId: String(g.institution_id),
            accountIds: who.accounts,
            surface: 'MEMBER',
            category: 'PAYMENT',
            titleKey: 'NTF.ALLOWANCE_CREDITED',
            params: { amount: formatInr(Number(g.amount_paise)), name: who.name },
            body: posted.reference,
            link: '/allowance',
          },
          at,
        );
        await recordAudit(trx, {
          institutionId: String(g.institution_id),
          action: 'ALLOWANCE_CREDITED',
          entityType: 'allowance_grant',
          entityRef: binToUuid(g.public_id),
          after: { reference: posted.reference, runDate: date },
          actor: { type: 'system', ref: 'allowance-cycle' },
        });
        return true;
      }),
    );
  }

  private async expireOne(grantId: string, date: string) {
    return retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const g = await trx
          .selectFrom('allowance_grants')
          .selectAll()
          .where('id', '=', grantId)
          .forUpdate()
          .executeTakeFirst();
        if (!g || g.status !== 'ACTIVE') return false;
        const at = this.now();
        let expiredPaise = 0;
        let txnId: string | null = null;
        let reference: string | null = null;
        if (g.credited_at !== null) {
          const b = await trx
            .selectFrom('wallet_balances')
            .select('available_paise')
            .where('wallet_id', '=', String(g.wallet_id))
            .forUpdate()
            .executeTakeFirstOrThrow();
          expiredPaise = Number(b.available_paise);
          if (expiredPaise > 0) {
            const posted = await this.deps.ledger.post(trx, {
              institutionId: String(g.institution_id),
              type: 'ALLOWANCE_EXPIRY',
              channel: 'JOB',
              amountPaise: expiredPaise,
              idempotencyKey: `ALW-EXPIRY:${g.id}`,
              debit: { walletId: String(g.wallet_id) },
              credit: { account: 'ALLOWANCE_FUNDING', institutionId: String(g.institution_id) },
              narration: 'Allowance lapsed',
              businessRef: { type: 'allowance_grant', id: String(g.id) },
              at,
            });
            txnId = posted.txnId;
            reference = posted.reference;
          }
        }
        // The definition ends (Q14 M13 recommendation); the wallet stays as it is (10.6).
        await trx
          .updateTable('allowance_grants')
          .set({
            status: 'INACTIVE',
            ended_reason: 'EXPIRED',
            expired_at: at,
            expired_paise: expiredPaise,
            expiry_txn_id: txnId,
            row_version: sql<number>`row_version + 1`,
            updated_at: at,
          })
          .where('id', '=', g.id)
          .execute();
        if (g.credited_at !== null) {
          const who = await this.audience(trx, String(g.profile_id));
          await notify(
            trx,
            {
              institutionId: String(g.institution_id),
              accountIds: who.accounts,
              surface: 'MEMBER',
              category: 'PAYMENT',
              titleKey: 'NTF.ALLOWANCE_EXPIRED',
              params: { amount: formatInr(expiredPaise), name: who.name },
              body: reference ?? '',
              link: '/allowance',
            },
            at,
          );
        }
        await recordAudit(trx, {
          institutionId: String(g.institution_id),
          action: 'ALLOWANCE_EXPIRED',
          entityType: 'allowance_grant',
          entityRef: binToUuid(g.public_id),
          after: { expired: formatInr(expiredPaise), reference, runDate: date },
          actor: { type: 'system', ref: 'allowance-cycle' },
        });
        return true;
      }),
    );
  }
}
