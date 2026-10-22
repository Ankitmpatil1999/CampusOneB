/**
 * Telling members of what was done for them (client 2026-10-22: "any action taken needs to inform the
 * person concerned"): each member's own account and — for a student — every parent's, in the app,
 * with the phone alert and the e-mail as the school's notification settings choose for the notice's
 * event (comm-events.ts). One notice per account, whatever the number of members it is about.
 */
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../models/ringpe_models';
import { familyAccountsByStudent } from './fee-notices.service';
import { notify } from './notifications.service';

type Db = Kysely<Database> | Transaction<Database>;

export async function tellMembers(
  db: Db,
  n: {
    readonly institutionId: string;
    /** member_profiles row ids. */
    readonly profileRowIds: readonly string[];
    readonly titleKey: string;
    readonly params?: Readonly<Record<string, string | number>>;
    readonly body: string;
    readonly link?: string | null;
    readonly category?: 'ACCOUNT' | 'PAYMENT';
  },
  at: Date,
) {
  const ids = [...new Set(n.profileRowIds.map(String))];
  if (!ids.length) return;
  const families = await familyAccountsByStudent(db, ids);
  const accounts = [...new Set([...families.values()].flat())];
  if (!accounts.length) return;
  await notify(
    db,
    {
      institutionId: n.institutionId,
      accountIds: accounts,
      about: ids,
      surface: 'MEMBER',
      category: n.category ?? 'ACCOUNT',
      titleKey: n.titleKey as Parameters<typeof notify>[1]['titleKey'],
      params: n.params ?? {},
      body: n.body,
      link: n.link ?? null,
    },
    at,
  );
}
