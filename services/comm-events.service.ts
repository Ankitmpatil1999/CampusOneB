/**
 * Notification settings per event (client 2026-10-16: the e-mail trigger configuration of the earlier
 * application; COM-032/033, migration 0078). Every in-app notice belongs to an event
 * (config/registers/comm-events.ts). For each event a school chooses whether the notice is also
 * e-mailed (to the student and parents, or whoever the notice is for) and whether it raises the
 * phone alert. Every event is on until the school switches it off (client).
 *
 * An e-mail goes only when the platform's e-mail channel (INT-010), the school's e-mail channel
 * (INS-011) and the event are all on. The Institution Administrator changes them in the console
 * (task config, as the school's channel switches).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { COMM_EVENTS, commEvent, type CommEventKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  CustomAPIError,
  NotFoundError,
  PreconditionFailedError,
} from '../utils/CustomAPIError';
import { isUuid, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';
import { recordAudit } from './audit.service';

type Db = Kysely<Database> | Transaction<Database>;

export interface CommEventSwitch {
  readonly email: boolean;
  readonly alert: boolean;
  readonly version: number;
}

const on = (v: unknown) => v === true || Number(v) === 1;

/** Every event's switches for a school (the register's default where none was saved). */
export async function eventSwitches(
  db: Db,
  institutionId: string,
): Promise<Map<CommEventKey, CommEventSwitch>> {
  const rows = await db
    .selectFrom('institution_comm_events')
    .select(['event_key', 'email_enabled', 'alert_enabled', 'row_version'])
    .where('institution_id', '=', institutionId)
    .execute();
  return new Map(
    COMM_EVENTS.map((e) => {
      const r = rows.find((x) => x.event_key === e.key);
      return [
        e.key,
        r
          ? { email: on(r.email_enabled), alert: on(r.alert_enabled), version: r.row_version }
          : { email: e.emailByDefault, alert: e.alertByDefault, version: 0 },
      ];
    }),
  );
}

/** Whether the platform's and the school's e-mail channels are both on. */
export async function emailChannelOn(db: Db, institutionId: string) {
  const [platform, school] = await Promise.all([
    db
      .selectFrom('messaging_channels')
      .select('enabled')
      .where('channel', '=', 'EMAIL')
      .executeTakeFirst(),
    db
      .selectFrom('notification_channel_settings')
      .select('enabled')
      .where('institution_id', '=', institutionId)
      .where('channel', '=', 'EMAIL')
      .executeTakeFirst(),
  ]);
  return on(platform?.enabled) && on(school?.enabled);
}

/** Whether a notice of this event is e-mailed at this school now. */
export async function emailWanted(db: Db, institutionId: string, event: CommEventKey) {
  if (!(await emailChannelOn(db, institutionId))) return false;
  return (await eventSwitches(db, institutionId)).get(event)?.email ?? true;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailRecipient {
  readonly email: string;
  readonly accountId: string | null;
  readonly profileId: string | null;
}

/**
 * Who a notice is e-mailed to, one per address: the students it is about and all their guardians
 * (each person's account e-mail, else the e-mail the school keeps for them), or else the notified
 * accounts (the account's e-mail, else the person's e-mail at this school).
 */
export async function emailRecipients(
  db: Db,
  institutionId: string,
  accounts: readonly string[] | null,
  about: readonly string[],
): Promise<EmailRecipient[]> {
  const out = new Map<string, EmailRecipient>();
  const add = (email: string | null | undefined, accountId: unknown, profileId: unknown) => {
    const e = email?.trim().toLowerCase();
    if (!e || !EMAIL.test(e) || out.has(e)) return;
    out.set(e, {
      email: e,
      accountId: accountId === null || accountId === undefined ? null : String(accountId),
      profileId: profileId === null || profileId === undefined ? null : String(profileId),
    });
  };
  if (about.length) {
    const guardians = await db
      .selectFrom('guardianships')
      .select('guardian_profile_id')
      .where('institution_id', '=', institutionId)
      .where('ward_profile_id', 'in', about as string[])
      .execute();
    const people = [...new Set([...about, ...guardians.map((g) => String(g.guardian_profile_id))])];
    const rows = await db
      .selectFrom('member_profiles as m')
      .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.account_id', 'm.contact_email', 'a.email'])
      .where('m.institution_id', '=', institutionId)
      .where('m.id', 'in', people)
      .orderBy('m.id')
      .execute();
    // A child without a phone sits on a parent's account: their own e-mail, not the parent's.
    const wards = new Set(about.map(String));
    for (const r of rows) {
      const own = wards.has(String(r.id)) && r.contact_email ? r.contact_email : (r.email ?? r.contact_email);
      add(own, r.account_id, r.id);
    }
    return [...out.values()];
  }
  if (!accounts?.length) return [];
  const rows = await db
    .selectFrom('platform_accounts as a')
    .leftJoin('member_profiles as m', (j) =>
      j.onRef('m.account_id', '=', 'a.id').on('m.institution_id', '=', institutionId),
    )
    .select(['a.id', 'a.email', 'm.id as profile_id', 'm.contact_email'])
    .where('a.id', 'in', accounts as string[])
    .orderBy('a.id')
    .orderBy('m.id')
    .execute();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(String(r.id))) continue;
    const email = r.email ?? rows.find((x) => String(x.id) === String(r.id) && x.contact_email)?.contact_email;
    if (email) {
      seen.add(String(r.id));
      add(email, r.id, r.profile_id);
    }
  }
  return [...out.values()];
}

export interface CommEventChange {
  readonly event: string;
  /** The version read (0 for an event never changed); a later change refuses the save. */
  readonly version: number;
  readonly email?: boolean | undefined;
  readonly alert?: boolean | undefined;
}

export class CommEventsService {
  constructor(private readonly deps: { db: Kysely<Database>; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async institution(p: Principal) {
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const i = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!i) throw new NotFoundError();
    return String(i.id);
  }

  private by(p: Principal) {
    return isUuid(p.subject) ? uuidToBin(p.subject) : null;
  }

  /** COM-032: every event with its switches and whether e-mail can go at all. */
  async list(p: Principal) {
    return this.view(await this.institution(p));
  }

  async view(institutionId: string) {
    const [switches, emailOn] = await Promise.all([
      eventSwitches(this.deps.db, institutionId),
      emailChannelOn(this.deps.db, institutionId),
    ]);
    return {
      emailChannel: emailOn,
      items: COMM_EVENTS.map((e) => {
        const s = switches.get(e.key)!;
        return {
          event: e.key,
          label: e.label,
          description: e.description,
          email: s.email,
          alert: s.alert,
          version: s.version,
        };
      }),
    };
  }

  /** COM-033: change some events; each change is guarded by the version it was read at. */
  async update(p: Principal, changes: readonly CommEventChange[]) {
    const institutionId = await this.institution(p);
    for (const c of changes) {
      if (!commEvent(c.event)) {
        throw new CustomAPIError(422, 'COM.EVENT_UNKNOWN', { params: { event: c.event } });
      }
    }
    const at = this.now();
    const by = this.by(p);
    await this.deps.db.transaction().execute(async (trx) => {
      const before = await eventSwitches(trx, institutionId);
      for (const c of changes) {
        const key = c.event as CommEventKey;
        const was = before.get(key)!;
        const email = c.email ?? was.email;
        const alert = c.alert ?? was.alert;
        if (c.version !== was.version) throw new PreconditionFailedError();
        if (email === was.email && alert === was.alert) continue;
        if (was.version === 0) {
          try {
            await trx
              .insertInto('institution_comm_events')
              .values({
                institution_id: institutionId,
                event_key: key,
                email_enabled: email,
                alert_enabled: alert,
                row_version: 1,
                updated_by: by,
                updated_at: at,
              })
              .execute();
          } catch (e) {
            // Saved meanwhile by someone else.
            if ((e as { errno?: number }).errno === 1062) throw new PreconditionFailedError();
            throw e;
          }
        } else {
          const r = await trx
            .updateTable('institution_comm_events')
            .set({
              email_enabled: email,
              alert_enabled: alert,
              row_version: sql<number>`row_version + 1`,
              updated_by: by,
              updated_at: at,
            })
            .where('institution_id', '=', institutionId)
            .where('event_key', '=', key)
            .where('row_version', '=', was.version)
            .executeTakeFirst();
          if (Number(r.numUpdatedRows) !== 1) throw new PreconditionFailedError();
        }
        await recordAudit(trx, {
          institutionId,
          action: 'COMM_EVENT_CHANGED',
          entityType: 'comm_event',
          before: { event: key, email: was.email, alert: was.alert },
          after: { event: key, email, alert },
        });
      }
    });
    return this.view(institutionId);
  }
}
