/**
 * Push notifications to the apps (client 2026-10-19): Firebase Cloud Messaging's HTTP v1 API with the
 * project's service account — a short-lived OAuth token signed with its key (RS256), then one send
 * per device token. Without a service account the pushes are only logged (development, tests), so
 * nothing else changes.
 *
 * A token Firebase no longer knows (the app was removed, its data cleared) is reported back, and the
 * caller forgets it.
 */
import { readFile } from 'node:fs/promises';
import { SignJWT, importPKCS8 } from 'jose';
import type { Loggers } from '../controllers/logger';

export interface PushMessage {
  readonly tokens: readonly string[];
  readonly title: string;
  readonly body: string;
  /** Strings only (FCM data): where the notification opens, its category. */
  readonly data?: Readonly<Record<string, string>>;
}

export interface PushSender {
  readonly mode: 'fcm' | 'log';
  /** Sends to every token; returns the tokens Firebase refused as unknown. */
  send(m: PushMessage): Promise<{ readonly invalid: readonly string[] }>;
}

/** Development and tests: the push is logged (titles only, never the body). */
export function logPushSender(loggers: Loggers): PushSender {
  return {
    mode: 'log',
    async send(m) {
      loggers.app.info('push.logged', { devices: m.tokens.length, title: m.title });
      return { invalid: [] };
    },
  };
}

interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Firebase Cloud Messaging (HTTP v1) with the service account in `file`. */
export async function fcmPushSender(
  file: string,
  loggers: Loggers,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSender> {
  const sa = JSON.parse(await readFile(file, 'utf8')) as ServiceAccount;
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT_FILE is not a Firebase service account JSON');
  }
  const key = await importPKCS8(sa.private_key, 'RS256');
  let cached: { token: string; until: number } | null = null;

  const accessToken = async () => {
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const r = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!r.ok) throw new Error(`FCM token request failed (${r.status})`);
    const body = (await r.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return cached.token;
  };

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  return {
    mode: 'fcm',
    async send(m) {
      const invalid: string[] = [];
      if (!m.tokens.length) return { invalid };
      const bearer = await accessToken();
      for (const token of m.tokens) {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: m.title, body: m.body },
              ...(m.data ? { data: m.data } : {}),
              android: { priority: 'HIGH', notification: { channel_id: 'ringpe' } },
            },
          }),
        });
        if (r.ok) continue;
        const text = await r.text().catch(() => '');
        // UNREGISTERED (404) or a malformed token (400 INVALID_ARGUMENT): forget the token.
        if (r.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) {
          invalid.push(token);
        } else if (r.status === 400 && /INVALID_ARGUMENT/.test(text)) {
          invalid.push(token);
        } else {
          loggers.app.warn('push.failed', { status: r.status });
          if (r.status >= 500 || r.status === 429) throw new Error(`FCM send failed (${r.status})`);
        }
      }
      return { invalid };
    },
  };
}
