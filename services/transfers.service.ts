/**
 * Wallet-to-wallet transfers (SRS 8.7, FR-WAL-06, BR-11…13; WAL-006/007; prototype m.transfer).
 *
 * - The institution must have the `transfers` feature on (FR-INS-04).
 * - The payer finds the recipient by mobile within the session's institution only (money never
 *   leaves an institution, BR-12). A number can carry several profiles — a parent and the children
 *   registered under it (CR-04) — so the payer chooses; names are shortened ("Aarav H.").
 * - The transfer goes through the payment engine on the TRANSFER channel: the per-transfer limit,
 *   the pending guard, wallet status, the PIN and the daily cap, then the checks and the balanced
 *   ledger pair with an RPET reference.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { CustomAPIError, NotFoundError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import type { PaymentEngine } from './payment-engine.service';

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
/** "AARAV HEGDE" → "Aarav H." (enough to recognise, not a full name to a stranger). */
const shortName = (first: string, last: string | null) =>
  `${titleCase(first)}${last ? ` ${last.trim().charAt(0).toUpperCase()}.` : ''}`;
const maskWallet = (no: string) => `•••• ${no.slice(-4)}`;

export interface TransferInput {
  readonly toProfileId: string;
  readonly amountPaise: number;
  readonly note?: string | null | undefined;
  readonly pin: string;
}

export class TransfersService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly engine: PaymentEngine;
      readonly now?: () => Date;
    },
  ) {}

  /** The payer: the session's active profile in its institution, and the account (for the PIN). */
  private async payer(p: Principal) {
    if (!p.profileId || !isUuid(p.profileId) || !p.institutionId || !isUuid(p.institutionId)) {
      throw new NotFoundError();
    }
    const r = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('institutions as i', 'i.id', 'm.institution_id')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.institution_id', 'a.id as account_id', 'a.public_id as account_public'])
      .where('m.public_id', '=', uuidToBin(p.profileId))
      .where('i.public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!r || !isUuid(p.subject) || binToUuid(r.account_public) !== p.subject.toLowerCase()) {
      throw new NotFoundError();
    }
    const on = await this.deps.db
      .selectFrom('feature_toggles')
      .select('enabled')
      .where('institution_id', '=', String(r.institution_id))
      .where('feature_key', '=', 'transfers')
      .executeTakeFirst();
    if (!on || !Number(on.enabled)) throw new CustomAPIError(409, 'PAY.TRANSFERS_OFF');
    return {
      profileId: String(r.id),
      institutionId: String(r.institution_id),
      accountId: String(r.account_id),
    };
  }

  // --- WAL-006 ------------------------------------------------------------------------------------
  async lookup(p: Principal, input: { mobile: string }) {
    const payer = await this.payer(p);
    const rows = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .leftJoin('wallets as w', (j) =>
        j.onRef('w.owner_profile_id', '=', 'm.id').on('w.kind', '=', 'CAMPUS'),
      )
      .leftJoin('academic_years as y', (j) =>
        j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
      )
      .leftJoin('enrolments as e', (j) =>
        j.onRef('e.student_profile_id', '=', 'm.id').onRef('e.year_id', '=', 'y.id'),
      )
      .leftJoin('sections as s', 's.id', 'e.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        'm.id',
        'm.public_id',
        'm.first_name',
        'm.last_name',
        'm.status',
        'ut.name as user_type',
        'ut.category',
        'w.wallet_no',
        'w.status as wallet_status',
        'c.name as class_name',
        's.name as section_name',
      ])
      .where('m.institution_id', '=', payer.institutionId)
      .where((eb) =>
        eb.or([eb('m.contact_mobile', '=', input.mobile), eb('a.mobile', '=', input.mobile)]),
      )
      .where('ut.category', '<>', 'MERCHANT')
      .orderBy('m.id')
      .execute();
    const others = rows.filter((r) => String(r.id) !== payer.profileId);
    if (!others.length) {
      throw rows.length
        ? new CustomAPIError(409, 'PAY.SELF_TRANSFER')
        : new CustomAPIError(404, 'PAY.RECIPIENT_NOT_FOUND');
    }
    const open = others.filter((r) => r.status === 'ACTIVE' && r.wallet_status === 'ACTIVE');
    if (!open.length) {
      throw new CustomAPIError(409, 'PAY.RECIPIENT_CANNOT_RECEIVE', {
        params: { name: shortName(others[0]!.first_name, others[0]!.last_name) },
      });
    }
    return {
      candidates: open.map((r) => ({
        profileId: binToUuid(r.public_id),
        name: shortName(r.first_name, r.last_name),
        userType: r.user_type,
        grade: r.class_name ? `${r.class_name}${r.section_name ? ` ${r.section_name}` : ''}` : null,
        wallet: r.wallet_no ? maskWallet(r.wallet_no) : null,
      })),
    };
  }

  // --- WAL-007 ------------------------------------------------------------------------------------
  async transfer(p: Principal, input: TransferInput, idempotencyKey: string) {
    const payer = await this.payer(p);
    if (!isUuid(input.toProfileId)) throw new CustomAPIError(404, 'PAY.RECIPIENT_NOT_FOUND');
    const to = await this.deps.db
      .selectFrom('member_profiles')
      .select(['id', 'first_name', 'last_name'])
      .where('institution_id', '=', payer.institutionId)
      .where('public_id', '=', uuidToBin(input.toProfileId))
      .executeTakeFirst();
    if (!to) throw new CustomAPIError(404, 'PAY.RECIPIENT_NOT_FOUND');
    const result = await this.deps.engine.pay({
      channel: 'TRANSFER',
      institutionId: payer.institutionId,
      payerProfileId: payer.profileId,
      payeeProfileId: String(to.id),
      amountPaise: input.amountPaise,
      remarks: input.note?.trim() || 'Transfer',
      idempotencyKey,
      auth: { kind: 'pin', accountId: payer.accountId, pin: input.pin },
      actorRef: isUuid(p.subject) ? uuidToBin(p.subject) : null,
    });
    const a = result.attempt;
    return {
      receipt: {
        id: a.id,
        reference: a.reference,
        status: a.status,
        amount: toMoneyDto(a.amountPaise),
        to: { name: shortName(to.first_name, to.last_name) },
        note: input.note?.trim() || null,
        paidAt: (a.completedAt ?? a.attemptedAt).toISOString(),
        balanceAfter:
          result.payerBalancePaise === null ? null : toMoneyDto(result.payerBalancePaise),
      },
      stages: result.stages,
      replayed: result.replayed,
    };
  }
}
