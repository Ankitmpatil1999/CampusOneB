/**
 * Customer-portal statuses (FR-SAS-04; prototype s.data): a cancellation the institution asks for.
 * A new record with no 27.2 domain — register change RC-27 (client standing approval, 2026-10-03).
 * Data exports use the existing data_export domain (RC-26).
 */
import { NEW, type StatusDomain } from './types';

export type CancellationRequestStatus = 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'WITHDRAWN';

/** RC-27: a cancellation request waits for RingPe; the institution may withdraw it meanwhile. */
export const CANCELLATION_REQUEST: StatusDomain<CancellationRequestStatus> = {
  domain: 'cancellation_request',
  srsDomain: null,
  rc: 'RC-27',
  values: [
    {
      code: 'PENDING',
      registerValue: null,
      labelKey: 'status.cancellation_request.pending',
      label: 'Pending',
      tone: 'warn',
      terminal: false,
    },
    {
      code: 'CONFIRMED',
      registerValue: null,
      labelKey: 'status.cancellation_request.confirmed',
      label: 'Confirmed',
      tone: 'bad',
      terminal: true,
    },
    {
      code: 'DECLINED',
      registerValue: null,
      labelKey: 'status.cancellation_request.declined',
      label: 'Declined',
      tone: 'neutral',
      terminal: true,
    },
    {
      code: 'WITHDRAWN',
      registerValue: null,
      labelKey: 'status.cancellation_request.withdrawn',
      label: 'Withdrawn',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'the administrator asks to cancel (portal)' },
    { from: 'PENDING', to: 'CONFIRMED', operation: 'RingPe cancels the institution' },
    { from: 'PENDING', to: 'DECLINED', operation: 'RingPe declines, with a reason' },
    { from: 'PENDING', to: 'WITHDRAWN', operation: 'the administrator withdraws it' },
  ],
};
