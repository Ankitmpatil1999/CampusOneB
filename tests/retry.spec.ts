import { backoffMs, isRetriableLockError, retryOnLock } from '../utils/retry';

const lockError = (errno: number) => Object.assign(new Error('lock'), { errno });

describe('retryOnLock', () => {
  it('re-runs after a deadlock or lock-wait timeout, then returns the result', async () => {
    let calls = 0;
    const out = await retryOnLock(async () => {
      calls++;
      if (calls === 1) throw lockError(1213);
      if (calls === 2) throw lockError(1205);
      return 'done';
    });
    expect(out).toBe('done');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt and passes other errors through at once', async () => {
    let calls = 0;
    await expect(
      retryOnLock(async () => {
        calls++;
        throw lockError(1213);
      }, 2),
    ).rejects.toMatchObject({ errno: 1213 });
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      retryOnLock(async () => {
        calls++;
        throw lockError(1062);
      }),
    ).rejects.toMatchObject({ errno: 1062 });
    expect(calls).toBe(1);
    expect(isRetriableLockError(null)).toBe(false);
  });

  it('rides out a burst of deadlocks: up to six attempts (parallel sign-ups, 2026-10-16)', async () => {
    let calls = 0;
    const out = await retryOnLock(async () => {
      calls++;
      if (calls < 6) throw lockError(1213);
      return 'done';
    });
    expect(out).toBe('done');
    expect(calls).toBe(6);
  });

  it('tries a lock-wait timeout at most three times: it has already waited', async () => {
    let calls = 0;
    await expect(
      retryOnLock(async () => {
        calls++;
        throw lockError(1205);
      }),
    ).rejects.toMatchObject({ errno: 1205 });
    expect(calls).toBe(3);
  });

  it('spreads the pauses at random and lets them grow, within 5…805 ms', () => {
    expect(backoffMs(1, () => 0)).toBe(5);
    expect(backoffMs(1, () => 0.999)).toBe(54);
    expect(backoffMs(3, () => 0.999)).toBe(204);
    expect(backoffMs(10, () => 0.999)).toBe(804);
  });
});
