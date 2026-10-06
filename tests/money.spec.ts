import {
  MoneyError,
  applyBasisPoints,
  formatAmount,
  fromMoneyDto,
  parseAmount,
  rupees,
  sumPaise,
  toMoneyDto,
} from '../utils/money';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof MoneyError ? e.code : 'OTHER';
  }
};

describe('parseAmount', () => {
  it.each([
    ['1', 100],
    ['1240', 124000],
    ['1240.5', 124050],
    ['1240.50', 124050],
    ['0.01', 1],
    ['99999999.99', 9999999999],
  ])('parses %s to %i paise', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['', ' 1', '1 ', '+1', '-1', '1e3', '.5', '1.', 'abc', '1,000', '₹10'])(
    'refuses %j as a format error',
    (input) => {
      expect(code(() => parseAmount(input))).toBe(input === '' ? 'MONEY_FORMAT' : 'MONEY_FORMAT');
    },
  );

  it('refuses more than two decimals with a precision error', () => {
    expect(code(() => parseAmount('1.234'))).toBe('MONEY_PRECISION');
  });

  it('treats zero as missing unless allowed (RNG-PAY-123)', () => {
    expect(code(() => parseAmount('0'))).toBe('MONEY_RANGE');
    expect(parseAmount('0.00', { allowZero: true })).toBe(0);
  });

  it('applies inclusive bounds (allowance ₹0.01–₹99,999,999.99, 27.4 §10)', () => {
    const bounds = { minPaise: 1, maxPaise: 9999999999 };
    expect(parseAmount('99999999.99', bounds)).toBe(9999999999);
    expect(code(() => parseAmount('100000000.00', bounds))).toBe('MONEY_RANGE');
  });

  it('refuses values beyond the safe-integer range', () => {
    expect(code(() => parseAmount('900719925474099.92'))).toBe('MONEY_UNSAFE');
  });
});

describe('formatting and DTOs', () => {
  it('formats with exactly two places', () => {
    expect(formatAmount(124050)).toBe('1240.50');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(-150)).toBe('-1.50');
    expect(formatAmount(12345678901234567890n)).toBe('123456789012345678.90');
  });

  it('round-trips through the API shape', () => {
    expect(toMoneyDto(124050)).toEqual({ amount: '1240.50', currency: 'INR' });
    expect(fromMoneyDto({ amount: '1240.50', currency: 'INR' })).toBe(124050);
  });

  it('refuses a non-INR currency', () => {
    expect(code(() => fromMoneyDto({ amount: '1.00', currency: 'USD' as 'INR' }))).toBe(
      'MONEY_CURRENCY',
    );
  });

  it('refuses non-integer paise', () => {
    expect(code(() => formatAmount(1.5))).toBe('MONEY_UNSAFE');
  });
});

describe('aggregates and rates', () => {
  it('sums numbers, bigints and driver strings exactly', () => {
    expect(sumPaise([100, 200n, '300', '-50'])).toBe(550n);
    expect(sumPaise(['9007199254740993', '1'])).toBe(9007199254740994n);
  });

  it('applies basis points with half-up rounding', () => {
    // 0.5 % of ₹100.01 = 50.005 paise → 50; of ₹100.10 = 50.05 → 50; of ₹101 = 50.5 → 51
    expect(applyBasisPoints(10001, 50)).toBe(50);
    expect(applyBasisPoints(10100, 50)).toBe(51);
    expect(applyBasisPoints(0, 50)).toBe(0);
  });

  it('converts rupees to paise', () => {
    expect(rupees(10000)).toBe(1000000);
  });
});
