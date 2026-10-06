/**
 * Identity registers (SRS 27.2 §6 values, 27.3 §6 transitions; RC-03 for the sign-in lock).
 * Sessions and one-time codes have no status column: their state follows from their timestamps
 * (ended, expired, consumed, abandoned), as docs/04 §3.2 specifies.
 */
import { NEW, type StatusDomain } from './types';

export type PlatformAccountStatus = 'ACTIVE' | 'DEACTIVATED';
export const PLATFORM_ACCOUNT: StatusDomain<PlatformAccountStatus> = {
  domain: 'platform_account',
  srsDomain: 'Platform account (status)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.platform_account.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'DEACTIVATED',
      registerValue: '0',
      labelKey: 'status.platform_account.deactivated',
      label: 'Deactivated',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'sign-up completes (6.2) or staff provisioning (6.19)' },
    { from: 'ACTIVE', to: 'DEACTIVATED', operation: 'back-office status permission false (6.29)' },
    { from: 'DEACTIVATED', to: 'ACTIVE', operation: 'back-office status permission true (6.29)' },
  ],
};

export type SigninLockStatus = 'UNLOCKED' | 'LOCKED';
export const SIGNIN_LOCK: StatusDomain<SigninLockStatus> = {
  domain: 'signin_lock',
  srsDomain: null,
  rc: 'RC-03',
  values: [
    {
      code: 'UNLOCKED',
      registerValue: null,
      labelKey: 'status.signin_lock.unlocked',
      label: 'Unlocked',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'LOCKED',
      registerValue: null,
      labelKey: 'status.signin_lock.locked',
      label: 'Locked',
      tone: 'bad',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'UNLOCKED', operation: 'account created' },
    {
      from: 'UNLOCKED',
      to: 'LOCKED',
      operation: 'abandoned code-attempt limit reached (RNG-IDN-380)',
    },
    { from: 'LOCKED', to: 'UNLOCKED', operation: 'administrator release only (RNG-IDN-380)' },
  ],
};

export type RegisteredDeviceStatus = 'ACTIVE' | 'INACTIVE';
export const REGISTERED_DEVICE: StatusDomain<RegisteredDeviceStatus> = {
  domain: 'registered_device',
  srsDomain: 'Registered device (active flag)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.registered_device.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.registered_device.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: true,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'first device registration (6.15)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation: 'a different device is registered for the account (6.15)',
    },
  ],
};

export const IDENTITY_DOMAINS = [PLATFORM_ACCOUNT, SIGNIN_LOCK, REGISTERED_DEVICE] as const;
