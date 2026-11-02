/**
 * In-app notifications (SRS 6.32, 23.7; COM-009/010 console bell, COM-014/015 member app; prototype
 * shell.cnotifs). Other services call `notify` inside their own transaction, so a notification exists
 * exactly when the change it reports does. The title is a message key rendered in the reader's
 * language (the response carries the key, its parameters and the English text); the body is the
 * request's own text.
 *
 * On the web (client 2026-10-21): the console bell also lists the account's member-app notices from
 * that school when the console session works as a teacher, principal or merchant (they reach their
 * notices on the web too), and the back office has its own bell (OPS, migration 0080).
 */
import { emit, rooms } from '../utils/outbox';
import type { Kysely, Transaction } from 'kysely';
import { commEventOf, renderMessage, type MessageKey } from '../config/registers';
import type { Database } from '../models/campusone_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  notificationsRepository,
  type NotificationSurface,
  type Surfaces,
} from '../repositories/notifications.repository';
import { NotFoundError } from '../utils/CustomAPIError';
import { logCommSafely } from './comm-log.service';
import {
  emailRecipients,
  emailWanted,
  eventSwitches,
  type CommEventSwitch,
} from './comm-events.service';
import { queuePushes } from './push.service';
import { idCursor } from '../utils/cursor';
import { binToUuid, isUuid, newPublicIdPair, uuidToBin } from '../utils/idGenerator';
import type { Principal } from '../utils/principal';

type Db = Kysely<Database> | Transaction<Database>;

export interface NotifyInput {
  readonly institutionId: string | null;
  readonly accountIds: readonly string[];
  readonly surface: NotificationSurface;
  readonly category: 'APPROVAL' | 'CORRECTION' | 'JOB' | 'ACCOUNT' | 'PAYMENT' | 'MESSAGE';
  readonly titleKey: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly body: string;
  readonly link?: string | null;
  /** The member or user who raised it; none: a business event (CR-16). */
  readonly raiser?: Buffer | null;
  /** `false`: the caller logs the send itself (announcements, direct messages). */
  readonly log?: false;
  /** `false`: never e-mailed here (announcements e-mail through their own channels). */
  readonly email?: false;
  /** `false`: never pushed to the phone (push.service.ts). */
  readonly push?: false;
  /**
   * The students (profile row ids) the notice is about: the e-mail goes to each of them and all their
   * parents as people — the account's e-mail, else the one the school keeps — so a parent without
   * the app is e-mailed too (client 2026-10-16, as the earlier application). Without it, the
   * e-mail goes to the notified accounts.
   */
  readonly about?: readonly string[];
  /**
   * The e-mail also tells each person how to sign in to the CampusOne app (client 2026-10-22, the
   * class placement e-mail): the mobile number to sign in with and their password, or — without an
   * account yet — to sign up with the mobile the school holds (a code is sent to it; the school's
   * profile links at sign-up). Never a password: CampusOne keeps none it could send.
   */
  readonly signIn?: boolean;
}

/** "98861 10000". */
const spaced = (mobile: string) =>
  /^\d{10}$/.test(mobile) ? `${mobile.slice(0, 5)} ${mobile.slice(5)}` : mobile;

/** Each recipient's own sign-in lines, by their profile at the school (else their account). */
async function signInTexts(
  db: Db,
  people: readonly { accountId: string | null; profileId: string | null }[],
) {
  const profiles = people.map((p) => p.profileId).filter((x): x is string => !!x);
  const accounts = people.map((p) => p.accountId).filter((x): x is string => !!x);
  const rows = profiles.length
    ? await db
        .selectFrom('member_profiles as m')
        .leftJoin('platform_accounts as a', 'a.id', 'm.account_id')
        .select(['m.id', 'm.contact_mobile', 'a.mobile'])
        .where('m.id', 'in', profiles)
        .execute()
    : [];
  const owners = accounts.length
    ? await db
        .selectFrom('platform_accounts')
        .select(['id', 'mobile'])
        .where('id', 'in', accounts)
        .execute()
    : [];
  const byProfile = new Map(rows.map((r) => [String(r.id), r]));
  const byAccount = new Map(owners.map((r) => [String(r.id), r.mobile]));
  return people.map((p) => {
    const r = p.profileId ? byProfile.get(p.profileId) : undefined;
    const registered = r?.mobile ?? (p.accountId ? byAccount.get(p.accountId) : undefined);
    if (registered) {
      return [
        'Signing in to the CampusOne app:',
        `Mobile number: ${spaced(registered)}`,
        'Password: the one you chose. Forgotten it? Tap "Forgot password?" on the sign-in screen and a code is sent to this mobile.',
      ].join('\n');
    }
    if (r?.contact_mobile) {
      return [
        'Signing in to the CampusOne app:',
        'Open the CampusOne app and tap "Sign up".',
        `Mobile number: ${spaced(r.contact_mobile)} — a one-time code is sent to it.`,
        'Then choose your password. Your school profile is linked to it, and from then on you sign in with this mobile and that password.',
      ].join('\n');
    }
    return null;
  });
}

/** Adds one notification per account (duplicates and empty lists are ignored). */
export async function notify(db: Db, n: NotifyInput, at: Date = new Date()) {
  const accounts = [...new Set(n.accountIds)];
  const ids = accounts.map(() => newPublicIdPair());
  if (accounts.length) {
    await notificationsRepository.insertMany(
      db,
      accounts.map((accountId, i) => ({
        publicId: ids[i]!.bin,
        institutionId: n.institutionId,
        accountId,
        surface: n.surface,
        category: n.category,
        titleKey: n.titleKey,
        params: n.params ?? {},
        body: n.body,
        link: n.link ?? null,
        at,
      })),
    );
    const surface = n.surface === 'CONSOLE' ? 'console' : n.surface === 'OPS' ? 'ops' : 'member';
    await emit(db, {
      institutionId: n.institutionId,
      type: 'notification.created',
      rooms: accounts.map((a) => rooms.account(a, surface)),
      data: { category: n.category },
    });
  }
  const event = commEventOf(n.titleKey);
  // Client 2026-10-19: pushed to the phone, so it shows with the app closed or the phone locked —
  // the member app's for a member notice, the staff app's for a console one (Accounts, Co-ordinator,
  // Counsellor). Sent after the commit (push-relay.service.ts).
  if (n.surface !== 'OPS' && n.push !== false && accounts.length) {
    await queuePushes(
      db,
      {
        institutionId: n.institutionId,
        accountIds: accounts,
        surface: n.surface,
        refs: ids.map((x) => x.bin),
        eventKey: event?.key ?? null,
        titleKey: n.titleKey,
        params: n.params ?? {},
        body: n.body,
        link: n.link ?? null,
      },
      at,
    );
  }
  // Client 2026-10-16: also e-mailed when the event, the school and the platform allow it. The rows
  // are written in this transaction; the relay sends them after the commit (email-relay.service.ts).
  if (
    event &&
    n.email !== false &&
    n.institutionId &&
    (accounts.length || n.about?.length) &&
    (await emailWanted(db, n.institutionId, event.key))
  ) {
    const to = await emailRecipients(
      db,
      n.institutionId,
      n.about?.length ? null : accounts,
      n.about ?? [],
    );
    if (to.length) {
      const subject = renderMessage(n.titleKey, n.params ?? {}).slice(0, 200);
      const signIn = n.signIn ? await signInTexts(db, to) : to.map(() => null);
      const refOf = (accountId: string | null) => {
        const i = accountId ? accounts.indexOf(accountId) : -1;
        return i >= 0 ? ids[i]!.bin : null;
      };
      await db
        .insertInto('email_outbox')
        .values(
          to.map((r, i) => ({
            institution_id: n.institutionId,
            account_id: r.accountId,
            profile_id: r.profileId,
            to_email: r.email,
            event_key: event.key,
            notification_ref: refOf(r.accountId),
            subject,
            body: (signIn[i]
              ? `${n.body.slice(0, 300)}\n\n${signIn[i]}`
              : n.body.slice(0, 300)
            ).slice(0, 1000),
            next_attempt_at: at,
            created_at: at,
          })),
        )
        .execute();
    }
  }
  if (n.log === false || !accounts.length) return;
  // Every in-app notification is in the communication log (CR-16, RNG-COM-181).
  const subject = renderMessage(n.titleKey, n.params ?? {});
  await logCommSafely(
    db,
    accounts.map((accountId, i) => ({
      institutionId: n.institutionId,
      kind: 'NOTIFICATION' as const,
      channel: 'IN_APP' as const,
      recipientAccountId: accountId,
      recipient:
        n.surface === 'CONSOLE' ? 'Console' : n.surface === 'OPS' ? 'Back office' : 'In-app',
      raiser: n.raiser ?? null,
      outcome: 'SUCCESS' as const,
      refType: `notification.${n.category.toLowerCase()}`,
      refId: ids[i]!.id,
      subject,
    })),
    at,
  );
}

const parse = (v: unknown): Record<string, string | number> => {
  if (v === null || v === undefined) return {};
  try {
    const o = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
    return o && typeof o === 'object' ? (o as Record<string, string | number>) : {};
  } catch {
    return {};
  }
};

/**
 * Console sessions that also read the account's member-app notices in the bell: a teacher, a
 * principal or a merchant working on the web (the same grants that open /me/notifications there).
 */
export const MEMBER_NOTICES_ON_CONSOLE = [
  'teaching.view',
  'principal.view',
  'business.view',
] as const;

/** The bell a caller reads: one surface, or the console's own and the member app's together. */
type Bell = 'CONSOLE' | 'MEMBER' | 'OPS';

export class NotificationsService {
  constructor(private readonly deps: { db: Kysely<Database>; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async account(p: Principal) {
    if (!isUuid(p.subject)) throw new NotFoundError();
    const a = await this.deps.db
      .selectFrom('platform_accounts')
      .select('id')
      .where('public_id', '=', uuidToBin(p.subject))
      .executeTakeFirst();
    if (!a) throw new NotFoundError();
    return String(a.id);
  }

  private async scope(
    p: Principal,
    bell: Bell,
  ): Promise<{ accountId: string; institutionId: string | null; surfaces: Surfaces }> {
    const accountId = await this.account(p);
    if (bell === 'MEMBER' || bell === 'OPS')
      return { accountId, institutionId: null, surfaces: bell };
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    const both = MEMBER_NOTICES_ON_CONSOLE.some((g) => p.subTasks.includes(g));
    return {
      accountId,
      institutionId: String(inst.id),
      surfaces: both ? (['CONSOLE', 'MEMBER'] as const) : 'CONSOLE',
    };
  }

  /** COM-009 / COM-014: newest first, with the unread count. */
  async list(
    p: Principal,
    bell: Bell,
    q: { unread?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined },
  ) {
    const { accountId, institutionId, surfaces: surface } = await this.scope(p, bell);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const rows = await notificationsRepository.page(
      this.deps.db,
      accountId,
      surface,
      institutionId,
      { unread: q.unread === true, before: idCursor.decode(q.cursor), limit },
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const alerts = await this.alerts(
      accountId,
      surface,
      institutionId,
      page.map((r) => r.institution_id),
    );
    return {
      unread: await notificationsRepository.unread(this.deps.db, accountId, surface, institutionId),
      /** Unread notices whose event raises the phone alert at their school (client 2026-10-16). */
      alertUnread: alerts.unread,
      items: page.map((r) => {
        const params = parse(r.params);
        return {
          id: binToUuid(r.public_id),
          /** Where it was sent: the web opens a member-app link at its own page. */
          surface: r.surface,
          category: r.category,
          titleKey: r.title_key,
          params,
          title: renderMessage(r.title_key as MessageKey, params),
          body: r.body,
          link: r.link,
          read: r.read_at !== null,
          alert: alerts.raises(r.institution_id, r.title_key),
          at: new Date(r.created_at).toISOString(),
        };
      }),
      nextCursor: rows.length > limit && last ? idCursor.encode(last.id) : null,
    };
  }

  /**
   * Which notices raise the phone alert: their event's switch at their school (every event on until
   * the school switches it off). The count is of unread notices that raise it.
   */
  private async alerts(
    accountId: string,
    surface: Surfaces,
    institutionId: string | null,
    shown: readonly (string | number | null)[],
  ) {
    let q = this.deps.db
      .selectFrom('notifications')
      .select(['institution_id', 'title_key', (eb) => eb.fn.countAll<number>().as('n')])
      .where('account_id', '=', accountId)
      .where('surface', 'in', typeof surface === 'string' ? [surface] : [...surface])
      .where('read_at', 'is', null);
    if (institutionId) q = q.where('institution_id', '=', institutionId);
    const unread = await q.groupBy(['institution_id', 'title_key']).execute();
    const schools = new Map<string, Map<string, CommEventSwitch>>();
    const ids = new Set(
      [...unread.map((r) => r.institution_id), ...shown].filter((x) => x !== null).map(String),
    );
    for (const id of ids) schools.set(id, await eventSwitches(this.deps.db, id));
    const raises = (inst: string | number | null, titleKey: string) => {
      const event = commEventOf(titleKey);
      if (!event || inst === null) return true;
      const sw = schools.get(String(inst));
      return sw ? (sw.get(event.key)?.alert ?? true) : event.alertByDefault;
    };
    return {
      unread: unread.reduce(
        (a, r) => a + (raises(r.institution_id, r.title_key) ? Number(r.n) : 0),
        0,
      ),
      raises,
    };
  }

  /** COM-010 / COM-015: mark the given notifications, or all, as read. */
  async markRead(
    p: Principal,
    bell: Bell,
    input: { ids?: readonly string[] | undefined; all?: boolean | undefined },
  ) {
    const { accountId, institutionId, surfaces: surface } = await this.scope(p, bell);
    const ids = input.all ? null : (input.ids ?? []).filter(isUuid).map(uuidToBin);
    await notificationsRepository.markRead(
      this.deps.db,
      accountId,
      surface,
      institutionId,
      ids,
      this.now(),
    );
  }
}
