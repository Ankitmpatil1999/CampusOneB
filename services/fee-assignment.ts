/**
 * Fee structure assignment (FEE-007; client 2026-10-16: an approved structure reaches the students
 * of its classes on its own). A student gets one assignment for the year and a record for each
 * instalment still to come (due today or later), with the structure's mandatory heads and the
 * optional heads chosen for them.
 *
 * Three ways in, one rule:
 * - the "Assign" button (FeesService.assign), for the classes chosen;
 * - the approval of a structure: every active student of its classes (assignVersion);
 * - a student placed in one of its classes later — onboarding, an admission, the Enrolment page, a
 *   roll-over, a class change (assignStudent).
 * A student already assigned for the year keeps that assignment (one live assignment per student and
 * year, fee_assignments.live_key).
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { istBusinessDate } from '../utils/format';
import { binToUuid, newPublicIdPair } from '../utils/idGenerator';
import { recordAudit } from './audit.service';
import { notifyFeeAssigned } from './fee-notices.service';

/** A transaction (the callers' own, so the assignment commits with what placed the student). */
type Db = Kysely<Database> | Transaction<Database>;

/**
 * A head's part of each instalment: whole rupees by share, the remainder on the last (RNG-FEE-164).
 * The parts always add up to the head's amount.
 */
export function headParts(amountPaise: number, sharesBp: readonly number[]): number[] {
  const parts = sharesBp.map((bp) => Math.floor((amountPaise * bp) / 1_000_000) * 100);
  const last = parts.length - 1;
  parts[last] = amountPaise - parts.slice(0, last).reduce((a, b) => a + b, 0);
  return parts;
}

/** What an approved version raises for a student. */
export interface AssignPlan {
  readonly institutionId: string;
  readonly yearId: string;
  readonly structureId: string;
  readonly structurePublicId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly lateFinePaise: number;
  /** Every instalment; `raised` when it is due on the day or later. */
  readonly instalments: readonly {
    readonly seq: number;
    readonly label: string;
    readonly due: string;
    readonly raised: boolean;
  }[];
  /** The heads in order, each split by the instalments' shares. */
  readonly heads: readonly {
    readonly headId: string;
    readonly publicId: string;
    readonly name: string;
    readonly optional: boolean;
    readonly parts: readonly number[];
  }[];
  /** The classes the version is for (row ids). */
  readonly classIds: readonly string[];
}

/** The plan of a version as of `today` (YYYY-MM-DD, IST); null when there is no such version. */
export async function assignPlan(
  db: Db,
  versionId: string,
  today: string,
): Promise<AssignPlan | null> {
  const v = await db
    .selectFrom('fee_structure_versions as v')
    .innerJoin('fee_structures as s', 's.id', 'v.structure_id')
    .select([
      'v.id',
      'v.version_no',
      'v.late_fine_paise',
      'v.institution_id',
      'v.structure_id',
      's.year_id',
      's.public_id as structure_public_id',
    ])
    .where('v.id', '=', versionId)
    .executeTakeFirst();
  if (!v) return null;
  const [instalments, heads, classes] = await Promise.all([
    db
      .selectFrom('fee_structure_instalments')
      .selectAll()
      .where('version_id', '=', versionId)
      .orderBy('seq')
      .execute(),
    db
      .selectFrom('fee_structure_heads as sh')
      .innerJoin('fee_heads as h', 'h.id', 'sh.head_id')
      .select(['sh.head_id', 'h.public_id', 'h.name', 'sh.optional', 'sh.amount_paise'])
      .where('sh.version_id', '=', versionId)
      .orderBy('sh.sort_order')
      .execute(),
    db
      .selectFrom('fee_structure_classes')
      .select('class_id')
      .where('version_id', '=', versionId)
      .execute(),
  ]);
  const shares = instalments.map((x) => x.share_bp);
  const due = (x: { due_date: Date | string }) => istBusinessDate(new Date(x.due_date));
  return {
    institutionId: String(v.institution_id),
    yearId: String(v.year_id),
    structureId: String(v.structure_id),
    structurePublicId: binToUuid(v.structure_public_id),
    versionId: String(v.id),
    versionNo: v.version_no,
    lateFinePaise: Number(v.late_fine_paise),
    instalments: instalments.map((x) => ({
      seq: x.seq,
      label: x.label,
      due: due(x),
      raised: due(x) >= today,
    })),
    heads: heads.map((h) => ({
      headId: String(h.head_id),
      publicId: binToUuid(h.public_id),
      name: h.name,
      optional: !!Number(h.optional),
      parts: headParts(Number(h.amount_paise), shares),
    })),
    classIds: classes.map((c) => String(c.class_id)),
  };
}

/** A student's records: each raised instalment with the mandatory heads and the optional ones taken. */
export function priceFor(plan: AssignPlan, opted: ReadonlySet<string> = new Set()) {
  const taken = plan.heads.filter((h) => !h.optional || opted.has(h.publicId));
  return plan.instalments.flatMap((x, idx) => {
    if (!x.raised) return [];
    const lines = taken.map((h) => ({ head: h, amount: h.parts[idx]! }));
    return [{ x, lines, amount: lines.reduce((a, l) => a + l.amount, 0) }];
  });
}

/**
 * Assigns the students and raises their records; one already assigned for the year (meanwhile, too)
 * is passed over. `opted` holds the public ids of the optional heads a student takes. The student and
 * their parents are told what was raised (client 2026-10-16: in the app, and by e-mail).
 */
export async function raiseFor(
  trx: Db,
  plan: AssignPlan,
  students: readonly { readonly rowId: string; readonly opted?: readonly string[] }[],
  who: { readonly by: Buffer | null; readonly at: Date },
) {
  let assigned = 0;
  let created = 0;
  const totals = new Map<string, number>();
  for (const st of students) {
    const opted = [...(st.opted ?? [])];
    let assignmentId: string;
    try {
      const a = await trx
        .insertInto('fee_assignments')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: plan.institutionId,
          year_id: plan.yearId,
          student_profile_id: st.rowId,
          structure_id: plan.structureId,
          version_id: plan.versionId,
          optional_heads: opted.length ? JSON.stringify(opted) : null,
          assigned_by: who.by,
          assigned_at: who.at,
        })
        .executeTakeFirstOrThrow();
      assignmentId = String(a.insertId);
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062) continue; // assigned meanwhile
      throw e;
    }
    assigned++;
    for (const r of priceFor(plan, new Set(opted))) {
      const rec = await trx
        .insertInto('fee_records')
        .values({
          public_id: newPublicIdPair().bin,
          institution_id: plan.institutionId,
          year_id: plan.yearId,
          student_profile_id: st.rowId,
          source: 'STRUCTURE',
          assignment_id: assignmentId,
          version_id: plan.versionId,
          instalment_seq: r.x.seq,
          label: r.x.label,
          due_date: r.x.due,
          amount_paise: r.amount,
          late_fine_paise: plan.lateFinePaise,
          created_by: who.by,
          created_at: who.at,
          updated_at: who.at,
        })
        .executeTakeFirstOrThrow();
      if (r.lines.length) {
        await trx
          .insertInto('fee_record_heads')
          .values(
            r.lines.map((l) => ({
              record_id: String(rec.insertId),
              head_id: l.head.headId,
              name: l.head.name,
              amount_paise: l.amount,
            })),
          )
          .execute();
      }
      created++;
      totals.set(st.rowId, (totals.get(st.rowId) ?? 0) + Number(r.amount));
    }
  }
  await notifyFeeAssigned(trx, plan.institutionId, plan.yearId, totals, who.at);
  return { assigned, created };
}

/** Active students enrolled for the year in the classes, not yet assigned for it (row ids). */
async function unassigned(
  db: Db,
  institutionId: string,
  yearId: string,
  classIds: readonly string[],
  studentId?: string,
) {
  if (!classIds.length) return [];
  let q = db
    .selectFrom('enrolments as e')
    .innerJoin('sections as sec', 'sec.id', 'e.section_id')
    .innerJoin('member_profiles as m', 'm.id', 'e.student_profile_id')
    .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
    .leftJoin('fee_assignments as fa', (j) =>
      j
        .onRef('fa.student_profile_id', '=', 'm.id')
        .onRef('fa.year_id', '=', 'e.year_id')
        .on('fa.status', '=', 'ACTIVE'),
    )
    .select('m.id')
    .where('e.institution_id', '=', institutionId)
    .where('e.year_id', '=', yearId)
    .where('sec.class_id', 'in', [...classIds])
    .where('m.status', '=', 'ACTIVE')
    .where('ut.category', '=', 'STUDENT')
    .where('fa.id', 'is', null);
  if (studentId) q = q.where('m.id', '=', studentId);
  return (await q.execute()).map((r) => String(r.id));
}

/**
 * On approval (applyApproved): every active student of the version's classes in its year who has no
 * assignment for the year is assigned (client 2026-10-16).
 */
export async function assignVersion(
  trx: Db,
  versionId: string,
  who: { readonly by: Buffer | null; readonly at: Date },
) {
  const plan = await assignPlan(trx, versionId, istBusinessDate(who.at));
  if (!plan) return { assigned: 0, created: 0 };
  const students = await unassigned(trx, plan.institutionId, plan.yearId, plan.classIds);
  const out = await raiseFor(
    trx,
    plan,
    students.map((rowId) => ({ rowId })),
    who,
  );
  if (out.assigned) {
    await recordAudit(trx, {
      institutionId: plan.institutionId,
      action: 'FEE_STRUCTURE_ASSIGNED',
      entityType: 'fee_structure',
      entityRef: plan.structurePublicId,
      after: {
        version: plan.versionNo,
        students: out.assigned,
        records: out.created,
        automatic: 'approval',
      },
    });
  }
  return out;
}

/**
 * A student placed in a class for a year (onboarding, an admission, the Enrolment page, a roll-over,
 * a class change): the approved structure of that class and year, unless they are already assigned
 * for it (client 2026-10-16). Returns what was raised, or null when nothing applies.
 */
export async function assignStudent(
  trx: Db,
  v: { readonly institutionId: string; readonly studentId: string; readonly yearId: string },
  who: { readonly by: Buffer | null; readonly at: Date },
) {
  const placed = await trx
    .selectFrom('enrolments as e')
    .innerJoin('sections as sec', 'sec.id', 'e.section_id')
    .select('sec.class_id')
    .where('e.institution_id', '=', v.institutionId)
    .where('e.student_profile_id', '=', v.studentId)
    .where('e.year_id', '=', v.yearId)
    .executeTakeFirst();
  if (!placed) return null;
  // At most one approved structure per class and year (FeesService.clash).
  const version = await trx
    .selectFrom('fee_structure_versions as fv')
    .innerJoin('fee_structures as s', 's.id', 'fv.structure_id')
    .innerJoin('fee_structure_classes as fc', 'fc.version_id', 'fv.id')
    .select('fv.id')
    .where('s.institution_id', '=', v.institutionId)
    .where('s.year_id', '=', v.yearId)
    .where('fv.state', '=', 'ACTIVE')
    .where('fc.class_id', '=', String(placed.class_id))
    .executeTakeFirst();
  if (!version) return null;
  const plan = await assignPlan(trx, String(version.id), istBusinessDate(who.at));
  if (!plan) return null;
  const students = await unassigned(
    trx,
    v.institutionId,
    v.yearId,
    [String(placed.class_id)],
    v.studentId,
  );
  if (!students.length) return null;
  const out = await raiseFor(trx, plan, [{ rowId: v.studentId }], who);
  if (out.assigned) {
    await recordAudit(trx, {
      institutionId: plan.institutionId,
      action: 'FEE_STRUCTURE_ASSIGNED',
      entityType: 'fee_structure',
      entityRef: plan.structurePublicId,
      after: {
        version: plan.versionNo,
        students: out.assigned,
        records: out.created,
        automatic: 'placement',
      },
    });
  }
  return out;
}
