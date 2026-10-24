/**
 * What the importers from the earlier CUG application share (client 2026-10-23):
 * `import-cug-staff.ts` (the school and its staff) and `import-cug-students.ts` (students, the
 * merchant, the school's feature switches). Cleaning rules for the earlier data, the temporary
 * passwords and the confidential sign-in sheet.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** The remark and reason on what the import writes. */
export const CARRIED = 'Carried over from the earlier application';

export const MOBILE = /^[6-9]\d{9}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The last ten digits of a mobile as the earlier application stored it. */
export function digits10(v: unknown) {
  return String(v ?? '')
    .replace(/\D/g, '')
    .slice(-10);
}

/** Text with its spaces collapsed and trimmed. */
export const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * An e-mail with its typing slips corrected (client 2026-10-23): spaces in an address are dropped
 * ("KIRAN DMsrgs@…" is kirandmsrgs@…) and a doubled ending is written once (".com.com" is ".com").
 * Lower case; '' when nothing was given. Check the result with EMAIL.
 */
export function correctedEmail(v: unknown) {
  return clean(v)
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/\.([a-z]{2,})\.\1$/, '.$1');
}

/** "SUNATH H BAGADI" → first "SUNATH H", last "BAGADI"; one word stays the first name. */
export function splitName(full: string) {
  const parts = clean(full).split(' ').filter(Boolean);
  if (parts.length < 2) return { first: (parts[0] ?? '').slice(0, 60), last: null };
  return { first: parts.slice(0, -1).join(' ').slice(0, 60), last: parts.at(-1)!.slice(0, 60) };
}

/** "A +VE", "0+", "B +IVE" → "A+", "O+", "B+"; anything else as written. */
export function bloodGroup(v: unknown) {
  const s = clean(v)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^0/, 'O')
    .replace(/(\+|-)I?VE$/, '$1')
    .replace(/POSITIVE$/, '+')
    .replace(/NEGATIVE$/, '-');
  return s || null;
}

/** A decimal rupee amount ("10.00") in paise, without floating point. */
export function paiseOf(v: unknown) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? '0').trim());
  if (!m) throw new Error(`not an amount: ${String(v)}`);
  const n = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -n : n;
}

export const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** A random temporary password, as staff onboarding gives one (changed at first sign-in). */
export const temporaryPassword = () => `${randomBytes(9).toString('base64url').slice(0, 10)}@1`;

/**
 * Writes the confidential sign-in sheet `<dir>/<name>` (UTF-8 with BOM, opens in Excel). A sheet
 * already there is appended to, so the passwords given in an earlier run are not lost. Returns the
 * file's path.
 */
export function writeSignInSheet(
  dir: string,
  name: string,
  head: readonly string[],
  rows: readonly (readonly string[])[],
) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [head, ...rows].map((r) => r.map(esc).join(','));
  const existing = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\ufeff/, '') : '';
  writeFileSync(
    file,
    '\ufeff' +
      (existing ? `${existing.trimEnd()}\r\n${lines.slice(1).join('\r\n')}` : lines.join('\r\n')),
  );
  return file;
}

/** Every sheet of an .xlsx file (a zip of XML, read with zlib; no formulas run) as rows of text. */
export function readXlsx(path: string): Record<string, string[][]> {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path} is not an .xlsx file`);
  const entries = new Map<string, Buffer>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: damaged zip directory`);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const text = (name: string) => entries.get(name)?.toString('utf8') ?? '';
  const unxml = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&');
  const shared = (text('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
    unxml(
      (si.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''),
    ),
  );
  const rels = text('xl/_rels/workbook.xml.rels');
  const col = (ref: string) =>
    ref
      .replace(/\d+/g, '')
      .split('')
      .reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const out: Record<string, string[][]> = {};
  for (const m of text('xl/workbook.xml').matchAll(
    /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g,
  )) {
    const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`))?.[1] ?? '';
    const rows: string[][] = [];
    for (const r of text(`xl/${target.replace(/^\/?xl\//, '')}`).match(
      /<row[^>]*>[\s\S]*?<\/row>/g,
    ) ?? []) {
      const row: string[] = [];
      for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1] ?? 'A1';
        const t = c.match(/ t="([^"]+)"/)?.[1];
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const is = c.match(/<is>[\s\S]*?<\/is>/)?.[0];
        row[col(ref)] =
          t === 's'
            ? (shared[Number(v)] ?? '')
            : t === 'inlineStr'
              ? unxml((is ?? '').replace(/<[^>]+>/g, ''))
              : v !== undefined
                ? unxml(v)
                : '';
      }
      rows.push(Array.from(row, (x) => (x ?? '').trim()));
    }
    out[unxml(m[1]!)] = rows;
  }
  return out;
}
