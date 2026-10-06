import { englishBundle, translate } from '../utils/i18n';
import { MESSAGES_EN } from '../utils/messages.en';
import {
  formatDate,
  formatDateTime,
  formatInr,
  formatTime,
  groupIndian,
  istBusinessDate,
  maskTail,
  formatMobile,
  titleCase,
} from '../utils/format';

describe('Indian number formatting', () => {
  it.each([
    ['0', '0'],
    ['999', '999'],
    ['1000', '1,000'],
    ['124560', '1,24,560'],
    ['12345678', '1,23,45,678'],
    ['9999999999', '9,99,99,99,999'],
  ])('groups %s as %s', (input, expected) => {
    expect(groupIndian(input)).toBe(expected);
  });

  it('formats paise as rupees with two decimals', () => {
    expect(formatInr(12456000)).toBe('₹1,24,560.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(-124050)).toBe('-₹1,240.50');
    expect(formatInr(9999999999n)).toBe('₹9,99,99,999.99');
  });
});

describe('IST date and time', () => {
  // 30 Sep 2026 07:10 UTC = 12:40 PM IST
  const instant = '2026-09-30T07:10:00Z';

  it('formats date, time and both', () => {
    expect(formatDate(instant)).toBe('30 Sep 2026');
    expect(formatTime(instant)).toBe('12:40 PM');
    expect(formatDateTime(instant)).toBe('30 Sep 2026 · 12:40 PM');
  });

  it('handles midnight, noon and the day boundary', () => {
    expect(formatTime('2026-09-30T18:30:00Z')).toBe('12:00 AM');
    expect(formatDate('2026-09-30T18:30:00Z')).toBe('01 Oct 2026');
    expect(formatTime('2026-09-30T06:30:00Z')).toBe('12:00 PM');
  });

  it('treats a bare date as a calendar date', () => {
    expect(formatDate('2026-03-31')).toBe('31 Mar 2026');
  });

  it('computes the business date in Asia/Kolkata', () => {
    expect(istBusinessDate('2026-09-30T18:29:59Z')).toBe('2026-09-30');
    expect(istBusinessDate('2026-09-30T18:30:00Z')).toBe('2026-10-01');
  });

  it('refuses invalid input', () => {
    expect(() => formatDate('not a date')).toThrow();
  });
});

describe('masking', () => {
  it('keeps the last four characters', () => {
    expect(maskTail('9876543210')).toBe('••••••3210');
    expect(maskTail('123')).toBe('123');
    expect(formatMobile('9880012345')).toBe('+91 98800 12345');
    expect(formatMobile('12345')).toBe('12345');
    expect(titleCase('MEERA HEGDE')).toBe('Meera Hegde');
    expect(titleCase("D'SOUZA-RAO")).toBe("D'Souza-Rao");
  });
});

describe('bundle', () => {
  it('contains register messages and status labels', () => {
    const b = englishBundle();
    expect(b['GEN.INTERNAL']).toBe('Something went wrong. Please try again.');
    expect(b['status.institution.pending_activation']).toBe('Pending activation');
  });

  it('falls back to English, never to the key (OI-GAS-20)', () => {
    expect(translate('GEN.RATE_LIMITED', {}, { 'GEN.RATE_LIMITED': 'ದಯವಿಟ್ಟು ಕಾಯಿರಿ' })).toBe(
      'ದಯವಿಟ್ಟು ಕಾಯಿರಿ',
    );
    expect(translate('GEN.RATE_LIMITED', {}, {})).toBe(
      'Too many requests from this IP, please try again later.',
    );
    expect(translate('NO.SUCH_KEY')).toBe('Something went wrong. Please try again.');
  });

  it('substitutes placeholders', () => {
    expect(translate('FILE.TOO_LARGE', { limit: '2 MB' })).toBe('The file must be under 2 MB.');
  });
});

describe('messages.en.ts (the bundle copied to the web and mobile apps)', () => {
  it('matches the registers (regenerate with `npm run shared:sync`)', () => {
    expect(MESSAGES_EN).toEqual(englishBundle());
  });
});
