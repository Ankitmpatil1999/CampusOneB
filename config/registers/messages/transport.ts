/**
 * Transport messages (SRS 22; TRN-001…034). The 27.5 wording is kept where it reads well (class K) or
 * reworded where it shows a value or names a field (class R); new texts are class N — client standing
 * approval 2026-10-03.
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
    batch: 7,
    refs: [...refs, 'client standing approval 2026-10-03'],
  }) as const;

export const TRANSPORT_MESSAGES = [
  // --- masters ----------------------------------------------------------------------------------------
  k('TRN.ROUTE_CODE_TAKEN', 'MSG-TRN-025', 'Route Code already exists.', 409, ['22.2']),
  k('TRN.ROUTE_NOT_FOUND', 'MSG-TRN-027', 'Route not found.', 404, ['22.2', '22.6']),
  k('TRN.STOP_NAME_TAKEN', 'MSG-TRN-033', 'Stop already exists.', 409, ['22.2']),
  k('TRN.STOP_NOT_FOUND', 'MSG-TRN-035', 'Stop not found.', 404, ['22.2']),
  {
    key: 'TRN.STOP_IN_USE',
    register: 'MSG-TRN-036',
    srsText: 'Stop is already mapped and cannot be deleted.',
    class: 'R',
    type: 'error',
    http: 409,
    en: 'This stop is on an active route, so it can’t be made inactive.',
    approval: 'approved',
    batch: 7,
    refs: ['22.2', 'OI-TRN-29', 'client standing approval 2026-10-03'],
  },
  k('TRN.LAT', 'MSG-TRN-007', 'Latitude must be between -90 and 90', 422, ['22.2']),
  k('TRN.LNG', 'MSG-TRN-008', 'Longitude must be between -180 and 180', 422, ['22.2']),
  k('TRN.DISTANCE', 'MSG-TRN-312', 'Distance From Previous cannot be negative.', 422, ['22.16']),
  k(
    'TRN.STOP_SEQUENCE',
    'MSG-TRN-315',
    'Stop Sequence should be continuous starting from 0.',
    422,
    ['22.16'],
  ),
  {
    key: 'TRN.DUPLICATE_STOP',
    register: 'MSG-TRN-313',
    srsText: '"Duplicate Stop Id : " followed by the stop',
    class: 'R',
    type: 'error',
    http: 422,
    en: '{stop} appears twice on the route.',
    placeholders: ['stop'],
    approval: 'approved',
    batch: 7,
    refs: ['22.16', 'BR-62', 'client standing approval 2026-10-03'],
  },
  n('TRN.ROUTE_DETAILS', 422, 'Enter a route code of 1 to 10 characters and a name.', ['22.2']),
  n('TRN.NAME', 422, 'Enter a name of 2 to 80 characters.', ['22.2', '22.3']),
  k('TRN.REGISTRATION_TAKEN', 'MSG-TRN-082', 'Registration Number already exists.', 409, ['22.3']),
  k('TRN.CAPACITY', 'MSG-TRN-080', 'Capacity should be greater than zero.', 422, ['22.3']),
  k('TRN.VEHICLE_NOT_FOUND', 'MSG-TRN-085', 'Bus not found.', 404, ['22.3', '22.6']),
  n('TRN.REGISTRATION', 422, 'Enter the registration number (up to 15 characters).', ['22.3']),
  k('TRN.ALREADY_CREW', 'MSG-TRN-113', 'Employee already registered as Transport Staff.', 409, [
    '22.4',
  ]),
  k('TRN.MEMBER_NOT_FOUND', 'MSG-TRN-112', 'Employee not found or Inactive.', 422, ['22.4']),
  k('TRN.LICENCE_TAKEN', 'MSG-TRN-115', 'License Number already exists.', 409, ['22.4']),
  k('TRN.CREW_NOT_FOUND', 'MSG-TRN-117', 'Staff not found.', 404, ['22.4']),
  n(
    'TRN.EMPLOYEE_REF_TAKEN',
    409,
    '{ref} is already used by another crew member.',
    ['22.4', 'BR-60'],
    ['ref'],
  ),
  n(
    'TRN.LICENCE_REQUIRED',
    422,
    'A driver needs a licence number and an expiry date in the future.',
    ['22.4', 'OI-TRN-08'],
  ),
  k('TRN.SESSION_NAME_TAKEN', 'MSG-TRN-150', 'Session Name already exists.', 409, ['22.5']),
  k('TRN.SESSION_NOT_FOUND', 'MSG-TRN-152', 'Session not found.', 404, ['22.5', '22.6']),
  k('TRN.SESSION_TIMES', 'MSG-TRN-146', 'End Time should be greater than Start Time.', 422, [
    '22.5',
  ]),
  n('TRN.SESSION_DAYS', 422, 'Choose the days the session runs.', ['22.5', 'OI-TRN-09']),
  // --- assignments and allocations ----------------------------------------------------------------------
  k('TRN.DATES', 'MSG-TRN-179', 'Effective To cannot be earlier than Effective From.', 422, [
    '22.6',
  ]),
  k('TRN.VEHICLE_INACTIVE', 'MSG-TRN-180', 'Selected bus is inactive.', 409, ['22.6']),
  k('TRN.ROUTE_INACTIVE', 'MSG-TRN-181', 'Selected route is inactive.', 409, ['22.6', '22.7']),
  k('TRN.NOT_DRIVER', 'MSG-TRN-184', 'Selected user is not registered as a DRIVER.', 422, ['22.6']),
  k('TRN.NOT_ATTENDANT', 'MSG-TRN-188', 'Selected user is not registered as an ATTENDANT.', 422, [
    '22.6',
  ]),
  k('TRN.SAME_CREW', 'MSG-TRN-185', 'Driver and Attendant cannot be the same user.', 422, ['22.6']),
  k(
    'TRN.VEHICLE_BOOKED',
    'MSG-TRN-193',
    'Bus is already assigned for the selected date range.',
    409,
    ['22.6', 'BR-61'],
  ),
  k(
    'TRN.DRIVER_BOOKED',
    'MSG-TRN-194',
    'Driver is already assigned for the selected date range.',
    409,
    ['22.6', 'BR-61'],
  ),
  k(
    'TRN.ATTENDANT_BOOKED',
    'MSG-TRN-195',
    'Attendant is already assigned for the selected date range.',
    409,
    ['22.6', 'BR-61'],
  ),
  k(
    'TRN.ROUTE_SESSION_TAKEN',
    'MSG-TRN-192',
    'Route is already assigned to this session for the selected date range.',
    409,
    ['22.6'],
  ),
  k('TRN.ASSIGNMENT_NOT_FOUND', 'MSG-TRN-197', 'Bus Assignment not found.', 404, ['22.6']),
  k('TRN.STOP_NOT_ON_ROUTE', 'MSG-TRN-224', 'Stop is not mapped to the selected route.', 422, [
    '22.7',
  ]),
  k(
    'TRN.ALREADY_ALLOCATED',
    'MSG-TRN-225',
    'User already has an active transport allocation for the selected date range.',
    409,
    ['22.7'],
  ),
  k('TRN.ALLOCATION_NOT_FOUND', 'MSG-TRN-227', 'User Allocation not found.', 404, ['22.7']),
  n('TRN.ALLOCATION_ENDED', 409, 'This allocation has already ended.', ['22.7']),
  n('TRN.MEMBERS', 422, 'Choose up to 200 active members of the school.', ['22.7']),
  n(
    'TRN.CHOICE_REASON',
    422,
    'Give the reason for changing the transport choice (3 to 200 characters).',
    ['22.7', 'client 2026-10-12'],
  ),
  n(
    'TRN.NO_TRANSPORT_CHOICE',
    409,
    'This student has no transport choice on record from the admission form, so they can be allocated already.',
    ['22.7', 'client 2026-10-12'],
  ),
  n(
    'TRN.OPT_OUT_ALLOCATED',
    409,
    'End the student’s current transport allocation before marking them as not opted.',
    ['22.7', 'client 2026-10-12'],
  ),
  n(
    'TRN.NOT_OPTED',
    409,
    'Only students who opted for school transport can be allocated a bus. Not opted on the admission form: {names}.',
    ['22.7', 'client 2026-10-12'],
    ['names'],
  ),
  // --- trips ----------------------------------------------------------------------------------------------
  k('TRN.TRIP_NOT_FOUND', 'MSG-TRN-252', 'Trip not found.', 404, ['22.8']),
  k('TRN.TRIP_ALREADY_CANCELLED', 'MSG-TRN-254', 'Trip is already cancelled.', 409, ['22.8']),
  k('TRN.TRIP_COMPLETED_CANCEL', 'MSG-TRN-255', 'Completed trip cannot be cancelled.', 409, [
    '22.8',
  ]),
  k('TRN.TRIP_STARTED_CANCEL', 'MSG-TRN-256', 'Started trip cannot be cancelled.', 409, ['22.8']),
  n('TRN.CANCEL_REMARKS', 422, 'Give the reason for cancelling the trip (5 to 300 characters).', [
    '22.8',
    'OI-TRN-15',
  ]),
  k('TRN.RANGE_DATES', 'MSG-TRN-257', 'To Date cannot be earlier than From Date.', 422, [
    '22.8',
    '22.10',
  ]),
  n('TRN.REPORT_NOT_FOUND', 404, 'Report not found.', ['22.10', 'OI-TRN-20']),
  k(
    'TRN.NOT_YOUR_TRIP',
    'MSG-TRN-282',
    'You are not assigned as Driver or Attendant for this trip.',
    403,
    ['22.13'],
  ),
  k('TRN.TRIP_CANCELLED_UPDATE', 'MSG-TRN-283', 'Cancelled trip cannot be updated.', 409, [
    '22.13',
  ]),
  k('TRN.TRIP_NOT_SCHEDULED', 'MSG-TRN-284', 'Only a scheduled trip can be started.', 409, [
    '22.13',
  ]),
  k('TRN.TRIP_NOT_STARTED_COMPLETE', 'MSG-TRN-285', 'Only a started trip can be completed.', 409, [
    '22.13',
  ]),
  k(
    'TRN.STOPS_PENDING',
    'MSG-TRN-287',
    'Trip can only be completed after reaching the final stop.',
    409,
    ['22.13'],
  ),
  k('TRN.TRIP_COMPLETED_UPDATE', 'MSG-TRN-290', 'Completed trip cannot be updated.', 409, [
    '22.13',
  ]),
  k(
    'TRN.TRIP_NOT_STARTED',
    'MSG-TRN-291',
    'Trip must be started before updating stop status.',
    409,
    ['22.13'],
  ),
  k('TRN.TRIP_STOP_NOT_FOUND', 'MSG-TRN-292', 'Trip Stop not found.', 404, ['22.13']),
  k(
    'TRN.STOP_NOT_UPCOMING',
    'MSG-TRN-293',
    'Only an upcoming stop can be marked as reached.',
    409,
    ['22.13'],
  ),
  k('TRN.STOP_NOT_REACHED', 'MSG-TRN-294', 'Stop must be reached before it can be departed.', 409, [
    '22.13',
  ]),
  k('TRN.SKIP_NOT_UPCOMING', 'MSG-TRN-295', 'Only an upcoming stop can be skipped.', 409, [
    '22.13',
  ]),
  k(
    'TRN.STOP_OUT_OF_ORDER',
    'MSG-TRN-296',
    'Previous stop must be departed or skipped first.',
    409,
    ['22.13', 'BR-62'],
  ),
  n('TRN.SKIP_REMARKS', 422, 'Give a reason for skipping the stop.', ['22.13']),
  n('TRN.NOT_CREW', 403, 'Only drivers and attendants can open this.', ['22.13']),
  n(
    'TRN.NOT_A_PASSENGER',
    422,
    '{name} isn’t allocated to this route today.',
    ['22.18', 'OI-TRN-26'],
    ['name'],
  ),
  n('TRN.BOARDING_ORDER', 409, 'Record the boarding before the passenger gets off.', [
    '22.18',
    'RC-25',
  ]),
  // --- maps, live tracking and the transport fee by distance (client 2026-10-21) -----------------------
  n('TRN.TRIP_NOT_RUNNING', 409, 'This trip isn’t running, so its position isn’t shared.', [
    'client 2026-10-21',
  ]),
  n('TRN.POSITION', 422, 'The position isn’t valid.', ['client 2026-10-21']),
  n(
    'TRN.STOPS_WITHOUT_PLACE',
    422,
    'Place these stops on the map first: {stops}.',
    ['client 2026-10-21'],
    ['stops'],
  ),
  n('TRN.MAPS_OFF', 409, 'Maps aren’t set up on this server yet.', ['client 2026-10-21']),
  n('TRN.MAPS_FAILED', 502, 'The map service didn’t answer. Try again in a moment.', [
    'client 2026-10-21',
  ]),
  n('TRN.FEE_RATE', 422, 'Enter the yearly rate per km, from ₹0 to ₹1,00,000.', [
    'client 2026-10-21',
  ]),
  n('TRN.FEE_DUE_DAY', 422, 'Choose a due day from 1 to 28.', ['client 2026-10-21']),
  n('TRN.FEE_RULE_OFF', 409, 'Turn on the transport fee by distance and set its rate first.', [
    'client 2026-10-21',
  ]),
  info(
    'NTF.BUS_NEAR_STOP',
    '{bus} is near {stop}',
    ['client 2026-10-21 (live tracking)'],
    ['bus', 'stop'],
  ),
  info('NTF.TRANSPORT_ALLOCATED', 'Transport: {route}', ['22.7', 'OI-TRN-13'], ['route']),
  info(
    'NTF.TRANSPORT_ENDED',
    'Transport on {route} ends on {date}',
    ['22.7', 'OI-TRN-13'],
    ['route', 'date'],
  ),
  info(
    'NTF.TRIP_STARTED',
    '{bus} has started — {session}',
    ['22.13', 'OI-TRN-25'],
    ['bus', 'session'],
  ),
  info(
    'NTF.TRIP_CANCELLED',
    '{session} on {route} is cancelled',
    ['22.8', 'OI-TRN-25'],
    ['session', 'route'],
  ),
] as const satisfies readonly MessageDefinition[];

export type TransportMessageKey = (typeof TRANSPORT_MESSAGES)[number]['key'];
