/**
 * Attendance messages (SRS 21.5–21.16; ATT-002, ATT-008…023, ATT-026). The 27.5 wording is kept where
 * it reads well (class K) or reworded where it names fields or shows a value (class R); new texts are
 * class N — client standing approval 2026-10-03.
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
    batch: 7,
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
    batch: 7,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const ATTENDANCE_MESSAGES = [
  k('ATT.DOUBLE_TAP', 'MSG-ATT-62', 'Please wait before tapping again', 429, [
    '21.6',
    'OI-ATT-05',
    'RNG-ATT-185',
  ]),
  k('ATT.ALREADY_COMPLETED', 'MSG-ATT-39', 'Attendance already completed', 409, ['21.5']),
  k('ATT.PERIOD_COMPLETED', 'MSG-ATT-63', 'Attendance already completed for this period', 409, [
    '21.6',
  ]),
  k('ATT.TYPE_NOT_FOUND', 'MSG-ATT-89', 'Attendance type not found', 404, ['21.8']),
  k('ATT.NO_CLASSES', 'MSG-ATT-97', 'No classes assigned to you.', 403, ['21.10']),
  {
    key: 'ATT.OUTSIDE_PERIOD',
    register: 'MSG-ATT-61',
    srsText: '"Allowed only between " followed by the period start and end time',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'Allowed only between {start} and {end}',
    placeholders: ['start', 'end'],
    approval: 'approved',
    batch: 7,
    refs: ['21.6', 'client standing approval 2026-10-03'],
  },
  {
    key: 'ATT.LOCATION_WAIT',
    register: 'MSG-ATT-90',
    srsText:
      '"Attendance already recorded. Please try again after " followed by the remaining seconds',
    class: 'R',
    type: 'error',
    http: 429,
    en: 'Attendance already recorded. Please try again after {seconds} seconds.',
    placeholders: ['seconds'],
    approval: 'approved',
    batch: 7,
    refs: ['21.8', 'OI-ATT-11', 'client standing approval 2026-10-03'],
  },
  n('ATT.NO_PERIOD_NOW', 409, 'There’s no period for this class right now.', ['21.6']),
  // Client 2026-10-26: a second tap too soon after the check-in is no check-out.
  n(
    'ATT.CHECKOUT_TOO_SOON',
    409,
    '{name} is already checked in (at {in}). Tap again after {after} to check out.',
    ['21.5', 'client 2026-10-26'],
    ['name', 'in', 'after'],
  ),
  n('ATT.NOT_IN_CLASS', 403, '{name} isn’t in this class.', ['21.6'], ['name']),
  n('ATT.FUTURE_DATE', 422, 'Attendance can’t be marked for a future date.', [
    '21.10',
    'OI-ATT-13',
  ]),
  n('ATT.MEMBER_NOT_FOUND', 422, 'Row {n}: this member isn’t in your school.', ['21.10'], ['n']),
  n('ATT.REMARK', 422, 'Keep the remark within 200 characters.', ['OI-ATT-23']),
  // Staff attendance at the front desk (client 2026-10-22).
  n(
    'ATT.NOT_STAFF',
    422,
    '{name} isn’t a staff member. Students are marked at the gate or by their teacher.',
    ['client 2026-10-22'],
    ['name'],
  ),
  n('ATT.ALREADY_CHECKED_IN', 409, 'Already checked in today.', ['client 2026-10-22']),
  n('ATT.NOT_CHECKED_IN', 409, 'Not checked in today yet.', ['client 2026-10-22']),
  n('ATT.TYPE_TAKEN', 409, '{name} already exists.', ['OI-IDN-22'], ['name']),
  n('ATT.TYPE_NAME', 422, 'Enter a name of 2 to 40 characters.', ['OI-ATT-23']),
  n('ATT.VISITOR_NOT_FOUND', 404, 'Visitor not found.', ['21.8']),
  n('ATT.VISITOR_OUT', 409, 'This visitor has already checked out.', ['21.8']),
  n('ATT.VISITOR_DETAILS', 422, 'Enter the visitor’s name, a 10-digit mobile and the purpose.', [
    '21.8',
  ]),
  n('ATT.CUTOFF', 422, 'Choose a cut-off time between 07:00 and 18:00.', ['OQ-14', 'OI-ATT-20']),
  // The staff timings by role on the Auto-absent page (client 2026-10-23).
  n('ATT.TIMING_NAME', 422, 'Enter a name of 2 to 60 characters.', ['client 2026-10-23']),
  n('ATT.TIMING_ROLES', 422, 'Choose at least one role.', ['client 2026-10-23']),
  n('ATT.TIMING_TAKEN', 422, '{name} already exists.', ['client 2026-10-23'], ['name']),
  n(
    'ATT.TIMING_ROLE_TAKEN',
    422,
    '{role} already follows “{timing}”. A role can be in one timing only.',
    ['client 2026-10-23'],
    ['role', 'timing'],
  ),
  n(
    'ATT.TIMING_ROLES_CHANGED',
    422,
    'One of these roles was just added to another timing. Reload and try again.',
    ['client 2026-10-23'],
  ),
  n('ATT.TIMING_AFTER', 422, 'Must be after the {after}.', ['client 2026-10-23'], ['after']),
  n('ATT.TIMING_BEFORE', 422, 'Must be before the {before}.', ['client 2026-10-23'], ['before']),
  n('ATT.TIMING_NOT_FOUND', 404, 'Staff timing not found.', ['client 2026-10-23']),
  n('ATT.RANGE', 422, 'Choose a range of up to {days} days.', ['OI-ATT-12'], ['days']),
  n('ATT.NOT_YOUR_PERIOD', 403, 'This period isn’t yours.', ['21.6', 'CR-02']),
  {
    key: 'NTF.ABSENT',
    register: null,
    srsText: null,
    class: 'N',
    type: 'info',
    en: '{name} was marked absent on {date}',
    placeholders: ['name', 'date'],
    approval: 'approved',
    batch: 7,
    refs: ['FR-COM-04', 'OI-ATT-21', 'client standing approval 2026-10-03'],
  },
] as const satisfies readonly MessageDefinition[];

export type AttendanceMessageKey = (typeof ATTENDANCE_MESSAGES)[number]['key'];
