/**
 * Platform technical registers — register change RC-26 (docs/01c Part C).
 * The job-run vocabulary reuses the registered run logs (27.2: settlement run log
 * STARTED / SUCCESS / FAILED; communication batch PARTIAL_FAILURE).
 */
import { NEW, type StatusDomain } from './types';

const v = <C extends string>(
  domain: string,
  code: C,
  label: string,
  tone: StatusDomainTone,
  terminal = false,
) => ({
  code,
  registerValue: null,
  labelKey: `status.${domain}.${code.toLowerCase()}`,
  label,
  tone,
  terminal,
});
type StatusDomainTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export type JobRunStatus = 'STARTED' | 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILED';
export const JOB_RUN: StatusDomain<JobRunStatus> = {
  domain: 'job_run',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('job_run', 'STARTED', 'Running', 'info'),
    v('job_run', 'SUCCESS', 'Succeeded', 'ok', true),
    v('job_run', 'PARTIAL_FAILURE', 'Partly failed', 'warn', true),
    v('job_run', 'FAILED', 'Failed', 'bad', true),
  ],
  transitions: [
    { from: NEW, to: 'STARTED', operation: 'job runner: start run (schedule, manual or catch-up)' },
    {
      from: 'STARTED',
      to: 'SUCCESS',
      operation: 'job runner: every item succeeded or was skipped',
    },
    { from: 'STARTED', to: 'PARTIAL_FAILURE', operation: 'job runner: some items failed' },
    { from: 'STARTED', to: 'FAILED', operation: 'job runner: run failed' },
  ],
};

export type JobRunItemStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';
export const JOB_RUN_ITEM: StatusDomain<JobRunItemStatus> = {
  domain: 'job_run_item',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('job_run_item', 'SUCCESS', 'Succeeded', 'ok', true),
    v('job_run_item', 'FAILED', 'Failed', 'bad', true),
    v('job_run_item', 'SKIPPED', 'Skipped', 'neutral', true),
  ],
  transitions: [
    { from: NEW, to: 'SUCCESS', operation: 'job runner: institution processed' },
    { from: NEW, to: 'FAILED', operation: 'job runner: institution failed' },
    { from: NEW, to: 'SKIPPED', operation: 'job runner: institution not eligible' },
  ],
};

export type OutboxStatus = 'PENDING' | 'DISPATCHED' | 'DEAD';
export const OUTBOX_EVENT: StatusDomain<OutboxStatus> = {
  domain: 'outbox_event',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('outbox_event', 'PENDING', 'Pending', 'info'),
    v('outbox_event', 'DISPATCHED', 'Dispatched', 'ok', true),
    v('outbox_event', 'DEAD', 'Dead letter', 'bad', true),
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'business transaction writes the event' },
    { from: 'PENDING', to: 'DISPATCHED', operation: 'outbox relay hands the event to its queue' },
    { from: 'PENDING', to: 'DEAD', operation: 'outbox relay: attempts exhausted' },
  ],
};

export type FileScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR';
export const FILE_SCAN: StatusDomain<FileScanStatus> = {
  domain: 'file_scan',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('file_scan', 'PENDING', 'Scanning', 'info'),
    v('file_scan', 'CLEAN', 'Clean', 'ok', true),
    v('file_scan', 'INFECTED', 'Infected', 'bad', true),
    v('file_scan', 'ERROR', 'Scan failed', 'warn'),
  ],
  transitions: [
    { from: NEW, to: 'PENDING', operation: 'upload accepted (size and type checked, CR-07)' },
    { from: 'PENDING', to: 'CLEAN', operation: 'antivirus scan passed' },
    { from: 'PENDING', to: 'INFECTED', operation: 'antivirus scan found malware' },
    { from: 'PENDING', to: 'ERROR', operation: 'antivirus unavailable or failed' },
    { from: 'ERROR', to: 'PENDING', operation: 'rescan job' },
  ],
};

export type DataExportStatus = 'REQUESTED' | 'RUNNING' | 'READY' | 'EXPIRED' | 'FAILED';
export const DATA_EXPORT: StatusDomain<DataExportStatus> = {
  domain: 'data_export',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('data_export', 'REQUESTED', 'Requested', 'info'),
    v('data_export', 'RUNNING', 'Preparing', 'info'),
    v('data_export', 'READY', 'Ready', 'ok'),
    v('data_export', 'EXPIRED', 'Expired', 'neutral', true),
    v('data_export', 'FAILED', 'Failed', 'bad', true),
  ],
  transitions: [
    { from: NEW, to: 'REQUESTED', operation: 'export requested (RNG-SAS-005)' },
    { from: 'REQUESTED', to: 'RUNNING', operation: 'export job picks it up' },
    { from: 'RUNNING', to: 'READY', operation: 'export file written' },
    { from: 'RUNNING', to: 'FAILED', operation: 'export job failed' },
    { from: 'READY', to: 'EXPIRED', operation: 'download window passed' },
  ],
};

export type IdempotencyRecordStatus = 'IN_PROGRESS' | 'COMPLETED';
export const IDEMPOTENCY_RECORD: StatusDomain<IdempotencyRecordStatus> = {
  domain: 'idempotency_record',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('idempotency_record', 'IN_PROGRESS', 'In progress', 'info'),
    v('idempotency_record', 'COMPLETED', 'Completed', 'ok', true),
  ],
  transitions: [
    { from: NEW, to: 'IN_PROGRESS', operation: 'first request with the Idempotency-Key' },
    { from: 'IN_PROGRESS', to: 'COMPLETED', operation: 'response stored for replay' },
  ],
};

export type RefreshTokenStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';
export const REFRESH_TOKEN: StatusDomain<RefreshTokenStatus> = {
  domain: 'refresh_token',
  srsDomain: null,
  rc: 'RC-26',
  values: [
    v('refresh_token', 'ACTIVE', 'Active', 'ok'),
    v('refresh_token', 'ROTATED', 'Rotated', 'neutral', true),
    v('refresh_token', 'REVOKED', 'Revoked', 'bad', true),
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'sign-in or rotation issues the token' },
    { from: 'ACTIVE', to: 'ROTATED', operation: 'token used to refresh' },
    { from: 'ACTIVE', to: 'REVOKED', operation: 'sign-out, reuse detection or status change' },
  ],
};

export const PLATFORM_DOMAINS = [
  JOB_RUN,
  JOB_RUN_ITEM,
  OUTBOX_EVENT,
  FILE_SCAN,
  DATA_EXPORT,
  IDEMPOTENCY_RECORD,
  REFRESH_TOKEN,
] as const;
