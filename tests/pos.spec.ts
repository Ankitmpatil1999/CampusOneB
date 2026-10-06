/** Point-of-sale pricing and tokens (SRS 12.8–12.10; OI-MER-10). */
import {
  captureMessage,
  GST_SLABS_BP,
  maskTagToken,
  newTagToken,
  priceLine,
  splitGst,
} from '../services/pos.service';

describe('order line pricing', () => {
  it('adds GST to the menu price (the prototype counter: Subtotal, GST, Total)', () => {
    expect(priceLine(6_000, 2, 500, false)).toEqual({ net: 12_000, tax: 600, total: 12_600 });
    expect(priceLine(1_500, 1, 500, false)).toEqual({ net: 1_500, tax: 75, total: 1_575 });
    // Half a paisa rounds up.
    expect(priceLine(1_010, 1, 500, false)).toEqual({ net: 1_010, tax: 51, total: 1_061 });
    expect(priceLine(4_500, 3, 0, false)).toEqual({ net: 13_500, tax: 0, total: 13_500 });
  });

  it('takes GST out of a price that includes it (RNG-MER-067)', () => {
    // ₹105.00 at 5 %: ₹100.00 + ₹5.00.
    expect(priceLine(10_500, 1, 500, true)).toEqual({ net: 10_000, tax: 500, total: 10_500 });
    // ₹100.00 at 18 %: tax 15.254… → 15.25.
    expect(priceLine(10_000, 1, 1_800, true)).toEqual({ net: 8_475, tax: 1_525, total: 10_000 });
    expect(priceLine(5_000, 2, 0, true)).toEqual({ net: 10_000, tax: 0, total: 10_000 });
  });

  it('splits GST into CGST and SGST, the odd paisa to SGST', () => {
    expect(splitGst(675)).toEqual({ cgst: 337, sgst: 338 });
    expect(splitGst(600)).toEqual({ cgst: 300, sgst: 300 });
    expect(splitGst(0)).toEqual({ cgst: 0, sgst: 0 });
  });

  it('knows the GST slabs', () => {
    expect(GST_SLABS_BP).toEqual([0, 500, 1200, 1800, 2800]);
  });
});

describe('operator tags and offline captures', () => {
  it('makes 100-bit tag tokens and masks them', () => {
    const a = newTagToken();
    expect(a).toMatch(/^OT[A-Z2-9]{20}$/);
    expect(newTagToken()).not.toBe(a);
    expect(maskTagToken('9D21')).toBe('OT••••9D21');
  });

  it('signs a capture over its key, card, amount, order and time', () => {
    expect(
      captureMessage({
        captureKey: 'OFF-1',
        cardToken: 'NFC0000000000123',
        amountPaise: 6_300,
        orderId: null,
        capturedAt: '2026-10-04T06:30:00.000Z',
      }),
    ).toBe('OFF-1.NFC0000000000123.6300..2026-10-04T06:30:00.000Z');
  });
});
