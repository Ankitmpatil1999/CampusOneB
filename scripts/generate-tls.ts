/**
 * A certificate for HTTPS on a server reached by its LAN address or an internal name, until it has
 * one from a public certificate authority. Creates, in keys/tls/ (gitignored):
 *
 * - ca.crt / ca.key — "CampusOne Local CA", made once and kept. Install ca.crt as a trusted root on
 *   each computer and phone that opens CampusOne (then no browser warning); ca.key never leaves here.
 * - server.crt (the full chain) / server.key — for this server's names and addresses: localhost,
 *   127.0.0.1, this computer's name and its LAN addresses, plus any names or addresses given.
 *   Made again on every run (valid 825 days, the most browsers accept).
 *
 *   npm run tls:generate -- [name-or-address …]
 *
 * Needs openssl (Git for Windows ships it). A public domain should use a public certificate
 * (e.g. Let's Encrypt) instead: point KEY_PATH and CERTIFICATE_PATH at its files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'keys', 'tls');
mkdirSync(dir, { recursive: true });

function openssl(): string {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {
      // try the next one
    }
  }
  console.error(
    'openssl was not found. Install Git for Windows (it includes openssl) and run again.',
  );
  process.exit(1);
}
const bin = openssl();
// Git's MSYS openssl would read "/CN=…" as a path: keep arguments as given.
const env = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
const run = (args: string[]) => execFileSync(bin, args, { cwd: dir, stdio: 'pipe', env });

// --- the local certificate authority (kept) ---------------------------------------------------
const caKey = join(dir, 'ca.key');
const caCrt = join(dir, 'ca.crt');
if (existsSync(caKey) && existsSync(caCrt)) {
  console.log('kept     keys/tls/ca.crt (CampusOne Local CA)');
} else {
  run(['genrsa', '-out', 'ca.key', '3072']);
  run([
    'req',
    '-x509',
    '-new',
    '-key',
    'ca.key',
    '-sha256',
    '-days',
    '3650',
    '-subj',
    '/CN=CampusOne Local CA/O=CampusOne',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-out',
    'ca.crt',
  ]);
  console.log('created  keys/tls/ca.crt (CampusOne Local CA)');
}

// --- the server certificate (made again each run) -------------------------------------------------
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n!.address);
const names = [
  ...new Set([
    'localhost',
    '127.0.0.1',
    hostname().toLowerCase(),
    ...lan,
    ...process.argv.slice(2),
  ]),
];
const san = names.map((n) => (isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');

writeFileSync(
  join(dir, 'server.ext'),
  [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    `subjectAltName=${san}`,
  ].join('\n'),
);
run(['genrsa', '-out', 'server.key', '2048']);
run([
  'req',
  '-new',
  '-key',
  'server.key',
  '-subj',
  `/CN=${names[2]}/O=CampusOne`,
  '-out',
  'server.csr',
]);
run([
  'x509',
  '-req',
  '-in',
  'server.csr',
  '-CA',
  'ca.crt',
  '-CAkey',
  'ca.key',
  '-CAcreateserial',
  '-days',
  '825',
  '-sha256',
  '-extfile',
  'server.ext',
  '-out',
  'server-only.crt',
]);
// The chain the server sends: its certificate, then the authority's.
writeFileSync(
  join(dir, 'server.crt'),
  readFileSync(join(dir, 'server-only.crt'), 'utf8') + readFileSync(caCrt, 'utf8'),
);
for (const f of ['server.csr', 'server.ext', 'server-only.crt'])
  rmSync(join(dir, f), { force: true });

console.log(`created  keys/tls/server.crt and server.key for:
           ${names.join(', ')}

Add to .env (paths are relative to this folder):
USE_HTTPS=true
KEY_PATH=keys/tls/server.key
CERTIFICATE_PATH=keys/tls/server.crt

Then install keys/tls/ca.crt as a trusted root certificate on every computer and phone that opens
CampusOne (Windows: double-click it → Install Certificate → Local Machine → "Trusted Root Certification
Authorities"). Never copy ca.key anywhere.`);
