import { z } from 'zod';
import { PATTERNS, isRealDate, isValidPassword } from '../utils/validators/patterns';
import {
  amount,
  email,
  isoDate,
  mobile,
  money,
  pan,
  password,
  publicId,
  toFieldErrors,
} from '../utils/validators/schemas';

describe('27.4 §5 patterns', () => {
  it.each([
    ['mobile', '9876543210', true],
    ['mobile', '5876543210', false],
    ['mobile', '987654321', false],
    ['mobile', '+919876543210', false],
    ['email', 'priya.k@school.in', true],
    ['email', 'priya@schoolin', false],
    ['pan', 'ABCDE1234F', true],
    ['pan', 'XABCDE1234F', false],
    ['ifsc', 'SBIN0001234', true],
    ['ifsc', 'SBIN1001234', false],
    ['postalCode', '560001', true],
    ['postalCode', '56001', false],
    ['otp', '1234', true],
    ['otp', '0123', false],
    ['otp', '12345', false],
    ['vehicleRegistration', 'KA01AB1234', true],
    ['vehicleRegistration', 'KA 01 AB 1234', false],
    ['languageCode', 'kn', true],
    ['languageCode', 'kan', false],
  ] as const)('%s %j → %s', (name, value, expected) => {
    expect(PATTERNS[name].test(value)).toBe(expected);
  });

  it('checks real calendar dates', () => {
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('30-09-2026')).toBe(false);
  });

  it('applies the password rule with the register bounds', () => {
    const policy = { minLength: 8, maxLength: 15 };
    expect(isValidPassword('Campus@2026', policy)).toBe(true);
    expect(isValidPassword('campus@2026', policy)).toBe(false);
    expect(isValidPassword('Campus2026', policy)).toBe(false);
    expect(isValidPassword('Cam@1', policy)).toBe(false);
    expect(isValidPassword('Campus@2026-Long!', policy)).toBe(false);
  });
});

describe('schemas', () => {
  it('normalises e-mail and PAN before checking', () => {
    expect(email().parse('  Priya.K@School.IN ')).toBe('priya.k@school.in');
    expect(pan().parse('abcde1234f')).toBe('ABCDE1234F');
  });

  it('parses amounts to paise and reports the register key', () => {
    expect(amount().parse('1240.50')).toBe(124050);
    const r = amount({ maxPaise: 1_000_000 }).safeParse('10000.01');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('VALIDATION.AMOUNT');
  });

  it('accepts only INR money objects without extra keys', () => {
    expect(money().parse({ amount: '5.00', currency: 'INR' })).toEqual({
      amount: 500,
      currency: 'INR',
    });
    expect(money().safeParse({ amount: '5.00', currency: 'USD' }).success).toBe(false);
    expect(money().safeParse({ amount: '5.00', currency: 'INR', extra: 1 }).success).toBe(false);
  });

  it('validates public ids as UUIDv7', () => {
    expect(publicId().safeParse('0199a8b2-7c3e-7d40-8a1b-3f2e4d5c6b7a').success).toBe(true);
    expect(publicId().safeParse('4f6c8e2a-1b3d-4e5f-9a7b-8c9d0e1f2a3b').success).toBe(false);
  });

  it('validates dates and passwords with register keys', () => {
    expect(isoDate().safeParse('2026-02-30').error?.issues[0]?.message).toBe('VALIDATION.DATE');
    expect(password().safeParse('weak').error?.issues[0]?.message).toBe('VALIDATION.PASSWORD');
  });
});

describe('toFieldErrors', () => {
  it('maps issues to field errors with register keys', () => {
    const schema = z.strictObject({
      mobile: mobile(),
      contact: z.strictObject({ email: email() }),
    });
    const result = schema.safeParse({ mobile: '123', contact: {}, extra: true });
    if (result.success) throw new Error('expected a validation failure');
    const errors = toFieldErrors(result.error);
    expect(errors).toEqual(
      expect.arrayContaining([
        { field: 'mobile', code: 'VALIDATION.MOBILE' },
        { field: 'contact.email', code: 'VALIDATION.REQUIRED' },
        { field: 'extra', code: 'VALIDATION.UNKNOWN_FIELD' },
      ]),
    );
  });
});
