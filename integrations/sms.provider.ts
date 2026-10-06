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
  /**
   * Whom it concerns, for the communication log (CR-16) — never the content. `false`: the caller
   * logs the send itself (announcements).
   */
  readonly log?: OutboundLog | false;
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
