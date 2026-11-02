/**
 * Lists the English texts that need a translation draft — the register bundle (messages, status and
 * reference labels) plus the member app's and the web's translated screen texts, and the English of the
 * web pages (`public/i18n/ui-text.en.json`). db/translations/source.en.json holds the
 * English the current drafts were made from, so only new or reworded texts are listed again.
 *
 *   npx tsx scripts/translation-source.ts <out.json>            every text
 *   npx tsx scripts/translation-source.ts <out.json> --changed  new or reworded since the drafts
 *   npx tsx scripts/translation-source.ts --accept              the drafts are up to date now
 *
 * Drafts are machine translations (client 2026-10-02) reviewed later in the back office.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { englishBundle } from '../config/registers';

const ROOT = join(import.meta.dirname, '..');
const SNAPSHOT = join(ROOT, 'db', 'translations', 'source.en.json');
const MOBILE_STRINGS = join(ROOT, '..', 'CampusOne_Mobile_App', 'src', 'utils', 'strings.en.ts');
/** The web's translated pages (Phase 10): `ui.web.*`. */
const WEB_STRINGS = join(
  ROOT,
  '..',
  'CampusOne_Web_App',
  'src',
  'components',
  'Utils',
  'strings.en.ts',
);

/** The English of the web pages written in English (ADR-0018): key → text, from `npm run ui-text`. */
const WEB_PAGES = join(ROOT, '..', 'CampusOne_Web_App', 'public', 'i18n', 'ui-text.en.json');

async function english(): Promise<Record<string, string>> {
  const all: Record<string, string> = { ...englishBundle() };
  if (existsSync(MOBILE_STRINGS)) {
    const mod = (await import(pathToFileURL(MOBILE_STRINGS).href)) as {
      STRINGS_EN: Record<string, string>;
    };
    Object.assign(all, mod.STRINGS_EN);
  }
  if (existsSync(WEB_STRINGS)) {
    const web = (await import(pathToFileURL(WEB_STRINGS).href)) as {
      WEB_STRINGS_EN: Record<string, string>;
    };
    Object.assign(all, web.WEB_STRINGS_EN);
  }
  if (existsSync(WEB_PAGES)) {
    Object.assign(all, JSON.parse(readFileSync(WEB_PAGES, 'utf8')) as Record<string, string>);
  }
  return Object.fromEntries(
    Object.keys(all)
      .sort()
      .map((k) => [k, all[k] ?? '']),
  );
}

const write = (file: string, data: Record<string, string>) =>
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

async function main() {
  const args = process.argv.slice(2);
  const all = await english();
  if (args.includes('--accept')) {
    write(SNAPSHOT, all);
    console.log(`${Object.keys(all).length} texts recorded as translated`);
    return;
  }
  const out = args.find((a) => !a.startsWith('--'));
  if (!out) throw new Error('usage: translation-source.ts <out.json> [--changed] | --accept');
  let keys = Object.keys(all);
  if (args.includes('--changed')) {
    const done = existsSync(SNAPSHOT)
      ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string>)
      : {};
    keys = keys.filter((k) => done[k] !== all[k]);
  }
  write(out, Object.fromEntries(keys.map((k) => [k, all[k] ?? ''])));
  console.log(`${keys.length} texts -> ${out}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
