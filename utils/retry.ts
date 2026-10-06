/**
 * Re-runs a whole transaction that InnoDB rolled back for a deadlock (1213) or a lock-wait timeout
 * (1205). Gap locks make these possible even between unrelated rows (two sign-ups whose codes sit in
 * the same index gap), so a short, jittered retry is the documented remedy. Only for transactions
 * that are safe to run again from the start.
 */
export const RETRIABLE_LOCK_ERRORS: ReadonlySet<number> = new Set([1213, 1205]);

export const isRetriableLockError = (e: unknown): boolean => {
  const errno = (e as { errno?: number } | null)?.errno;
  return errno !== undefined && RETRIABLE_LOCK_ERRORS.has(errno);
};

export async function retryOnLock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isRetriableLockError(e)) throw e;
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
    }
  }
}
