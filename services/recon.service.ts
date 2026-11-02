/**
 * Balance against ledger (RNG-GOV-018; REC-012, REC-017): every wallet's stored balance is compared
 * with the sum of its ledger entries (credits − debits). Differences are reported, never corrected —
 * a correction is a new, approved ledger entry.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../models/campusone_models';
import { NotFoundError } from '../utils/CustomAPIError';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';

export class ReconService {
  constructor(
    private readonly deps: { readonly db: Kysely<Database>; readonly now?: () => Date },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** The check for one institution (or all of them when `institutionId` is null). */
  private async check(institutionId: string | null, onlyDifferences: boolean) {
    const ledger = this.deps.db
      .selectFrom('ledger_entries')
      .select([
        'wallet_id',
        sql<string>`SUM(CASE WHEN direction = 'C' THEN amount_paise ELSE -amount_paise END)`.as(
          'net',
        ),
        sql<number>`COUNT(*)`.as('entries'),
      ])
      .where('wallet_id', 'is not', null)
      .groupBy('wallet_id')
      .as('l');
    let q = this.deps.db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .leftJoin(ledger, 'l.wallet_id', 'w.id')
      .leftJoin('institutions as i', 'i.id', 'w.institution_id')
      .select([
        'w.id',
        'w.public_id',
        'w.wallet_no',
        'w.kind',
        'i.public_id as institution_public_id',
        'i.name as institution',
        'b.available_paise',
        'b.held_paise',
        sql<string>`COALESCE(l.net, 0)`.as('net'),
        sql<number>`COALESCE(l.entries, 0)`.as('entries'),
      ]);
    if (institutionId) q = q.where('w.institution_id', '=', institutionId);
    const rows = await q.orderBy('w.id').execute();
    const differences = rows
      .map((r) => {
        const stored = Number(r.available_paise) + Number(r.held_paise);
        const fromLedger = Number(r.net);
        return { r, stored, fromLedger, diff: stored - fromLedger };
      })
      .filter((x) => !onlyDifferences || x.diff !== 0)
      .map(({ r, stored, fromLedger, diff }) => ({
        walletId: binToUuid(r.public_id),
        walletNo: r.wallet_no,
        kind: r.kind,
        institution: r.institution_public_id
          ? { id: binToUuid(r.institution_public_id), name: r.institution }
          : null,
        stored: toMoneyDto(stored),
        ledger: toMoneyDto(Math.abs(fromLedger)),
        ledgerNegative: fromLedger < 0,
        difference: toMoneyDto(Math.abs(diff)),
        differenceSign: diff === 0 ? 0 : diff > 0 ? 1 : -1,
        entries: Number(r.entries),
      }));
    return {
      checkedAt: this.now().toISOString(),
      checked: rows.length,
      differences,
    };
  }

  // --- REC-012 ------------------------------------------------------------------------------------
  async platform(f: { institutionId?: string | undefined; onlyDifferences?: boolean | undefined }) {
    let id: string | null = null;
    if (f.institutionId) {
      if (!isUuid(f.institutionId)) throw new NotFoundError();
      const i = await this.deps.db
        .selectFrom('institutions')
        .select('id')
        .where('public_id', '=', uuidToBin(f.institutionId))
        .executeTakeFirst();
      if (!i) throw new NotFoundError();
      id = String(i.id);
    }
    return this.check(id, f.onlyDifferences ?? true);
  }

  // --- REC-017 ------------------------------------------------------------------------------------
  async institution(p: Principal, f: { onlyDifferences?: boolean | undefined }) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await this.deps.db
      .selectFrom('institutions')
      .select('id')
      .where('public_id', '=', uuidToBin(p.institutionId))
      .executeTakeFirst();
    if (!i) throw new NotFoundError();
    return this.check(String(i.id), f.onlyDifferences ?? true);
  }
}
