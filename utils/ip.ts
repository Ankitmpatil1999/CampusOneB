import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/** An IP address as `VARBINARY(16)` bytes (IPv4-mapped IPv6 is stored as IPv4); null if unparsable. */
export function ipToBin(ip: string | undefined): Buffer | null {
  if (!ip) return null;
  const v4 = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return Buffer.from(v4.split('.').map(Number));
  if (!isIPv6(ip)) return null;
  const [head = '', tail = ''] = ip.split('::');
  const parts = (s: string) => (s ? s.split(':') : []);
  const h = parts(head);
  const t = parts(tail);
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return Buffer.from(
    groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]),
  );
}

export const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();
