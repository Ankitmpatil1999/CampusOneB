/**
 * Phone pushes (client 2026-10-19: notices while the app is closed or the phone is locked; OQ-26).
 * `fcm` sends through Firebase Cloud Messaging's HTTP v1 API with plain `fetch` (no SDK, as the
 * Razorpay integration): a service-account key (PUSH_FCM_SERVICE_ACCOUNT_FILE, kept out of the
 * repository) signs a short-lived OAuth token, cached until a minute before it expires. `log` writes
 * the push to the app log without the token (development and tests; refused in production); `off`
 * sends nothing and leaves the platform's push channel switched off.
 *
 * Android shows the push itself when the app is closed or in the background, in the app's
 * "CampusOne notifications" channel (LocalAlertsModule.kt) — high priority, so a locked phone lights
 * up — with the unread count for the icon badge.
 */
import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import type { Loggers } from '../controllers/logger';

export type PushProvider = 'off' | 'log' | 'fcm';

export interface PushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  /** The in-app notice's id: one notification per notice on the phone. */
  readonly notificationId: string;
  readonly link: string | null;
  /** Unread notices, for the badge on the app icon. */
  readonly badge: number;
}

/** `SENT`, or `GONE` when the phone's token is no longer valid (the app was removed). */
export type PushResult = 'SENT' | 'GONE';

export interface PushSender {
  readonly provider: Exclude<PushProvider, 'off'>;
  send(m: PushMessage): Promise<PushResult>;
}

/** Firebase's names for the Android channel and the notification, as the app creates them. */
export const ANDROID_CHANNEL = 'campusone_notifications';
export const tagOf = (notificationId: string) => `campusone:${notificationId}`;

export interface FcmServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly private_key_id?: string;
  readonly token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Reads and checks the service-account key file downloaded from the Firebase console. */
export function readServiceAccount(file: string): FcmServiceAccount {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<FcmServiceAccount> & {
    type?: string;
  };
  if (raw.type !== 'service_account' || !raw.project_id || !raw.client_email || !raw.private_key) {
    throw new Error(
      'PUSH_FCM_SERVICE_ACCOUNT_FILE is not a Firebase service-account key (Project settings → Service accounts → Generate new private key)',
    );
  }
  return raw as FcmServiceAccount;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function fcmSender(
  account: FcmServiceAccount,
  loggers: Loggers,
  fetchFn: Fetch = (u, i) => fetch(u, i),
  now: () => number = Date.now,
): PushSender {
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const key = await importPKCS8(account.private_key, 'RS256');
    const iat = Math.floor(now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'JWT',
        ...(account.private_key_id ? { kid: account.private_key_id } : {}),
      })
      .setIssuer(account.client_email)
      .setAudience(account.token_uri ?? TOKEN_URI)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const res = await fetchFn(account.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(`Firebase sign-in failed (${res.status} ${body.error ?? ''})`.trim());
    }
    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    provider: 'fcm',
    async send(m) {
      const token = await accessToken();
      const res = await fetchFn(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: m.token,
              notification: { title: m.title, body: m.body },
              data: { notificationId: m.notificationId, ...(m.link ? { link: m.link } : {}) },
              android: {
                priority: 'HIGH',
                notification: {
                  channel_id: ANDROID_CHANNEL,
                  tag: tagOf(m.notificationId),
                  notification_count: Math.max(0, Math.min(m.badge, 999)),
                  default_sound: true,
                  default_vibrate_timings: true,
                  visibility: 'PRIVATE',
                  // Android 7 has no channels: the push itself asks to pop up (client 2026-10-27).
                  notification_priority: 'PRIORITY_HIGH',
                },
              },
            },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.ok) return 'SENT';
      const err = (await res.json().catch(() => ({}))) as {
        error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
      };
      const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status;
      // The token is gone (app removed, data cleared) or not a token at all: never retried.
      if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') {
        return 'GONE';
      }
      if (res.status === 401) cached = null;
      loggers.app.warn('push.fcm_refused', { status: res.status, code: code ?? null });
      throw new Error(`Firebase refused the push (${res.status} ${code ?? ''})`.trim());
    },
  };
}

/** Development and tests: the push goes to the app log, without the token. */
export function logPushSender(loggers: Loggers): PushSender {
  return {
    provider: 'log',
    async send(m) {
      loggers.app.info('push.log', { title: m.title, notificationId: m.notificationId });
      return 'SENT';
    },
  };
}

export function createPushSender(
  provider: PushProvider,
  loggers: Loggers,
  opts: { serviceAccountFile?: string | null } = {},
): PushSender | null {
  if (provider === 'off') return null;
  if (provider === 'log') return logPushSender(loggers);
  if (!opts.serviceAccountFile)
    throw new Error('PUSH_FCM_SERVICE_ACCOUNT_FILE is required with PUSH_PROVIDER=fcm');
  return fcmSender(readServiceAccount(opts.serviceAccountFile), loggers);
}
