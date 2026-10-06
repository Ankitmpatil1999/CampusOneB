/**
 * The §9.11 checks (docs/03 §8.2): every guard, pre-check and validation refuses with its step,
 * stage and message key, in order — CLAUDE.md requires 100 % coverage of these checks.
 */
import {
  allowanceLimits,
  balanceCheck,
  channelMax,
  guardRefusal,
  guards,
  preChecks,
  validations,
  type AllowanceFacts,
  type PartyFacts,
  type PaymentFacts,
} from '../services/payment-checks';

const now = new Date('2026-10-03T06:30:00Z');
const limits = {
  staticQrMaxPaise: 1_000_000,
  dynamicQrMaxPaise: 1_000_000,
  transferMaxPaise: 1_000_000,
  pendingGuardMaxPaise: 100_000,
};
const payer: PartyFacts = {
  profileId: '11',
  institutionId: '1',
  status: 'ACTIVE',
  category: 'STUDENT',
  txnPermission: true,
  name: 'Aarav Hegde',
  subType: null,
};
const payee: PartyFacts = {
  profileId: '22',
  institutionId: '1',
  status: 'ACTIVE',
  category: 'MERCHANT',
  txnPermission: true,
  name: 'Campus Canteen',
  subType: 'REGULAR',
};
const base: PaymentFacts = {
  channel: 'STATIC_QR',
  institutionId: '1',
  payerProfileId: '11',
  payeeProfileId: '22',
  amountPaise: 6_000,
  remarks: 'QR payment',
  payer,
  payee,
  payerWallet: { id: '101', status: 'ACTIVE', availablePaise: 50_000 },
  payeeWallet: { id: '202', status: 'ACTIVE', availablePaise: 0 },
  now,
  requestTtlSeconds: 120,
};
const f = (o: Partial<PaymentFacts>): PaymentFacts => ({ ...base, ...o });

describe('caller guards (G2, G4, G5)', () => {
  const g = (o: Partial<PaymentFacts>, pendingCount = 0) => guards(f(o), { limits, pendingCount });

  it('lets an ordinary payment through', () => {
    expect(g({})).toBeNull();
  });

  it('G2 refuses an amount above the channel maximum, per channel', () => {
    expect(g({ amountPaise: 1_000_001 })).toMatchObject({
      check: 'G2',
      stage: 'amount',
      code: 'PAY.LIMIT_EXCEEDED',
      status: 422,
      params: { max: '₹10,000' },
    });
    expect(g({ channel: 'DYNAMIC_QR', amountPaise: 1_000_001 })?.check).toBe('G2');
    expect(g({ channel: 'NFC', amountPaise: 1_000_001 })?.check).toBe('G2');
    expect(g({ channel: 'TRANSFER', amountPaise: 1_000_001 })?.check).toBe('G2');
    expect(g({ channel: 'TUITION', amountPaise: 99_000_000 })).toBeNull();
    expect(g({ amountPaise: null })).toBeNull();
  });

  it('G4 holds back payments above the guard while one is pending, on every channel', () => {
    expect(g({ amountPaise: 100_001 }, 1)).toMatchObject({
      check: 'G4',
      code: 'PAY.PENDING_GUARD',
      params: { limit: '1,000' },
    });
    expect(g({ amountPaise: 100_000 }, 1)).toBeNull();
    expect(g({ amountPaise: 100_001 }, 0)).toBeNull();
  });

  it('G5 refuses a suspended or inactive wallet before anything is written (CR-08)', () => {
    expect(g({ payerWallet: { id: '101', status: 'SUSPENDED', availablePaise: 1 } })?.code).toBe(
      'PAY.PAYER_WALLET_SUSPENDED',
    );
    expect(g({ payerWallet: { id: '101', status: 'INACTIVE', availablePaise: 1 } })?.code).toBe(
      'PAY.PAYER_WALLET_INACTIVE',
    );
    expect(g({ payeeWallet: { id: '202', status: 'SUSPENDED', availablePaise: 0 } })).toMatchObject(
      {
        check: 'G5',
        code: 'PAY.PAYEE_WALLET_INACTIVE',
        params: { name: 'Campus Canteen' },
      },
    );
    expect(
      g({ payee: null, payeeWallet: { id: '202', status: 'INACTIVE', availablePaise: 0 } })?.params,
    ).toEqual({ name: '' });
    expect(g({ payerWallet: null, payeeWallet: null })).toBeNull();
  });

  it('G3 and G6 refusals carry their step and stage', () => {
    expect(guardRefusal('G6', 'IDN.CAP_EXCEEDED', 409)).toEqual({
      check: 'G6',
      stage: 'balance',
      code: 'IDN.CAP_EXCEEDED',
      status: 409,
    });
    expect(guardRefusal('G3', 'PAY.REQUEST_EXPIRED', 409, { minutes: 2 }).stage).toBe('request');
  });

  it('knows each channel maximum', () => {
    expect(channelMax('STATIC_QR', limits)).toBe(1_000_000);
    expect(channelMax('POS_QR', limits)).toBe(limits.dynamicQrMaxPaise);
    expect(channelMax('EVENT', limits)).toBeNull();
  });
});

describe('pre-checks (P1–P8): no record on a refusal', () => {
  it('passes a complete payment', () => {
    expect(preChecks(base)).toBeNull();
  });

  it('P1 refuses a missing party, institution, amount (0 counts) or remarks', () => {
    for (const o of [
      { payerProfileId: null },
      { payeeProfileId: null },
      { institutionId: null },
      { amountPaise: 0 },
      { amountPaise: null },
      { remarks: '  ' },
      { remarks: null },
    ] as Partial<PaymentFacts>[]) {
      expect(preChecks(f(o))).toMatchObject({ check: 'P1', code: 'VALIDATION.REQUIRED' });
    }
  });

  it('P2 refuses a closed event, P3 an order no longer payable, P4 an inactive asset', () => {
    expect(preChecks(f({ event: { active: false } }))?.code).toBe('FEE.EVENT_CLOSED');
    expect(preChecks(f({ event: { active: true } }))).toBeNull();
    expect(preChecks(f({ order: { payable: false } }))?.code).toBe('MER.ORDER_PAID');
    expect(preChecks(f({ order: { payable: true } }))).toBeNull();
    expect(preChecks(f({ feeRecord: { payable: false } }))).toMatchObject({
      check: 'P3',
      code: 'FEE.RECORD_PAID',
    });
    expect(preChecks(f({ feeRecord: { payable: true } }))).toBeNull();
    expect(preChecks(f({ asset: { active: false } }))).toMatchObject({
      check: 'P4',
      code: 'PAY.VENDOR_ASSET_REQUIRED',
    });
  });

  it('P5 refuses an invoice already paid (BR-20)', () => {
    expect(preChecks(f({ invoice: { invoiceNo: 'INV9', alreadyPaid: true } }))).toMatchObject({
      check: 'P5',
      code: 'PAY.INVOICE_ALREADY_PAID',
      params: { invoiceNo: 'INV9' },
    });
    expect(preChecks(f({ invoice: { invoiceNo: 'INV9', alreadyPaid: false } }))).toBeNull();
  });

  it('P6 refuses a request paid, failed, cancelled or expired; P7 one already carrying a payment', () => {
    const later = new Date(now.getTime() + 60_000);
    const req = (o: Partial<NonNullable<PaymentFacts['request']>>) =>
      preChecks(f({ request: { status: 'PENDING', expiresAt: later, hasPayment: false, ...o } }));
    expect(req({})).toBeNull();
    expect(req({ status: 'SUCCESS' })).toMatchObject({ check: 'P6', code: 'PAY.REQUEST_PAID' });
    expect(req({ status: 'FAILED' })).toMatchObject({
      check: 'P6',
      code: 'PAY.REQUEST_EXPIRED',
      params: { minutes: 2 },
    });
    expect(req({ status: 'CANCELLED' })?.code).toBe('PAY.REQUEST_EXPIRED');
    expect(req({ expiresAt: now })?.code).toBe('PAY.REQUEST_EXPIRED');
    expect(req({ hasPayment: true })).toMatchObject({ check: 'P7', code: 'PAY.REQUEST_PAID' });
    expect(
      preChecks(
        f({
          requestTtlSeconds: 20,
          request: { status: 'CANCELLED', expiresAt: later, hasPayment: false },
        }),
      )?.params,
    ).toEqual({ minutes: 1 });
  });

  it('P8 refuses a vendor payment without both an asset and an invoice', () => {
    const vendor = { ...payee, subType: 'VENDOR' as const };
    expect(preChecks(f({ payee: vendor }))).toMatchObject({
      check: 'P8',
      stage: 'vendor',
      code: 'PAY.VENDOR_ASSET_REQUIRED',
    });
    expect(
      preChecks(f({ payee: vendor, invoice: { invoiceNo: 'A1', alreadyPaid: false } }))?.check,
    ).toBe('P8');
    expect(
      preChecks(
        f({
          payee: vendor,
          asset: { active: true },
          invoice: { invoiceNo: 'A1', alreadyPaid: false },
        }),
      ),
    ).toBeNull();
  });
});

describe('validations (V1–V13): the record is kept as a failure', () => {
  it('passes a valid payment', () => {
    expect(validations(base)).toBeNull();
  });

  it('V1/V2 an unknown payer or payee; V9 a missing wallet — all "party unknown"', () => {
    expect(validations(f({ payer: null }))).toMatchObject({ check: 'V1', status: 404 });
    expect(validations(f({ payee: null }))).toMatchObject({ check: 'V2', status: 404 });
    expect(validations(f({ payerWallet: null }))).toMatchObject({
      check: 'V9',
      code: 'PAY.PARTY_UNKNOWN',
    });
    expect(validations(f({ payeeWallet: null }))?.check).toBe('V9');
  });

  it('V3 refuses a payee that is not a merchant, except on a transfer', () => {
    const person = { ...payee, category: 'PARENT' };
    expect(validations(f({ payee: person }))).toMatchObject({
      check: 'V3',
      stage: 'identify',
      code: 'PAY.PAYEE_NOT_MERCHANT',
    });
    expect(validations(f({ channel: 'TRANSFER', payee: person }))).toBeNull();
  });

  it('V4 refuses parties of another institution or another session institution (BR-12)', () => {
    expect(validations(f({ payee: { ...payee, institutionId: '2' } }))).toMatchObject({
      check: 'V4',
      stage: 'institution',
      code: 'PAY.PARTY_UNKNOWN',
    });
    expect(validations(f({ institutionId: '2' }))?.check).toBe('V4');
  });

  it('V5 refuses a payer without transaction permission (BR-13)', () => {
    expect(validations(f({ payer: { ...payer, txnPermission: false } }))).toMatchObject({
      check: 'V5',
      code: 'PAY.NO_TXN_PERMISSION',
      status: 403,
    });
  });

  it('V6 refuses a merchant that is not active', () => {
    expect(validations(f({ payee: { ...payee, status: 'INACTIVE' } }))).toMatchObject({
      check: 'V6',
      code: 'PAY.PAYEE_NOT_ACCEPTING',
      params: { merchant: 'Campus Canteen' },
    });
  });

  it('V7 refuses a zero or negative amount', () => {
    expect(validations(f({ amountPaise: 0 }))?.code).toBe('PAY.AMOUNT_INVALID');
    expect(validations(f({ amountPaise: -5 }))?.check).toBe('V7');
    expect(validations(f({ amountPaise: null }))?.check).toBe('V7');
  });

  it('V8 refuses paying oneself; V12 the same wallet on both sides', () => {
    expect(validations(f({ payee: { ...payee, profileId: '11' } }))).toMatchObject({
      check: 'V8',
      code: 'PAY.SELF_PAYMENT',
    });
    expect(
      validations(f({ payeeWallet: { id: '101', status: 'ACTIVE', availablePaise: 0 } })),
    ).toMatchObject({ check: 'V12', code: 'PAY.SELF_PAYMENT' });
  });

  it('V10 refuses the payer wallet suspended or inactive; V11 the payee wallet inactive', () => {
    expect(
      validations(f({ payerWallet: { id: '101', status: 'SUSPENDED', availablePaise: 1 } }))?.code,
    ).toBe('PAY.PAYER_WALLET_SUSPENDED');
    expect(
      validations(f({ payerWallet: { id: '101', status: 'INACTIVE', availablePaise: 1 } })),
    ).toMatchObject({ check: 'V10', code: 'PAY.PAYER_WALLET_INACTIVE' });
    expect(
      validations(f({ payeeWallet: { id: '202', status: 'INACTIVE', availablePaise: 0 } })),
    ).toMatchObject({ check: 'V11', params: { name: 'Campus Canteen' } });
  });

  it('V13 refuses a balance short of the amount, naming the balance and the shortfall', () => {
    expect(balanceCheck(6_000, 6_000)).toBeNull();
    expect(balanceCheck(2_500, 6_000)).toEqual({
      check: 'V13',
      stage: 'balance',
      code: 'PAY.INSUFFICIENT_BALANCE',
      status: 409,
      params: { balance: '₹25.00', shortfall: '₹35.00' },
    });
  });
});

describe('transfers (8.7): the same steps, worded for a person, in the transfer stage order', () => {
  const t = (o: Partial<PaymentFacts>) => f({ channel: 'TRANSFER', ...o });
  const person = { ...payee, category: 'PARENT', subType: null, name: 'Ravi K.' };

  it('passes a transfer to a person (no merchant check)', () => {
    expect(validations(t({ payee: person }))).toBeNull();
  });

  it('words the limit, the recipient and self-transfers for a person', () => {
    expect(guards(t({ amountPaise: 1_000_001 }), { limits, pendingCount: 0 })).toMatchObject({
      check: 'G2',
      code: 'PAY.TRANSFER_LIMIT',
      params: { max: '₹10,000' },
    });
    expect(validations(t({ payee: null }))).toMatchObject({
      check: 'V2',
      code: 'PAY.RECIPIENT_NOT_FOUND',
    });
    expect(validations(t({ payee: { ...person, institutionId: '2' } }))?.code).toBe(
      'PAY.RECIPIENT_NOT_FOUND',
    );
    expect(validations(t({ payee: person, payeeWallet: null }))).toMatchObject({
      check: 'V9',
      code: 'PAY.RECIPIENT_NOT_FOUND',
    });
    expect(validations(t({ payee: person, payerWallet: null }))).toMatchObject({
      check: 'V9',
      code: 'PAY.PARTY_UNKNOWN',
    });
    expect(validations(t({ payee: { ...person, profileId: '11' } }))).toMatchObject({
      check: 'V8',
      stage: 'identify',
      code: 'PAY.SELF_TRANSFER',
    });
    expect(
      validations(
        t({ payee: person, payeeWallet: { id: '101', status: 'ACTIVE', availablePaise: 0 } }),
      ),
    ).toMatchObject({ check: 'V12', code: 'PAY.SELF_TRANSFER' });
  });

  it("refuses a recipient who can't receive, and puts the payer's own wallet under permission", () => {
    expect(validations(t({ payee: { ...person, status: 'SUSPENDED' } }))).toMatchObject({
      check: 'V6',
      stage: 'walletsActive',
      code: 'PAY.RECIPIENT_CANNOT_RECEIVE',
      params: { name: 'Ravi K.' },
    });
    expect(
      validations(
        t({ payee: person, payeeWallet: { id: '202', status: 'INACTIVE', availablePaise: 0 } }),
      ),
    ).toMatchObject({
      check: 'V11',
      code: 'PAY.RECIPIENT_CANNOT_RECEIVE',
      params: { name: 'Ravi K.' },
    });
    expect(
      validations(
        t({ payee: person, payerWallet: { id: '101', status: 'INACTIVE', availablePaise: 9 } }),
      ),
    ).toMatchObject({ check: 'V10', stage: 'permission' });
    const g = (o: Partial<PaymentFacts>) => guards(t(o), { limits, pendingCount: 0 });
    expect(
      g({ payee: person, payeeWallet: { id: '202', status: 'SUSPENDED', availablePaise: 0 } }),
    ).toMatchObject({
      check: 'G5',
      code: 'PAY.RECIPIENT_CANNOT_RECEIVE',
      params: { name: 'Ravi K.' },
    });
    expect(
      g({ payee: null, payeeWallet: { id: '202', status: 'SUSPENDED', availablePaise: 0 } })
        ?.params,
    ).toEqual({ name: '' });
    expect(g({ payerWallet: { id: '101', status: 'SUSPENDED', availablePaise: 0 } })).toMatchObject(
      { check: 'G5', stage: 'permission', code: 'PAY.PAYER_WALLET_SUSPENDED' },
    );
    expect(
      validations(t({ payee: person, payer: { ...payer, txnPermission: false } })),
    ).toMatchObject({
      check: 'V5',
      stage: 'permission',
      code: 'PAY.NO_TXN_PERMISSION',
    });
    expect(guards(t({}), { limits, pendingCount: 0 })).toBeNull();
  });
});

describe('allowance payments (10.7): the same steps from the allowance wallet, worded for an allowance', () => {
  const alw: AllowanceFacts = {
    merchantAccepts: true,
    dailyCount: 3,
    dailyAmountPaise: 20_000,
    countToday: 0,
    spentTodayPaise: 0,
  };
  const a = (o: Partial<PaymentFacts>, x: Partial<AllowanceFacts> = {}) =>
    f({ channel: 'ALLOWANCE', allowance: { ...alw, ...x }, ...o });

  it('passes an allowance payment to a merchant that accepts allowances', () => {
    expect(guards(a({}), { limits, pendingCount: 0 })).toBeNull();
    expect(validations(a({}))).toBeNull();
    expect(channelMax('ALLOWANCE', limits)).toBeNull();
  });

  it('refuses a merchant that does not accept allowances (V6) and an inactive allowance wallet', () => {
    expect(validations(a({}, { merchantAccepts: false }))).toMatchObject({
      check: 'V6',
      stage: 'permission',
      code: 'ALW.MERCHANT_NOT_ACCEPTING',
      params: { merchant: 'Campus Canteen' },
    });
    const inactive = { id: '101', status: 'INACTIVE' as const, availablePaise: 0 };
    expect(guards(a({ payerWallet: inactive }), { limits, pendingCount: 0 })).toMatchObject({
      check: 'G5',
      code: 'ALW.WALLET_INACTIVE',
    });
    expect(validations(a({ payerWallet: inactive }))).toMatchObject({
      check: 'V10',
      code: 'ALW.WALLET_INACTIVE',
    });
    // A suspended wallet keeps the wallet wording; other refusals are unchanged.
    const suspended = { ...inactive, status: 'SUSPENDED' as const };
    expect(validations(a({ payerWallet: suspended }))?.code).toBe('PAY.PAYER_WALLET_SUSPENDED');
    expect(validations(a({ payer: null }))?.code).toBe('PAY.PARTY_UNKNOWN');
  });

  it("G6 keeps to the daily payment count and today's amount (OI-ALW-10)", () => {
    expect(allowanceLimits(alw, 20_000)).toBeNull();
    expect(allowanceLimits({ ...alw, countToday: 3 }, 100)).toMatchObject({
      check: 'G6',
      stage: 'balance',
      code: 'ALW.DAILY_COUNT',
    });
    expect(allowanceLimits({ ...alw, spentTodayPaise: 15_000 }, 5_001)).toMatchObject({
      check: 'G6',
      code: 'ALW.DAILY_AMOUNT',
      params: { limit: '₹200.00' },
    });
    expect(
      allowanceLimits({ ...alw, dailyCount: null, dailyAmountPaise: null, countToday: 99 }, 99_999),
    ).toBeNull();
  });

  it('V13 words a short allowance balance without the campus top-up hint', () => {
    expect(balanceCheck(1_000, 1_001, true)).toEqual({
      check: 'V13',
      stage: 'balance',
      code: 'ALW.INSUFFICIENT_BALANCE',
      status: 409,
    });
    expect(balanceCheck(1_001, 1_001, true)).toBeNull();
  });
});

describe('event payments (13.10): P2 refuses a closed event and a second payment', () => {
  it('passes an open event, refuses a closed one and one already paid', () => {
    expect(
      preChecks(f({ channel: 'EVENT', event: { active: true, alreadyPaid: false } })),
    ).toBeNull();
    expect(preChecks(f({ channel: 'EVENT', event: { active: false } }))).toMatchObject({
      check: 'P2',
      code: 'FEE.EVENT_CLOSED',
    });
    expect(
      preChecks(f({ channel: 'EVENT', event: { active: true, alreadyPaid: true } })),
    ).toMatchObject({
      check: 'P2',
      stage: 'event',
      code: 'FEE.EVENT_ALREADY_PAID',
      status: 409,
    });
  });
});
