/**
 * Transport (27.2 / 27.3 §22, adopted; RC-25). Masters (routes, stops, vehicles, crew, sessions,
 * assignments, allocations) keep their registered 1 / 0 flags as `active`. A trip is generated
 * Scheduled, started and completed by its crew, or cancelled; its stops are passed in order; boarding is
 * written by the crew (RC-25).
 */
import { NEW, type StatusDomain } from './types';

export const TRIP: StatusDomain<'SCHEDULED' | 'STARTED' | 'COMPLETED' | 'CANCELLED'> = {
  domain: 'trip',
  srsDomain: 'Trip (status)',
  rc: 'RC-25',
  values: [
    {
      code: 'SCHEDULED',
      registerValue: 'SCHEDULED',
      labelKey: 'status.trip.scheduled',
      label: 'Upcoming',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'STARTED',
      registerValue: 'STARTED',
      labelKey: 'status.trip.started',
      label: 'Ongoing',
      tone: 'brand',
      terminal: false,
    },
    {
      code: 'COMPLETED',
      registerValue: 'COMPLETED',
      labelKey: 'status.trip.completed',
      label: 'Completed',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'CANCELLED',
      registerValue: 'CANCELLED',
      labelKey: 'status.trip.cancelled',
      label: 'Cancelled',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'SCHEDULED',
      operation: 'the job trip-generation creates the day’s trip for an active assignment',
    },
    {
      from: 'SCHEDULED',
      to: 'STARTED',
      operation: 'the assigned driver or attendant starts it (TRN-029)',
    },
    {
      from: 'STARTED',
      to: 'COMPLETED',
      operation: 'the crew completes it once the final stop is reached or departed (TRN-032)',
    },
    {
      from: 'SCHEDULED',
      to: 'CANCELLED',
      operation: 'cancelled with remarks (TRN-025), or a stale trip of an earlier date by the job',
    },
  ],
};

export const TRIP_STOP: StatusDomain<'UPCOMING' | 'REACHED' | 'DEPARTED' | 'SKIPPED'> = {
  domain: 'trip_stop',
  srsDomain: 'Trip stop (status)',
  rc: null,
  values: [
    {
      code: 'UPCOMING',
      registerValue: 'UPCOMING',
      labelKey: 'status.tripStop.upcoming',
      label: 'Upcoming',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'REACHED',
      registerValue: 'REACHED',
      labelKey: 'status.tripStop.reached',
      label: 'Reached',
      tone: 'brand',
      terminal: false,
    },
    {
      code: 'DEPARTED',
      registerValue: 'DEPARTED',
      labelKey: 'status.tripStop.departed',
      label: 'Departed',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'SKIPPED',
      registerValue: 'SKIPPED',
      labelKey: 'status.tripStop.skipped',
      label: 'Skipped',
      tone: 'warn',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'UPCOMING', operation: 'the job creates the trip’s stops in travel order' },
    {
      from: 'UPCOMING',
      to: 'REACHED',
      operation:
        'the crew marks it reached after the previous stop departed or was skipped (TRN-030)',
    },
    { from: 'REACHED', to: 'DEPARTED', operation: 'the crew marks it departed (TRN-030)' },
    {
      from: 'UPCOMING',
      to: 'SKIPPED',
      operation: 'the crew skips it with remarks, in order (TRN-030)',
    },
  ],
};

export const BOARDING: StatusDomain<'CHECKED_IN' | 'CHECKED_OUT' | 'NO_SHOW' | 'MISSED'> = {
  domain: 'boarding',
  srsDomain: 'Boarding attendance (status)',
  rc: 'RC-25',
  values: [
    {
      code: 'CHECKED_IN',
      registerValue: 'CHECKED_IN',
      labelKey: 'status.boarding.checkedIn',
      label: 'Boarded',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'CHECKED_OUT',
      registerValue: 'CHECKED_OUT',
      labelKey: 'status.boarding.checkedOut',
      label: 'Got off',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'NO_SHOW',
      registerValue: 'NO_SHOW',
      labelKey: 'status.boarding.noShow',
      label: 'No show',
      tone: 'warn',
      terminal: true,
    },
    {
      code: 'MISSED',
      registerValue: 'MISSED',
      labelKey: 'status.boarding.missed',
      label: 'Missed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'CHECKED_IN',
      operation: 'the crew records the passenger boarding at a stop (TRN-031)',
    },
    {
      from: NEW,
      to: 'NO_SHOW',
      operation: 'the crew records the passenger did not come to the stop (TRN-031)',
    },
    {
      from: NEW,
      to: 'MISSED',
      operation: 'the crew records the passenger missed the bus (TRN-031)',
    },
    {
      from: 'CHECKED_IN',
      to: 'CHECKED_OUT',
      operation: 'the crew records the passenger getting off (TRN-031)',
    },
  ],
};

export const TRANSPORT_DOMAINS = [TRIP, TRIP_STOP, BOARDING] as const;
