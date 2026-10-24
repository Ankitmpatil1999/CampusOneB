/**
 * Fee notices to the student and parents (client 2026-10-16, as the earlier application's
 * TUTION_FEE_ASSIGNED and FEE_ALERT): in the app, and by e-mail and the phone alert when the school's
 * "Fee assigned" / "Fee due reminder" events are on (comm-events).
 *
 * - Fee assigned: when a structure is assigned, a fee is added by hand or a fee sheet is committed —
 *   one notice per student with the total added.
 * - Fee due (job `fee-reminders`, 09:00 IST): an unpaid instalment `fee.reminder.daysBefore` days
 *   before its due date and on the due date itself; `reminded_on` keeps a re-run from sending twice.
 */
import type { Kysely, Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import type { JobContext } from '../schedulers';
import { formatDate, formatInr, istBusinessDate } from '../utils/format';
import { notify } from './notifications.service';
import { defaultValues, type SettingValues } from './settings.service';

type Db = Kysely<Database> | Transaction<Database>;

/** The student's account and their guardians' accounts, per student. */
export async function familyAccountsByStudent(db: Db, studentRowIds: readonly string[]) {
  const out = new Map<string, string[]>();
  if (!studentRowIds.length) return out;
  const rows = await db
    .selectFrom('member_profiles as m')
    .leftJoin('guardianships as g', 'g.ward_profile_id', 'm.id')
    .leftJoin('member_profiles as gm', 'gm.id', 'g.guardian_profile_id')
    .select(['m.id', 'm.account_id', 'm.own_account_id', 'gm.account_id as guardian_account'])
    .where('m.id', 'in', studentRowIds as string[])
    .execute();
  for (const r of rows) {
    const list = out.get(String(r.id)) ?? [];
    for (const a of [r.account_id, r.own_account_id, r.guardian_account]) {
      if (a !== null && a !== undefined && !list.includes(String(a))) list.push(String(a));
    }
    out.set(String(r.id), list);
  }
  return out;
}

const fullName = (r: { first_name: string; last_name: string | null }) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ');

/** "Fee of ₹… assigned to … for 2026-27" to each student (amounts in paise) and their parents. */
export async function notifyFeeAssigned(
  db: Db,
  institutionId: string,
  yearId: string,
  totals: ReadonlyMap<string, number>,
  at: Date,
) {
  const ids = [...totals.keys()];
  if (!ids.length) return;
  const [year, people, families] = await Promise.all([
    db.selectFrom('academic_years').select('label').where('id', '=', yearId).executeTakeFirst(),
    db
      .selectFrom('member_profiles')
      .select(['id', 'first_name', 'last_name'])
      .where('id', 'in', ids)
      .execute(),
    familyAccountsByStudent(db, ids),
  ]);
  for (const p of people) {
    const accounts = families.get(String(p.id)) ?? [];
    const paise = totals.get(String(p.id)) ?? 0;
    if (paise <= 0) continue;
    const params = { amount: formatInr(paise), name: fullName(p), year: year?.label ?? '' };
    await notify(
      db,
      {
        institutionId,
        accountIds: accounts,
        surface: 'MEMBER',
        category: 'PAYMENT',
        titleKey: 'NTF.FEE_ASSIGNED',
        params,
        about: [String(p.id)],
        body: `The fee of ${params.amount} for ${params.year} is in the app under Fees, with each instalment and its due date.`,
        link: '/fees',
      },
      at,
    );
  }
}

export class FeeNoticesService {
  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      settings?: { values(): Promise<SettingValues> };
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async daysBefore() {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[LIMITS.feeReminderDaysBefore.key] ?? LIMITS.feeReminderDaysBefore.value);
  }

  /** Job `fee-reminders`: today's reminders (the run's IST business date). */
  async run(ctx: Pick<JobContext, 'periodKey' | 'item' | 'scope'>) {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    const ahead = await this.daysBefore();
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + ahead);
    const dates = [...new Set([today, soon.toISOString().slice(0, 10)])];
    let q = this.deps.db
      .selectFrom('fee_records as r')
      .innerJoin('member_profiles as m', 'm.id', 'r.student_profile_id')
      .select([
        'r.id',
        'r.institution_id',
        'r.student_profile_id',
        'r.label',
        'r.due_date',
        'r.amount_paise',
        'r.paid_paise',
        'm.first_name',
        'm.last_name',
      ])
      .where('r.status', 'in', ['DUE', 'PARTIALLY_PAID'])
      .where('r.financed', '=', 0)
      .where('r.due_date', 'in', dates)
      .where((eb) => eb.or([eb('r.reminded_on', 'is', null), eb('r.reminded_on', '<', today)]))
      .orderBy('r.id');
    if (ctx.scope) q = q.where('r.institution_id', '=', ctx.scope.institutionId);
    const due = await q.execute();
    const tally = new Map<string, { sent: number; failed: number }>();
    for (const r of due) {
      const inst = String(r.institution_id);
      const t = tally.get(inst) ?? { sent: 0, failed: 0 };
      try {
        await this.deps.db.transaction().execute(async (trx) => {
          // Guarded: another run the same day reminds nothing twice.
          const claimed = await trx
            .updateTable('fee_records')
            .set({ reminded_on: today })
            .where('id', '=', r.id)
            .where((eb) => eb.or([eb('reminded_on', 'is', null), eb('reminded_on', '<', today)]))
            .executeTakeFirst();
          if (Number(claimed.numUpdatedRows) !== 1) return;
          const accounts =
            (await familyAccountsByStudent(trx, [String(r.student_profile_id)])).get(
              String(r.student_profile_id),
            ) ?? [];
          const left = Math.max(0, Number(r.amount_paise) - Number(r.paid_paise));
          const params = {
            label: r.label,
            amount: formatInr(left),
            name: fullName(r),
            date: formatDate(r.due_date),
          };
          await notify(
            trx,
            {
              institutionId: inst,
              accountIds: accounts,
              surface: 'MEMBER',
              category: 'PAYMENT',
              titleKey: 'NTF.FEE_DUE',
              params,
              about: [String(r.student_profile_id)],
              body: `Please pay ${params.amount} for ${params.name} by ${params.date} to avoid a late fine. You can pay in the app under Fees.`,
              link: '/fees',
            },
            this.now(),
          );
        });
        t.sent++;
      } catch {
        t.failed++;
      }
      tally.set(inst, t);
    }
    for (const [institutionId, t] of tally) {
      ctx.item({
        institutionId,
        status: t.failed ? 'FAILED' : 'SUCCESS',
        processed: t.sent,
        failed: t.failed,
        note: `${t.sent} fee reminder${t.sent === 1 ? '' : 's'} sent`,
      });
    }
    return { reminded: [...tally.values()].reduce((a, t) => a + t.sent, 0) };
  }
}
