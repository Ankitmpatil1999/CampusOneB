/**
 * Languages, the English bundle (built from the registers) and translation.
 * `utils/messages.en.ts` is the bundle written out for the web and mobile apps; a test fails when
 * it is stale (`npm run shared:sync` regenerates it).
 */
export { englishBundle } from '../config/registers';
export { translate, type Bundle } from './translate';

export interface LanguageInfo {
  readonly code: string;
  readonly name: string;
  readonly nativeName: string;
}

/**
 * Launch languages (client, 2026-10-02, Q18) in picker order: Kannada always next to English.
 */
export const LAUNCH_LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
];
