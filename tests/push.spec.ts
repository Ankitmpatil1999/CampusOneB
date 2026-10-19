/**
 * The Firebase push sender (integrations/push.provider.ts) without the network: it signs in with the
 * service account (an RS256 assertion for the messaging scope), reuses the access token until a
 * minute before it expires, sends the notice to the Android channel with one tag per notice and the
 * badge, reads "unregistered" as a phone that is gone, and fails on anything else.
 */
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createPushSender, fcmSender, type FcmServiceAccount } from '../integrations/push.provider';
import { capturingLoggers } from './helpers';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: FcmServiceAccount = {
  project_id: 'ringpe-test',
  client_email: 'push@ringpe-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'key-1',
};
const { loggers } = capturingLoggers();

const message = {
  token: 'phone-token',
  title: 'Fee of ₹800.00 assigned to Asha Rao for 2026-27',
  body: 'The fee is in the app under Fees.',
  notificationId: '0b9b3f2e-4f6a-4a8e-9a77-6f1c2f7b2c11',
  link: '/fees',
  badge: 3,
};

function network(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const url2 = String(url);
    const a = url2.includes('oauth2')
      ? { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } }
      : (answers.shift() ?? { status: 200, body: { name: 'projects/x/messages/1' } });
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { calls, fetchFn };
}

describe('Firebase push sender', () => {
  it('signs in with the service account and sends the notice to the Android channel', async () => {
    const net = network([]);
    let now = Date.now();
    const push = fcmSender(account, loggers, net.fetchFn, () => now);
    expect(await push.send(message)).toBe('SENT');

    const [signIn, send] = net.calls;
    expect(signIn!.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(signIn!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'RS256', kid: 'key-1' });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: account.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });

    expect(send!.url).toBe('https://fcm.googleapis.com/v1/projects/ringpe-test/messages:send');
    expect((send!.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    expect(JSON.parse(String(send!.init.body))).toEqual({
      message: {
        token: 'phone-token',
        notification: { title: message.title, body: message.body },
        data: { notificationId: message.notificationId, link: '/fees' },
        android: {
          priority: 'HIGH',
          notification: expect.objectContaining({
            channel_id: 'ringpe_notifications',
            tag: `ringpe:${message.notificationId}`,
            notification_count: 3,
            visibility: 'PRIVATE',
          }),
        },
      },
    });

    // The access token is reused until a minute before it expires.
    await push.send(message);
    expect(net.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    now += 3600_000;
    await push.send(message);
    expect(net.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });

  it('reads an unregistered token as a phone that is gone, and fails on anything else', async () => {
    const net = network([
      {
        status: 404,
        body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
      },
      { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } },
      { status: 503, body: { error: { status: 'UNAVAILABLE' } } },
    ]);
    const push = fcmSender(account, loggers, net.fetchFn);
    expect(await push.send(message)).toBe('GONE');
    expect(await push.send(message)).toBe('GONE');
    await expect(push.send(message)).rejects.toThrow('Firebase refused the push (503 UNAVAILABLE)');
  });

  it('is off without a provider, and needs the key file for Firebase', () => {
    expect(createPushSender('off', loggers)).toBeNull();
    expect(createPushSender('log', loggers)?.provider).toBe('log');
    expect(() => createPushSender('fcm', loggers, {})).toThrow('PUSH_FCM_SERVICE_ACCOUNT_FILE');
  });
});
