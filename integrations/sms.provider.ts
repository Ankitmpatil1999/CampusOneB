/**
 * SMS sending (reference integrations/sms.provider.js). Until a provider is chosen (Q17; Kaleyra
 * per the legacy system) messages go to the app log, as in the reference: the platform stays
 * usable end to end in development. The text itself is logged only with OTP_DEV_ECHO, which
 * production refuses (it can contain a one-time code).
 */
import type { Loggers } from '../controllers/logger';

export interface OutboundMessage {
  readonly to: string;
  /** What the message is for (`otp.signup`, `otp.console_2fa`, …) — logged, never the content. */
  readonly purpose: string;
  readonly text: string;
  /** E-mail only: the subject (default: from the purpose) and the sender's name (a school's). */
  readonly subject?: string;
  readonly fromName?: string;
  /** E-mail only: where replies go (the school's office address). */
  readonly replyTo?: string | null;
  /** E-mail only: the others in copy (the family's addresses with the login details, 2026-10-23). */
  readonly cc?: readonly string[];
  /** E-mail only: files sent with it (client 2026-10-23: the submitted application form). */
  readonly attachments?: readonly MessageAttachment[];
  /**
   * E-mail only: the details the HTML shows highlighted wherever they appear in the text — the
   * application number, a one-time password, an amount (client 2026-10-26). The text is unchanged.
   */
  readonly highlight?: readonly (string | null | undefined)[];
  /** E-mail only: the school's logo, shown at the head of the e-mail (client 2026-10-26). */
  readonly logo?: { readonly content: Buffer; readonly contentType: string } | null;
  /**
   * Whom it concerns, for the communication log (CR-16) — never the content. `false`: the caller
   * logs the send itself (announcements).
   */
  readonly log?: OutboundLog | false;
}

export interface MessageAttachment {
  readonly fileName: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface OutboundLog {
  readonly institutionId?: string | null;
  /** Default: OTP for `otp.*` purposes, otherwise TRANSACTIONAL. */
  readonly kind?: 'OTP' | 'TRANSACTIONAL';
  readonly recipientAccountId?: string | null;
  readonly recipientProfileId?: string | null;
  /** The subject or first line (never a code); default: the purpose in words. */
  readonly subject?: string | null;
  readonly raiser?: Buffer | null;
  readonly refType?: string | null;
  readonly refId?: string | null;
}

export interface MessageSender {
  readonly channel: 'sms' | 'email';
  send(message: OutboundMessage): Promise<void>;
}

const maskMobile = (m: string) => (m.length >= 4 ? `••••••${m.slice(-4)}` : '••••');

export function logSender(
  channel: 'sms' | 'email',
  loggers: Loggers,
  opts: { echo: boolean },
): MessageSender {
  const mask =
    channel === 'sms'
      ? maskMobile
      : (e: string) => e.replace(/^(.)[^@]*(@.*)$/, (_m, a: string, b: string) => `${a}•••${b}`);
  return {
    channel,
    async send(m) {
      loggers.app.info(`${channel} not sent (log provider)`, {
        to: mask(m.to),
        purpose: m.purpose,
        ...(m.attachments?.length ? { attachments: m.attachments.length } : {}),
        ...(opts.echo ? { devText: m.text } : {}),
      });
    },
  };
}

export function createSmsSender(
  provider: 'log' | 'kaleyra',
  loggers: Loggers,
  opts: { echo: boolean },
): MessageSender {
  if (provider === 'log') return logSender('sms', loggers, opts);
  throw new Error(`SMS provider '${provider}' is not integrated yet (Q17)`);
}
