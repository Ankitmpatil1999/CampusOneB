/**
 * HTTPS on the server (client 2026-10-12): the settings (reference USE_HTTPS, KEY_PATH,
 * CERTIFICATE_PATH, CERT_PASSPHRASE), the plain-HTTP redirect, and the built web application served
 * on the same address with its own page headers (WEB_ROOT).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ConfigError, loadConfig } from '../config/config';
import { inlineScriptHashes } from '../middlewares/web-app.middleware';
import { createApiServer, createRedirectServer } from '../utils/https-server';
import { buildTestApp } from './helpers';

const base = { DATABASE_URL: 'mysql://app:s3cret-pw@localhost:3306/ringpe' };
const problems = (env: Record<string, string>) => {
  try {
    loadConfig({ ...base, ...env });
    return '';
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).message;
  }
};

describe('HTTPS settings', () => {
  it('refuses a web address with the scheme twice, or one that is not a plain address', () => {
    // 2026-10-13: "https://http://192.168.88.16" made every link the API sends broken.
    expect(problems({ PUBLIC_WEB_URL: 'https://http://192.168.88.16' })).toContain(
      'PUBLIC_WEB_URL',
    );
    expect(problems({ PUBLIC_WEB_URL: 'ftp://school.example.in' })).toContain('PUBLIC_WEB_URL');
    expect(problems({ PUBLIC_WEB_URL: 'https://school.example.in/?x=1' })).toContain(
      'PUBLIC_WEB_URL',
    );
    expect(problems({ CORS_ORIGINS: 'https://http://192.168.88.16' })).toContain('CORS_ORIGINS');
    expect(problems({ CORS_ORIGINS: 'https://a.in/console' })).toContain('CORS_ORIGINS');
    // HTTPS on: the links must be https too.
    expect(
      problems({
        USE_HTTPS: 'true',
        KEY_PATH: 'k',
        CERTIFICATE_PATH: 'c',
        PUBLIC_WEB_URL: 'http://192.168.88.16',
      }),
    ).toContain('PUBLIC_WEB_URL: must start with https://');
    const ok = loadConfig({
      ...base,
      PUBLIC_WEB_URL: 'https://192.168.88.16/',
      CORS_ORIGINS: 'https://192.168.88.16,https://localhost:4200',
    });
    expect(ok.publicWebUrl).toBe('https://192.168.88.16');
    // The web app's development server is HTTPS (npm start).
    expect(loadConfig(base).publicWebUrl).toBe('https://localhost:4200');
  });

  it('needs the key and certificate files with USE_HTTPS, and HTTPS for a redirect port', () => {
    const m = problems({ USE_HTTPS: 'true' });
    expect(m).toContain('KEY_PATH');
    expect(m).toContain('CERTIFICATE_PATH');
    expect(problems({ HTTP_REDIRECT_PORT: '80' })).toContain('HTTP_REDIRECT_PORT');
    expect(
      problems({
        USE_HTTPS: 'true',
        KEY_PATH: 'k',
        CERTIFICATE_PATH: 'c',
        HTTP_PORT: '443',
        HTTP_REDIRECT_PORT: '443',
      }),
    ).toContain('HTTP_REDIRECT_PORT');
  });

  it('reads them into the configuration (off by default)', () => {
    expect(loadConfig(base).tls).toBeUndefined();
    const c = loadConfig({
      ...base,
      USE_HTTPS: 'true',
      KEY_PATH: 'keys/tls/server.key',
      CERTIFICATE_PATH: 'keys/tls/server.crt',
      CERT_PASSPHRASE: 'pass-phrase',
      HTTP_PORT: '443',
      HTTP_REDIRECT_PORT: '80',
      WEB_ROOT: '../RingPe_Web_App/dist/browser',
    });
    expect(c.tls).toEqual({
      keyPath: 'keys/tls/server.key',
      certPath: 'keys/tls/server.crt',
      passphrase: 'pass-phrase',
      redirectPort: 80,
    });
    expect(c.http.webRoot).toBe('../RingPe_Web_App/dist/browser');
  });

  it('names an unreadable key file without its content', () => {
    expect(() =>
      createApiServer(() => undefined, { keyPath: join(tmpdir(), 'no-such.key'), certPath: 'x' }),
    ).toThrow(/^KEY_PATH: the file can't be read \(ENOENT\)$/);
    expect(createApiServer(() => undefined, undefined).scheme).toBe('http');
  });
});

describe('plain-HTTP redirect', () => {
  it('sends every request to the same address on HTTPS, keeping the method', async () => {
    const server = createRedirectServer(3443).listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await request(`http://127.0.0.1:${port}`)
        .post('/terminal?x=1')
        .set('Host', 'school.example.in');
      expect(r.status).toBe(308);
      expect(r.headers['location']).toBe('https://school.example.in:3443/terminal?x=1');
      const bad = await request(`http://127.0.0.1:${port}`).get('/').set('Host', 'evil/x');
      expect(bad.status).toBe(400);
      const standard = createRedirectServer(443).listen(0);
      const p2 = (standard.address() as AddressInfo).port;
      const r2 = await request(`http://127.0.0.1:${p2}`).get('/console').set('Host', 'a.in:80');
      expect(r2.headers['location']).toBe('https://a.in/console');
      standard.close();
    } finally {
      server.close();
    }
  });
});

describe('the web application on the same address (WEB_ROOT)', () => {
  const loader = "document.querySelectorAll('link').forEach(function(l){l.media='all'})";
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ringpe-web-'));
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><html><head><base href="/"><script>${loader}</script></head><body><rp-root></rp-root><script src="main-ABCD1234.js" type="module"></script></body></html>`,
    );
    writeFileSync(join(dir, 'main-ABCD1234.js'), 'console.log(1)');
    writeFileSync(join(dir, 'favicon.ico'), 'x');
    mkdirSync(join(dir, 'i18n'));
    writeFileSync(join(dir, 'i18n', 'ui-text.en.json'), '{}');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('hashes only the inline scripts', () => {
    const want = `'sha256-${createHash('sha256').update(loader).digest('base64')}'`;
    expect(
      inlineScriptHashes(
        `<script>${loader}</script><script src="a.js"></script><script> </script>`,
      ),
    ).toEqual([want]);
  });

  it('serves pages, bundles and files with page headers; the API keeps its own', async () => {
    const { app } = await buildTestApp({ env: { WEB_ROOT: dir } });

    const page = await request(app).get('/console/readers');
    expect(page.status).toBe(200);
    expect(page.type).toBe('text/html');
    expect(page.text).toContain('<rp-root>');
    expect(page.headers['cache-control']).toBe('no-cache');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain(`script-src 'self' ${inlineScriptHashes(page.text)[0]}`);
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:47821");
    expect(csp).toContain("frame-ancestors 'none'");

    const js = await request(app).get('/main-ABCD1234.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get('/i18n/ui-text.en.json')).headers['cache-control']).toBe(
      'no-cache',
    );

    // A missing file is a 404, not the app's page.
    expect((await request(app).get('/chunk-MISSING1.js')).status).toBe(404);

    // The API, health and the bank's addresses are never the web app.
    const health = await request(app).get('/health/live');
    expect(health.headers['content-security-policy']).toContain("default-src 'none'");
    const api = await request(app).get('/api/v1/nothing');
    expect(api.type).toBe('application/problem+json');
    expect((await request(app).get('/cug/bank/token')).type).toBe('application/problem+json');
    // Only reads are pages.
    expect((await request(app).post('/console/readers').send({})).type).toBe(
      'application/problem+json',
    );
  });

  // 2026-10-13: a rebuilt web app kept being served its old page until the API was restarted.
  it('serves the page of the latest build without a restart', async () => {
    const own = mkdtempSync(join(tmpdir(), 'ringpe-web-'));
    try {
      const index = join(own, 'index.html');
      const page = (main: string, script: string) =>
        `<!doctype html><html><head><script>${script}</script></head><body><script src="${main}"></script></body></html>`;
      writeFileSync(index, page('main-OLD11111.js', 'var a=1'));
      const { app } = await buildTestApp({ env: { WEB_ROOT: own } });
      expect((await request(app).get('/console')).text).toContain('main-OLD11111.js');

      writeFileSync(index, page('main-NEW22222.js', 'var b=2'));
      const later = new Date(Date.now() + 60_000);
      utimesSync(index, later, later);
      const next = await request(app).get('/console');
      expect(next.text).toContain('main-NEW22222.js');
      // Its inline script is allowed, not the old one's.
      const csp = String(next.headers['content-security-policy']);
      expect(csp).toContain(inlineScriptHashes(next.text)[0]);
      expect(csp).not.toContain(inlineScriptHashes(page('x', 'var a=1'))[0]);

      // Mid-build (no index.html for a moment): the last page stays.
      rmSync(index);
      expect((await request(app).get('/console')).text).toContain('main-NEW22222.js');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('refuses to start without a built web application', async () => {
    await expect(buildTestApp({ env: { WEB_ROOT: join(dir, 'missing') } })).rejects.toThrow(
      /WEB_ROOT: index.html not found/,
    );
  });
});
