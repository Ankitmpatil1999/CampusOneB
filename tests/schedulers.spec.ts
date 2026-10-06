/** The worker's clock: cron expressions read in IST (RNG-GOV-021). */
import { cronMatches, firedToday, RUNNABLE_JOB_IDS } from '../schedulers';
import { JOB_CATALOGUE } from '../schedulers/catalogue';

// 00:20 IST on 3 Oct 2026 is 18:50 UTC on 2 Oct.
const ist = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000);

describe('cronMatches', () => {
  it('reads the minute and hour in IST', () => {
    expect(cronMatches('20 0 * * *', ist(2026, 10, 3, 0, 20))).toBe(true);
    expect(cronMatches('20 0 * * *', new Date(Date.UTC(2026, 9, 2, 18, 50)))).toBe(true);
    expect(cronMatches('20 0 * * *', ist(2026, 10, 3, 0, 21))).toBe(false);
  });

  it('understands lists, ranges and steps', () => {
    expect(cronMatches('*/30 8-20 * * *', ist(2026, 10, 3, 8, 30))).toBe(true);
    expect(cronMatches('*/30 8-20 * * *', ist(2026, 10, 3, 21, 0))).toBe(false);
    expect(cronMatches('0 9 * * 1,3,5', ist(2026, 10, 5, 9, 0))).toBe(true); // a Monday
    expect(cronMatches('0 9 * * 1,3,5', ist(2026, 10, 6, 9, 0))).toBe(false);
    expect(cronMatches('0 9 1 4 *', ist(2027, 4, 1, 9, 0))).toBe(true);
  });

  it('refuses malformed expressions', () => {
    expect(cronMatches('20 0 * *', ist(2026, 10, 3, 0, 20))).toBe(false);
    expect(cronMatches('x 0 * * *', ist(2026, 10, 3, 0, 20))).toBe(false);
  });
});

describe('firedToday', () => {
  it('is true once the time has passed on the IST day', () => {
    expect(firedToday('20 0 * * *', ist(2026, 10, 3, 0, 19))).toBe(false);
    expect(firedToday('20 0 * * *', ist(2026, 10, 3, 0, 20))).toBe(true);
    expect(firedToday('20 0 * * *', ist(2026, 10, 3, 23, 59))).toBe(true);
  });
});

describe('job registry', () => {
  it('lists only runners the catalogue knows', () => {
    for (const id of RUNNABLE_JOB_IDS) expect(JOB_CATALOGUE.some((j) => j.id === id)).toBe(true);
  });
});
