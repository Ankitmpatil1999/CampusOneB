/**
 * Per-request context carried through async calls (AsyncLocalStorage): the correlation id and,
 * once authenticated, the tenant and actor. The institution comes from the session only, never
 * from the request (golden rule: tenant isolation).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  institutionId?: string;
  actorId?: string;
  actorType?: string;
  route?: string;
  /** Client IP as Express resolved it (trust proxy). */
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Adds fields to the current context (no-op outside a request). */
export function updateContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
