/**
 * Campus NFC cards (SRS 21.2–21.4, 21.7, 9.5; ATT-003…007, ATT-024/025; prototype c.cards, m.card,
 * t.reader).
 *
 * - A card-issue reader writes a card for a member: the token is generated here (27.4 `NFC…`, 16
 *   characters) and the hardware UID recorded. A member has one Active card. A replacement needs a
 *   re-issue authorised in the console (lost, damaged, stolen, defective, expired); the old card is
 *   deactivated at once and its token kept.
 * - The console blocks and reactivates cards (audited, the holder told). A member, or a guardian for a
 *   child, reports a card lost: it is blocked immediately.
 * - The balance kiosk shows the holder, the campus and allowance balances and the wallet status.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import type { CardIssueReason, Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { toMoneyDto } from '../utils/money';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';
import { notify } from './notifications.service';
import { defaultValues, type SettingValues } from './settings.service';
import { usesProfile } from './member-roles';

/**
 * The value read off a card carried over from the earlier application (client 2026-10-23): that
 * application wrote an encrypted token — base64 beginning "U2FsdGVkX1" ("Salted__") — instead of
 * CampusOne's plain one. Up to 128 characters.
 */
export const LEGACY_CARD_VALUE = /^U2FsdGVkX1[A-Za-z0-9+/]{30,116}={0,2}$/;

/** The SHA-256 a carried-over card is found by (migration 0089), or null for a CampusOne token. */
export function legacyCardHash(value: string): Buffer | null {
  const v = value.trim();
  return LEGACY_CARD_VALUE.test(v) ? createHash('sha256').update(v, 'utf8').digest() : null;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const personName = (f: string | null, l: string | null) =>
  titleCase([f, l].filter(Boolean).join(' '));
const sha = (s: string) => createHash('sha256').update(s).digest();
const random = (alphabet: string, n: number) => {
  let out = '';
  for (const b of randomBytes(n)) out += alphabet[b % alphabet.length];
  return out;
};

/** 27.4: NFC + 13 [A-Z0-9]. */
export const newCardToken = () => `NFC${random(ALNUM, 13)}`;
export const maskToken = (t: string) => `NFC••••${t.slice(-4)}`;

export type ReissueReason = Exclude<CardIssueReason, 'NEW_REGISTRATION'>;

export class CardsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly settings?: { values(): Promise<SettingValues> };
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  /** An Active card of the institution by its token (another institution's card is unknown). */
  async activeCard(institutionId: string, token: string) {
    const legacy = legacyCardHash(token);
    const c = await this.deps.db
      .selectFrom('cards as c')
      .innerJoin('member_profiles as m', 'm.id', 'c.profile_id')
      .select([
        'c.id',
        'c.public_id',
        'c.profile_id',
        'c.status',
        'm.public_id as member_public_id',
        'm.first_name',
        'm.last_name',
        'm.account_id',
        'm.status as member_status',
      ])
      .where('c.institution_id', '=', institutionId)
      .where((eb) =>
        // A card carried over from the earlier application answers with that application's value.
        legacy
          ? eb('c.legacy_token_hash', '=', legacy)
          : eb('c.token', '=', token.trim().toUpperCase()),
      )
      .executeTakeFirst();
    if (!c || c.status !== 'ACTIVE') throw new CustomAPIError(409, 'ATT.CARD_NOT_ACTIVE');
    return c;
  }

  async touch(cardId: string) {
    await this.deps.db
      .updateTable('cards')
      .set({ last_tap_at: this.now() })
      .where('id', '=', cardId)
      .execute();
  }

  // --- ATT-003 (balance kiosk) ----------------------------------------------------------------------
  async kiosk(terminal: { institutionId: string }, input: { cardToken: string }) {
    const c = await this.activeCard(terminal.institutionId, input.cardToken);
    const wallets = await this.deps.db
      .selectFrom('wallets as w')
      .innerJoin('wallet_balances as b', 'b.wallet_id', 'w.id')
      .select(['w.kind', 'w.status', 'b.available_paise'])
      .where('w.owner_profile_id', '=', c.profile_id)
      .execute();
    await this.touch(String(c.id));
    const campus = wallets.find((w) => w.kind === 'CAMPUS' || w.kind === 'MERCHANT');
    const allowance = wallets.find((w) => w.kind === 'ALLOWANCE');
    return {
      member: { id: binToUuid(c.member_public_id), name: personName(c.first_name, c.last_name) },
      campus: campus
        ? { balance: toMoneyDto(Number(campus.available_paise)), status: campus.status }
        : null,
      allowance: allowance
        ? { balance: toMoneyDto(Number(allowance.available_paise)), status: allowance.status }
        : null,
    };
  }

  // --- ATT-004 (card-issue reader) ------------------------------------------------------------------
  async write(
    terminal: { id: string; institutionId: string },
    input: { memberId: string; hardwareUid: string },
  ) {
    return this.issue(
      { institutionId: terminal.institutionId, terminalId: terminal.id },
      { type: 'terminal', ref: terminal.id },
      input,
    );
  }

  // --- ATT-027 (console with a desktop NFC reader, client 2026-10-08) ------------------------------
  /**
   * The console of the CampusOne desktop app writes the card on its USB reader: the same rules as the
   * card-issue reader (one active card; a replacement needs the console's re-issue first).
   */
  async writeFromConsole(p: Principal, input: { memberId: string; hardwareUid: string }) {
    const inst = await this.own(p);
    return this.issue({ institutionId: String(inst.id), terminalId: null }, undefined, input);
  }

  private async issue(
    by: { institutionId: string; terminalId: string | null },
    actor: { type: 'terminal'; ref: string } | undefined,
    input: { memberId: string; hardwareUid: string },
  ) {
    const terminal = { id: by.terminalId, institutionId: by.institutionId };
    if (!isUuid(input.memberId)) throw new NotFoundError();
    const out = await this.deps.db.transaction().execute(async (trx) => {
      const m = await trx
        .selectFrom('member_profiles')
        .select(['id', 'first_name', 'last_name', 'status'])
        .where('institution_id', '=', terminal.institutionId)
        .where('public_id', '=', uuidToBin(input.memberId))
        .forUpdate()
        .executeTakeFirst();
      if (!m) throw new NotFoundError();
      const cards = await trx
        .selectFrom('cards')
        .select(['id', 'status', 'reissue_count'])
        .where('profile_id', '=', m.id)
        .orderBy('id', 'desc')
        .execute();
      if (cards.some((c) => c.status === 'ACTIVE')) {
        throw new CustomAPIError(409, 'ATT.CARD_ACTIVE_EXISTS', {
          params: { name: personName(m.first_name, m.last_name) },
        });
      }
      let reason: CardIssueReason = 'NEW_REGISTRATION';
      if (cards.length) {
        const auth = await trx
          .selectFrom('card_writes')
          .select(['id', 'reason'])
          .where('profile_id', '=', m.id)
          .where('used_at', 'is', null)
          .where('expires_at', '>', this.now())
          .orderBy('id', 'desc')
          .executeTakeFirst();
        if (!auth) throw new CustomAPIError(409, 'ATT.CARD_WRITE_REQUIRED');
        reason = auth.reason;
        await trx
          .updateTable('card_writes')
          .set({ used_at: this.now() })
          .where('id', '=', auth.id)
          .execute();
      }
      const token = newCardToken();
      const pub = newPublicIdPair();
      await trx
        .insertInto('cards')
        .values({
          public_id: pub.bin,
          institution_id: terminal.institutionId,
          profile_id: m.id,
          token,
          hardware_uid: input.hardwareUid.trim().toUpperCase().slice(0, 32),
          status: 'ACTIVE',
          issue_reason: reason,
          reissue_count: cards.length ? Number(cards[0]!.reissue_count) + 1 : 0,
          issued_by_terminal: terminal.id,
          issued_at: this.now(),
        })
        .execute();
      await recordAudit(trx, {
        institutionId: terminal.institutionId,
        action: cards.length ? 'CARD_REISSUED' : 'CARD_ISSUED',
        entityType: 'card',
        entityRef: pub.id,
        after: { member: input.memberId, reason, via: terminal.id ? 'reader' : 'console' },
        ...(actor ? { actor } : {}),
      });
      return { cardId: pub.id, cardToken: token };
    });
    return out;
  }

  private async cardRow(institutionId: string, cardId: string) {
    if (!isUuid(cardId)) throw new NotFoundError();
    const c = await this.deps.db
      .selectFrom('cards as c')
      .innerJoin('member_profiles as m', 'm.id', 'c.profile_id')
      .select([
        'c.id',
        'c.public_id',
        'c.profile_id',
        'c.token',
        'c.status',
        'c.issue_reason',
        'c.reissue_count',
        'c.status_reason',
        'c.blocked_at',
        'c.issued_at',
        'c.last_tap_at',
        'm.public_id as member_public_id',
        'm.first_name',
        'm.last_name',
        'm.account_id',
        'm.member_seq',
      ])
      .where('c.institution_id', '=', institutionId)
      .where('c.public_id', '=', uuidToBin(cardId))
      .executeTakeFirst();
    if (!c) throw new NotFoundError();
    return c;
  }

  private view(c: Awaited<ReturnType<CardsService['cardRow']>>) {
    return {
      id: binToUuid(c.public_id),
      member: { id: binToUuid(c.member_public_id), name: personName(c.first_name, c.last_name) },
      token: maskToken(c.token),
      status: c.status,
      issueReason: c.issue_reason,
      reissueCount: Number(c.reissue_count),
      statusReason: c.status_reason,
      blockedAt: iso(c.blocked_at),
      issuedAt: iso(c.issued_at)!,
      lastTapAt: iso(c.last_tap_at),
    };
  }

  // --- ATT-005 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: {
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      q?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    const inst = await this.own(p);
    let q = this.deps.db
      .selectFrom('cards as c')
      .innerJoin('member_profiles as m', 'm.id', 'c.profile_id')
      .select('c.public_id')
      .select('c.id')
      .where('c.institution_id', '=', inst.id);
    if (f.status) q = q.where('c.status', '=', f.status);
    const text = f.q?.trim();
    if (text) {
      const like = `%${text.replace(/[%_\\]/g, '\\$&')}%`;
      q = q.where((eb) =>
        eb.or([
          eb(sql<string>`CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))`, 'like', like),
          eb('c.token', 'like', `%${text.toUpperCase()}`),
        ]),
      );
    }
    const after = f.cursor ? idCursor.decode(f.cursor) : null;
    if (after) q = q.where('c.id', '<', after);
    const rows = await q.orderBy('c.id', 'desc').limit(51).execute();
    const page = rows.slice(0, 50);
    const cards = await Promise.all(page.map((r) => this.cardRow(inst.id, binToUuid(r.public_id))));
    return {
      items: cards.map((c) => this.view(c)),
      nextCursor: rows.length > 50 ? idCursor.encode(String(page[page.length - 1]!.id)) : null,
    };
  }

  private async tellHolder(
    institutionId: string,
    accountId: string | null,
    blocked: boolean,
    name: string,
  ) {
    if (!accountId) return;
    await notify(this.deps.db, {
      institutionId,
      accountIds: [accountId],
      surface: 'MEMBER',
      category: 'ACCOUNT',
      titleKey: blocked ? 'NTF.CARD_BLOCKED' : 'NTF.CARD_ACTIVE',
      params: { name },
      body: '',
    });
  }

  // --- ATT-006 ------------------------------------------------------------------------------------
  async setStatus(
    p: Principal,
    cardId: string,
    input: { action: 'BLOCK' | 'REACTIVATE'; reason: string },
  ) {
    const inst = await this.own(p);
    const c = await this.cardRow(inst.id, cardId);
    const reason = input.reason.trim();
    if (!reason) throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    if (input.action === 'BLOCK') {
      if (c.status !== 'ACTIVE') throw new CustomAPIError(409, 'ATT.CARD_ALREADY_BLOCKED');
      await this.deps.db
        .updateTable('cards')
        .set({
          status: 'INACTIVE',
          status_reason: reason,
          blocked_at: this.now(),
          row_version: sql<number>`row_version + 1`,
        })
        .where('id', '=', c.id)
        .execute();
    } else {
      if (c.status === 'ACTIVE') return this.view(c);
      try {
        await this.deps.db
          .updateTable('cards')
          .set({
            status: 'ACTIVE',
            status_reason: reason,
            blocked_at: null,
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', c.id)
          .execute();
      } catch (e) {
        if ((e as { errno?: number }).errno === 1062) {
          throw new CustomAPIError(409, 'ATT.CARD_ACTIVE_EXISTS', {
            params: { name: personName(c.first_name, c.last_name) },
          });
        }
        throw e;
      }
    }
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: input.action === 'BLOCK' ? 'CARD_BLOCKED' : 'CARD_REACTIVATED',
      entityType: 'card',
      entityRef: cardId.toLowerCase(),
      reason,
    });
    await this.tellHolder(
      inst.id,
      c.account_id ? String(c.account_id) : null,
      input.action === 'BLOCK',
      personName(c.first_name, c.last_name),
    );
    return this.view(await this.cardRow(inst.id, cardId));
  }

  // --- ATT-007 ------------------------------------------------------------------------------------
  async reissue(p: Principal, cardId: string, input: { reasonCode: ReissueReason }) {
    const inst = await this.own(p);
    const c = await this.cardRow(inst.id, cardId);
    const minutes = await this.limit(LIMITS.cardWriteMinutes);
    const raw = random(CODE, 8);
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(this.now().getTime() + minutes * 60_000);
    await this.deps.db.transaction().execute(async (trx) => {
      if (c.status === 'ACTIVE') {
        await trx
          .updateTable('cards')
          .set({
            status: 'INACTIVE',
            status_reason: `Re-issue: ${input.reasonCode.toLowerCase()}`,
            blocked_at: this.now(),
            row_version: sql<number>`row_version + 1`,
          })
          .where('id', '=', c.id)
          .execute();
      }
      await trx
        .insertInto('card_writes')
        .values({
          institution_id: inst.id,
          profile_id: c.profile_id,
          reason: input.reasonCode,
          code_hash: sha(raw),
          expires_at: expiresAt,
          created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
          created_at: this.now(),
        })
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'CARD_REISSUE_AUTHORISED',
        entityType: 'card',
        entityRef: cardId.toLowerCase(),
        after: { reason: input.reasonCode, expiresAt: expiresAt.toISOString() },
      });
    });
    return { pairingForWrite: { code, expiresAt: expiresAt.toISOString() } };
  }

  /** The profile a member acts for: the active one, or a profile on the same account (`for`). */
  private async memberProfile(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', (j) => j.on(usesProfile))
      .select(['m.id', 'm.institution_id', 'm.first_name', 'm.last_name', 'm.account_id'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  // --- ATT-024 ------------------------------------------------------------------------------------
  async myCard(p: Principal, forProfile?: string) {
    const m = await this.memberProfile(p, forProfile);
    const c = await this.deps.db
      .selectFrom('cards')
      .select([
        'public_id',
        'token',
        'status',
        'issue_reason',
        'reissue_count',
        'status_reason',
        'issued_at',
        'last_tap_at',
        'blocked_at',
      ])
      .where('profile_id', '=', m.id)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return {
      card: c
        ? {
            id: binToUuid(c.public_id),
            token: maskToken(c.token),
            status: c.status,
            issueReason: c.issue_reason,
            reissueCount: Number(c.reissue_count),
            statusReason: c.status_reason,
            issuedAt: iso(c.issued_at)!,
            lastTapAt: iso(c.last_tap_at),
            blockedAt: iso(c.blocked_at),
          }
        : null,
    };
  }

  // --- ATT-025 ------------------------------------------------------------------------------------
  async reportLost(
    p: Principal,
    input: { for?: string | undefined; reason?: string | null | undefined },
  ) {
    const m = await this.memberProfile(p, input.for);
    const c = await this.deps.db
      .selectFrom('cards')
      .select(['id', 'public_id'])
      .where('profile_id', '=', m.id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!c) throw new CustomAPIError(409, 'ATT.CARD_ALREADY_BLOCKED');
    const reason = input.reason?.trim() || 'Reported lost in the app';
    await this.deps.db
      .updateTable('cards')
      .set({
        status: 'INACTIVE',
        status_reason: reason,
        blocked_at: this.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', c.id)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: String(m.institution_id),
      action: 'CARD_REPORTED_LOST',
      entityType: 'card',
      entityRef: binToUuid(c.public_id),
      reason,
      actor: { type: 'member', ref: p.subject },
    });
    return { blocked: true };
  }
}
