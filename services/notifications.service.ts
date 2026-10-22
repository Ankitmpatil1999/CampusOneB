/**
 * In-app notifications (SRS 6.32, 23.7; COM-009/010 console bell, COM-014/015 member app; prototype
 * shell.cnotifs). Other services call `notify` inside their own transaction, so a notification exists
 * exactly when the change it reports does. The title is a message key rendered in the reader's
 * language (the response carries the key, its parameters and the English text); the body is the
 * request's own text.
 */
import { emit, enqueuePush, rooms } from '../utils/outbox';
import type { Kysely, Transaction } from 'kysely';
import { renderMessage, type MessageKey } from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { institutionsRepository } from '../repositories/institutions.repository';
import {
  notificationsRepository,
  type NotificationSurface,
} from '../repositories/notifications.repository';
import { NotFoundError } from '../utils/CustomAPIError';
import { logCommSafely } from './comm-log.service';
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
}

/** Adds one notification per account (duplicates and empty lists are ignored). */
export async function notify(db: Db, n: NotifyInput, at: Date = new Date()) {
  const accounts = [...new Set(n.accountIds)];
  const ids = accounts.map(() => newPublicIdPair());
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
  const surface = n.surface === 'CONSOLE' ? 'console' : 'member';
  await emit(db, {
    institutionId: n.institutionId,
    type: 'notification.created',
    rooms: accounts.map((a) => rooms.account(a, surface)),
    data: { category: n.category },
  });
  // And to the accounts' phones, once committed (client 2026-10-19).
  await enqueuePush(db, {
    institutionId: n.institutionId,
    accountIds: accounts,
    surface: n.surface,
    titleKey: n.titleKey,
    params: n.params ?? {},
    body: n.body,
    link: n.link ?? null,
    category: n.category,
  });
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
      recipient: n.surface === 'CONSOLE' ? 'Console' : 'In-app',
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

  private async scope(p: Principal, surface: NotificationSurface) {
    const accountId = await this.account(p);
    if (surface === 'MEMBER') return { accountId, institutionId: null };
    if (!p.institutionId || !isUuid(p.institutionId)) throw new NotFoundError();
    const inst = await institutionsRepository.byPublicId(this.deps.db, uuidToBin(p.institutionId));
    if (!inst) throw new NotFoundError();
    return { accountId, institutionId: String(inst.id) };
  }

  /** COM-009 / COM-014: newest first, with the unread count. */
  async list(
    p: Principal,
    surface: NotificationSurface,
    q: { unread?: boolean | undefined; cursor?: string | undefined; limit?: number | undefined },
  ) {
    const { accountId, institutionId } = await this.scope(p, surface);
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
    return {
      unread: await notificationsRepository.unread(this.deps.db, accountId, surface, institutionId),
      items: page.map((r) => {
        const params = parse(r.params);
        return {
          id: binToUuid(r.public_id),
          category: r.category,
          titleKey: r.title_key,
          params,
          title: renderMessage(r.title_key as MessageKey, params),
          body: r.body,
          link: r.link,
          read: r.read_at !== null,
          at: new Date(r.created_at).toISOString(),
        };
      }),
      nextCursor: rows.length > limit && last ? idCursor.encode(last.id) : null,
    };
  }

  /** COM-010 / COM-015: mark the given notifications, or all, as read. */
  async markRead(
    p: Principal,
    surface: NotificationSurface,
    input: { ids?: readonly string[] | undefined; all?: boolean | undefined },
  ) {
    const { accountId, institutionId } = await this.scope(p, surface);
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
