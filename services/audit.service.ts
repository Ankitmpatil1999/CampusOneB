/**
 * Audit writer (Standards: an append-only `audit_log`; RNG-GOV-019/020). Written in the caller's
 * transaction so the record exists exactly when the change does. Before/after snapshots are
 * redacted (no PAN, identity numbers, bank accounts, secrets) before they reach the table.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/campusone_models';
import { getContext } from '../utils/request-context';
import { NIL_UUID_BIN, isUuid, uuidToBin } from '../utils/idGenerator';
import { ipToBin } from '../utils/ip';
import { redact } from '../utils/redact';

type Db = Kysely<Database> | Transaction<Database>;

export type AuditActorType =
  'member' | 'console' | 'operator' | 'portal' | 'terminal' | 'partner' | 'system';

export interface AuditEntry {
  /** Internal institution id (BIGINT) for tenant actions; omit for platform actions. */
  readonly institutionId?: string | null;
  /** UPPER_SNAKE action, e.g. SESSION_REVOKED, MEMBER_STATUS_CHANGE. */
  readonly action: string;
  readonly entityType: string;
  /** Public id of the entity. */
  readonly entityRef?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
  /** Overrides the actor taken from the request context (jobs, system actions). */
  readonly actor?: { readonly type: AuditActorType; readonly ref?: string };
}

const SURFACE_TO_ACTOR: Readonly<Record<string, AuditActorType>> = {
  member: 'member',
  console: 'console',
  ops: 'operator',
  portal: 'portal',
  terminal: 'terminal',
  partner: 'partner',
};

const snapshot = (v: unknown) => (v === undefined ? null : JSON.stringify(redact(v)));

export async function recordAudit(
  db: Db,
  entry: AuditEntry,
  now: Date = new Date(),
): Promise<void> {
  const ctx = getContext();
  const actorType =
    entry.actor?.type ??
    (ctx?.actorType ? (SURFACE_TO_ACTOR[ctx.actorType] ?? 'system') : 'system');
  const actorRef = entry.actor?.ref ?? ctx?.actorId;
  await db
    .insertInto('audit_log')
    .values({
      occurred_on: now.toISOString().slice(0, 10),
      occurred_at: now,
      institution_id: entry.institutionId ?? null,
      actor_type: actorType,
      actor_ref: actorRef && isUuid(actorRef) ? uuidToBin(actorRef) : null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_ref: entry.entityRef && isUuid(entry.entityRef) ? uuidToBin(entry.entityRef) : null,
      before_state: snapshot(entry.before),
      after_state: snapshot(entry.after),
      reason: entry.reason ?? null,
      ip: ipToBin(ctx?.ip),
      correlation_id:
        ctx?.correlationId && isUuid(ctx.correlationId)
          ? uuidToBin(ctx.correlationId)
          : NIL_UUID_BIN,
    })
    .execute();
}
