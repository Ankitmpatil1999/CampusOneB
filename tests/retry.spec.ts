import { isRetriableLockError, retryOnLock } from '../utils/retry';

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
});
