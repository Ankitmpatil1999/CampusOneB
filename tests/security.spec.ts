/** Unit tests of the Phase 2 security building blocks (no database). */
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import {
  hashSecret,
  needsRehash,
  normaliseAnswer,
  verifyAgainstDummy,
  verifySecret,
} from '../utils/password';
import {
  DecryptionError,
  FieldCipher,
  generateFieldKeyFile,
  lastFour,
  maskAccountNumber,
  maskIdNumber,
  maskPan,
} from '../utils/fieldEncryption';
import { generateKeyFile, keySetFromFile } from '../utils/signing-keys';
import { createTokenSigner } from '../utils/token-signer';
import { createTokenVerifier } from '../utils/token-verifier';
import { csrfTokenFor, cookieNames } from '../utils/cookies';
import { csrfProtection } from '../middlewares/csrf.middleware';
import { authenticate } from '../middlewares/auth.middleware';
import { errorHandler } from '../middlewares/error-handler.middleware';
import { assertUpdated, etagOf, expectedVersion } from '../utils/etag';
import { ipToBin } from '../utils/ip';
import { canonicalJson } from '../middlewares/idempotency.middleware';
import { formatSize } from '../services/file.service';
import { memoryRevocations } from '../utils/session-revocations';
import { binToUuid, uuidToBin, newPublicIdPair } from '../utils/idGenerator';
import { capturingLoggers, testSecurity } from './helpers';

const ACCOUNT = '0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a';

describe('password hashing (Argon2id)', () => {
  it('verifies the right secret and refuses a wrong one', async () => {
    const h = await hashSecret('CampusOne@2026');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret(h, 'CampusOne@2026')).toBe(true);
    expect(await verifySecret(h, 'campusone@2026')).toBe(false);
    expect(await verifySecret('not-a-hash', 'x')).toBe(false);
  });

  it('asks for a rehash when the stored parameters are weaker', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
    expect(needsRehash('$2b$10$bcrypt')).toBe(true);
  });

  it('normalises security answers and burns time for unknown accounts', async () => {
    expect(normaliseAnswer('  Blue   Whale ')).toBe('blue whale');
    await expect(verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});

describe('field encryption and blind indexes (ADR-0012)', () => {
  const cipher = new FieldCipher(generateFieldKeyFile('k1'));

  it('round-trips a value bound to its row', () => {
    const blob = cipher.encrypt('pan', 'ABCDE1234F', 'platform_accounts.pan:row-1');
    expect(blob[0]).toBe(1);
    expect(blob.includes(Buffer.from('ABCDE1234F'))).toBe(false);
    expect(cipher.decrypt('pan', blob, 'platform_accounts.pan:row-1')).toBe('ABCDE1234F');
  });

  it('refuses a ciphertext moved to another row, purpose or altered', () => {
    const blob = cipher.encrypt('pan', 'ABCDE1234F', 'row-1');
    expect(() => cipher.decrypt('pan', blob, 'row-2')).toThrow(DecryptionError);
    expect(() => cipher.decrypt('id_doc', blob, 'row-1')).toThrow(DecryptionError);
    const tampered = Buffer.from(blob);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 20) ^ 0xff, tampered.length - 20);
    expect(() => cipher.decrypt('pan', tampered, 'row-1')).toThrow(DecryptionError);
  });

  it('still decrypts old ciphertexts after the active key rotates', () => {
    const file = generateFieldKeyFile('k1');
    const old = new FieldCipher(file);
    const blob = old.encrypt('bank_acct', '123456789012', 'r');
    const rotated = new FieldCipher({
      ...file,
      activeKeyId: 'k2',
      keys: { ...file.keys, k2: generateFieldKeyFile('k2').keys['k2']! },
    });
    expect(rotated.currentKeyId).toBe('k2');
    expect(rotated.decrypt('bank_acct', blob, 'r')).toBe('123456789012');
    expect(rotated.encrypt('bank_acct', 'x', 'r').subarray(2, 4).toString('ascii')).toBe('k2');
  });

  it('indexes normalised values per purpose and masks the last four', () => {
    expect(
      cipher.blindIndex('pan', 'abcde 1234f').equals(cipher.blindIndex('pan', 'ABCDE1234F')),
    ).toBe(true);
    expect(
      cipher.blindIndex('pan', 'ABCDE1234F').equals(cipher.blindIndex('id_doc', 'ABCDE1234F')),
    ).toBe(false);
    expect(lastFour('1234 5678 9012')).toBe('9012');
    expect(maskPan('234F')).toBe('••••••234F');
    expect(maskIdNumber('AADHAAR', '4821')).toBe('XXXX XXXX 4821');
    expect(maskIdNumber('PASSPORT', '5678')).toBe('••••5678');
    expect(maskIdNumber('VOTER_ID', '5678')).toBe('••••••5678');
    expect(maskAccountNumber('7719')).toBe('XXXXXXXX7719');
    expect(maskPan(null)).toBeNull();
  });
});

describe('access tokens (ADR-0011)', () => {
  it('signs and verifies a session token with its claims', async () => {
    const s = await testSecurity();
    const { token, expiresAt } = await s.signer.sign({
      subject: ACCOUNT,
      surface: 'console',
      sessionId: 'sess-1',
      institutionId: 'inst-1',
      subTasks: ['members.view'],
    });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    const p = await s.verifier.verify(token);
    expect(p).toMatchObject({
      subject: ACCOUNT,
      surface: 'console',
      sessionId: 'sess-1',
      institutionId: 'inst-1',
      subTasks: ['members.view'],
    });
  });

  it('keeps the back-office keys and audience apart from every other surface', async () => {
    const keys = await keySetFromFile(await generateKeyFile('d'));
    const opsKeys = await keySetFromFile(await generateKeyFile('o'));
    const signer = createTokenSigner({ issuer: 'campusone', keys, opsKeys, ttlSeconds: 900 });
    const verifier = createTokenVerifier({
      issuer: 'campusone',
      jwks: keys.publicJwks,
      opsJwks: opsKeys.publicJwks,
    });
    const ops = await signer.sign({
      subject: ACCOUNT,
      surface: 'ops',
      sessionId: 's',
      subTasks: [],
    });
    await expect(verifier.verify(ops.token)).resolves.toMatchObject({ surface: 'ops' });

    // An `ops` audience signed with the default key is refused, and the reverse.
    const forgedOps = await new SignJWT({ sid: 's', st: [] })
      .setProtectedHeader({ alg: 'ES256', kid: keys.activeKid })
      .setIssuer('campusone')
      .setSubject(ACCOUNT)
      .setAudience('ops')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    await expect(verifier.verify(forgedOps)).rejects.toThrow();
    const consoleWithOpsKey = await new SignJWT({ sid: 's', st: [] })
      .setProtectedHeader({ alg: 'ES256', kid: opsKeys.activeKid })
      .setIssuer('campusone')
      .setSubject(ACCOUNT)
      .setAudience('console')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(opsKeys.privateKey);
    await expect(verifier.verify(consoleWithOpsKey)).rejects.toThrow();
  });

  it('refuses unknown keys, expired tokens and garbage', async () => {
    const s = await testSecurity();
    const other = await testSecurity();
    const foreign = await other.signer.sign({
      subject: ACCOUNT,
      surface: 'member',
      sessionId: 's',
      subTasks: [],
    });
    await expect(s.verifier.verify(foreign.token)).rejects.toThrow(/unknown_kid/);
    await expect(s.verifier.verify('abc.def.ghi')).rejects.toThrow();
    const past = createTokenSigner({
      issuer: 'campusone',
      keys: await keySetFromFile(await generateKeyFile('p')),
      opsKeys: await keySetFromFile(await generateKeyFile('po')),
      ttlSeconds: 60,
      now: () => new Date(Date.now() - 3_600_000),
    });
    const expired = await past.sign({
      subject: ACCOUNT,
      surface: 'member',
      sessionId: 's',
      subTasks: [],
    });
    const v = createTokenVerifier({ issuer: 'campusone', jwks: { keys: [] } });
    await expect(v.verify(expired.token)).rejects.toThrow();
  });

  it('publishes only public key material', async () => {
    const set = await keySetFromFile(await generateKeyFile('pub'));
    for (const k of set.publicJwks.keys) expect('d' in k).toBe(false);
  });

  it('refuses a key file with duplicate key ids', async () => {
    const f = await generateKeyFile('dup');
    await expect(keySetFromFile({ keys: [f.keys[0]!, f.keys[0]!] })).rejects.toThrow(
      /duplicate kid/,
    );
  });
});

describe('cookie sessions: surface binding, revocation and CSRF', () => {
  async function app() {
    const s = await testSecurity();
    const revocations = memoryRevocations();
    const { loggers } = capturingLoggers();
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.cookies = Object.fromEntries(
        (req.get('cookie') ?? '')
          .split(';')
          .map((c) => c.trim().split('='))
          .filter((p) => p.length === 2),
      );
      next();
    });
    const api = express.Router();
    api.use(authenticate(s.verifier, loggers, revocations));
    api.use(csrfProtection(s.cipher, loggers));
    api.post('/console/things', (req, res) => res.json({ via: req.authVia }));
    api.get('/console/things', (_req, res) => res.json({ ok: true }));
    a.use('/api/v1', api);
    a.use(errorHandler(loggers));
    const t = await s.signer.sign({
      subject: ACCOUNT,
      surface: 'console',
      sessionId: 'sess-9',
      subTasks: [],
    });
    return { a, s, revocations, token: t.token, csrf: csrfTokenFor(s.cipher, 'sess-9') };
  }
  const cookie = (token: string) => `${cookieNames('console').access}=${token}`;

  it('refuses a cookie-authenticated write without the CSRF header', async () => {
    const { a, token } = await app();
    const res = await request(a)
      .post('/api/v1/console/things')
      .set('Cookie', cookie(token))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH.CSRF');
  });

  it('accepts the write with the session-bound CSRF token, and reads without it', async () => {
    const { a, token, csrf } = await app();
    const ok = await request(a)
      .post('/api/v1/console/things')
      .set('Cookie', cookie(token))
      .set('X-CSRF-Token', csrf)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.via).toBe('cookie');
    const read = await request(a).get('/api/v1/console/things').set('Cookie', cookie(token));
    expect(read.status).toBe(200);
  });

  it('does not ask Bearer clients for a CSRF token', async () => {
    const { a, token } = await app();
    const res = await request(a)
      .post('/api/v1/console/things')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('bearer');
  });

  it('stops an access token at once when its session is revoked', async () => {
    const { a, token, revocations } = await app();
    await revocations.revoke('sess-9', Math.floor(Date.now() / 1000) + 900);
    const res = await request(a)
      .get('/api/v1/console/things')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('record versions (ETag / If-Match)', () => {
  const req = (h?: string) => ({ get: () => h }) as unknown as express.Request;

  it('reads the expected version and refuses a missing or malformed header', () => {
    expect(etagOf(7)).toBe('"v7"');
    expect(expectedVersion(req('"v7"'))).toBe(7);
    expect(expectedVersion(req('W/"v12"'))).toBe(12);
    expect(() => expectedVersion(req())).toThrow(
      expect.objectContaining({ statusCode: 428, code: 'GEN.PRECONDITION_REQUIRED' }),
    );
    expect(() => expectedVersion(req('"abc"'))).toThrow(
      expect.objectContaining({ statusCode: 412 }),
    );
    expect(() => assertUpdated(0n)).toThrow(
      expect.objectContaining({ code: 'GEN.CONFLICT_VERSION' }),
    );
    expect(() => assertUpdated(1n)).not.toThrow();
  });
});

describe('small helpers', () => {
  it('stores IPv4, mapped IPv4 and IPv6 addresses as bytes', () => {
    expect(ipToBin('10.1.2.3')).toEqual(Buffer.from([10, 1, 2, 3]));
    expect(ipToBin('::ffff:10.1.2.3')).toEqual(Buffer.from([10, 1, 2, 3]));
    expect(ipToBin('::1')?.length).toBe(16);
    expect(ipToBin('2001:db8::1')?.[0]).toBe(0x20);
    expect(ipToBin('not-an-ip')).toBeNull();
    expect(ipToBin(undefined)).toBeNull();
  });

  it('hashes request bodies independently of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it('formats file sizes for the refusal message', () => {
    expect(formatSize(2_500_000)).toBe('2.4 MB');
    expect(formatSize(900 * 1024)).toBe('900 KB');
  });

  it('converts public ids between UUID strings and BINARY(16)', () => {
    const p = newPublicIdPair();
    expect(p.bin).toHaveLength(16);
    expect(binToUuid(uuidToBin(p.id))).toBe(p.id);
  });
});
