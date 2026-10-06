/**
 * Wallet statuses (RC-02; CR-08, RNG-WAL-171…184). Every wallet kind is Active, Inactive or
 * Suspended. A wallet follows its holder; a de-link suspends it at the request and makes it
 * Inactive on approval; an allowance wallet starts Inactive and the allowance job activates it.
 * No status change alters a balance (RNG-WAL-183).
 */
import { NEW, type StatusDomain } from './types';

export type WalletStatusCode = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export const WALLET: StatusDomain<WalletStatusCode> = {
  domain: 'wallet',
  srsDomain: 'Wallet (campus and personal) — wallet status; Allowance wallet (wallet status)',
  rc: 'RC-02',
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.wallet.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.wallet.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
    {
      code: 'SUSPENDED',
      registerValue: null,
      labelKey: 'status.wallet.suspended',
      label: 'Suspended',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    {
      from: NEW,
      to: 'ACTIVE',
      operation: 'a campus or merchant wallet is opened with the profile',
    },
    { from: NEW, to: 'INACTIVE', operation: 'an allowance wallet is opened (credited later)' },
    {
      from: 'INACTIVE',
      to: 'ACTIVE',
      operation: 'the holder is activated, or the allowance job credits it',
    },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'the holder is deactivated, or a de-link is approved',
    },
    {
      from: 'ACTIVE',
      to: 'SUSPENDED',
      operation: 'the holder is suspended, or a de-link is requested',
    },
    {
      from: 'SUSPENDED',
      to: 'ACTIVE',
      operation: 'the suspension is lifted, or the de-link rejected',
    },
    {
      from: 'SUSPENDED',
      to: 'INACTIVE',
      operation: 'the holder is deactivated, or the de-link approved',
    },
  ],
};
