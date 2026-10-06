/**
 * Bank-account check ("penny drop": ₹1 is sent and the name at the bank is compared; prototype
 * pf.bankgo). Until a provider is chosen (Q17) the test provider answers at once — clearly marked
 * as a test in the app — and production refuses it (BANK_VERIFY_MODE). A live provider that is not
 * configured leaves the account saved but not verified.
 */
export interface BankCheckInput {
  readonly holderName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
}

export type BankCheckResult =
  | { readonly verified: true; readonly reference: string; readonly test: boolean }
  | { readonly verified: false; readonly reason: 'NOT_CONFIGURED' | 'NAME_MISMATCH' | 'FAILED' };

export interface BankVerifier {
  readonly mode: 'test' | 'live';
  check(input: BankCheckInput): Promise<BankCheckResult>;
}

/** Answers at once; account numbers ending in 0000 fail, to exercise the refusal path in tests. */
export function testBankVerifier(): BankVerifier {
  return {
    mode: 'test',
    async check(input) {
      if (input.accountNumber.endsWith('0000')) return { verified: false, reason: 'FAILED' };
      return {
        verified: true,
        reference: `TEST-${Date.now().toString(36).toUpperCase()}`,
        test: true,
      };
    },
  };
}

/** The live provider arrives with the provider set-up (Q17); until then nothing is verified. */
export function liveBankVerifier(): BankVerifier {
  return {
    mode: 'live',
    async check() {
      return { verified: false, reason: 'NOT_CONFIGURED' };
    },
  };
}

export const createBankVerifier = (mode: 'test' | 'live'): BankVerifier =>
  mode === 'test' ? testBankVerifier() : liveBankVerifier();
