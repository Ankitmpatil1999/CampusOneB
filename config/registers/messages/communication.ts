/**
 * Communication messages (SRS 23; COM-001…024). The 27.5 wording is kept where it reads well (class K);
 * new texts are class N — client standing approval 2026-10-03.
 */
import type { MessageDefinition } from './types';

const k = (key: string, register: string, text: string, http: number, refs: readonly string[]) =>
  ({
    key,
    register,
    srsText: text,
    class: 'K',
    type: 'error',
    http,
    en: text,
    approval: 'register',
    batch: 8,
    refs,
  }) as const;

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

const r = (
  key: string,
  register: string,
  srsText: string,
  http: number,
  en: string,
  refs: readonly string[],
  placeholders?: readonly string[],
) =>
  ({
    key,
    register,
    srsText,
    class: 'R',
    type: 'error',
    http,
    en,
    ...(placeholders ? { placeholders } : {}),
    approval: 'approved',
    batch: 8,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

const info = (key: string, en: string, refs: readonly string[], placeholders: readonly string[]) =>
  ({
    key,
    register: null,
    srsText: null,
    class: 'N',
    type: 'info',
    en,
    placeholders,
    approval: 'approved',
    batch: 8,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const COMMUNICATION_MESSAGES = [
  k('COM.NOT_FOUND', 'MSG-COM-33', 'Announcement not found', 404, ['23.2']),
  n(
    'COM.TITLE',
    422,
    'Enter a title of {min} to {max} characters.',
    ['23.2', 'OI-COM-05'],
    ['min', 'max'],
  ),
  n(
    'COM.BODY',
    422,
    'Write the message in {min} to {max} characters.',
    ['23.2', 'OI-COM-05'],
    ['min', 'max'],
  ),
  n('COM.CATEGORY', 422, 'Choose a category.', ['23.2', 'OI-COM-03']),
  n('COM.TARGETS', 422, 'Choose who receives it.', ['23.2', 'OI-COM-04']),
  n('COM.NO_RECIPIENTS', 422, 'No one matches the chosen groups.', ['23.2', 'MSG-COM-11']),
  n(
    'COM.CHANNEL_DISABLED',
    409,
    '{channel} isn’t switched on for your school.',
    ['23.2', 'BR-70', 'OI-COM-09'],
    ['channel'],
  ),
  n('COM.SEND_AT', 422, 'Choose a send time within the next 30 days.', ['23.2']),
  n('COM.ALREADY_DISPATCHED', 409, 'This announcement has been sent; it can only be withdrawn.', [
    '23.2',
    'OI-COM-08',
  ]),
  n('COM.ALREADY_WITHDRAWN', 409, 'This announcement is already withdrawn.', ['23.2', 'OI-COM-08']),
  n('COM.WITHDRAW_REASON', 422, 'Give the reason for withdrawing it (5 to 300 characters).', [
    '23.2',
    'OI-COM-08',
  ]),
  n('COM.ACK_NOT_REQUIRED', 409, 'This announcement doesn’t ask for an acknowledgement.', [
    '23.3',
    'OI-COM-11',
  ]),
  n('COM.NOT_SENT', 409, 'This announcement hasn’t been sent yet.', ['23.2']),
  info('NTF.ANNOUNCEMENT', '{title}', ['23.2', 'FR-COM-01'], ['title']),
  info(
    'NTF.ANNOUNCEMENT_REMINDER',
    'Please acknowledge: {title}',
    ['23.2', 'FR-COM-03'],
    ['title'],
  ),
  // Direct messages (23.9–23.11; COM-016…021; FR-COM-05; BR-71).
  k('COM.DM_SELF', 'MSG-COM-117', 'You cannot send a direct message to yourself', 422, [
    '23.9.4',
    'RNG-COM-089',
  ]),
  r(
    'COM.DM_BODY',
    'MSG-COM-118',
    'content is required and must not exceed 4000 characters',
    422,
    'Write a message of 1 to {max} characters.',
    ['23.9.4', 'RNG-COM-090'],
    ['max'],
  ),
  k('COM.DM_RECIPIENT', 'MSG-COM-122', 'Recipient is inactive or not in your organization', 404, [
    '23.9.4',
    'RNG-COM-088',
  ]),
  k(
    'COM.DM_NOT_PERMITTED',
    'MSG-COM-123',
    'Your role is not permitted to message this recipient type',
    403,
    ['23.9.4', 'RNG-COM-092', 'BR-71'],
  ),
  n(
    'COM.DM_NOT_A_CONTACT',
    403,
    'You can start a conversation only with someone in your contacts.',
    ['23.9.5', 'RNG-COM-108', 'RNG-COM-126'],
  ),
  k(
    'COM.CONVERSATION_NOT_FOUND',
    'MSG-COM-130',
    'Conversation not found or access is not permitted',
    404,
    ['23.9.5', 'RNG-COM-105'],
  ),
  k(
    'COM.DM_RATE_LIMITED',
    'MSG-COM-136',
    'Too many direct messages. Please try again shortly.',
    429,
    ['23.9.5', 'RNG-COM-097'],
  ),
  info('NTF.DIRECT_MESSAGE', 'Message from {name}', ['23.9.4', 'FR-COM-05'], ['name']),
  // The communication report and exports (23.18.1, CR-16; OI-COM-50: wording at design time).
  n('COM.REPORT_RANGE', 422, 'The end date must be on or after the start date.', [
    '23.18.1',
    'RNG-COM-175',
  ]),
  n('RPT.EXPORT_NOT_FOUND', 404, 'Export not found.', ['OI-GAS-17']),
  // Cross-institution reporting (26.9.1, CR-18; OI-RPT-30: wording at design time).
  n('RPT.XI_NOT_ENTITLED', 403, 'Your role can’t read figures across institutions.', [
    'CR-18',
    'RNG-GOV-030',
    'RNG-RPT-125',
  ]),
  n(
    'RPT.XI_SELECTION_TOO_LARGE',
    422,
    'Choose at most {max} institutions to compare.',
    ['CR-18', 'RNG-RPT-121'],
    ['max'],
  ),
  n('RPT.XI_SELECTION', 422, 'Choose the institutions to compare, or a status.', [
    'CR-18',
    'RNG-GOV-034',
  ]),
  n('RPT.XI_REASON', 422, 'Give the reason for reading these figures (10 to 300 characters).', [
    'CR-18',
    'RNG-GOV-032',
  ]),
  n('RPT.XI_NOT_IN_SELECTION', 404, 'That institution isn’t part of this comparison.', [
    'CR-18',
    'RNG-RPT-123',
  ]),
  n('RPT.ACCESS_NOT_FOUND', 404, 'Comparison not found.', ['CR-18']),
  // Console reports (24; RPT-002…004).
  n('RPT.REPORT_NOT_FOUND', 404, 'Report not found.', ['24', 'CR-17']),
  n('RPT.PARAM_INVALID', 422, 'Choose a period of at most one year.', ['24', 'CR-13']),
  n('RPT.EXPORT_NOT_READY', 409, 'The export is still being prepared.', ['OI-GAS-17']),
  n('RPT.EXPORT_EXPIRED', 410, 'This export has expired. Export the report again.', ['OI-GAS-17']),
  // Notification settings per event (client 2026-10-16; COM-032/033).
  n('COM.EVENT_UNKNOWN', 422, 'There is no notification event {event}.', ['client 2026-10-16'], [
    'event',
  ]),
] as const satisfies readonly MessageDefinition[];

export type CommunicationMessageKey = (typeof COMMUNICATION_MESSAGES)[number]['key'];
