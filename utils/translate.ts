/**
 * Shared file. The master is RingPe_Backend_API/utils/translate.ts; identical copies live in
 * RingPe_Web_Application/src/components/Utils/ and RingPe_Mobile_App/src/utils/. Edit the master,
 * then run `npm run shared:sync` in RingPe_Backend_API (`npm run shared:check` fails on drift).
 *
 * Message lookup with `{name}` placeholders and a fallback to English — never to the key itself
 * (OI-GAS-20, FR-PLT-01).
 */
import { MESSAGES_EN } from './messages.en';

export type Bundle = Readonly<Record<string, string>>;

let active: Bundle = MESSAGES_EN;

/**
 * The bundle `translate` uses when none is passed: a web page set in the person's language loads
 * its bundle once at start-up (the language menu reloads the page).
 */
export function useBundle(bundle: Bundle): void {
  active = bundle;
}

/** The bundle in use (the web looks up its own screen texts' English when a key is missing). */
export function activeBundle(): Bundle {
  return active;
}

/**
 * Translates `key`. Order: the requested bundle (default: the one in use), then English. If the key is unknown everywhere, a
 * neutral English sentence is returned instead of the raw key.
 */
export function translate(
  key: string,
  params: Readonly<Record<string, string | number>> = {},
  bundle: Bundle = active,
): string {
  const template =
    bundle[key] ?? MESSAGES_EN[key] ?? MESSAGES_EN['GEN.INTERNAL'] ?? 'Something went wrong.';
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}
