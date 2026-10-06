/**
 * Communication (27.2 / 27.3 §23, adopted; RC-24). An announcement is queued, processed and completed
 * (or failed); every send is logged per recipient and channel with its outcome and kind.
 */
import { NEW, type StatusDomain } from './types';

export const ANNOUNCEMENT: StatusDomain<'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED'> = {
  domain: 'announcement',
  srsDomain: 'Announcement (dispatch status)',
  rc: null,
  values: [
    {
      code: 'QUEUED',
      registerValue: 'QUEUED',
      labelKey: 'status.announcement.queued',
      label: 'Queued',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'PROCESSING',
      registerValue: 'PROCESSING',
      labelKey: 'status.announcement.processing',
      label: 'Sending',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'COMPLETED',
      registerValue: 'COMPLETED',
      labelKey: 'status.announcement.completed',
      label: 'Sent',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.announcement.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'QUEUED',
      operation:
        'created by the console, the principal or a class teacher (COM-002, COM-022, COM-024)',
    },
    {
      from: 'QUEUED',
      to: 'PROCESSING',
      operation:
        'its send time has come: claimed once by the dispatch (or the job announcement-dispatch); one left sending for 10 minutes is claimed again and stays sending',
    },
    {
      from: 'PROCESSING',
      to: 'COMPLETED',
      operation: 'every recipient and channel attempted; the counts are kept',
    },
    {
      from: 'PROCESSING',
      to: 'FAILED',
      operation: 'the dispatch could not be completed; the reason is kept',
    },
  ],
};

export const COMM_LOG: StatusDomain<'SUCCESS' | 'SKIPPED' | 'FAILED'> = {
  domain: 'comm_log',
  srsDomain: 'Communication log (status)',
  rc: 'RC-24',
  values: [
    {
      code: 'SUCCESS',
      registerValue: 'SUCCESS',
      labelKey: 'status.commLog.success',
      label: 'Sent',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'SKIPPED',
      registerValue: 'SKIPPED',
      labelKey: 'status.commLog.skipped',
      label: 'Skipped',
      tone: 'neutral',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.commLog.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'SUCCESS',
      operation: 'the channel accepted the message (one row per recipient and channel)',
    },
    {
      from: NEW,
      to: 'SKIPPED',
      operation: 'not attempted: channel off, no address or not available (reason kept)',
    },
    { from: NEW, to: 'FAILED', operation: 'the channel refused or errored (the error kept)' },
  ],
};

/** A direct message (23.9.4/23.9.5); in-app delivery is recorded in the communication log. */
export const DIRECT_MESSAGE: StatusDomain<'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = {
  domain: 'direct_message',
  srsDomain: 'Direct message (status)',
  rc: null,
  values: [
    {
      code: 'SENT',
      registerValue: 'SENT',
      labelKey: 'status.directMessage.sent',
      label: 'Sent',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'DELIVERED',
      registerValue: 'DELIVERED',
      labelKey: 'status.directMessage.delivered',
      label: 'Delivered',
      tone: 'info',
      terminal: false,
    },
    {
      code: 'READ',
      registerValue: 'READ',
      labelKey: 'status.directMessage.read',
      label: 'Read',
      tone: 'ok',
      terminal: true,
    },
    {
      code: 'FAILED',
      registerValue: 'FAILED',
      labelKey: 'status.directMessage.failed',
      label: 'Failed',
      tone: 'bad',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'SENT', operation: 'stored in the pair’s conversation (COM-018, COM-020)' },
    { from: 'SENT', to: 'DELIVERED', operation: 'delivered in the app; the delivery time is kept' },
    { from: 'SENT', to: 'FAILED', operation: 'no channel could deliver it' },
    {
      from: 'DELIVERED',
      to: 'READ',
      operation: 'the recipient opens the conversation (COM-019); the first read time is kept',
    },
    {
      from: 'SENT',
      to: 'READ',
      operation: 'the recipient opens the conversation before a delivery was recorded',
    },
  ],
};

export const COMMUNICATION_DOMAINS = [ANNOUNCEMENT, COMM_LOG, DIRECT_MESSAGE] as const;
