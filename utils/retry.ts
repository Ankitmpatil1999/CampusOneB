/**
 * Re-runs a whole transaction that InnoDB rolled back for a deadlock (1213) or a lock-wait timeout
 * (1205). Gap locks make these possible even between unrelated rows (two sign-ups whose codes sit in
 * the same index gap — every new row does while a table is nearly empty), so a short, jittered retry
 * is the documented remedy. Only for transactions that are safe to run again from the start.
 *
 * The pause grows with each attempt and is spread at random (exponential backoff with jitter), so
 * transactions that collided don't meet again (a burst of sign-ups ran out of three quick attempts).
 * A lock-wait timeout has already waited innodb_lock_wait_timeout, so it is tried at most three times.
 */
export const RETRIABLE_LOCK_ERRORS: ReadonlySet<number> = new Set([1213, 1205]);

const LOCK_WAIT_TIMEOUT = 1205;
const MAX_LOCK_WAIT_ATTEMPTS = 3;

export const isRetriableLockError = (e: unknown): boolean => {
  const errno = (e as { errno?: number } | null)?.errno;
  return errno !== undefined && RETRIABLE_LOCK_ERRORS.has(errno);
};

/** The pause after failed attempt n: 5 ms plus a random share of 25 ms · 2ⁿ, at most 800 ms. */
export const backoffMs = (attempt: number, random: () => number = Math.random) =>
  5 + Math.floor(random() * Math.min(800, 25 * 2 ** attempt));

export async function retryOnLock<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lockWaits = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isRetriableLockError(e)) throw e;
      const errno = (e as { errno?: number }).errno;
      if (errno === LOCK_WAIT_TIMEOUT && ++lockWaits >= MAX_LOCK_WAIT_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
}
