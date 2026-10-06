/** Asset groups and assets (27.2, SRS 7.6/7.7): Active (1) or Inactive (0). */
import { NEW, type StatusDomain } from './types';

type Code = 'ACTIVE' | 'INACTIVE';
const values = (domain: string) =>
  [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: `status.${domain}.active`,
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: `status.${domain}.inactive`,
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ] as const;

export const ASSET_GROUP: StatusDomain<Code> = {
  domain: 'asset_group',
  srsDomain: 'Asset group (status)',
  rc: null,
  values: values('asset_group'),
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'created Active (INS-021)' },
    { from: NEW, to: 'INACTIVE', operation: 'created Inactive (INS-021)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'deactivated (INS-022); links stay, new links are skipped',
    },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'activated (INS-022)' },
  ],
};

export const ASSET: StatusDomain<Code> = {
  domain: 'asset',
  srsDomain: 'Asset (status)',
  rc: null,
  values: values('asset'),
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'created Active (INS-024)' },
    { from: NEW, to: 'INACTIVE', operation: 'created Inactive (INS-024)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'deactivated (INS-025); vendor payments can no longer name it',
    },
    { from: 'INACTIVE', to: 'ACTIVE', operation: 'activated (INS-025)' },
  ],
};

export const ASSET_DOMAINS = [ASSET_GROUP, ASSET] as const;
