/**
 * The platform fee (RNG-STL-063, BR-17, Q14 M1/M2): ₹1.00 up to and including ₹100, otherwise 0.5 %
 * rounded to the paisa; never more than the line; tuition per the setting.
 */
import { platformFee, windowEnd, type FeeRules } from '../services/settlement.service';

const rules: FeeRules = {
  thresholdPaise: 10_000,
  flatPaise: 100,
  basisPoints: 50,
  chargeTuition: true,
};

describe('platformFee', () => {
  it('charges ₹1 flat up to and including ₹100', () => {
    expect(platformFee('PAYMENT', 1, rules)).toBe(1);
    expect(platformFee('PAYMENT', 5_000, rules)).toBe(100);
    expect(platformFee('PAYMENT', 10_000, rules)).toBe(100);
  });

  it('charges 0.5 % above ₹100, rounded half up to the paisa', () => {
    expect(platformFee('PAYMENT', 10_001, rules)).toBe(50); // 50.005 → 50
    expect(platformFee('PAYMENT', 25_000, rules)).toBe(125);
    expect(platformFee('PAYMENT', 10_100, rules)).toBe(51); // 50.5 → 51
    expect(platformFee('EVENT', 1_000_000, rules)).toBe(5_000);
  });

  it('never takes more than the line', () => {
    expect(platformFee('PAYMENT', 50, rules)).toBe(50);
  });

  it('follows the tuition setting', () => {
    expect(platformFee('TUITION', 500_000, rules)).toBe(2_500);
    expect(platformFee('TUITION', 500_000, { ...rules, chargeTuition: false })).toBe(0);
  });

  it('follows a plan rule: an exclusive threshold and the collections it applies to (STL-009)', () => {
    const plan: FeeRules = {
      ...rules,
      flatPaise: 200,
      basisPoints: 100,
      boundary: 'EXCLUSIVE',
      appliesTo: ['PAYMENT', 'EVENT'],
    };
    expect(platformFee('PAYMENT', 9_999, plan)).toBe(200);
    expect(platformFee('PAYMENT', 10_000, plan)).toBe(100); // the threshold itself is a percentage
    expect(platformFee('TRANSFER', 50_000, plan)).toBe(0);
    expect(platformFee('TUITION', 50_000, plan)).toBe(0);
  });

  it('ends the window at 23:30 IST on the settlement date', () => {
    expect(windowEnd('2026-10-04').toISOString()).toBe('2026-10-04T18:00:00.000Z');
  });
});
