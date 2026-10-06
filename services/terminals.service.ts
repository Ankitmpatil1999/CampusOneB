/**
 * Readers and POS terminals (CR-10, SRS 6.38.8; INS-030…034, IDN-040/041; prototype c.readers).
 *
 * - The console registers a terminal with its purpose (RC-16) and what it is bound to: a merchant
 *   (coupon counter, POS), a class section (period attendance) or a location type.
 * - Pairing: the console issues a one-time code (hashed, `trm.pairing.minutes`); the device sends it
 *   with its fingerprint and receives a device secret (shown once, stored encrypted). A new code
 *   re-pairs the terminal and replaces the secret.
 * - Sign-in: the device signs `<terminalId>.<nonce>` with HMAC-SHA256 using its secret. The nonce is
 *   `<unix seconds>.<random>`, within `trm.challenge.skewSeconds`, and accepted once. The institution
 *   must be active. The access token (audience `terminal`) carries `terminal.<purpose>`.
 * - Every terminal call re-reads the terminal: a disabled terminal or a wrong purpose is refused at
 *   once, whatever token it holds.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { LIMITS } from '../config/registers';
import { istBusinessDate } from '../utils/format';
import type { Database, TerminalPurpose } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  AuthenticationError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import type { TokenSigner } from '../utils/token-signer';
import type { FieldError } from '../utils/validators';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues } from './settings.service';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const sha = (s: string) => createHash('sha256').update(s).digest();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The sub-task a terminal's token carries for its purpose. */
export const terminalGrant = (purpose: TerminalPurpose) =>
  `terminal.${purpose.toLowerCase().replace(/_/g, '-')}`;

export interface TerminalInput {
  readonly name: string;
  readonly location?: string | null | undefined;
  readonly purpose: TerminalPurpose;
  readonly merchantId?: string | null | undefined;
  readonly sectionId?: string | null | undefined;
  readonly locationType?: string | null | undefined;
}

export class TerminalsService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly signer: TokenSigner;
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

  private async row(institutionId: string, id: string) {
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.deps.db
      .selectFrom('terminals as t')
      .leftJoin('merchants as mer', 'mer.profile_id', 't.merchant_profile_id')
      .leftJoin('member_profiles as mp', 'mp.id', 't.merchant_profile_id')
      .leftJoin('sections as s', 's.id', 't.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        't.id',
        't.public_id',
        't.institution_id',
        't.name',
        't.location',
        't.purpose',
        't.merchant_profile_id',
        't.section_id',
        't.location_type',
        't.status',
        't.status_reason',
        't.device_fingerprint',
        't.paired_at',
        't.pairing_expires_at',
        't.last_seen_at',
        't.row_version',
        'mer.display_name as merchant_name',
        'mp.public_id as merchant_public_id',
        's.public_id as section_public_id',
        's.name as section_name',
        'c.name as class_name',
      ])
      .where('t.institution_id', '=', institutionId)
      .where('t.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  private view(r: Awaited<ReturnType<TerminalsService['row']>>, onlineMinutes = 20) {
    const seen = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
    return {
      id: binToUuid(r.public_id),
      name: r.name,
      location: r.location,
      purpose: r.purpose,
      merchant: r.merchant_public_id
        ? { id: binToUuid(r.merchant_public_id), name: r.merchant_name ?? '' }
        : null,
      section: r.section_public_id
        ? {
            id: binToUuid(r.section_public_id),
            name: `${r.class_name ?? ''} ${r.section_name ?? ''}`.trim(),
          }
        : null,
      locationType: r.location_type,
      status: r.status,
      statusReason: r.status_reason,
      paired: !!r.paired_at,
      pairedAt: iso(r.paired_at),
      device: r.device_fingerprint ? `…${r.device_fingerprint.slice(-6)}` : null,
      lastSeenAt: iso(r.last_seen_at),
      /** Seen within `trm.online.minutes` (a terminal is seen on every call). */
      online: r.status === 'ACTIVE' && seen > this.now().getTime() - onlineMinutes * 60_000,
      version: r.row_version,
    };
  }

  /** The binding a purpose needs: a merchant for coupon counters and POS, a section, a location type. */
  private async binding(
    institutionId: string,
    input: Partial<TerminalInput> & { purpose: TerminalPurpose },
  ) {
    const errors: FieldError[] = [];
    let merchant: string | null = null;
    let section: string | null = null;
    if (input.purpose === 'COUPON' || input.purpose === 'POS') {
      if (!input.merchantId || !isUuid(input.merchantId)) {
        errors.push({ field: 'merchantId', code: 'VALIDATION.REQUIRED' });
      } else {
        const m = await this.deps.db
          .selectFrom('member_profiles as m')
          .innerJoin('merchants as mer', 'mer.profile_id', 'm.id')
          .select('m.id')
          .where('m.institution_id', '=', institutionId)
          .where('m.public_id', '=', uuidToBin(input.merchantId))
          .executeTakeFirst();
        if (!m) errors.push({ field: 'merchantId', code: 'MER.NOT_MERCHANT' });
        else merchant = String(m.id);
      }
    }
    if (input.purpose === 'PERIOD_ATTENDANCE') {
      if (!input.sectionId || !isUuid(input.sectionId)) {
        errors.push({ field: 'sectionId', code: 'VALIDATION.REQUIRED' });
      } else {
        const s = await this.deps.db
          .selectFrom('sections')
          .select('id')
          .where('institution_id', '=', institutionId)
          .where('public_id', '=', uuidToBin(input.sectionId))
          .executeTakeFirst();
        if (!s) errors.push({ field: 'sectionId', code: 'VALIDATION.FORMAT' });
        else section = String(s.id);
      }
    }
    if (input.purpose === 'LOCATION' && !input.locationType?.trim()) {
      errors.push({ field: 'locationType', code: 'VALIDATION.REQUIRED' });
    }
    if (errors.length) throw new ValidationError(errors);
    return {
      merchant_profile_id: merchant,
      section_id: section,
      location_type: input.purpose === 'LOCATION' ? input.locationType!.trim() : null,
    };
  }

  // --- INS-030 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: { purpose?: TerminalPurpose | undefined; status?: 'ACTIVE' | 'DISABLED' | undefined },
  ) {
    const inst = await this.own(p);
    let q = this.deps.db
      .selectFrom('terminals')
      .select('public_id')
      .where('institution_id', '=', inst.id);
    if (f.purpose) q = q.where('purpose', '=', f.purpose);
    if (f.status) q = q.where('status', '=', f.status);
    const ids = await q.orderBy('name').execute();
    const rows = await Promise.all(ids.map((r) => this.row(inst.id, binToUuid(r.public_id))));
    const minutes = await this.limit(LIMITS.terminalOnlineMinutes);
    return { items: rows.map((r) => this.view(r, minutes)) };
  }

  async detail(p: Principal, id: string) {
    const inst = await this.own(p);
    return this.view(await this.row(inst.id, id), await this.limit(LIMITS.terminalOnlineMinutes));
  }

  // --- INS-031 ------------------------------------------------------------------------------------
  async register(p: Principal, input: TerminalInput) {
    const inst = await this.own(p);
    const bind = await this.binding(inst.id, input);
    const pub = newPublicIdPair();
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const now = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('terminals')
        .values({
          public_id: pub.bin,
          institution_id: inst.id,
          name: input.name.trim(),
          location: input.location?.trim() || null,
          purpose: input.purpose,
          ...bind,
          created_by: by,
          created_at: now,
          updated_at: now,
        })
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('terminal_changes')
        .values({
          terminal_id: String(r.insertId),
          name: input.name.trim(),
          location: input.location?.trim() || null,
          purpose: input.purpose,
          changed_by: by,
          changed_at: now,
        })
        .execute();
      await recordAudit(trx, {
        institutionId: inst.id,
        action: 'TERMINAL_REGISTERED',
        entityType: 'terminal',
        entityRef: pub.id,
        after: { name: input.name, purpose: input.purpose },
      });
    });
    return { readerId: pub.id };
  }

  // --- INS-032 ------------------------------------------------------------------------------------
  async update(p: Principal, id: string, expected: number, patch: Partial<TerminalInput>) {
    const inst = await this.own(p);
    const cur = await this.row(inst.id, id);
    if (cur.row_version !== expected) throw new PreconditionFailedError();
    const purpose = patch.purpose ?? cur.purpose;
    const bind =
      patch.purpose ||
      patch.merchantId !== undefined ||
      patch.sectionId !== undefined ||
      patch.locationType !== undefined
        ? await this.binding(inst.id, {
            purpose,
            merchantId:
              patch.merchantId ??
              (cur.merchant_public_id ? binToUuid(cur.merchant_public_id) : null),
            sectionId:
              patch.sectionId ?? (cur.section_public_id ? binToUuid(cur.section_public_id) : null),
            locationType: patch.locationType ?? cur.location_type,
          })
        : {};
    const name = patch.name?.trim() ?? cur.name;
    const location = patch.location === undefined ? cur.location : patch.location?.trim() || null;
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .updateTable('terminals')
        .set({
          name,
          location,
          purpose,
          ...bind,
          row_version: sql<number>`row_version + 1`,
          updated_at: this.now(),
        })
        .where('id', '=', cur.id)
        .where('row_version', '=', expected)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
      await trx
        .insertInto('terminal_changes')
        .values({
          terminal_id: cur.id,
          name,
          location,
          purpose,
          changed_by: by,
          changed_at: this.now(),
        })
        .execute();
    });
    return this.view(await this.row(inst.id, id), await this.limit(LIMITS.terminalOnlineMinutes));
  }

  // --- INS-033 ------------------------------------------------------------------------------------
  async pairingCode(p: Principal, id: string) {
    const inst = await this.own(p);
    const cur = await this.row(inst.id, id);
    if (cur.status !== 'ACTIVE') throw new CustomAPIError(403, 'TRM.TERMINAL_DISABLED');
    const minutes = await this.limit(LIMITS.terminalPairingMinutes);
    const bytes = randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresAt = new Date(this.now().getTime() + minutes * 60_000);
    await this.deps.db
      .updateTable('terminals')
      .set({ pairing_code_hash: sha(code.replace('-', '')), pairing_expires_at: expiresAt })
      .where('id', '=', cur.id)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'TERMINAL_PAIRING_CODE_ISSUED',
      entityType: 'terminal',
      entityRef: id.toLowerCase(),
      after: { expiresAt: expiresAt.toISOString() },
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  // --- INS-034 ------------------------------------------------------------------------------------
  async setStatus(
    p: Principal,
    id: string,
    input: { enabled: boolean; reason?: string | null | undefined },
  ) {
    const inst = await this.own(p);
    const cur = await this.row(inst.id, id);
    if (!input.enabled && !input.reason?.trim()) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    }
    await this.deps.db
      .updateTable('terminals')
      .set({
        status: input.enabled ? 'ACTIVE' : 'DISABLED',
        status_reason: input.enabled ? null : input.reason!.trim(),
        // A disabled terminal must pair again: its secret is discarded.
        ...(input.enabled
          ? {}
          : { device_secret_enc: null, device_fingerprint: null, paired_at: null }),
        row_version: sql<number>`row_version + 1`,
        updated_at: this.now(),
      })
      .where('id', '=', cur.id)
      .execute();
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: input.enabled ? 'TERMINAL_ENABLED' : 'TERMINAL_DISABLED',
      entityType: 'terminal',
      entityRef: id.toLowerCase(),
      reason: input.reason ?? undefined,
    });
    return this.view(await this.row(inst.id, id), await this.limit(LIMITS.terminalOnlineMinutes));
  }

  // --- IDN-040 ------------------------------------------------------------------------------------
  async pair(input: { pairingCode: string; deviceFingerprint: string }) {
    const code = input.pairingCode.replace(/[\s-]/g, '').toUpperCase();
    const t = await this.deps.db
      .selectFrom('terminals as t')
      .innerJoin('institutions as i', 'i.id', 't.institution_id')
      .select(['t.id', 't.public_id', 't.purpose', 't.status', 't.pairing_expires_at', 'i.name'])
      .where('t.pairing_code_hash', '=', sha(code))
      .executeTakeFirst();
    if (!t || t.status !== 'ACTIVE') throw new CustomAPIError(401, 'TRM.PAIRING_CODE_INVALID');
    if (!t.pairing_expires_at || new Date(t.pairing_expires_at).getTime() <= this.now().getTime()) {
      throw new CustomAPIError(401, 'TRM.PAIRING_CODE_EXPIRED');
    }
    const secret = randomBytes(32).toString('base64url');
    const id = binToUuid(t.public_id);
    await this.deps.db
      .updateTable('terminals')
      .set({
        device_fingerprint: input.deviceFingerprint,
        device_secret_enc: this.deps.cipher.encrypt(
          'terminal_secret',
          secret,
          `terminals.secret:${id}`,
        ),
        paired_at: this.now(),
        pairing_code_hash: null,
        pairing_expires_at: null,
        // A newly paired device starts without an operator (a POS counter's session, 6.34).
        operator_tag_id: null,
        operator_since: null,
        operator_until: null,
        row_version: sql<number>`row_version + 1`,
      })
      .where('id', '=', t.id)
      .execute();
    return { terminalId: id, credential: secret, purpose: t.purpose, institution: t.name };
  }

  // --- IDN-041 ------------------------------------------------------------------------------------
  async signIn(input: {
    terminalId: string;
    deviceFingerprint: string;
    nonce: string;
    signature: string;
  }) {
    if (!isUuid(input.terminalId)) throw new CustomAPIError(401, 'TRM.SIGNATURE_INVALID');
    const t = await this.deps.db
      .selectFrom('terminals as t')
      .innerJoin('institutions as i', 'i.id', 't.institution_id')
      .select([
        't.id',
        't.public_id',
        't.purpose',
        't.status',
        't.device_fingerprint',
        't.device_secret_enc',
        'i.public_id as institution_public_id',
        'i.status as institution_status',
        'i.name as institution_name',
      ])
      .where('t.public_id', '=', uuidToBin(input.terminalId))
      .executeTakeFirst();
    if (!t || !t.device_secret_enc) throw new CustomAPIError(401, 'TRM.SIGNATURE_INVALID');
    if (t.status !== 'ACTIVE') throw new CustomAPIError(403, 'TRM.TERMINAL_DISABLED');
    if (t.device_fingerprint !== input.deviceFingerprint) {
      throw new CustomAPIError(401, 'TRM.DEVICE_MISMATCH');
    }
    const skew = await this.limit(LIMITS.terminalChallengeSkewSeconds);
    const ts = Number(input.nonce.split('.')[0]);
    if (!Number.isInteger(ts) || Math.abs(Math.floor(this.now().getTime() / 1000) - ts) > skew) {
      throw new CustomAPIError(401, 'TRM.SIGNATURE_INVALID');
    }
    const id = binToUuid(t.public_id);
    const secret = this.deps.cipher.decrypt(
      'terminal_secret',
      t.device_secret_enc,
      `terminals.secret:${id}`,
    );
    const want = createHmac('sha256', secret).update(`${id}.${input.nonce}`).digest();
    const given = /^[0-9a-f]{64}$/.test(input.signature)
      ? Buffer.from(input.signature, 'hex')
      : null;
    if (!given || !timingSafeEqual(want, given))
      throw new CustomAPIError(401, 'TRM.SIGNATURE_INVALID');
    try {
      await this.deps.db
        .insertInto('terminal_nonces')
        .values({ terminal_id: t.id, nonce: input.nonce.slice(0, 80), used_at: this.now() })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(401, 'TRM.SIGNATURE_INVALID');
      throw e;
    }
    if (t.institution_status !== 'ACTIVE') {
      throw new CustomAPIError(403, 'TRM.INSTITUTION_NOT_ACTIVE', {
        params: { institution: t.institution_name },
      });
    }
    const token = await this.deps.signer.sign({
      subject: id,
      surface: 'terminal',
      sessionId: randomUUID(),
      institutionId: binToUuid(t.institution_public_id),
      subTasks: [terminalGrant(t.purpose)],
    });
    await this.deps.db
      .updateTable('terminals')
      .set({ last_seen_at: this.now() })
      .where('id', '=', t.id)
      .execute();
    // Old nonces are of no use once outside the window.
    await this.deps.db
      .deleteFrom('terminal_nonces')
      .where('used_at', '<', new Date(this.now().getTime() - 2 * skew * 1000))
      .execute();
    return {
      accessToken: token.token,
      purpose: t.purpose,
      expiresAt: token.expiresAt.toISOString(),
    };
  }

  // --- ATT-001 (its first part: who the terminal is; periods and slots arrive with attendance) ----
  /** The terminal's identity card on its own screen (prototype t.signin, CR-10, OI-IDN-45). */
  async config(t: Awaited<ReturnType<TerminalsService['caller']>>) {
    const r = await this.deps.db
      .selectFrom('terminals as t')
      .innerJoin('institutions as i', 'i.id', 't.institution_id')
      .leftJoin('merchants as mer', 'mer.profile_id', 't.merchant_profile_id')
      .leftJoin('sections as s', 's.id', 't.section_id')
      .leftJoin('classes as c', 'c.id', 's.class_id')
      .select([
        't.public_id',
        't.name',
        't.location',
        't.purpose',
        't.section_id',
        't.location_type',
        't.device_fingerprint',
        't.paired_at',
        't.created_at',
        't.created_by',
        'i.public_id as institution_public_id',
        'i.name as institution_name',
        'i.identifier',
        'i.city',
        'i.board',
        'i.status as institution_status',
        'mer.display_name',
        'c.name as class_name',
        's.name as section_name',
      ])
      .where('t.id', '=', t.id)
      .executeTakeFirstOrThrow();
    const by = r.created_by
      ? await this.deps.db
          .selectFrom('platform_accounts')
          .select(['first_name', 'last_name'])
          .where('public_id', '=', r.created_by)
          .executeTakeFirst()
      : undefined;
    const fp = r.device_fingerprint ?? '';
    return {
      terminal: {
        id: binToUuid(r.public_id),
        name: r.name,
        location: r.location,
        purpose: r.purpose,
        locationType: r.location_type,
        fingerprint: fp ? fp.slice(-9).toUpperCase() : null,
        pairedAt: r.paired_at ? new Date(r.paired_at).toISOString() : null,
        registeredAt: new Date(r.created_at).toISOString(),
        registeredBy: by
          ? [by.first_name, by.last_name]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
          : null,
      },
      institution: {
        id: binToUuid(r.institution_public_id),
        name: r.institution_name,
        code: r.identifier,
        city: r.city,
        board: r.board,
        status: r.institution_status,
      },
      merchant: r.display_name ?? null,
      section: r.class_name ? `${r.class_name} ${r.section_name ?? ''}`.trim() : null,
      attendance: {
        doubleTapSeconds: await this.limit(LIMITS.doubleTapSeconds),
        period:
          r.purpose === 'PERIOD_ATTENDANCE' && r.section_id
            ? await this.periodNow(String(r.section_id))
            : null,
      },
    };
  }

  /** A period reader's current (or next) period today: the section's timetable in the current year. */
  private async periodNow(sectionId: string) {
    const at = this.deps.now?.() ?? new Date();
    const date = istBusinessDate(at);
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [h, m] = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(at)
      .split(':')
      .map(Number);
    const now = `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}:00`;
    const slot = await this.deps.db
      .selectFrom('timetable_slots as ts')
      .innerJoin('academic_years as y', 'y.id', 'ts.year_id')
      .innerJoin('periods as pd', 'pd.id', 'ts.period_id')
      .innerJoin('subjects as sub', 'sub.id', 'ts.subject_id')
      .innerJoin('member_profiles as t', 't.id', 'ts.teacher_profile_id')
      .select([
        'pd.name',
        'pd.starts_at',
        'pd.ends_at',
        'sub.name as subject_name',
        't.first_name',
        't.last_name',
      ])
      .where('ts.section_id', '=', sectionId)
      .where('ts.day', '=', wd === 0 ? 7 : wd)
      .where('y.starts_on', '<=', date)
      .where('y.ends_on', '>=', date)
      .where('pd.ends_at', '>', now)
      .orderBy('pd.starts_at')
      .limit(1)
      .executeTakeFirst();
    return slot
      ? {
          name: slot.name,
          subject: slot.subject_name,
          teacher: [slot.first_name, slot.last_name].filter(Boolean).join(' '),
          startsAt: slot.starts_at.slice(0, 5),
          endsAt: slot.ends_at.slice(0, 5),
          running: slot.starts_at <= now,
        }
      : null;
  }

  /**
   * Checks signatures made with the terminal's device secret (offline captures, 12.10): HMAC-SHA256
   * of the message, hex. The secret is decrypted once per batch.
   */
  async verifier(terminalId: string) {
    const t = await this.deps.db
      .selectFrom('terminals')
      .select(['public_id', 'device_secret_enc'])
      .where('id', '=', terminalId)
      .executeTakeFirst();
    if (!t?.device_secret_enc) return () => false;
    const id = binToUuid(t.public_id);
    const secret = this.deps.cipher.decrypt(
      'terminal_secret',
      t.device_secret_enc,
      `terminals.secret:${id}`,
    );
    return (message: string, signature: string) => {
      const given = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : null;
      return (
        !!given && timingSafeEqual(createHmac('sha256', secret).update(message).digest(), given)
      );
    };
  }

  /** The calling terminal, re-read on every call: active, of an active institution, of a purpose. */
  async caller(req: Request, purposes: readonly TerminalPurpose[]) {
    const p = req.principal;
    if (!p || p.surface !== 'terminal' || !isUuid(p.subject)) throw new AuthenticationError();
    const t = await this.deps.db
      .selectFrom('terminals as t')
      .innerJoin('institutions as i', 'i.id', 't.institution_id')
      .select([
        't.id',
        't.public_id',
        't.institution_id',
        't.purpose',
        't.status',
        't.merchant_profile_id',
        't.section_id',
        't.location_type',
        't.name',
        't.last_seen_at',
        'i.status as institution_status',
        'i.name as institution_name',
      ])
      .where('t.public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!t || t.status !== 'ACTIVE') throw new CustomAPIError(403, 'TRM.TERMINAL_DISABLED');
    if (t.institution_status !== 'ACTIVE') {
      throw new CustomAPIError(403, 'TRM.INSTITUTION_NOT_ACTIVE', {
        params: { institution: t.institution_name },
      });
    }
    if (!purposes.includes(t.purpose)) throw new CustomAPIError(403, 'TRM.WRONG_PURPOSE');
    // Seen now: refreshed at most once a minute (the console's online state, INS-030).
    if (!t.last_seen_at || new Date(t.last_seen_at).getTime() < this.now().getTime() - 60_000) {
      await this.deps.db
        .updateTable('terminals')
        .set({ last_seen_at: this.now() })
        .where('id', '=', t.id)
        .execute();
    }
    return {
      id: String(t.id),
      publicId: binToUuid(t.public_id),
      institutionId: String(t.institution_id),
      purpose: t.purpose,
      merchantProfileId: t.merchant_profile_id ? String(t.merchant_profile_id) : null,
      sectionId: t.section_id ? String(t.section_id) : null,
      locationType: t.location_type,
      name: t.name,
    };
  }
}
