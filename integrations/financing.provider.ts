/**
 * The fee-financing partner (SRS 13.11–13.12, FR-FEE-11, OQ-03). The partner is not named yet, so
 * this is an example contract:
 * - a registration sends the minimum data (RNG-GOV-007): the student's name, class, admission number
 *   and the fee records to finance, with RingPe's reference;
 * - the partner answers later on its signed webhook (FEE-026): approved, rejected, or paid.
 *
 * test: STUB — every registration is acknowledged at once; nothing leaves RingPe. Production refuses
 * it (FINANCING_PARTNER_MODE). live: not built until the partner's API is known; a registration then
 * stays pending with "not sent", so nothing is lost.
 */
export interface FinancingRegistration {
  readonly reference: string;
  readonly institution: string;
  readonly student: {
    readonly name: string;
    readonly admissionNo: string | null;
    readonly classSection: string | null;
  };
  readonly records: readonly {
    readonly label: string;
    readonly dueDate: string;
    readonly amount: string;
  }[];
}

export type FinancingSendResult =
  | { readonly sent: true; readonly test: boolean }
  | { readonly sent: false; readonly reason: 'NOT_CONFIGURED' };

export interface FinancingPartner {
  readonly mode: 'test' | 'live';
  readonly name: string;
  register(r: FinancingRegistration): Promise<FinancingSendResult>;
}

export function createFinancingPartner(mode: 'test' | 'live', name: string): FinancingPartner {
  return mode === 'test'
    ? { mode, name, register: async () => ({ sent: true, test: true }) }
    : { mode, name, register: async () => ({ sent: false, reason: 'NOT_CONFIGURED' }) };
}
