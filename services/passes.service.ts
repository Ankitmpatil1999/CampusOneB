/**
 * Entry passes (SRS 9.7–9.9; RC-15, OI-PAY-07/09/10, OQ-18; PAY-003…006, PAY-026…028; prototype
 * c.passes, m.passes, m.pass).
 *
 * - The institution issues a one-day pass of a registered type to students and visitors, bound to
 *   the holder's registered phone, with a number of scans; at most one live pass per holder, phone
 *   and day (RNG-PAY-080).
 * - The holder authorises it on that phone on its day: a fresh QR token valid for
 *   `pas.authorise.minutes` (RNG-PAY-100). Only the token's hash is stored.
 * - A staff member scans the token: not the holder, not from the holder's phone, within the window,
 *   the day and the scans; each scan is recorded (OI-PAY-10); the last one makes the pass USED.
 * - The institution cancels a live pass; the 23:50 job expires passes whose day has passed.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { LIMITS, PASS_TYPES } from '../config/registers';
import type { Database, PassStatus } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import type { JobContext } from '../schedulers';
import { CustomAPIError, NotFoundError, ValidationError } from '../utils/CustomAPIError';
import { formatDate, istBusinessDate } from '../utils/format';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { retryOnLock } from '../utils/retry';
import { recordAudit } from './audit.service';
import { tellMembers } from './member-notices';
import { defaultValues, type SettingValues } from './settings.service';

const day = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
const nameOf = (first: string | null, last: string | null) =>
  titleCase([first, last].filter(Boolean).join(' '));
const masked = (first: string | null, last: string | null) =>
  [titleCase(first ?? ''), last ? `${last.charAt(0).toUpperCase()}.` : '']
    .filter(Boolean)
    .join(' ');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASS_PAYLOAD = /^ringpe:\/\/pass\/([A-Z2-7]{26})$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest();
/** Who receives passes (students and visitors) and who scans them (staff). */
const HOLDER_CATEGORIES = new Set(['STUDENT', 'OTHER']);
const CHECKER_CATEGORIES = new Set(['TEACHER', 'STAFF', 'PRINCIPAL', 'MANAGEMENT', 'CREW']);

export interface PassIssueInput {
  readonly type: string;
  readonly purpose: string;
  readonly description: string;
  readonly holderIds: readonly string[];
  readonly validOn: string;
  readonly maxScans?: number | undefined;
  readonly transferAllowed?: boolean | undefined;
  readonly comments?: string | null | undefined;
}

export class PassesService {
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

  private async own(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const row = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!row) throw new NotFoundError();
    return row;
  }

  /** The visibility of a pass on a day (9.9.1): its day today, later, or gone. */
  private visibility(validOn: string, status: PassStatus, today: string) {
    if (status === 'CANCELLED') return 'CANCELLED' as const;
    if (status === 'USED') return 'USED' as const;
    if (validOn < today || status === 'EXPIRED') return 'EXPIRED' as const;
    return validOn === today ? ('VALID_TODAY' as const) : ('VALID_IN_FUTURE' as const);
  }

  private query() {
    return this.deps.db
      .selectFrom('entry_passes as p')
      .innerJoin('member_profiles as m', 'm.id', 'p.holder_profile_id')
      .select([
        'p.id',
        'p.public_id',
        'p.institution_id',
        'p.pass_type',
        'p.purpose',
        'p.description',
        'p.valid_on',
        'p.max_scans',
        'p.used_scans',
        'p.transfer_allowed',
        'p.comments',
        'p.status',
        'p.authorised_until',
        'p.cancel_reason',
        'p.ended_at',
        'p.created_at',
        'p.device_id',
        'p.holder_profile_id',
        'p.row_version',
        'm.public_id as holder_public_id',
        'm.first_name',
        'm.last_name',
        'm.admission_no',
      ]);
  }

  private view(
    r: Awaited<ReturnType<ReturnType<PassesService['query']>['execute']>>[number],
    today: string,
  ) {
    const type = PASS_TYPES.find((t) => t.code === r.pass_type);
    return {
      id: binToUuid(r.public_id),
      type: { code: r.pass_type, label: type?.label ?? r.pass_type },
      purpose: r.purpose,
      description: r.description,
      holder: {
        id: binToUuid(r.holder_public_id),
        name: nameOf(r.first_name, r.last_name),
        admissionNo: r.admission_no,
      },
      validOn: day(r.valid_on),
      maxScans: r.max_scans,
      usedScans: r.used_scans,
      transferAllowed: !!Number(r.transfer_allowed),
      comments: r.comments,
      status: r.status,
      visibility: this.visibility(day(r.valid_on), r.status, today),
      authorisedUntil: iso(r.authorised_until),
      cancelReason: r.cancel_reason,
      createdAt: iso(r.created_at)!,
      version: r.row_version,
    };
  }

  // --- PAY-027 ------------------------------------------------------------------------------------
  async issue(p: Principal, input: PassIssueInput) {
    const inst = await this.own(p);
    if (!PASS_TYPES.some((t) => t.code === input.type)) {
      throw new ValidationError([{ field: 'type', code: 'VALIDATION.FORMAT' }]);
    }
    const today = istBusinessDate(this.now());
    if (input.validOn <= today) {
      throw new ValidationError([{ field: 'validOn', code: 'PAY.PASS_DATE_NOT_FUTURE' }]);
    }
    const ids = [...new Set(input.holderIds.map((x) => x.toLowerCase()))];
    const holders = ids.filter(isUuid).length
      ? await this.deps.db
          .selectFrom('member_profiles as m')
          .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
          .leftJoin('devices as d', (j) =>
            j.onRef('d.account_id', '=', 'm.account_id').on('d.status', '=', 'ACTIVE'),
          )
          .select([
            'm.id',
            'm.public_id',
            'm.status',
            'm.account_id',
            'ut.category',
            'd.id as device_id',
          ])
          .where('m.institution_id', '=', inst.id)
          .where('m.public_id', 'in', ids.filter(isUuid).map(uuidToBin))
          .execute()
      : [];
    const byId = new Map(holders.map((h) => [binToUuid(h.public_id), h]));
    const by = isUuid(p.subject) ? uuidToBin(p.subject) : null;
    const issued: { holderId: string; passId: string }[] = [];
    const refused: { holderId: string; code: string }[] = [];
    for (const id of ids) {
      const h = byId.get(id);
      if (!h) {
        refused.push({ holderId: id, code: 'GEN.NOT_FOUND' });
        continue;
      }
      if (h.status !== 'ACTIVE' || !HOLDER_CATEGORIES.has(h.category)) {
        refused.push({ holderId: id, code: 'PAY.PASS_HOLDER_TYPE' });
        continue;
      }
      if (!h.device_id) {
        refused.push({ holderId: id, code: 'PAY.PASS_NO_DEVICE' });
        continue;
      }
      const pub = newPublicIdPair();
      try {
        await this.deps.db
          .insertInto('entry_passes')
          .values({
            public_id: pub.bin,
            institution_id: inst.id,
            pass_type: input.type,
            purpose: input.purpose.trim(),
            description: input.description.trim(),
            holder_profile_id: String(h.id),
            device_id: String(h.device_id),
            valid_on: input.validOn,
            max_scans: input.maxScans ?? 1,
            transfer_allowed: input.transferAllowed ? 1 : 0,
            comments: input.comments?.trim() || null,
            created_by: by,
          })
          .execute();
        issued.push({ holderId: id, passId: pub.id });
      } catch (e) {
        if ((e as { errno?: number }).errno === 1062) {
          refused.push({ holderId: id, code: 'PAY.PASS_DUPLICATE' });
          continue;
        }
        throw e;
      }
    }
    if (issued.length) {
      await recordAudit(this.deps.db, {
        institutionId: inst.id,
        action: 'PASSES_ISSUED',
        entityType: 'entry_pass',
        entityRef: issued[0]!.passId,
        after: { type: input.type, validOn: input.validOn, passes: issued.map((x) => x.passId) },
      });
      // The holders and their parents are told (client 2026-10-22).
      await tellMembers(
        this.deps.db,
        {
          institutionId: inst.id,
          profileRowIds: issued.map((x) => String(byId.get(x.holderId)!.id)),
          titleKey: 'NTF.PASS_ISSUED',
          params: { pass: input.purpose.trim(), date: formatDate(input.validOn) },
          body: `${input.description.trim()} — show it from the app under Passes.`.slice(0, 300),
          link: '/passes',
        },
        this.now(),
      );
    }
    return { issued, refused };
  }

  // --- PAY-026 ------------------------------------------------------------------------------------
  async list(
    p: Principal,
    f: { status?: PassStatus | undefined; type?: string | undefined; date?: string | undefined },
  ) {
    const inst = await this.own(p);
    let q = this.query().where('p.institution_id', '=', inst.id);
    if (f.status) q = q.where('p.status', '=', f.status);
    if (f.type) q = q.where('p.pass_type', '=', f.type);
    if (f.date) q = q.where('p.valid_on', '=', f.date);
    const rows = await q.orderBy('p.id', 'desc').limit(1000).execute();
    const today = istBusinessDate(this.now());
    const counts = await this.deps.db
      .selectFrom('entry_passes')
      .select(['status', sql<number>`COUNT(*)`.as('n')])
      .where('institution_id', '=', inst.id)
      .groupBy('status')
      .execute();
    const count = (s: PassStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    return {
      items: rows.map((r) => this.view(r, today)),
      counts: {
        total: counts.reduce((a, c) => a + Number(c.n), 0),
        active: count('ACTIVE') + count('AUTHORIZED'),
        used: count('USED'),
        expired: count('EXPIRED'),
        cancelled: count('CANCELLED'),
      },
      types: PASS_TYPES.map((t) => ({ code: t.code, label: t.label })),
    };
  }

  // --- PAY-028 ------------------------------------------------------------------------------------
  async cancel(p: Principal, id: string, input: { reason: string }) {
    const inst = await this.own(p);
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.query()
      .where('p.institution_id', '=', inst.id)
      .where('p.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    if (r.status === 'USED') throw new CustomAPIError(409, 'PAY.PASS_USED');
    if (r.status !== 'ACTIVE' && r.status !== 'AUTHORIZED') {
      throw new CustomAPIError(409, 'PAY.PASS_NOT_LIVE');
    }
    const res = await this.deps.db
      .updateTable('entry_passes')
      .set({
        status: 'CANCELLED',
        cancel_reason: input.reason.trim(),
        ended_at: this.now(),
        token_hash: null,
        authorised_until: null,
        row_version: sql<number>`row_version + 1`,
        updated_at: this.now(),
      })
      .where('id', '=', r.id)
      .where('status', 'in', ['ACTIVE', 'AUTHORIZED'])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'PAY.PASS_NOT_LIVE');
    await recordAudit(this.deps.db, {
      institutionId: inst.id,
      action: 'PASS_CANCELLED',
      entityType: 'entry_pass',
      entityRef: id.toLowerCase(),
      before: { status: r.status },
      after: { status: 'CANCELLED', reason: input.reason },
    });
    const after = await this.query().where('p.id', '=', r.id).executeTakeFirstOrThrow();
    // The holder and their parents are told (client 2026-10-22).
    await tellMembers(
      this.deps.db,
      {
        institutionId: inst.id,
        profileRowIds: [String(after.holder_profile_id)],
        titleKey: 'NTF.PASS_CANCELLED',
        params: { pass: after.purpose, date: formatDate(day(after.valid_on)) },
        body: input.reason.trim().slice(0, 200),
        link: '/passes',
      },
      this.now(),
    );
    return this.view(after, istBusinessDate(this.now()));
  }

  // --- PAY-003 / PAY-004 --------------------------------------------------------------------------
  private async memberOf(p: Principal, forProfile?: string) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const wanted = forProfile ?? p.profileId;
    if (!wanted || !isUuid(wanted)) throw new NotFoundError();
    const m = await this.deps.db
      .selectFrom('member_profiles as m')
      .innerJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .innerJoin('user_types as ut', 'ut.id', 'm.user_type_id')
      .select(['m.id', 'm.institution_id', 'm.status', 'ut.category'])
      .where('a.public_id', '=', uuidToBin(p.subject))
      .where('m.public_id', '=', uuidToBin(wanted))
      .executeTakeFirst();
    if (!m) throw new NotFoundError();
    return m;
  }

  async mine(p: Principal, forProfile?: string) {
    const m = await this.memberOf(p, forProfile);
    const today = istBusinessDate(this.now());
    const rows = await this.query()
      .where('p.holder_profile_id', '=', m.id)
      .where(
        'p.valid_on',
        '>=',
        new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10),
      )
      .orderBy('p.valid_on')
      .execute();
    return { items: rows.map((r) => this.view(r, today)) };
  }

  async detail(p: Principal, id: string, forProfile?: string) {
    const m = await this.memberOf(p, forProfile);
    if (!isUuid(id)) throw new NotFoundError();
    const r = await this.query()
      .where('p.holder_profile_id', '=', m.id)
      .where('p.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const scans = await this.deps.db
      .selectFrom('entry_pass_scans as s')
      .innerJoin('member_profiles as c', 'c.id', 's.checker_profile_id')
      .select(['s.scan_no', 's.scanned_at', 'c.first_name', 'c.last_name'])
      .where('s.pass_id', '=', r.id)
      .orderBy('s.scan_no')
      .execute();
    return {
      ...this.view(r, istBusinessDate(this.now())),
      scans: scans.map((s) => ({
        no: s.scan_no,
        at: iso(s.scanned_at)!,
        checker: nameOf(s.first_name, s.last_name),
      })),
    };
  }

  /** The session's device (the phone the member signed in on, IDN 6.15). */
  private async sessionDevice(p: Principal) {
    if (!isUuid(p.sessionId)) return null;
    const s = await this.deps.db
      .selectFrom('sessions')
      .select('device_id')
      .where('public_id', '=', uuidToBin(p.sessionId))
      .executeTakeFirst();
    return s?.device_id != null ? String(s.device_id) : null;
  }

  // --- PAY-005 ------------------------------------------------------------------------------------
  async authorise(p: Principal, id: string) {
    if (!p.profileId || !isUuid(p.profileId) || !isUuid(id)) throw new NotFoundError();
    const m = await this.memberOf(p);
    const r = await this.query()
      .where('p.holder_profile_id', '=', m.id)
      .where('p.public_id', '=', uuidToBin(id))
      .executeTakeFirst();
    if (!r) throw new NotFoundError();
    const today = istBusinessDate(this.now());
    if (r.status === 'CANCELLED') throw new CustomAPIError(409, 'PAY.PASS_CANCELLED');
    if (r.status === 'USED' || r.used_scans >= r.max_scans) {
      throw new CustomAPIError(409, 'PAY.PASS_USED');
    }
    if (r.status === 'EXPIRED' || day(r.valid_on) < today) {
      throw new CustomAPIError(409, 'PAY.PASS_EXPIRED');
    }
    if (day(r.valid_on) > today) throw new CustomAPIError(409, 'PAY.PASS_NOT_TODAY');
    if ((await this.sessionDevice(p)) !== String(r.device_id)) {
      throw new CustomAPIError(409, 'PAY.PASS_DEVICE_MISMATCH');
    }
    const v = this.deps.settings ? await this.deps.settings.values() : defaultValues();
    const minutes = Number(v[LIMITS.passAuthoriseMinutes.key] ?? LIMITS.passAuthoriseMinutes.value);
    const bytes = randomBytes(26);
    let token = '';
    for (const b of bytes) token += ALPHABET[b % ALPHABET.length];
    const until = new Date(this.now().getTime() + minutes * 60_000);
    const res = await this.deps.db
      .updateTable('entry_passes')
      .set({
        status: 'AUTHORIZED',
        token_hash: hashToken(token),
        authorised_until: until,
        row_version: sql<number>`row_version + 1`,
        updated_at: this.now(),
      })
      .where('id', '=', r.id)
      .where('status', 'in', ['ACTIVE', 'AUTHORIZED'])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw new CustomAPIError(409, 'PAY.PASS_USED');
    return {
      authorisedUntil: until.toISOString(),
      minutes,
      qrToken: `ringpe://pass/${token}`,
    };
  }

  // --- PAY-006 ------------------------------------------------------------------------------------
  async scan(p: Principal, input: { qrToken: string }) {
    if (!p.profileId || !isUuid(p.profileId)) throw new NotFoundError();
    const checker = await this.memberOf(p);
    if (!CHECKER_CATEGORIES.has(checker.category)) {
      throw new CustomAPIError(403, 'PAY.PASS_CHECKER');
    }
    if (checker.status !== 'ACTIVE') throw new CustomAPIError(403, 'PAY.PASS_CHECKER');
    const m = PASS_PAYLOAD.exec(input.qrToken.trim());
    if (!m) throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
    const hash = hashToken(m[1]!);
    const checkerDevice = await this.sessionDevice(p);
    const now = this.now();
    const today = istBusinessDate(now);
    return retryOnLock(() =>
      this.deps.db.transaction().execute(async (trx) => {
        const r = await trx
          .selectFrom('entry_passes')
          .selectAll()
          .where('token_hash', '=', hash)
          .where('institution_id', '=', String(checker.institution_id))
          .forUpdate()
          .executeTakeFirst();
        if (!r) throw new CustomAPIError(404, 'PAY.QR_UNKNOWN');
        if (String(r.holder_profile_id) === String(checker.id)) {
          throw new CustomAPIError(409, 'PAY.PASS_OWN');
        }
        if (
          r.status !== 'AUTHORIZED' ||
          !r.authorised_until ||
          new Date(r.authorised_until) <= now
        ) {
          throw new CustomAPIError(409, 'PAY.PASS_NOT_AUTHORISED');
        }
        if (day(r.valid_on) > today) throw new CustomAPIError(409, 'PAY.PASS_NOT_TODAY');
        if (day(r.valid_on) < today) throw new CustomAPIError(409, 'PAY.PASS_EXPIRED');
        if (r.used_scans >= r.max_scans) throw new CustomAPIError(409, 'PAY.PASS_SCAN_LIMIT');
        if (checkerDevice !== null && checkerDevice === String(r.device_id)) {
          throw new CustomAPIError(409, 'PAY.PASS_SAME_DEVICE');
        }
        const used = r.used_scans + 1;
        const last = used >= r.max_scans;
        await trx
          .updateTable('entry_passes')
          .set({
            used_scans: used,
            ...(last ? { status: 'USED' as const, ended_at: now, token_hash: null } : {}),
            row_version: sql<number>`row_version + 1`,
            updated_at: now,
          })
          .where('id', '=', r.id)
          .execute();
        await trx
          .insertInto('entry_pass_scans')
          .values({
            pass_id: r.id,
            checker_profile_id: String(checker.id),
            scanned_at: now,
            scan_no: used,
          })
          .execute();
        const h = await trx
          .selectFrom('member_profiles as m')
          .leftJoin('academic_years as y', (j) =>
            j.onRef('y.institution_id', '=', 'm.institution_id').on('y.is_current', '=', 1),
          )
          .leftJoin('enrolments as en', (j) =>
            j.onRef('en.student_profile_id', '=', 'm.id').onRef('en.year_id', '=', 'y.id'),
          )
          .leftJoin('sections as s', 's.id', 'en.section_id')
          .leftJoin('classes as c', 'c.id', 's.class_id')
          .select(['m.first_name', 'm.last_name', 'c.name as class_name', 's.name as section_name'])
          .where('m.id', '=', String(r.holder_profile_id))
          .executeTakeFirstOrThrow();
        return {
          result: last ? ('ACCEPTED_LAST' as const) : ('ACCEPTED' as const),
          holder: {
            maskedName: masked(h.first_name, h.last_name),
            classSection: h.class_name ? `${h.class_name} ${h.section_name ?? ''}`.trim() : null,
          },
          pass: {
            id: binToUuid(r.public_id),
            purpose: r.purpose,
            type: r.pass_type,
            usedScans: used,
            maxScans: r.max_scans,
          },
          scannedAt: now.toISOString(),
        };
      }),
    );
  }

  // --- job event-status: passes whose day has passed --------------------------------------------------
  async expire(ctx: Pick<JobContext, 'item' | 'periodKey'>) {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(ctx.periodKey)
      ? ctx.periodKey
      : istBusinessDate(this.now());
    const due = await this.deps.db
      .selectFrom('entry_passes')
      .select(['institution_id', sql<number>`COUNT(*)`.as('n')])
      .where('status', 'in', ['ACTIVE', 'AUTHORIZED'])
      .where('valid_on', '<', today)
      .groupBy('institution_id')
      .execute();
    let total = 0;
    for (const d of due) {
      const res = await this.deps.db
        .updateTable('entry_passes')
        .set({ status: 'EXPIRED', ended_at: this.now(), token_hash: null, authorised_until: null })
        .where('institution_id', '=', String(d.institution_id))
        .where('status', 'in', ['ACTIVE', 'AUTHORIZED'])
        .where('valid_on', '<', today)
        .executeTakeFirst();
      const n = Number(res.numUpdatedRows);
      total += n;
      ctx.item({
        institutionId: String(d.institution_id),
        status: 'SUCCESS',
        processed: n,
        failed: 0,
        note: `${n} pass${n === 1 ? '' : 'es'} expired`,
      });
    }
    return { expired: total };
  }
}
