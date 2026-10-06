/**
 * Platform tool messages (SRS 6.30, 6.31, 18.5; IDN-070…076, INT-009/010). New texts, class N — client
 * standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const n = (
  key: string,
  http: number,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 8,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const PLATFORM_TOOL_MESSAGES = [
  n('I18N.LANGUAGE_EXISTS', 409, 'That language is already in the list.', ['6.30']),
  n('I18N.LANGUAGE_NOT_FOUND', 404, 'Language not found.', ['6.30']),
  n(
    'I18N.LANGUAGE_CODE',
    422,
    'Enter a language code (such as kn or ta) and its English and native names.',
    ['6.30'],
  ),
  n('I18N.DEFAULT_ENABLED', 409, 'The default language must stay switched on.', ['6.30']),
  n('I18N.KEY_NOT_FOUND', 404, 'This text key doesn’t exist.', ['6.30', 'OI-GAS-20']),
  n('I18N.TEXT_LENGTH', 422, 'Enter a text of up to 2,000 characters.', ['6.30']),
  n(
    'I18N.PLACEHOLDERS',
    422,
    '{lang}: keep the placeholders {names}.',
    ['6.30'],
    ['lang', 'names'],
  ),
  n('LOG.NOT_FOUND', 404, 'Log entry not found.', ['6.31']),
  n('LOG.RANGE', 422, 'Choose a time range of up to {days} days.', ['6.31'], ['days']),
  n('INT.CHANNEL_NOT_FOUND', 404, 'Channel not found.', ['18.5']),
  n(
    'INT.PROVIDER_NOT_INTEGRATED',
    409,
    '{channel} has no provider yet, so it can’t be switched on.',
    ['18.5', 'Q17', 'OQ-26'],
    ['channel'],
  ),
  n('INT.IN_APP_REQUIRED', 409, 'In-app messages can’t be switched off.', ['18.5']),
] as const satisfies readonly MessageDefinition[];

export type PlatformToolMessageKey = (typeof PLATFORM_TOOL_MESSAGES)[number]['key'];
