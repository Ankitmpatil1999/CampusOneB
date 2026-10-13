/**
 * The API's listener: HTTPS when USE_HTTPS is on (reference server.js: key, certificate chain and
 * passphrase from files, TLS 1.2 or newer), plain HTTP otherwise (TLS ended by a load balancer or
 * reverse proxy in front). With HTTP_REDIRECT_PORT, a plain-HTTP port answers every request with a
 * permanent redirect to the same path on the HTTPS address.
 *
 * Browsers give pages their secure-only features (the terminal's device key store, Secure cookies)
 * only on https:// or localhost, so a server reached by its address must use HTTPS.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { RequestListener } from 'node:http';
import type { Config } from '../config/config';

/** Reads a TLS file; a problem names the setting, never the file's content. */
function readTlsFile(setting: string, path: string) {
  try {
    return readFileSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Error(`${setting}: the file can't be read (${code})`, { cause: e });
  }
}

export function createApiServer(app: RequestListener, tls: Config['tls']) {
  if (!tls) return { server: http.createServer(app), scheme: 'http' as const };
  const server = https.createServer(
    {
      key: readTlsFile('KEY_PATH', tls.keyPath),
      cert: readTlsFile('CERTIFICATE_PATH', tls.certPath),
      ...(tls.passphrase ? { passphrase: tls.passphrase } : {}),
      minVersion: 'TLSv1.2',
    },
    app,
  );
  return { server, scheme: 'https' as const };
}

const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]{2,45}\]$/;

/** A plain-HTTP listener that sends every request to the HTTPS port (308 keeps the method). */
export function createRedirectServer(httpsPort: number) {
  return http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!HOST.test(host)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Bad request');
      return;
    }
    const port = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(308, {
      Location: `https://${host}${port}${req.url ?? '/'}`,
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end();
  });
}
