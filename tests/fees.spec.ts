/** The one fee formula (SRS 13.19 CR-11, RNG-FEE-164/165). */
import { headParts, shareBp, structureTotals } from '../services/fees.service';

describe('fee structure formula', () => {
  it('splits a head by the shares in whole rupees, the remainder on the last', () => {
    expect(headParts(3_000_000, [4000, 3000, 3000])).toEqual([1_200_000, 900_000, 900_000]);
    // ₹10,000.50 in thirds: ₹3,333 + ₹3,333 + ₹3,334.50.
    expect(headParts(1_000_050, [3333, 3333, 3334])).toEqual([333_300, 333_300, 333_450]);
    expect(headParts(150_000, [10_000])).toEqual([150_000]);
  });

  it('makes each instalment the sum of its mandatory parts and the total their sum', () => {
    const t = structureTotals(
      [
        { amountPaise: 3_000_000, optional: false },
        { amountPaise: 500_000, optional: false },
        { amountPaise: 600_000, optional: true },
      ],
      [4000, 3000, 3000],
    );
    expect(t).toEqual({
      total: 3_500_000,
      optional: 600_000,
      instalments: [1_400_000, 1_050_000, 1_050_000],
    });
    expect(t.instalments.reduce((a, b) => a + b, 0)).toBe(t.total);
  });

  it('reads shares as percentages with two decimals at most', () => {
    expect(shareBp('50')).toBe(5000);
    expect(shareBp('33.33')).toBe(3333);
    expect(shareBp('0.5')).toBe(50);
    expect(shareBp('0')).toBeNull();
    expect(shareBp('100.01')).toBeNull();
    expect(shareBp('12.345')).toBeNull();
    expect(shareBp('abc')).toBeNull();
  });
});
