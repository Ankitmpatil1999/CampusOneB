/**
 * Readers, POS terminals and campus cards (27.2; docs/01c).
 *
 * - A terminal is Active or Disabled. RC-29 is a new record (CR-10): disabling one ends its sessions
 *   and refuses its sign-in until enabled again. Its purpose follows RC-16.
 * - An NFC card is Active (1) or Inactive (0) (27.2 "NFC card (status)"); one Active card per member.
 */
import { NEW, type StatusDomain } from './types';

export type TerminalStatusCode = 'ACTIVE' | 'DISABLED';
export type CardStatusCode = 'ACTIVE' | 'INACTIVE';

export const TERMINAL: StatusDomain<TerminalStatusCode> = {
  domain: 'terminal',
  srsDomain: null,
  rc: 'RC-29',
  values: [
    {
      code: 'ACTIVE',
      registerValue: null,
      labelKey: 'status.terminal.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'DISABLED',
      registerValue: null,
      labelKey: 'status.terminal.disabled',
      label: 'Disabled',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'registered in the console (INS-031)' },
    {
      from: 'ACTIVE',
      to: 'DISABLED',
      operation: 'disabled with a reason (INS-034); its sessions end',
    },
    { from: 'DISABLED', to: 'ACTIVE', operation: 'enabled again (INS-034); it pairs again' },
  ],
};

export const CARD: StatusDomain<CardStatusCode> = {
  domain: 'card',
  srsDomain: 'NFC card (status)',
  rc: null,
  values: [
    {
      code: 'ACTIVE',
      registerValue: '1',
      labelKey: 'status.card.active',
      label: 'Active',
      tone: 'ok',
      terminal: false,
    },
    {
      code: 'INACTIVE',
      registerValue: '0',
      labelKey: 'status.card.inactive',
      label: 'Inactive',
      tone: 'neutral',
      terminal: false,
    },
  ],
  transitions: [
    { from: NEW, to: 'ACTIVE', operation: 'written at a card-issue reader (ATT-004)' },
    {
      from: 'ACTIVE',
      to: 'INACTIVE',
      operation:
        'blocked in the console (ATT-006), reported lost (ATT-025) or replaced by a re-issue (ATT-007)',
    },
    {
      from: 'INACTIVE',
      to: 'ACTIVE',
      operation: 'reactivated in the console (ATT-006) while no other card is active',
    },
  ],
};

export const TERMINAL_DOMAINS = [TERMINAL, CARD] as const;
