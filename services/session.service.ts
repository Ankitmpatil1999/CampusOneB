/**
 * Sessions per surface (ADR-0011, BR-05, SRS 6.35):
 * - one session per account per surface; signing in ends the previous one (OTHER_DEVICE_LOGIN);
 * - a 15-minute access token plus an opaque refresh token that rotates on every use, inside the
 *   session's absolute lifetime (member app 365 days, staff 24 hours) and, on staff surfaces, an
 *   idle limit of 15 minutes;
 * - presenting a refresh token that was already rotated (outside a short grace for parallel
 *   requests) is treated as theft: the whole family is revoked and the session ends; inside the
 *   grace it is refused as superseded and the session goes on with the winner's tokens; one whose
 *   successor was never used (the answer to its rotation was lost) is rotated again;
 * - ended sessions are added to the revocation list so their access tokens stop at once.
 */
import { randomBytes } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { LIMITS } from '../config/registers';
import type { Loggers } from '../controllers/logger';
import type { Database, SurfaceCode } from '../models/ringpe_models';
import { type RefreshTokenRow, sessionRepository } from '../repositories/session.repository';
import { AuthenticationError, CustomAPIError } from '../utils/CustomAPIError';
import { binToUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import { ipToBin, sha256 } from '../utils/ip';
import type { Surface } from '../utils/principal';
import type { SessionRevocations } from '../utils/session-revocations';
import type { TokenSigner } from '../utils/token-signer';
import { retryOnLock } from '../utils/retry';
import { defaultValues, type SettingValues } from './settings.service';

export type SessionSurface = Exclude<Surface, 'partner'>;

export const END_REASONS = [
  'SIGN_OUT',
  'OTHER_DEVICE_LOGIN',
  'REFRESH_REUSE',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'ACCOUNT_DEACTIVATED',
  'PROFILE_DELINKED',
  'ADMIN_REVOKED',
  'INSTITUTION_SUSPENDED',
  'INSTITUTION_CANCELLED',
] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Grace for two parallel refreshes with the same token (two tabs): refused, not punished. */
export const REUSE_GRACE_MS = 10_000;

/**
 * How long a rotation's answer may turn out to have been lost (the page reloaded or the connection
 * dropped mid-renewal), so that the old token is rotated again instead of being taken for theft.
 */
export const LOST_ROTATION_MS = 15 * 60_000;

const toCode = (s: SessionSurface) => s.toUpperCase() as SurfaceCode;
const fromCode = (s: SurfaceCode) => s.toLowerCase() as SessionSurface;

/**
 * Absolute lifetime and idle limit per surface: limits register (27.4 §6) defaults, overridden by
 * the platform settings in force (Q23: changeable later).
 */
export function sessionLimits(
  surface: SessionSurface,
  v: SettingValues = defaultValues(),
): { absoluteMs: number; idleMs?: number } {
  const n = (l: { key: string; value: number }) => v[l.key] ?? l.value;
  const hours = (h: number) => h * 3_600_000;
  switch (surface) {
    case 'member':
      return { absoluteMs: n(LIMITS.sessionMemberMobileDays) * 24 * 3_600_000 };
    case 'terminal':
      return { absoluteMs: hours(n(LIMITS.sessionTerminalHours)) };
    case 'console':
    case 'ops':
    case 'portal':
      return {
        absoluteMs: hours(n(LIMITS.sessionConsoleHours)),
        idleMs: n(LIMITS.idleConsoleMinutes) * 60_000,
      };
  }
}

export interface SessionSubject {
  readonly accountId: string;
  readonly accountPublicId: string;
  readonly surface: SessionSurface;
  readonly institution?: { readonly id: string; readonly publicId: string };
  readonly profile?: { readonly id: string; readonly publicId: string };
  readonly deviceId?: string;
}

export interface ClientContext {
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface SessionTokens {
  readonly sessionId: string;
  readonly surface: SessionSurface;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

/** Sub-tasks granted to the session's roles (filled by the identity module, 2.3). */
export type GrantsProvider = (s: {
  readonly accountId: string;
  readonly surface: SessionSurface;
  readonly institutionId: string | null;
  readonly profileId: string | null;
}) => Promise<readonly string[]>;

export interface SessionServiceDeps {
  readonly db: Kysely<Database>;
  readonly signer: TokenSigner;
  readonly revocations: SessionRevocations;
  readonly loggers: Loggers;
  readonly grants?: GrantsProvider;
  /** Platform settings in force (session lifetimes, access-token minutes). */
  readonly settings?: { values(): Promise<SettingValues> };
  readonly now?: () => Date;
}

const newRefreshToken = () => randomBytes(32).toString('base64url');

export class SessionService {
  private readonly now: () => Date;
  private readonly grants: GrantsProvider;

  constructor(private readonly deps: SessionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.grants = deps.grants ?? (async () => []);
  }

  /** Signs in: ends the account's other session on this surface, opens a new one, issues tokens. */
  async start(subject: SessionSubject, client: ClientContext = {}): Promise<SessionTokens> {
    const now = this.now();
    const settings = await this.settingValues();
    const limits = sessionLimits(subject.surface, settings);
    const absoluteExpiresAt = new Date(now.getTime() + limits.absoluteMs);
    const refreshExpiresAt = limits.idleMs
      ? new Date(Math.min(now.getTime() + limits.idleMs, absoluteExpiresAt.getTime()))
      : absoluteExpiresAt;
    const session = newPublicIdPair();
    const refreshToken = newRefreshToken();
    // Re-run on a deadlock: locking the (often absent) active sessions takes a gap lock that a
    // parallel sign-in of another account can share before both insert (retryOnLock).
    const ended = await retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const previous = await sessionRepository.lockActive(
          trx,
          subject.accountId,
          toCode(subject.surface),
        );
        await sessionRepository.endSessions(
          trx,
          previous.map((p) => p.id),
          'OTHER_DEVICE_LOGIN',
          now,
        );
        const sessionRowId = await sessionRepository.insertSession(trx, {
          publicId: session.bin,
          accountId: subject.accountId,
          surface: toCode(subject.surface),
          institutionId: subject.institution?.id ?? null,
          profileId: subject.profile?.id ?? null,
          deviceId: subject.deviceId ?? null,
          ip: ipToBin(client.ip),
          uaHash: client.userAgent ? sha256(client.userAgent) : null,
          absoluteExpiresAt,
        });
        await sessionRepository.insertRefreshToken(trx, {
          sessionId: sessionRowId,
          familyId: newPublicIdPair().bin,
          tokenHash: sha256(refreshToken),
          expiresAt: refreshExpiresAt,
        });
        return previous.map((p) => binToUuid(p.public_id));
      }),
    );
    await this.revokeAccessTokens(ended);
    const subTasks = await this.grants({
      accountId: subject.accountId,
      surface: subject.surface,
      institutionId: subject.institution?.id ?? null,
      profileId: subject.profile?.id ?? null,
    });
    const access = await this.deps.signer.sign(
      {
        subject: subject.accountPublicId,
        surface: subject.surface,
        sessionId: session.id,
        ...(subject.institution ? { institutionId: subject.institution.publicId } : {}),
        ...(subject.profile ? { profileId: subject.profile.publicId } : {}),
        subTasks,
      },
      await this.accessTtlSeconds(),
    );
    return {
      sessionId: session.id,
      surface: subject.surface,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }

  /**
   * Rotates a refresh token (IDN-008). `expectedSurface` binds cookie-based refreshes to the
   * surface whose cookie carried the token.
   */
  async refresh(
    refreshToken: string,
    client: ClientContext = {},
    expectedSurface?: SessionSurface,
  ): Promise<SessionTokens> {
    const now = this.now();
    const settings = await this.settingValues();
    const hash = sha256(refreshToken);
    const outcome = await this.deps.db.transaction().execute(async (trx) => {
      const row = await sessionRepository.lockByTokenHash(trx, hash);
      if (!row) return { kind: 'unknown' as const };
      const surface = fromCode(row.surface);
      if (expectedSurface && surface !== expectedSurface) return { kind: 'unknown' as const };
      let recovered = false;
      if (row.status !== 'ACTIVE') {
        if (row.endedAt !== null) return { kind: 'ended' as const, reason: row.endReason };
        const recent =
          row.status === 'ROTATED' &&
          row.rotatedAt !== null &&
          now.getTime() - new Date(row.rotatedAt).getTime() < REUSE_GRACE_MS;
        if (recent) return { kind: 'superseded' as const };
        const lost = await this.lostRotation(trx, row, now);
        if (lost === 'expired') return { kind: 'expired' as const };
        if (lost !== 'recovered') {
          await sessionRepository.revokeFamily(trx, row.familyId);
          await sessionRepository.endSessions(trx, [row.sessionId], 'REFRESH_REUSE', now);
          return { kind: 'reuse' as const, sessionPublicId: binToUuid(row.sessionPublicId), row };
        }
        recovered = true;
      } else {
        if (
          row.endedAt !== null ||
          new Date(row.expiresAt) <= now ||
          new Date(row.absoluteExpiresAt) <= now ||
          row.accountStatus !== 'ACTIVE'
        ) {
          return { kind: 'expired' as const };
        }
        if (!(await sessionRepository.markRotated(trx, row.tokenId, now))) {
          return { kind: 'superseded' as const };
        }
      }
      const limits = sessionLimits(surface, settings);
      const absolute = new Date(row.absoluteExpiresAt);
      const expiresAt = limits.idleMs
        ? new Date(Math.min(now.getTime() + limits.idleMs, absolute.getTime()))
        : absolute;
      const next = newRefreshToken();
      await sessionRepository.insertRefreshToken(trx, {
        sessionId: row.sessionId,
        familyId: row.familyId,
        tokenHash: sha256(next),
        expiresAt,
      });
      await sessionRepository.touch(trx, row.sessionId, now);
      return { kind: 'rotated' as const, row, surface, next, expiresAt, recovered };
    });

    if (outcome.kind === 'rotated' && outcome.recovered) {
      this.deps.loggers.security.info('auth.refresh_recovered', {
        sessionId: binToUuid(outcome.row.sessionPublicId),
        surface: outcome.surface,
        ip: client.ip,
      });
    }
    if (outcome.kind === 'reuse') {
      this.deps.loggers.security.warn('auth.refresh_reuse', {
        sessionId: outcome.sessionPublicId,
        surface: fromCode(outcome.row.surface),
        ip: client.ip,
      });
      await this.revokeAccessTokens([outcome.sessionPublicId]);
    }
    // A parallel renewal with the same token (another tab) won: refused, but the session goes on
    // with the winner's tokens — the caller must not clear them (client 2026-10-13).
    if (outcome.kind === 'superseded') throw new CustomAPIError(401, 'AUTH.REFRESH_SUPERSEDED');
    // Signed in again elsewhere (one session per surface, BR-05): said so, not a bare "no session".
    if (outcome.kind === 'ended' && outcome.reason === 'OTHER_DEVICE_LOGIN') {
      throw new CustomAPIError(401, 'AUTH.SIGNED_IN_ELSEWHERE');
    }
    if (outcome.kind !== 'rotated') throw new AuthenticationError();

    const { row, surface } = outcome;
    const subTasks = await this.grants({
      accountId: row.accountId,
      surface,
      institutionId: row.institutionId,
      profileId: row.profileId,
    });
    const sessionId = binToUuid(row.sessionPublicId);
    const access = await this.deps.signer.sign(
      {
        subject: binToUuid(row.accountPublicId),
        surface,
        sessionId,
        ...(row.institutionPublicId ? { institutionId: binToUuid(row.institutionPublicId) } : {}),
        // The active profile rides in every access token, not only the first (console, portal).
        ...(row.profilePublicId ? { profileId: binToUuid(row.profilePublicId) } : {}),
        subTasks,
      },
      await this.accessTtlSeconds(),
    );
    return {
      sessionId,
      surface,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: outcome.next,
      refreshTokenExpiresAt: outcome.expiresAt,
    };
  }

  /**
   * A rotation whose answer never reached the client (the page was reloaded or closed mid-renewal,
   * the connection dropped) leaves the client holding the old token while its successor goes
   * unused. That is not theft: within LOST_ROTATION_MS the old token is rotated again and the unused
   * successor revoked (client 2026-10-13: staff were signed out "many times"). Theft is still
   * caught: once the successor has been used the old token ends the family, and a thief who gets in
   * first leaves the real client a revoked successor, which ends it on its next renewal.
   */
  private async lostRotation(
    trx: Transaction<Database>,
    row: RefreshTokenRow,
    now: Date,
  ): Promise<'recovered' | 'expired' | null> {
    if (row.status !== 'ROTATED' || row.rotatedAt === null) return null;
    if (now.getTime() - new Date(row.rotatedAt).getTime() >= LOST_ROTATION_MS) return null;
    // Everything issued after it: earlier recoveries' revoked tokens, then one unused token.
    const later = await sessionRepository.laterInFamily(trx, row.familyId, row.tokenId);
    const last = later.at(-1);
    if (!last || last.status !== 'ACTIVE') return null;
    if (later.slice(0, -1).some((t) => t.status !== 'REVOKED')) return null;
    if (
      new Date(last.expiresAt) <= now ||
      new Date(row.absoluteExpiresAt) <= now ||
      row.accountStatus !== 'ACTIVE'
    ) {
      return 'expired';
    }
    await sessionRepository.revokeTokens(trx, [last.id]);
    // A second tab presenting the same old token at once is then refused as superseded.
    await sessionRepository.markRotatedAgain(trx, row.tokenId, now);
    return 'recovered';
  }

  /** Ends one session (sign-out, IDN-009). Unknown or already-ended sessions are a no-op. */
  async end(sessionPublicId: string, reason: EndReason): Promise<void> {
    const now = this.now();
    const ended = await this.deps.db.transaction().execute(async (trx) => {
      const s = await sessionRepository.findActiveByPublicId(trx, uuidToBin(sessionPublicId));
      if (!s) return false;
      await sessionRepository.endSessions(trx, [s.id], reason, now);
      return true;
    });
    if (ended) await this.revokeAccessTokens([sessionPublicId]);
  }

  /** Ends every session of an account (password change, deactivation, de-link). */
  async endAllForAccount(
    accountId: string,
    reason: EndReason,
    surfaces?: readonly SessionSurface[],
    /** Keeps this session (e.g. the one that changed the password). */
    exceptSessionId?: string,
  ): Promise<number> {
    const now = this.now();
    const ended = await this.deps.db.transaction().execute(async (trx) => {
      const rows = await sessionRepository.activeSessionsOfAccount(
        trx,
        accountId,
        surfaces?.map(toCode),
        exceptSessionId ? uuidToBin(exceptSessionId) : undefined,
      );
      await sessionRepository.endSessions(
        trx,
        rows.map((r) => r.id),
        reason,
        now,
      );
      return rows.map((r) => binToUuid(r.public_id));
    });
    await this.revokeAccessTokens(ended);
    return ended.length;
  }

  /** Ends every session opened in one institution (suspension or cancellation, FR-INS-05). */
  async endAllForInstitution(institutionId: string, reason: EndReason): Promise<number> {
    const now = this.now();
    const ended = await this.deps.db.transaction().execute(async (trx) => {
      const rows = await sessionRepository.activeSessionsOfInstitution(trx, institutionId);
      await sessionRepository.endSessions(
        trx,
        rows.map((r) => r.id),
        reason,
        now,
      );
      return rows.map((r) => binToUuid(r.public_id));
    });
    await this.revokeAccessTokens(ended);
    return ended.length;
  }

  private async settingValues(): Promise<SettingValues> {
    return this.deps.settings ? this.deps.settings.values() : defaultValues();
  }

  private async accessTtlSeconds(): Promise<number> {
    const v = await this.settingValues();
    return (v[LIMITS.accessTokenMinutes.key] ?? LIMITS.accessTokenMinutes.value) * 60;
  }

  private async revokeAccessTokens(sessionPublicIds: readonly string[]): Promise<void> {
    const until = Math.ceil(this.now().getTime() / 1000) + (await this.accessTtlSeconds()) + 5;
    for (const sid of sessionPublicIds) await this.deps.revocations.revoke(sid, until);
  }
}
