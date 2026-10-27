/**
 * E-mail sending (reference integrations/email.provider.js). `log` writes to the app log (development
 * and tests; refused in production); `smtp` sends through the mail server in .env (client
 * 2026-10-16: the earlier application's server, mail.sabadotechnologies.com, 587 STARTTLS, with
 * EMAIL_USER / EMAIL_PASS). Every message goes out as HTML in the RingPe layout with the plain text
 * beside it; the sender's name is the school's when the caller gives it.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Loggers } from '../controllers/logger';
import { emailHtml, LOGO_CID, subjectFor } from '../utils/email-layout';
import { logSender, type MessageSender } from './sms.provider';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | null;
  readonly pass: string | null;
  readonly from: string | null;
  readonly fromName: string;
  readonly tlsVerify: boolean;
}

/** A display name safe inside "Name" <address>. */
const displayName = (s: string) =>
  s
    .replace(/["\\\r\n<>]/g, '')
    .trim()
    .slice(0, 100) || 'RingPe';

export function smtpSender(
  smtp: SmtpSettings,
  loggers: Loggers,
  transport: Pick<Transporter, 'sendMail'> = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    tls: { rejectUnauthorized: smtp.tlsVerify, minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  }),
): MessageSender {
  if (!smtp.from) throw new Error('EMAIL_FROM (or EMAIL_USER) is required for SMTP');
  const from = smtp.from;
  return {
    channel: 'email',
    async send(m) {
      const subject = subjectFor(m.purpose, m.subject ?? (m.log ? m.log.subject : null));
      const sender = displayName(m.fromName ?? smtp.fromName);
      const attachments = [
        ...(m.attachments ?? []).map((a) => ({
          filename: a.fileName,
          content: a.content,
          contentType: a.contentType,
        })),
        // The school's logo travels inside the e-mail (client 2026-10-26).
        ...(m.logo
          ? [
              {
                filename: `logo.${m.logo.contentType === 'image/png' ? 'png' : 'jpg'}`,
                content: m.logo.content,
                contentType: m.logo.contentType,
                cid: LOGO_CID,
                contentDisposition: 'inline' as const,
              },
            ]
          : []),
      ];
      const info = await transport.sendMail({
        from: { name: sender, address: from },
        to: m.to,
        ...(m.cc?.length ? { cc: [...m.cc] } : {}),
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        subject,
        text: m.text,
        html: emailHtml({
          subject,
          text: m.text,
          sender,
          highlight: m.highlight ?? [],
          withLogo: !!m.logo,
        }),
        ...(attachments.length ? { attachments } : {}),
      });
      // The address and content are never logged (they may hold a code or a child's details).
      loggers.app.info('email sent', {
        purpose: m.purpose,
        messageId: (info as { messageId?: string }).messageId ?? null,
      });
    },
  };
}

export function createEmailSender(
  provider: 'log' | 'smtp',
  loggers: Loggers,
  opts: { echo: boolean; smtp?: SmtpSettings },
): MessageSender {
  if (provider === 'log') return logSender('email', loggers, opts);
  if (!opts.smtp) throw new Error('SMTP settings are required for EMAIL_PROVIDER=smtp');
  return smtpSender(opts.smtp, loggers);
}
