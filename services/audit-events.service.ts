/**
 * The institution's audit trail (GOV-005; NFR-06, OI-GAS-19): who changed what, when and why, with
 * the before and after values the services recorded. Read-only, newest first, scoped to the
 * session's institution. Personal numbers are never in the trail (services record masks only).
 */
import type { Kysely } from 'kysely';
import type { Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import { NotFoundError } from '../utils/CustomAPIError';
import { idCursor } from '../utils/cursor';
import { binToUuid, isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

const parse = (v: unknown) => {
  if (v === null || v === undefined) return null;
  try {
    return typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  } catch {
    return null;
  }
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

export class AuditEventsService {
  constructor(private readonly deps: { db: Kysely<Database> }) {}

  async list(
    p: Principal,
    q: {
      entity?: string | undefined;
      entityId?: string | undefined;
      actor?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    let s = this.deps.db
      .selectFrom('audit_log as l')
      .leftJoin('platform_accounts as a', 'a.public_id', 'l.actor_ref')
      .select([
        'l.id',
        'l.action',
        'l.entity_type',
        'l.entity_ref',
        'l.actor_type',
        'l.occurred_at',
        'l.before_state',
        'l.after_state',
        'l.reason',
        'a.first_name',
        'a.last_name',
      ])
      .where('l.institution_id', '=', String(inst.id));
    if (q.entity) s = s.where('l.entity_type', '=', q.entity);
    if (q.entityId) s = s.where('l.entity_ref', '=', uuidToBin(q.entityId));
    if (q.actor) s = s.where('l.actor_ref', '=', uuidToBin(q.actor));
    if (q.from) s = s.where('l.occurred_on', '>=', new Date(`${q.from}T00:00:00Z`));
    if (q.to) s = s.where('l.occurred_on', '<=', new Date(`${q.to}T00:00:00Z`));
    const before = idCursor.decode(q.cursor);
    if (before) s = s.where('l.id', '<', before);
    const rows = await s
      .orderBy('l.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        action: r.action,
        entity: { type: r.entity_type, id: r.entity_ref ? binToUuid(r.entity_ref) : null },
        actor: {
          type: r.actor_type,
          name:
            titleCase([r.first_name, r.last_name].filter(Boolean).join(' ')) ||
            (r.actor_type === 'system' ? 'System' : 'CampusOne'),
        },
        at: new Date(r.occurred_at).toISOString(),
        before: parse(r.before_state),
        after: parse(r.after_state),
        reason: r.reason,
      })),
      nextCursor: rows.length > limit && last ? idCursor.encode(last.id) : null,
    };
  }
}
