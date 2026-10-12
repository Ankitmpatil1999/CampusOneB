/**
 * Partner API clients and their tokens (SRS 8.13, 18.2; IDN-043, INT-001…008), and the checks every
 * signed partner call passes (WAL-012/013).
 *
 * - A client has a client id and one shared secret, shown once at creation or rotation and stored
 *   encrypted (it verifies token requests and signs calls). A rotation keeps the previous secret
 *   valid for `int.secret.overlapHours`.
 * - Tokens: OAuth 2 client credentials (JSON body), ES256 access tokens for the `partner` audience
 *   carrying the scopes, lifetime `auth.partner.tokenMinutes`. A new token ends the client's
 *   earlier live tokens (27.2). Every request is logged, issued or refused with the reason.
 * - A signed call: a token with the scope, an active client, an allowed address, a timestamp within
 *   `int.signature.skewSeconds` and `X-RingPe-Signature: v1=<hex HMAC-SHA256(secret,
 *   "<timestamp>.<raw body>")>`. Each request id is accepted once: a repeat with the same body
 *   returns the first response, a different body is refused (replay-safe, exactly once).
 *
 * The header names and the signature scheme are an example contract until the sponsor bank's API is
 * known (C-11); they are documented in docs/05 and configurable here only, in one place.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { INSTITUTION_SCOPES, LIMITS, PARTNER_SCOPES, type PartnerScope } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import {
  AuthenticationError,
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import type { FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { ipToBin } from '../utils/ip';
import type { Principal } from '../utils/principal';
import type { SessionRevocations } from '../utils/session-revocations';
import type { TokenSigner } from '../utils/token-signer';
import type { FieldError } from '../utils/validators';
import { recordAudit } from './audit.service';
import { defaultValues, type SettingValues, type SettingsService } from './settings.service';

export const SIGNATURE_HEADER = 'X-RingPe-Signature';
export const TIMESTAMP_HEADER = 'X-RingPe-Timestamp';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const parseList = (v: unknown): string[] => {
  try {
    const x = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

/** IPv4 dotted quad → number, or null. */
const v4 = (ip: string) => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!
    : null;
};
/** An allow-list entry: an IPv4 or IPv6 address, or an IPv4 CIDR block. */
export const validAllowEntry = (e: string) => {
  const [addr, bits] = e.split('/');
  if (bits === undefined) return isIP(addr ?? '') !== 0;
  const n = Number(bits);
  return isIP(addr ?? '') === 4 && Number.isInteger(n) && n >= 0 && n <= 32;
};
/** Whether `ip` (as Express sees it) is on the list; IPv4-mapped IPv6 is read as IPv4. */
export function ipAllowed(ip: string | undefined, list: readonly string[]): boolean {
  if (!ip) return false;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return list.some((entry) => {
    const [base, bits] = entry.split('/');
    if (bits === undefined) return base === addr;
    const a = v4(addr);
    const b = v4(base ?? '');
    if (a === null || b === null) return false;
    const n = Number(bits);
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (a & mask) >>> 0 === (b & mask) >>> 0;
  });
}

export class PartnersService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly cipher: FieldCipher;
      readonly signer: TokenSigner;
      readonly revocations?: SessionRevocations | undefined;
      readonly settings?: SettingsService;
      readonly now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async limit(l: { key: string; value: number }) {
    const v: SettingValues = this.deps.settings
      ? await this.deps.settings.values()
      : defaultValues();
    return Number(v[l.key] ?? l.value);
  }

  private aad = (publicId: string) => `api_clients.secret:${publicId}`;

  private async row(publicId: string, lock = false, db: Kysely<Database> = this.deps.db) {
    if (!isUuid(publicId)) throw new NotFoundError();
    let q = db
      .selectFrom('api_clients')
      .leftJoin('institutions as i', 'i.id', 'api_clients.institution_id')
      .selectAll('api_clients')
      .select('i.public_id as institution_public_id')
      .where('api_clients.public_id', '=', uuidToBin(publicId));
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundError();
    return r;
  }

  private present(r: Awaited<ReturnType<PartnersService['row']>>) {
    return {
      id: binToUuid(r.public_id),
      clientId: r.client_id,
      name: r.name,
      partner: r.partner,
      institutionId: r.institution_public_id ? binToUuid(r.institution_public_id) : null,
      scopes: parseList(r.scopes),
      ipAllowlist: parseList(r.ip_allowlist),
      status: r.status,
      statusReason: r.status_reason,
      secretRotatedAt: iso(r.secret_rotated_at)!,
      previousSecretValidUntil: iso(r.previous_valid_until),
      createdAt: iso(r.created_at)!,
      version: r.row_version,
    };
  }

  private checkInput(scopes?: readonly string[], allow?: readonly string[]) {
    const errors: FieldError[] = [];
    for (const s of scopes ?? []) {
      if (!(PARTNER_SCOPES as readonly string[]).includes(s)) {
        throw new CustomAPIError(422, 'INT.SCOPE_UNKNOWN', { params: { scope: s } });
      }
    }
    (allow ?? []).forEach((e, i) => {
      if (!validAllowEntry(e))
        errors.push({ field: `ipAllowlist.${i}`, code: 'VALIDATION.FORMAT' });
    });
    if (errors.length) throw new ValidationError(errors);
  }

  // --- INT-001 ------------------------------------------------------------------------------------
  async list() {
    const rows = await this.deps.db
      .selectFrom('api_clients')
      .leftJoin('institutions as i', 'i.id', 'api_clients.institution_id')
      .selectAll('api_clients')
      .select('i.public_id as institution_public_id')
      .orderBy('api_clients.id')
      .execute();
    const last = await this.deps.db
      .selectFrom('api_client_tokens')
      .select(['api_client_id', sql<Date>`MAX(issued_at)`.as('at')])
      .where('outcome', '=', 'ISSUED')
      .groupBy('api_client_id')
      .execute();
    const lastOf = new Map(last.map((x) => [String(x.api_client_id), iso(x.at)]));
    return {
      items: rows.map((r) => ({
        ...this.present(r),
        lastTokenAt: lastOf.get(String(r.id)) ?? null,
      })),
    };
  }

  // --- INT-002 ------------------------------------------------------------------------------------
  async create(
    p: Principal,
    input: {
      name: string;
      partner: string;
      scopes: readonly string[];
      ipAllowlist: readonly string[];
      institutionId?: string | undefined;
    },
  ) {
    this.checkInput(input.scopes, input.ipAllowlist);
    // A POS partner serves one institution's counters (RNG-GOV-006); others serve the platform.
    let institutionRowId: string | null = null;
    if (input.scopes.some((s) => (INSTITUTION_SCOPES as readonly string[]).includes(s))) {
      const inst = input.institutionId
        ? await this.deps.db
            .selectFrom('institutions')
            .select('id')
            .where('public_id', '=', uuidToBin(input.institutionId))
            .executeTakeFirst()
        : undefined;
      if (!inst) {
        throw new ValidationError([{ field: 'institutionId', code: 'VALIDATION.REQUIRED' }]);
      }
      institutionRowId = String(inst.id);
    }
    const name = input.name.trim();
    const taken = await this.deps.db
      .selectFrom('api_clients')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirst();
    if (taken) throw new CustomAPIError(409, 'INT.CLIENT_NAME_TAKEN');
    const pub = newPublicIdPair();
    const bytes = randomBytes(26);
    let suffix = '';
    for (const b of bytes) suffix += BASE32[b & 31];
    const clientId = `rpc_${suffix}`;
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('api_clients')
        .values({
          public_id: pub.bin,
          client_id: clientId,
          name,
          partner: input.partner,
          institution_id: institutionRowId,
          scopes: JSON.stringify([...new Set(input.scopes)]),
          ip_allowlist: JSON.stringify([...new Set(input.ipAllowlist)]),
          secret_enc: this.deps.cipher.encrypt('partner_secret', secret, this.aad(pub.id)),
          secret_rotated_at: now,
          created_by: isUuid(p.subject) ? uuidToBin(p.subject) : null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await recordAudit(trx, {
        action: 'API_CLIENT_CREATED',
        entityType: 'api_client',
        entityRef: pub.id,
        after: {
          name,
          partner: input.partner,
          scopes: input.scopes,
          ipAllowlist: input.ipAllowlist,
        },
      });
    });
    return { id: pub.id, clientId, secret };
  }

  // --- INT-003 ------------------------------------------------------------------------------------
  async update(
    p: Principal,
    id: string,
    expected: number,
    patch: {
      name?: string | undefined;
      scopes?: readonly string[] | undefined;
      ipAllowlist?: readonly string[] | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      reason?: string | null | undefined;
    },
  ) {
    this.checkInput(patch.scopes, patch.ipAllowlist);
    if (patch.status === 'INACTIVE' && !patch.reason?.trim()) {
      throw new ValidationError([{ field: 'reason', code: 'VALIDATION.REQUIRED' }]);
    }
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.row(id, true, trx);
      if (r.row_version !== expected) throw new PreconditionFailedError();
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set['name'] = patch.name.trim();
      if (patch.scopes) set['scopes'] = JSON.stringify([...new Set(patch.scopes)]);
      if (patch.ipAllowlist) set['ip_allowlist'] = JSON.stringify([...new Set(patch.ipAllowlist)]);
      if (patch.status) {
        set['status'] = patch.status;
        set['status_reason'] = patch.status === 'INACTIVE' ? patch.reason!.trim() : null;
      }
      await trx
        .updateTable('api_clients')
        .set({ ...set, row_version: sql<number>`row_version + 1`, updated_at: this.now() })
        .where('id', '=', r.id)
        .execute();
      await recordAudit(trx, {
        action: 'API_CLIENT_UPDATED',
        entityType: 'api_client',
        entityRef: id.toLowerCase(),
        after: { ...patch },
        reason: patch.reason ?? undefined,
      });
    });
    if (patch.status === 'INACTIVE') await this.endLiveTokens(id, 'Client suspended');
    return this.present(await this.row(id));
  }

  // --- INT-004 ------------------------------------------------------------------------------------
  async rotate(p: Principal, id: string, input: { overlapHours?: number | undefined }) {
    const overlap = input.overlapHours ?? (await this.limit(LIMITS.partnerSecretOverlapHours));
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > 168) {
      throw new ValidationError([
        { field: 'overlapHours', code: 'VALIDATION.RANGE', params: { min: 0, max: 168 } },
      ]);
    }
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    const until = new Date(now.getTime() + overlap * 3_600_000);
    await this.deps.db.transaction().execute(async (trx) => {
      const r = await this.row(id, true, trx);
      await trx
        .updateTable('api_clients')
        .set({
          previous_secret_enc: overlap > 0 ? r.secret_enc : null,
          previous_valid_until: overlap > 0 ? until : null,
          secret_enc: this.deps.cipher.encrypt(
            'partner_secret',
            secret,
            this.aad(binToUuid(r.public_id)),
          ),
          secret_rotated_at: now,
          row_version: sql<number>`row_version + 1`,
          updated_at: now,
        })
        .where('id', '=', r.id)
        .execute();
      await recordAudit(trx, {
        action: 'API_CLIENT_SECRET_ROTATED',
        entityType: 'api_client',
        entityRef: id.toLowerCase(),
        after: { overlapHours: overlap },
      });
    });
    void p;
    return { secret, previousSecretValidUntil: overlap > 0 ? until.toISOString() : null };
  }

  // --- INT-005 ------------------------------------------------------------------------------------
  async tokens(id: string, f: { cursor?: string | undefined; limit?: number | undefined }) {
    const r = await this.row(id);
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    let q = this.deps.db
      .selectFrom('api_client_tokens')
      .selectAll()
      .where('api_client_id', '=', r.id);
    const after = f.cursor ? idCursor.decode(f.cursor) : null;
    if (after) q = q.where('id', '<', after);
    const rows = await q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const now = this.now().getTime();
    return {
      items: page.map((t) => ({
        id: binToUuid(t.public_id),
        outcome: t.outcome,
        reason: t.reason,
        scopes: t.scopes ? parseList(t.scopes) : [],
        issuedAt: iso(t.issued_at)!,
        expiresAt: iso(t.expires_at),
        revokedAt: iso(t.revoked_at),
        live:
          t.outcome === 'ISSUED' &&
          !t.revoked_at &&
          !!t.expires_at &&
          new Date(t.expires_at).getTime() > now,
      })),
      nextCursor: rows.length > limit ? idCursor.encode(String(page[page.length - 1]!.id)) : null,
    };
  }

  /**
   * Ends every live token of the client (deny-list by token id until it would have expired); with
   * `sameScopes`, only the live tokens holding exactly those scopes.
   */
  private async endLiveTokens(
    id: string,
    reason: string,
    exceptTokenId?: string,
    sameScopes?: readonly string[],
  ) {
    const r = await this.row(id);
    const now = this.now();
    let q = this.deps.db
      .selectFrom('api_client_tokens')
      .select(['id', 'public_id', 'expires_at', 'scopes'])
      .where('api_client_id', '=', r.id)
      .where('outcome', '=', 'ISSUED')
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now);
    if (exceptTokenId) q = q.where('id', '<>', exceptTokenId);
    const key = (list: readonly string[]) => [...list].sort().join(' ');
    const live = (await q.execute()).filter(
      (t) => !sameScopes || key(parseList(t.scopes)) === key(sameScopes),
    );
    for (const t of live) {
      await this.deps.revocations?.revoke(
        binToUuid(t.public_id),
        Math.ceil(new Date(t.expires_at!).getTime() / 1000),
      );
    }
    if (live.length) {
      await this.deps.db
        .updateTable('api_client_tokens')
        .set({ revoked_at: now, revoke_reason: reason })
        .where(
          'id',
          'in',
          live.map((t) => t.id),
        )
        .execute();
    }
    return live.length;
  }

  // --- INT-006 ------------------------------------------------------------------------------------
  async revokeAll(p: Principal, id: string, input: { reason: string }) {
    const ended = await this.endLiveTokens(id, input.reason.trim());
    await recordAudit(this.deps.db, {
      action: 'API_CLIENT_TOKENS_REVOKED',
      entityType: 'api_client',
      entityRef: id.toLowerCase(),
      after: { ended },
      reason: input.reason,
      actor: { type: 'operator', ref: p.subject },
    });
  }

  // --- INT-007 / INT-008 --------------------------------------------------------------------------
  async tokenPolicy() {
    if (!this.deps.settings) {
      return { minutes: LIMITS.partnerTokenMinutes.value, min: 5, max: 60, version: 0 };
    }
    const s = (await this.deps.settings.list()).find(
      (x) => x.key === LIMITS.partnerTokenMinutes.key,
    );
    return {
      minutes: Number(s?.value ?? LIMITS.partnerTokenMinutes.value),
      min: 5,
      max: 60,
      version: s?.version ?? 0,
    };
  }

  async setTokenPolicy(p: Principal, expected: number, input: { minutes: number; reason: string }) {
    if (!this.deps.settings) throw new NotFoundError();
    await this.deps.settings.change(
      LIMITS.partnerTokenMinutes.key,
      input.minutes,
      input.reason,
      p.subject,
      expected,
    );
    return this.tokenPolicy();
  }

  private secretsOf(r: {
    public_id: Buffer;
    secret_enc: Buffer;
    previous_secret_enc: Buffer | null;
    previous_valid_until: Date | null;
  }): string[] {
    const aad = this.aad(binToUuid(r.public_id));
    const out = [this.deps.cipher.decrypt('partner_secret', r.secret_enc, aad)];
    if (
      r.previous_secret_enc &&
      r.previous_valid_until &&
      new Date(r.previous_valid_until).getTime() > this.now().getTime()
    ) {
      out.push(this.deps.cipher.decrypt('partner_secret', r.previous_secret_enc, aad));
    }
    return out;
  }

  // --- IDN-043 ------------------------------------------------------------------------------------
  /** OAuth 2 client credentials. Refusals are logged and returned as OAuth errors by the route. */
  async issueToken(
    input: {
      grantType: string;
      clientId: string;
      clientSecret: string;
      scope?: string | undefined;
    },
    ip: string | undefined,
    /**
     * Which earlier live tokens the new one ends: all of the client's (27.2, the default), or only
     * those with the same scopes — the Axis Bank asks for one token per scope (client 2026-10-12).
     */
    ends: 'all' | 'sameScopes' = 'all',
  ): Promise<
    | { ok: true; accessToken: string; expiresIn: number; scope: string }
    | {
        ok: false;
        error: 'invalid_grant_type' | 'invalid_client' | 'invalid_scope' | 'IP_NOT_ALLOWED';
      }
  > {
    if (input.grantType !== 'client_credentials') return { ok: false, error: 'invalid_grant_type' };
    const c = await this.deps.db
      .selectFrom('api_clients')
      .selectAll()
      .where('client_id', '=', input.clientId)
      .executeTakeFirst();
    const now = this.now();
    const log = async (
      outcome: 'ISSUED' | 'REFUSED',
      reason: string | null,
      scopes: string[] | null,
      expiresAt: Date | null,
      pub = newPublicIdPair(),
    ) => {
      if (!c) return pub;
      const r = await this.deps.db
        .insertInto('api_client_tokens')
        .values({
          public_id: pub.bin,
          api_client_id: c.id,
          outcome,
          reason,
          scopes: scopes ? JSON.stringify(scopes) : null,
          ip_bin: ipToBin(ip),
          issued_at: now,
          expires_at: expiresAt,
        })
        .executeTakeFirstOrThrow();
      return { ...pub, rowId: String(r.insertId) };
    };
    const given = Buffer.from(input.clientSecret);
    const secretOk =
      !!c &&
      this.secretsOf(c).some((s) => {
        const want = Buffer.from(s);
        return want.length === given.length && timingSafeEqual(want, given);
      });
    if (!c || c.status !== 'ACTIVE' || !secretOk) {
      await log('REFUSED', 'invalid_client', null, null);
      return { ok: false, error: 'invalid_client' };
    }
    if (!ipAllowed(ip, parseList(c.ip_allowlist))) {
      await log('REFUSED', 'IP_NOT_ALLOWED', null, null);
      return { ok: false, error: 'IP_NOT_ALLOWED' };
    }
    const held = parseList(c.scopes);
    const asked = input.scope?.trim() ? input.scope.trim().split(/\s+/) : held;
    if (!asked.length || asked.some((s) => !held.includes(s))) {
      await log('REFUSED', 'invalid_scope', null, null);
      return { ok: false, error: 'invalid_scope' };
    }
    const minutes = await this.limit(LIMITS.partnerTokenMinutes);
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const pub = newPublicIdPair();
    const token = await this.deps.signer.sign(
      { subject: binToUuid(c.public_id), surface: 'partner', sessionId: pub.id, subTasks: asked },
      minutes * 60,
    );
    const logged = await log('ISSUED', null, asked, expiresAt, pub);
    // 27.2: a new token for the client ends its earlier live tokens.
    await this.endLiveTokens(
      binToUuid(c.public_id),
      'A newer token was issued',
      'rowId' in logged ? logged.rowId : undefined,
      ends === 'sameScopes' ? asked : undefined,
    );
    return { ok: true, accessToken: token.token, expiresIn: minutes * 60, scope: asked.join(' ') };
  }

  /**
   * The checks a bearer-only partner call passes (the Axis Bank format, which isn't signed): the
   * token's client is active, the caller's address is on its allow-list, and the token holds the
   * scope. Answers instead of throwing, so the caller can reply in the partner's own format.
   */
  async bearerClient(
    principal: Principal | undefined,
    ip: string | undefined,
    scope: PartnerScope,
  ): Promise<
    | { ok: true; clientRowId: string }
    | { ok: false; reason: 'INVALID_TOKEN' | 'IP_NOT_ALLOWED' | 'INSUFFICIENT_SCOPE' }
  > {
    if (!principal || principal.surface !== 'partner')
      return { ok: false, reason: 'INVALID_TOKEN' };
    const c = await this.deps.db
      .selectFrom('api_clients')
      .select(['id', 'status', 'ip_allowlist'])
      .where('public_id', '=', uuidToBin(principal.subject))
      .executeTakeFirst();
    if (!c || c.status !== 'ACTIVE') return { ok: false, reason: 'INVALID_TOKEN' };
    if (!ipAllowed(ip, parseList(c.ip_allowlist))) return { ok: false, reason: 'IP_NOT_ALLOWED' };
    if (!principal.subTasks.includes(scope)) return { ok: false, reason: 'INSUFFICIENT_SCOPE' };
    return { ok: true, clientRowId: String(c.id) };
  }

  // --- Signed partner calls (WAL-012/013) -----------------------------------------------------------
  /** The checks every signed call passes; returns the client's row id. */
  async verifySigned(
    req: Request,
    scope: PartnerScope,
  ): Promise<{ clientRowId: string; institutionId: string | null }> {
    const p = req.principal;
    if (!p || p.surface !== 'partner') throw new AuthenticationError();
    if (!p.subTasks.includes(scope)) throw new CustomAPIError(403, 'INT.SCOPE_MISSING');
    const c = await this.deps.db
      .selectFrom('api_clients')
      .selectAll()
      .where('public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!c || c.status !== 'ACTIVE') throw new CustomAPIError(401, 'INT.INVALID_CLIENT');
    if (!ipAllowed(req.ip, parseList(c.ip_allowlist))) {
      throw new CustomAPIError(403, 'INT.IP_NOT_ALLOWED');
    }
    const skew = await this.limit(LIMITS.partnerSignatureSkewSeconds);
    const ts = Number(req.get(TIMESTAMP_HEADER));
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > skew) {
      throw new CustomAPIError(401, 'INT.TIMESTAMP_SKEW', { params: { seconds: skew } });
    }
    const raw = req.rawBody ?? Buffer.alloc(0);
    const sig = /^v1=([0-9a-f]{64})$/.exec(req.get(SIGNATURE_HEADER) ?? '')?.[1];
    const given = sig ? Buffer.from(sig, 'hex') : null;
    const ok =
      !!given &&
      this.secretsOf(c).some((s) => {
        const want = createHmac('sha256', s).update(`${ts}.`).update(raw).digest();
        return timingSafeEqual(want, given);
      });
    if (!ok) throw new CustomAPIError(401, 'INT.SIGNATURE_INVALID');
    return {
      clientRowId: String(c.id),
      institutionId: c.institution_id ? String(c.institution_id) : null,
    };
  }

  /**
   * Runs a signed call once per (client, endpoint, request id): a repeat with the same body returns
   * the stored response; a different body, or a repeat while the first is still running, is refused.
   */
  async once<T extends object>(
    clientRowId: string,
    endpoint: string,
    requestId: string,
    raw: Buffer | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const hash = createHash('sha256')
      .update(raw ?? Buffer.alloc(0))
      .digest();
    const prior = await this.deps.db
      .selectFrom('partner_requests')
      .selectAll()
      .where('api_client_id', '=', clientRowId)
      .where('endpoint', '=', endpoint)
      .where('request_id', '=', requestId)
      .executeTakeFirst();
    if (prior) {
      if (!prior.body_hash.equals(hash) || prior.response === null) {
        throw new CustomAPIError(409, 'INT.REQUEST_REPLAYED');
      }
      const stored = prior.response;
      return (typeof stored === 'string' ? JSON.parse(stored) : stored) as T;
    }
    try {
      await this.deps.db
        .insertInto('partner_requests')
        .values({
          api_client_id: clientRowId,
          endpoint,
          request_id: requestId,
          body_hash: hash,
          received_at: this.now(),
        })
        .execute();
    } catch (e) {
      if ((e as { errno?: number }).errno === 1062)
        throw new CustomAPIError(409, 'INT.REQUEST_REPLAYED');
      throw e;
    }
    let out: T;
    try {
      out = await run();
    } catch (e) {
      // A failed call leaves no claim behind, so the partner can retry it.
      await this.deps.db
        .deleteFrom('partner_requests')
        .where('api_client_id', '=', clientRowId)
        .where('endpoint', '=', endpoint)
        .where('request_id', '=', requestId)
        .execute();
      throw e;
    }
    await this.deps.db
      .updateTable('partner_requests')
      .set({ status_code: 200, response: JSON.stringify(out) })
      .where('api_client_id', '=', clientRowId)
      .where('endpoint', '=', endpoint)
      .where('request_id', '=', requestId)
      .execute();
    return out;
  }
}
