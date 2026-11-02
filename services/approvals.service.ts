/**
 * Maker-checker queue (SRS 17; MKR-001…005; FR-MKC-01/03; ADR-0015; prototype c.approvals) and the
 * correction request for an institution profile's identity fields (CR-06; IDN-057).
 *
 * - Requests are numbered APR-0001 per institution; the platform's own (member corrections of an
 *   account without an institution) are decided in the back office.
 * - Only an Institution Administrator decides (`approvals.decide`, Q9); nobody decides their own
 *   request (MSG-MKR-16/17). An administrator's own request is applied at once and recorded as
 *   applied directly (setting `mkr.adminSelfApply`).
 * - The effect runs in the same transaction as the decision and re-checks the record first; when
 *   it refuses (for example the admission number was taken meanwhile) nothing changes, the request
 *   stays pending and the reason is shown (MSG-MKR-19, reworded).
 * - Remarks are mandatory (setting `mkr.remarks.minLength`). The maker is notified of the decision;
 *   the checkers are notified of a new request.
 */
import { emit, rooms } from '../utils/outbox';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { LIMITS, renderMessage, type MessageKey } from '../config/registers';
import type { Database, PiiField } from '../models/campusone_models';
import {
  approvalsRepository,
  type ApprovalModule,
  type ApprovalState,
} from '../repositories/approvals.repository';
import { fileRepository } from '../repositories/file.repository';
import { institutionsRepository } from '../repositories/institutions.repository';
import { kindOf, membersRepository } from '../repositories/members.repository';
import { notificationsRepository } from '../repositories/notifications.repository';
import { recordAudit } from './audit.service';
import type { BankCreditsService } from './bank-credits.service';
import type { FeeRecordsService } from './fee-records.service';
import type { GrievancesService } from './grievances.service';
import type { EnrolmentsService } from './enrolments.service';
import type { FeesService } from './fees.service';
import type { FileService } from './file.service';
import { nameAddressKey } from './institutions.service';
import type { MembersService } from './members.service';
import { notify } from './notifications.service';
import type { SessionService } from './session.service';
import { defaultValues, type SettingValues } from './settings.service';
import {
  ConflictError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { lastFour, maskPan, normaliseForIndex, type FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { isRealDate, type FieldError } from '../utils/validators';

type Db = Kysely<Database> | Transaction<Database>;

/** What each module's request does, as the queue shows it (prototype c.approvals). */
export const APPROVAL_ACTIONS: Readonly<
  Record<ApprovalModule, { area: string; action: string; cr: string | null }>
> = {
  MEMBER_SUSPENSION: { area: 'Members', action: 'Suspend member', cr: 'CR-08' },
  MEMBER_DELINK: { area: 'Members', action: 'De-link member', cr: 'CR-08' },
  PII_CORRECTION: { area: 'Members', action: 'Correct personal information', cr: 'CR-06' },
  INSTITUTION_DETAILS: { area: 'Institutions', action: 'Change institution details', cr: null },
  BANK_CREDIT_RETURN: { area: 'Wallets', action: 'Return a held bank credit', cr: 'CR-08' },
  FEE_STRUCTURE: { area: 'Fees', action: 'Approve fee structure', cr: 'CR-11' },
  FEE_RECORD_CHANGE: { area: 'Fees', action: 'Change a fee record', cr: null },
  GRIEVANCE_UPDATE: { area: 'Grievances', action: 'Priority 1 ticket update', cr: null },
  ACADEMIC_CORRECTION: { area: 'Academics', action: 'Correct a closed year', cr: 'CR-13' },
};

export const FIELD_LABELS: Readonly<Record<PiiField, string>> = {
  FULL_NAME: 'Full name',
  DOB: 'Date of birth',
  GENDER: 'Gender',
  PAN: 'PAN',
  ID_NUMBER: 'Identity document number',
  ADMISSION_NO: 'Admission number',
  EMPLOYEE_NO: 'Employee ID',
};

/** Fields an institution profile can correct (IDN-057). */
export const PROFILE_FIELDS = [
  'FULL_NAME',
  'DOB',
  'GENDER',
  'ADMISSION_NO',
  'EMPLOYEE_NO',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const GENDER_LABEL: Readonly<Record<string, string>> = {
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
};
const PERSON = /^[A-Za-z.'-]+(?: [A-Za-z.'-]+)*$/;

export const approvalNo = (seq: number) => `APR-${String(seq).padStart(4, '0')}`;

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

const personName = (first: string | null | undefined, last: string | null | undefined) =>
  titleCase([first, last].filter(Boolean).join(' '));

const day = (d: Date | string | null | undefined) =>
  !d ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

const displayDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const parse = (v: unknown): Record<string, unknown> => {
  if (v === null || v === undefined) return {};
  try {
    const o = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** A refusal raised by an effect: the decision rolls back and the request stays pending. */
class EffectRefused extends Error {
  constructor(readonly inner: CustomAPIError) {
    super(inner.message);
  }
}

/**
 * Raises a request (or records one applied directly) and tells the institution's checkers. Call it
 * inside the transaction that holds the institution row lock.
 */
export async function raiseApproval(
  trx: Db,
  v: {
    institutionId: string | null;
    module: ApprovalModule;
    summary: string;
    payload: Readonly<Record<string, unknown>>;
    makerType: 'member' | 'staff' | 'operator';
    makerRef: Buffer;
    subjectType:
      | 'member'
      | 'account'
      | 'institution'
      | 'bank_credit'
      | 'fee_structure'
      | 'fee_record'
      | 'ticket'
      | 'enrolment';
    subjectRef: Buffer;
    at: Date;
    /** ADR-0015: an administrator's own request, applied at once. */
    appliedDirectly?: boolean;
  },
) {
  const pub = newPublicIdPair();
  const r = await approvalsRepository.insert(trx, {
    publicId: pub.bin,
    institutionId: v.institutionId,
    module: v.module,
    action: 'UPDATE',
    summary: v.summary,
    payload: v.payload,
    makerType: v.makerType,
    makerRef: v.makerRef,
    subjectType: v.subjectType,
    subjectRef: v.subjectRef,
    ...(v.appliedDirectly
      ? { appliedDirectly: { at: v.at, remarks: 'Applied directly by an administrator' } }
      : {}),
  });
  const no = approvalNo(r.seq);
  if (!v.appliedDirectly && v.institutionId) {
    const maker = await trx
      .selectFrom('platform_accounts')
      .select('id')
      .where('public_id', '=', v.makerRef)
      .executeTakeFirst();
    const checkers = (await notificationsRepository.checkers(trx, v.institutionId)).filter(
      (a) => a !== (maker ? String(maker.id) : null),
    );
    await notify(
      trx,
      {
        institutionId: v.institutionId,
        accountIds: checkers,
        surface: 'CONSOLE',
        category: 'APPROVAL',
        titleKey: 'NTF.APPROVAL_RAISED',
        params: { no },
        body: v.summary,
        link: `/console/approvals?open=${pub.id}`,
      },
      v.at,
    );
  }
  // A platform request waits for an operator who decides (client 2026-10-21: the back-office bell).
  if (!v.appliedDirectly && !v.institutionId) {
    const maker = await trx
      .selectFrom('platform_accounts')
      .select('id')
      .where('public_id', '=', v.makerRef)
      .executeTakeFirst();
    const checkers = (await notificationsRepository.operatorCheckers(trx)).filter(
      (a) => a !== (maker ? String(maker.id) : null),
    );
    await notify(
      trx,
      {
        institutionId: null,
        accountIds: checkers,
        surface: 'OPS',
        category: 'APPROVAL',
        titleKey: 'NTF.APPROVAL_RAISED',
        params: { no },
        body: v.summary,
        link: `/backoffice/approvals?open=${pub.id}`,
      },
      v.at,
    );
  }
  if (!v.appliedDirectly) {
    await emit(trx, {
      institutionId: v.institutionId,
      type: 'approval.created',
      rooms: [v.institutionId ? rooms.institutionConsole(v.institutionId) : rooms.ops()],
      data: { approvalId: pub.id, no },
    });
  }
  return { id: pub.id, no, rowId: r.id };
}

type Scope = { institutionId: string | null; console: boolean };

export class ApprovalsService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly members: MembersService;
      readonly sessions: SessionService;
      readonly cipher: FieldCipher;
      readonly files: FileService;
      /** Applies an approved return of a held bank credit (late-bound: it raises approvals too). */
      readonly bankCredits?: { applyReturn: BankCreditsService['applyReturn'] };
      /** Activates or returns a fee structure version (CR-11; late-bound for the same reason). */
      readonly fees?: {
        applyApproved: FeesService['applyApproved'];
        applyReturned: FeesService['applyReturned'];
        changes: FeesService['approvalChanges'];
      };
      /** Applies an approved fee record change (FEE-013, FR-FEE-07; late-bound likewise). */
      readonly feeRecords?: {
        applyChange: FeeRecordsService['applyChange'];
        changes: FeeRecordsService['changeRows'];
      };
      readonly grievances?: {
        applyUpdate: GrievancesService['applyUpdate'];
        changes: GrievancesService['changeRows'];
      };
      readonly enrolments?: {
        applyCorrection: EnrolmentsService['applyCorrection'];
        changes: EnrolmentsService['changeRows'];
      };
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return v[l.key] ?? l.value;
  }

  private async scope(
    p: Principal,
    surface: 'console' | 'ops',
    lock = false,
    db: Db = this.deps.db,
  ) {
    if (surface === 'ops') return { institutionId: null, console: false } as Scope;
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await institutionsRepository.byPublicId(db, uuidToBin(p.institutionId), lock);
    if (!inst) throw new NotFoundError();
    return { institutionId: String(inst.id), console: true } as Scope;
  }

  private me(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  private canDecide(p: Principal, surface: 'console' | 'ops') {
    return p.subTasks.includes(surface === 'console' ? 'approvals.decide' : 'mkr.decide');
  }

  // --- MKR-001 / MKR-004 --------------------------------------------------------------------------
  async list(
    p: Principal,
    surface: 'console' | 'ops',
    q: {
      status?: ApprovalState | undefined;
      module?: string | undefined;
      maker?: string | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const s = await this.scope(p, surface);
    const me = this.me(p);
    const status = q.status ?? 'PENDING';
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const since = new Date(this.now().getTime() - 30 * 86_400_000);
    const [rows, counts, makers, modules] = await Promise.all([
      approvalsRepository.page(this.deps.db, s.institutionId, {
        status,
        module: q.module || undefined,
        makerRef: q.maker && isUuid(q.maker) ? uuidToBin(q.maker) : undefined,
        q: q.q,
        before: idCursor.decode(q.cursor),
        limit,
      }),
      approvalsRepository.counts(this.deps.db, s.institutionId, me, since),
      approvalsRepository.makers(this.deps.db, s.institutionId),
      approvalsRepository.modules(this.deps.db, s.institutionId),
    ]);
    const decider = this.canDecide(p, surface);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const pendingOthers = decider ? counts.pending - counts.mine : 0;
    return {
      counts: {
        tabs: { PENDING: counts.pending, APPROVED: counts.approved, REJECTED: counts.rejected },
        canDecide: Math.max(pendingOthers, 0),
        mine: counts.mine,
        decided30: counts.decided,
      },
      canDecide: decider,
      modules: modules.map((m) => ({
        code: m,
        label: APPROVAL_ACTIONS[m as ApprovalModule]?.action ?? m,
      })),
      makers: makers.map((m) => ({
        id: binToUuid(m.maker_ref),
        name: personName(m.first_name, m.last_name) || 'CampusOne',
        you: me !== null && m.maker_ref.equals(me),
      })),
      items: page.map((r) => this.row(r, me, decider)),
      nextCursor: rows.length > limit && last ? idCursor.encode(last.id) : null,
    };
  }

  private row(
    r: NonNullable<Awaited<ReturnType<typeof approvalsRepository.detail>>>,
    me: Buffer | null,
    decider: boolean,
  ) {
    const def = APPROVAL_ACTIONS[r.module as ApprovalModule];
    const own = me !== null && r.maker_ref.equals(me);
    return {
      id: binToUuid(r.public_id),
      no: approvalNo(r.request_seq),
      module: r.module,
      area: def?.area ?? r.module,
      action: def?.action ?? r.module,
      cr: def?.cr ?? null,
      summary: r.summary,
      status: r.status,
      maker: {
        id: binToUuid(r.maker_ref),
        name: personName(r.maker_first, r.maker_last) || 'CampusOne',
        you: own,
        type: r.maker_type,
      },
      raisedAt: new Date(r.created_at).toISOString(),
      checker:
        r.checker_ref !== null
          ? { name: personName(r.checker_first, r.checker_last) || 'CampusOne' }
          : null,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      remarks: r.remarks,
      appliedDirectly: r.applied_directly === 1,
      canDecide: decider && r.status === 'PENDING' && !own,
      lastError: r.effect_error_code,
      version: r.row_version,
    };
  }

  // --- MKR-002 ------------------------------------------------------------------------------------
  async detail(p: Principal, surface: 'console' | 'ops', id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const s = await this.scope(p, surface);
    const r = await approvalsRepository.detail(this.deps.db, s.institutionId, uuidToBin(id));
    if (!r) throw new NotFoundError();
    const payload = parse(r.payload);
    const changes = await this.changes(this.deps.db, r, payload);
    const correction =
      r.module === 'PII_CORRECTION'
        ? await this.deps.db
            .selectFrom('pii_correction_requests as c')
            .innerJoin('files as f', 'f.id', 'c.evidence_file_id')
            .select(['c.reason', 'c.field', 'f.public_id as file_public_id', 'f.original_name'])
            .where('c.approval_request_id', '=', r.id)
            .executeTakeFirst()
        : undefined;
    const reason =
      correction?.reason ?? (typeof payload['reason'] === 'string' ? payload['reason'] : null);
    return {
      ...this.row(r, this.me(p), this.canDecide(p, surface)),
      reason,
      changes,
      evidence: correction
        ? {
            name: correction.original_name,
            url: this.deps.files.linkFor(binToUuid(correction.file_public_id)).url,
          }
        : null,
      subject:
        r.subject_type === 'member' && r.subject_ref
          ? { type: 'member' as const, id: binToUuid(r.subject_ref) }
          : r.subject_type === 'institution' && r.subject_ref
            ? { type: 'institution' as const, id: binToUuid(r.subject_ref) }
            : r.subject_type === 'account'
              ? { type: 'account' as const, id: null }
              : null,
      lastError: r.effect_error_code
        ? renderMessage(
            r.effect_error_code as MessageKey,
            parse(r.effect_error_params) as Record<string, string | number>,
          )
        : null,
    };
  }

  /** Before → after rows for the drawer (prototype CM.changes), read from the live record. */
  private async changes(
    db: Db,
    r: { id: string; module: string; institution_id: string | null; subject_ref: Buffer | null },
    payload: Record<string, unknown>,
  ) {
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : '';
    if (r.module === 'MEMBER_SUSPENSION' || r.module === 'MEMBER_DELINK') {
      const m =
        r.institution_id && r.subject_ref
          ? await db
              .selectFrom('member_profiles')
              .select(['status', 'account_id'])
              .where('institution_id', '=', r.institution_id)
              .where('public_id', '=', r.subject_ref)
              .executeTakeFirst()
          : undefined;
      const status = m ? titleCase(m.status) : '—';
      return r.module === 'MEMBER_SUSPENSION'
        ? [
            { label: 'Member status', from: status, to: 'Suspended' },
            { label: 'Reason', from: '—', to: reason },
          ]
        : [
            {
              label: 'Institution link',
              from: m ? (m.account_id !== null ? 'Linked' : 'Not linked') : '—',
              to: 'Unlinked',
            },
            { label: 'Member status', from: status, to: 'Inactive' },
          ];
    }
    if (r.module === 'INSTITUTION_DETAILS' && r.subject_ref) {
      const i = await db
        .selectFrom('institutions')
        .select(['name', 'address_line1', 'board'])
        .where('public_id', '=', r.subject_ref)
        .executeTakeFirst();
      const field = String(payload['field'] ?? '');
      const label = { NAME: 'Name', ADDRESS: 'Address', BOARD: 'Board' }[field] ?? field;
      const from =
        field === 'NAME' ? i?.name : field === 'ADDRESS' ? i?.address_line1 : (i?.board ?? '—');
      return [{ label, from: from ?? '—', to: String(payload['value'] ?? '') }];
    }
    if (r.module === 'FEE_STRUCTURE' && this.deps.fees) {
      return this.deps.fees.changes(db, payload);
    }
    if (r.module === 'FEE_RECORD_CHANGE' && this.deps.feeRecords) {
      return this.deps.feeRecords.changes(db, payload);
    }
    if (r.module === 'GRIEVANCE_UPDATE' && this.deps.grievances) {
      return this.deps.grievances.changes(db, payload);
    }
    if (r.module === 'ACADEMIC_CORRECTION' && this.deps.enrolments) {
      return this.deps.enrolments.changes(db, payload);
    }
    if (r.module === 'PII_CORRECTION') {
      const c = await db
        .selectFrom('pii_correction_requests')
        .select(['public_id', 'field', 'current_masked', 'proposed_enc', 'profile_id'])
        .where('approval_request_id', '=', r.id)
        .executeTakeFirst();
      if (!c) return [];
      const proposed = this.proposed(c);
      return [{ label: FIELD_LABELS[c.field], from: c.current_masked, to: proposed.shown }];
    }
    return [];
  }

  private proposed(c: { public_id: Buffer; field: PiiField; proposed_enc: Buffer }) {
    const value = this.deps.cipher.decrypt(
      'pii_correction',
      c.proposed_enc,
      `pii_correction_requests.proposed:${binToUuid(c.public_id)}`,
    );
    const shown =
      c.field === 'PAN'
        ? (maskPan(lastFour(value)) ?? '—')
        : c.field === 'ID_NUMBER'
          ? `••••••${lastFour(value)}`
          : c.field === 'DOB'
            ? displayDate(value)
            : c.field === 'GENDER'
              ? (GENDER_LABEL[value] ?? value)
              : value;
    return { value, shown };
  }

  // --- MKR-003 / MKR-005 --------------------------------------------------------------------------
  async decide(
    p: Principal,
    surface: 'console' | 'ops',
    id: string,
    expected: number,
    input: { decision: 'APPROVE' | 'REJECT'; remarks: string },
  ) {
    if (!isUuid(id)) throw new NotFoundError();
    const remarks = input.remarks.trim();
    const min = await this.limit(LIMITS.approvalsRemarksMinLength);
    if (remarks.length < min || remarks.length > 500) {
      throw new ValidationError([
        { field: 'remarks', code: 'MKR.REMARKS_TOO_SHORT', params: { min } },
      ]);
    }
    const me = this.me(p);
    if (!me) throw new NotFoundError();
    if (!this.canDecide(p, surface)) throw new CustomAPIError(403, 'MKR.NOT_YOUR_MODULE');
    const approve = input.decision === 'APPROVE';
    const at = this.now();
    let rowId: string | null = null;
    try {
      const out = await this.deps.db.transaction().execute(async (trx) => {
        const s = await this.scope(p, surface, true, trx);
        const a = await approvalsRepository.byPublicId(trx, s.institutionId, uuidToBin(id), true);
        if (!a) throw new NotFoundError();
        rowId = a.id;
        if (a.status !== 'PENDING') throw new ConflictError('MKR.ALREADY_DECIDED');
        if (a.maker_ref.equals(me)) {
          throw new CustomAPIError(403, approve ? 'MKR.OWN_APPROVE' : 'MKR.OWN_REJECT');
        }
        if (a.row_version !== expected) throw new PreconditionFailedError();
        const payload = parse(a.payload);
        let endSessions: {
          accountId: string;
          reason: 'ACCOUNT_DEACTIVATED' | 'PROFILE_DELINKED';
        } | null = null;
        if (approve) {
          try {
            endSessions = await this.apply(trx, a, payload, at, me);
          } catch (e) {
            if (e instanceof CustomAPIError) throw new EffectRefused(e);
            throw e;
          }
        } else if (a.module === 'FEE_STRUCTURE' && this.deps.fees) {
          await this.deps.fees.applyReturned(trx, payload, remarks, at);
        } else if (a.module === 'PII_CORRECTION') {
          await trx
            .updateTable('pii_correction_requests')
            .set({ closed_at: at })
            .where('approval_request_id', '=', a.id)
            .where('applied_at', 'is', null)
            .where('closed_at', 'is', null)
            .execute();
        }
        const ok = await approvalsRepository.decide(trx, a.id, {
          status: approve ? 'APPROVED' : 'REJECTED',
          checker: me,
          remarks,
          at,
        });
        if (!ok) throw new ConflictError('MKR.ALREADY_DECIDED');
        const def = APPROVAL_ACTIONS[a.module as ApprovalModule];
        await recordAudit(trx, {
          institutionId: a.institution_id,
          action: approve ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
          entityType: 'approval_request',
          entityRef: id,
          before: { status: 'PENDING' },
          after: { status: approve ? 'APPROVED' : 'REJECTED', module: a.module },
          reason: remarks,
        });
        await this.tellMaker(trx, a, approve, remarks, def?.action ?? a.module, at);
        return { endSessions, version: a.row_version + 1 };
      });
      if (out.endSessions) {
        await this.deps.sessions.endAllForAccount(
          out.endSessions.accountId,
          out.endSessions.reason,
        );
      }
      return this.detail(p, surface, id);
    } catch (e) {
      if (e instanceof EffectRefused) {
        if (rowId) {
          await approvalsRepository.setEffectError(
            this.deps.db,
            rowId,
            e.inner.code,
            (e.inner.params ?? {}) as Record<string, unknown>,
          );
        }
        throw new CustomAPIError(409, 'MKR.EFFECT_FAILED', {
          params: {
            reason: renderMessage(
              e.inner.code as MessageKey,
              (e.inner.params ?? {}) as Record<string, string | number>,
            ),
          },
        });
      }
      throw e;
    }
  }

  /** Applies an approved request; returns the account whose sessions must end, if any. */
  private async apply(
    trx: Transaction<Database>,
    a: { id: string; module: string; institution_id: string | null },
    payload: Record<string, unknown>,
    at: Date,
    checker: Buffer,
  ): Promise<{ accountId: string; reason: 'ACCOUNT_DEACTIVATED' | 'PROFILE_DELINKED' } | null> {
    const member = typeof payload['member'] === 'string' ? payload['member'] : '';
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : '';
    if (a.module === 'MEMBER_SUSPENSION' && a.institution_id) {
      const acc = await this.deps.members.applySuspension(trx, a.institution_id, member, reason);
      return acc ? { accountId: acc, reason: 'ACCOUNT_DEACTIVATED' } : null;
    }
    if (a.module === 'MEMBER_DELINK' && a.institution_id) {
      const acc = await this.deps.members.applyDelink(trx, a.institution_id, member, reason);
      return acc ? { accountId: acc, reason: 'PROFILE_DELINKED' } : null;
    }
    if (a.module === 'PII_CORRECTION') {
      await this.applyCorrection(trx, a.id, at);
      return null;
    }
    if (a.module === 'INSTITUTION_DETAILS') {
      await this.applyInstitutionDetails(trx, payload, at);
      return null;
    }
    if (a.module === 'BANK_CREDIT_RETURN' && this.deps.bankCredits) {
      await this.deps.bankCredits.applyReturn(trx, payload, at);
      return null;
    }
    if (a.module === 'FEE_STRUCTURE' && this.deps.fees) {
      await this.deps.fees.applyApproved(trx, payload, at);
      return null;
    }
    if (a.module === 'FEE_RECORD_CHANGE' && this.deps.feeRecords) {
      await this.deps.feeRecords.applyChange(trx, payload, at);
      return null;
    }
    if (a.module === 'ACADEMIC_CORRECTION' && this.deps.enrolments) {
      // Recorded as an adjustment carrying the closed year, which stays closed (OI-ACA-60).
      await this.deps.enrolments.applyCorrection(trx, payload, at, a.id, checker);
      return null;
    }
    if (a.module === 'GRIEVANCE_UPDATE' && this.deps.grievances) {
      // The checker's approval is also a refund's approval (Q14 M16).
      await this.deps.grievances.applyUpdate(trx, payload, at, {
        checker,
        approvalId: a.id,
        actor: a.institution_id ? 'STAFF' : 'OPERATOR',
      });
      return null;
    }
    throw new CustomAPIError(409, 'MKR.ALREADY_DECIDED');
  }

  /** Name, address or board of an institution (portal SAS-021): name + address stay unique. */
  private async applyInstitutionDetails(
    trx: Transaction<Database>,
    payload: Record<string, unknown>,
    at: Date,
  ) {
    const id = String(payload['institution'] ?? '');
    const field = String(payload['field'] ?? '');
    const value = String(payload['value'] ?? '').trim();
    if (!isUuid(id) || !value) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(trx, uuidToBin(id), true);
    if (!row) throw new NotFoundError();
    const name = field === 'NAME' ? value : row.name;
    const address = field === 'ADDRESS' ? value : row.address_line1;
    const key = nameAddressKey(name, address);
    if (field !== 'BOARD' && (await institutionsRepository.nameAddressTaken(trx, key, row.id))) {
      throw new CustomAPIError(409, 'INS.NAME_ADDRESS_TAKEN');
    }
    const ok = await institutionsRepository.update(
      trx,
      row.id,
      row.row_version,
      field === 'BOARD'
        ? { board: value }
        : { name, address_line1: address, name_address_key: key },
      null,
    );
    if (!ok) throw new ConflictError('MKR.ALREADY_DECIDED');
    await institutionsRepository.addEvent(trx, {
      institutionId: row.id,
      action: 'DETAILS_CHANGED',
      from: null,
      to: null,
      reason: `${field.toLowerCase()} → ${value}`,
      actor: null,
      at,
    });
    await recordAudit(trx, {
      institutionId: row.id,
      action: 'INSTITUTION_DETAILS_CHANGED',
      entityType: 'institution',
      entityRef: id,
      before: {
        [field.toLowerCase()]:
          field === 'NAME' ? row.name : field === 'ADDRESS' ? row.address_line1 : row.board,
      },
      after: { [field.toLowerCase()]: value },
    });
  }

  private async applyCorrection(trx: Transaction<Database>, approvalRowId: string, at: Date) {
    const c = await trx
      .selectFrom('pii_correction_requests')
      .selectAll()
      .where('approval_request_id', '=', approvalRowId)
      .forUpdate()
      .executeTakeFirst();
    if (!c || c.applied_at || c.closed_at) throw new ConflictError('MKR.ALREADY_DECIDED');
    const { value } = this.proposed(c);
    if (c.profile_id !== null) {
      await this.applyToProfile(trx, c.profile_id, c.field, value, c.reason);
    } else if (c.account_id !== null) {
      await this.applyToAccount(trx, c.account_id, c.field, value);
    }
    await trx
      .updateTable('pii_correction_requests')
      .set({ applied_at: at })
      .where('id', '=', c.id)
      .execute();
  }

  private async applyToProfile(
    trx: Transaction<Database>,
    profileId: string,
    field: PiiField,
    value: string,
    reason: string,
  ) {
    const m = await trx
      .selectFrom('member_profiles')
      .selectAll()
      .where('id', '=', profileId)
      .forUpdate()
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    const inst = String(m.institution_id);
    const set: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (field === 'FULL_NAME') {
      const [first, ...rest] = value.split(' ');
      set['first_name'] = first;
      set['last_name'] = rest.join(' ') || null;
      before['name'] = [m.first_name, m.last_name].filter(Boolean).join(' ');
      after['name'] = value;
    } else if (field === 'DOB') {
      set['date_of_birth'] = value;
      before['dateOfBirth'] = day(m.date_of_birth);
      after['dateOfBirth'] = value;
    } else if (field === 'GENDER') {
      set['gender'] = value;
      before['gender'] = m.gender;
      after['gender'] = value;
    } else if (field === 'ADMISSION_NO') {
      if (await membersRepository.admissionTaken(trx, inst, value, profileId)) {
        throw new CustomAPIError(409, 'IDN.ADMISSION_NO_TAKEN', { params: { n: value } });
      }
      set['admission_no'] = value;
      before['admissionNo'] = m.admission_no;
      after['admissionNo'] = value;
    } else if (field === 'EMPLOYEE_NO') {
      const taken = await trx
        .selectFrom('member_profiles')
        .select('id')
        .where('institution_id', '=', inst)
        .where('employee_no', '=', value)
        .where('id', '!=', profileId)
        .executeTakeFirst();
      if (taken) throw new CustomAPIError(409, 'IDN.EMPLOYEE_NO_TAKEN', { params: { n: value } });
      set['employee_no'] = value;
      before['employeeNo'] = m.employee_no;
      after['employeeNo'] = value;
    }
    await trx
      .updateTable('member_profiles')
      .set({
        ...set,
        row_version: sql<number>`row_version + 1`,
        updated_at: sql<Date>`UTC_TIMESTAMP(3)`,
      })
      .where('id', '=', profileId)
      .execute();
    await recordAudit(trx, {
      institutionId: inst,
      action: 'MEMBER_PII_CORRECTED',
      entityType: 'member',
      entityRef: binToUuid(m.public_id),
      before,
      after,
      reason,
    });
  }

  private async applyToAccount(
    trx: Transaction<Database>,
    accountId: string,
    field: PiiField,
    value: string,
  ) {
    const a = await trx
      .selectFrom('platform_accounts')
      .select(['id', 'public_id'])
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirst();
    if (!a) throw new NotFoundError();
    const pub = binToUuid(a.public_id);
    const c = this.deps.cipher;
    const set: Record<string, unknown> = {};
    if (field === 'FULL_NAME') {
      const parts = value.toUpperCase().split(' ');
      set['first_name'] = parts[0];
      set['last_name'] = parts.length > 1 ? parts.at(-1) : null;
      set['middle_name'] = parts.length > 2 ? parts.slice(1, -1).join(' ') : null;
    } else if (field === 'DOB') {
      set['dob'] = value;
    } else if (field === 'GENDER') {
      set['gender'] = value;
    } else if (field === 'PAN') {
      const pan = value.toUpperCase();
      const bidx = c.blindIndex('pan', pan);
      const other = await trx
        .selectFrom('platform_accounts')
        .select('id')
        .where('pan_bidx', '=', bidx)
        .where('id', '!=', accountId)
        .executeTakeFirst();
      if (other) throw new CustomAPIError(409, 'IDN.PAN_TAKEN');
      set['pan_enc'] = c.encrypt('pan', pan, `platform_accounts.pan:${pub}`);
      set['pan_bidx'] = bidx;
      set['pan_last4'] = lastFour(pan);
    } else if (field === 'ID_NUMBER') {
      const doc = normaliseForIndex(value);
      set['id_doc_enc'] = c.encrypt('id_doc', doc, `platform_accounts.id_doc:${pub}`);
      set['id_doc_bidx'] = c.blindIndex('id_doc', doc);
      set['id_doc_last4'] = lastFour(doc);
    }
    await trx
      .updateTable('platform_accounts')
      .set({ ...set, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
      .where('id', '=', accountId)
      .execute();
    await recordAudit(trx, {
      action: 'ACCOUNT_PII_CORRECTED',
      entityType: 'account',
      entityRef: pub,
      after: { field },
    });
  }

  private async tellMaker(
    trx: Transaction<Database>,
    a: {
      public_id: Buffer;
      request_seq: number;
      institution_id: string | null;
      maker_type: string;
      maker_ref: Buffer;
      module: string;
      subject_type: string | null;
      subject_ref: Buffer | null;
    },
    approved: boolean,
    remarks: string,
    action: string,
    at: Date,
  ) {
    const maker = await trx
      .selectFrom('platform_accounts')
      .select('id')
      .where('public_id', '=', a.maker_ref)
      .executeTakeFirst();
    if (!maker) return;
    const no = approvalNo(a.request_seq);
    if (a.maker_type === 'member') {
      const field = await trx
        .selectFrom('pii_correction_requests as c')
        .innerJoin('approval_requests as r', 'r.id', 'c.approval_request_id')
        .select('c.field')
        .where('r.public_id', '=', a.public_id)
        .executeTakeFirst();
      await notify(
        trx,
        {
          institutionId: a.institution_id,
          accountIds: [String(maker.id)],
          surface: 'MEMBER',
          category: 'CORRECTION',
          titleKey: approved ? 'NTF.CORRECTION_APPROVED' : 'NTF.CORRECTION_REJECTED',
          params: { no },
          body: `${field ? FIELD_LABELS[field.field] : action}: ${remarks}`,
          link: null,
        },
        at,
      );
      return;
    }
    // A platform request about an institution (its details) is answered in that school's console.
    const subjectInst =
      a.subject_type === 'institution' && a.subject_ref
        ? await institutionsRepository.byPublicId(trx, a.subject_ref)
        : undefined;
    const bellInst = a.institution_id ?? (subjectInst ? subjectInst.id : null);
    if (a.maker_type === 'operator') {
      // An operator's own request is answered in the back office (client 2026-10-21).
      await notify(
        trx,
        {
          institutionId: null,
          accountIds: [String(maker.id)],
          surface: 'OPS',
          category: 'APPROVAL',
          titleKey: approved ? 'NTF.APPROVAL_APPROVED' : 'NTF.APPROVAL_REJECTED',
          params: { no },
          body: `${action}: ${remarks}`,
          link: `/backoffice/approvals?open=${binToUuid(a.public_id)}`,
        },
        at,
      );
    } else if (bellInst) {
      await notify(
        trx,
        {
          institutionId: bellInst,
          accountIds: [String(maker.id)],
          surface: 'CONSOLE',
          category: 'APPROVAL',
          titleKey: approved ? 'NTF.APPROVAL_APPROVED' : 'NTF.APPROVAL_REJECTED',
          params: { no },
          body: `${action}: ${remarks}`,
          link: a.institution_id ? `/console/approvals?open=${binToUuid(a.public_id)}` : null,
        },
        at,
      );
    }
  }

  // --- IDN-057 ------------------------------------------------------------------------------------
  /**
   * A correction of a member's display-only identity field, with the reason and the evidence. It
   * waits for an Institution Administrator, or applies at once when the maker is one (ADR-0015).
   */
  async requestProfileCorrection(
    p: Principal,
    memberId: string,
    input: { field: ProfileField; proposedValue: string; reason: string; evidenceFileId: string },
  ) {
    if (!isUuid(memberId)) throw new NotFoundError();
    const me = this.me(p);
    if (!me) throw new NotFoundError();
    const field = input.field;
    let value = input.proposedValue.trim().replace(/\s+/g, ' ');
    const reason = input.reason.trim();
    const e: FieldError[] = [];
    const bad = (code: MessageKey, params?: Record<string, string | number>) =>
      e.push({ field: 'proposedValue', code, ...(params ? { params } : {}) });
    if (!value) bad('VALIDATION.REQUIRED');
    else if (field === 'FULL_NAME' && (!PERSON.test(value) || value.length > 60)) {
      bad('IDN.NAME_LETTERS_ONLY');
    } else if (field === 'DOB') {
      if (!isRealDate(value)) bad('VALIDATION.DATE');
      else if (value >= this.now().toISOString().slice(0, 10)) bad('IDN.DOB_IN_FUTURE');
    } else if (field === 'GENDER') {
      value = value.toUpperCase();
      if (!['MALE', 'FEMALE', 'OTHER'].includes(value)) bad('VALIDATION.FORMAT');
    } else if ((field === 'ADMISSION_NO' || field === 'EMPLOYEE_NO') && value.length > 30) {
      bad('VALIDATION.FORMAT');
    }
    if (!reason) e.push({ field: 'reason', code: 'VALIDATION.REQUIRED' });
    else if (reason.length < 10 || reason.length > 300) {
      e.push({ field: 'reason', code: 'VALIDATION.FORMAT' });
    }
    if (!input.evidenceFileId) e.push({ field: 'evidenceFileId', code: 'VALIDATION.REQUIRED' });
    if (e.length) throw new ValidationError(e);

    const at = this.now();
    const correction = newPublicIdPair();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const s = await this.scope(p, 'console', true, trx);
      const inst = s.institutionId as string;
      const m = await membersRepository.lock(trx, inst, uuidToBin(memberId));
      if (!m) throw new NotFoundError();
      const ut = await trx
        .selectFrom('user_types')
        .select('category')
        .where('id', '=', m.user_type_id)
        .executeTakeFirstOrThrow();
      const kind = kindOf(ut.category);
      if (field === 'ADMISSION_NO' && kind !== 'STUDENTS') {
        throw new ValidationError([{ field: 'field', code: 'IDN.PII_FIELD_NOT_CORRECTABLE' }]);
      }
      if (field === 'EMPLOYEE_NO' && kind !== 'STAFF') {
        throw new ValidationError([{ field: 'field', code: 'IDN.PII_FIELD_NOT_CORRECTABLE' }]);
      }
      const current = {
        FULL_NAME: [m.first_name, m.last_name].filter(Boolean).join(' '),
        DOB: m.date_of_birth ? (day(m.date_of_birth) ?? '') : '',
        GENDER: m.gender ?? '',
        ADMISSION_NO: m.admission_no ?? '',
        EMPLOYEE_NO: m.employee_no ?? '',
      }[field];
      if (current.toLowerCase() === value.toLowerCase()) {
        throw new ValidationError([{ field: 'proposedValue', code: 'IDN.CORRECTION_SAME' }]);
      }
      if (
        field === 'ADMISSION_NO' &&
        (await membersRepository.admissionTaken(trx, inst, value, m.id))
      ) {
        throw new ValidationError([
          { field: 'proposedValue', code: 'IDN.ADMISSION_NO_TAKEN', params: { n: value } },
        ]);
      }
      if (!isUuid(input.evidenceFileId)) throw new NotFoundError();
      const f = await fileRepository.findByPublicId(trx, uuidToBin(input.evidenceFileId));
      if (
        !f ||
        f.purpose !== 'evidence' ||
        f.scan_status !== 'CLEAN' ||
        String(f.institution_id) !== inst
      ) {
        throw new NotFoundError();
      }
      const shownCurrent =
        field === 'DOB' && current
          ? displayDate(current)
          : field === 'GENDER'
            ? (GENDER_LABEL[current] ?? (current || '—'))
            : current || '—';
      const shownTo =
        field === 'DOB' ? displayDate(value) : field === 'GENDER' ? GENDER_LABEL[value] : value;
      const name = [m.first_name, m.last_name].filter(Boolean).join(' ');
      const direct = await this.deps.members.adminSelfApplies(trx, p);
      const raised = await raiseApproval(trx, {
        institutionId: inst,
        module: 'PII_CORRECTION',
        summary: `${FIELD_LABELS[field]} for ${name}: ${shownCurrent} → ${shownTo} (${f.original_name} attached)`,
        payload: { member: memberId, field, correction: correction.id },
        makerType: 'staff',
        makerRef: me,
        subjectType: 'member',
        subjectRef: m.public_id,
        at,
        appliedDirectly: direct,
      });
      try {
        await trx
          .insertInto('pii_correction_requests')
          .values({
            public_id: correction.bin,
            account_id: m.account_id,
            profile_id: m.id,
            institution_id: inst,
            field,
            current_masked: shownCurrent,
            proposed_enc: this.deps.cipher.encrypt(
              'pii_correction',
              value,
              `pii_correction_requests.proposed:${correction.id}`,
            ),
            reason,
            evidence_file_id: String(f.id),
            approval_request_id: raised.rowId,
          })
          .execute();
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
          throw new ConflictError('IDN.CORRECTION_PENDING');
        }
        throw err;
      }
      await recordAudit(trx, {
        institutionId: inst,
        action: 'MEMBER_CORRECTION_REQUESTED',
        entityType: 'member',
        entityRef: memberId,
        reason,
        after: { field, approval: raised.id },
      });
      if (direct) await this.applyCorrection(trx, raised.rowId, at);
      return { approvalId: raised.id, no: raised.no, applied: direct };
    });
    return out;
  }
}

export type { ApprovalState };
