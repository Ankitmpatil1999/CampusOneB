/**
 * E-mail sending (reference integrations/email.provider.js). Log provider until the SMTP host is
 * chosen (Q17); see sms.provider.ts for the logging rules.
 */
import type { Loggers } from '../controllers/logger';
import { logSender, type MessageSender } from './sms.provider';

export function createEmailSender(
  provider: 'log' | 'smtp',
  loggers: Loggers,
  opts: { echo: boolean },
): MessageSender {
  if (provider === 'log') return logSender('email', loggers, opts);
  throw new Error(`E-mail provider '${provider}' is not integrated yet (Q17)`);
}
