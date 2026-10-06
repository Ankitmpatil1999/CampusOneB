/**
 * Machine-draft translations of the register texts and the member app's screen texts (client
 * 2026-10-02: "please prepare machine drafts"), one file per language. They seed the translations
 * table as MACHINE drafts; reviewers correct them in the back office (IDN-073/074), and a corrected
 * text is never overwritten by a later seed. `scripts/translation-source.ts <out> <lang>` lists the
 * keys a language still lacks.
 */
import hi from './hi.json';
import kn from './kn.json';
import ml from './ml.json';
import mr from './mr.json';
import ta from './ta.json';
import te from './te.json';

export const MACHINE_TRANSLATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  kn,
  hi,
  te,
  ta,
  ml,
  mr,
};
