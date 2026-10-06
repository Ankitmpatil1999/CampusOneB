/**
 * The communication log (CR-16, RNG-COM-172…186; 27.2 SUCCESS · SKIPPED · FAILED; RC-24 kind): one row per
 * recipient and channel for every dispatch path — announcements, direct messages, notifications,
 * one-time passwords and transactional messages. Never the message body; the address is kept masked.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MessageSender } from '../integrations/sms.provider';
import { opsMetrics } from '../utils/metrics';
import type { CommChannel, CommKind, CommOutcome, Database } from '../models/ringpe_models';

type Db = Kysely<Database> | Transaction<Database>;

export interface CommLogRow {
  readonly institutionId: string | null;
  readonly kind: CommKind;
  readonly channel: CommChannel;
  readonly recipientProfileId?: string | null;
  readonly recipientAccountId?: string | null;
  /** The address as shown in the report (already masked). */
  readonly recipient?: string | null;
  readonly raiser?: Buffer | null;
  readonly outcome: CommOutcome;
  readonly reason?: string | null;
  readonly refType?: string | null;
  readonly refId?: string | null;
  /** The subject or first line (RNG-COM-174); none for a direct message (RNG-COM-178). */
  readonly subject?: string | null;
}

export const maskMobile = (m: string | null | undefined) =>
  m && m.length >= 4 ? `••••••${m.slice(-4)}` : null;
export const maskEmail = (e: string | null | undefined) =>
  e ? e.replace(/^(.)[^@]*(@.*)$/, (_m, a: string, b: string) => `${a}•••${b}`) : null;

const istDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);

export async function logComm(db: Db, rows: readonly CommLogRow[], at: Date = new Date()) {
  if (!rows.length) return;
  for (const r of rows) opsMetrics.commSent(r.kind, r.channel, r.outcome);
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insertInto('comm_log')
      .values(
        rows.slice(i, i + 500).map((r) => ({
          logged_on: istDate(at),
          at,
          institution_id: r.institutionId,
          kind: r.kind,
          channel: r.channel,
          recipient_profile_id: r.recipientProfileId ?? null,
          recipient_account_id: r.recipientAccountId ?? null,
          recipient_masked: r.recipient?.slice(0, 80) ?? null,
          raiser: r.raiser ?? null,
          outcome: r.outcome,
          reason: r.reason?.slice(0, 200) ?? null,
          ref_type: r.refType ?? null,
          ref_id: r.refId ?? null,
          subject: r.subject?.slice(0, 160) ?? null,
        })),
      )
      .execute();
  }
}

/**
 * Writes the rows without ever failing the send (RNG-COM-183): a failed write is counted per
 * institution and day, and the report shows the gap.
 */
export async function logCommSafely(db: Db, rows: readonly CommLogRow[], at: Date = new Date()) {
  try {
    await logComm(db, rows, at);
  } catch {
    const byInstitution = new Map<string, number>();
    for (const r of rows) {
      const k = r.institutionId ?? '0';
      byInstitution.set(k, (byInstitution.get(k) ?? 0) + 1);
    }
    for (const [institutionId, n] of byInstitution) {
      try {
        await db
          .insertInto('comm_log_gaps')
          .values({ institution_id: institutionId, day: istDate(at), failures: n })
          .onDuplicateKeyUpdate({ failures: sql<number>`failures + ${n}` })
          .execute();
      } catch {
        // Nothing more can be recorded; the send itself stands.
      }
    }
  }
}

const words = (purpose: string) => {
  const t = purpose.replace(/^otp./, '').replace(/[._]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Message';
};

/**
 * Wraps an e-mail or SMS sender so every send is in the communication log with its outcome (CR-16,
 * RNG-COM-181): one-time codes as "One-time code", never the code (RNG-COM-179); the address masked.
 */
export function loggedSender(
  inner: MessageSender,
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): MessageSender {
  const channel: CommChannel = inner.channel === 'sms' ? 'SMS' : 'EMAIL';
  const mask = inner.channel === 'sms' ? maskMobile : maskEmail;
  return {
    channel: inner.channel,
    async send(m) {
      const ctx = m.log;
      const row = (outcome: CommOutcome, reason: string | null): CommLogRow | null =>
        ctx === false
          ? null
          : {
              institutionId: ctx?.institutionId ?? null,
              kind: ctx?.kind ?? (m.purpose.startsWith('otp.') ? 'OTP' : 'TRANSACTIONAL'),
              channel,
              recipientAccountId: ctx?.recipientAccountId ?? null,
              recipientProfileId: ctx?.recipientProfileId ?? null,
              recipient: mask(m.to),
              raiser: ctx?.raiser ?? null,
              outcome,
              reason,
              refType: ctx?.refType ?? m.purpose.slice(0, 30),
              refId: ctx?.refId ?? null,
              subject: m.purpose.startsWith('otp.')
                ? 'One-time code'
                : (ctx?.subject ?? words(m.purpose)),
            };
      try {
        await inner.send(m);
      } catch (e) {
        const r = row('FAILED', (e instanceof Error ? e.message : String(e)).slice(0, 200));
        if (r) await logCommSafely(db, [r], now());
        throw e;
      }
      const r = row('SUCCESS', null);
      if (r) await logCommSafely(db, [r], now());
    },
  };
}
