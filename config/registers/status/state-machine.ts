import { NEW, type NewState, type StatusDomain } from './types';

export type TransitionCheck =
  | { readonly ok: true; readonly operation: string }
  | { readonly ok: false; readonly reason: 'UNKNOWN_VALUE' | 'TERMINAL' | 'NOT_ALLOWED' };

/** Returns whether `from → to` is a registered transition of the domain. */
export function checkTransition<C extends string>(
  domain: StatusDomain<C>,
  from: C | NewState,
  to: C,
): TransitionCheck {
  const codes = new Set<string>(domain.values.map((v) => v.code));
  if (!codes.has(to) || (from !== NEW && !codes.has(from))) {
    return { ok: false, reason: 'UNKNOWN_VALUE' };
  }
  if (from !== NEW && domain.values.find((v) => v.code === from)?.terminal) {
    return { ok: false, reason: 'TERMINAL' };
  }
  const match = domain.transitions.find((t) => t.from === from && t.to === to);
  return match ? { ok: true, operation: match.operation } : { ok: false, reason: 'NOT_ALLOWED' };
}

/** Codes reachable from `from` in one registered step. */
export function nextStates<C extends string>(domain: StatusDomain<C>, from: C | NewState): C[] {
  return domain.transitions.filter((t) => t.from === from).map((t) => t.to);
}

/**
 * Validates a domain definition: unique codes, transitions between known codes, no transition out
 * of a terminal value, and at least one creation transition. Used by the register unit tests and
 * by the seed generator.
 */
export function validateDomain(domain: StatusDomain): string[] {
  const problems: string[] = [];
  const codes = domain.values.map((v) => v.code);
  const unique = new Set(codes);
  if (unique.size !== codes.length) problems.push(`${domain.domain}: duplicate codes`);
  for (const v of domain.values) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.code)) problems.push(`${domain.domain}: bad code ${v.code}`);
    if (v.registerValue === null && domain.rc === null) {
      problems.push(`${domain.domain}: ${v.code} has neither a 27.2 value nor a register change`);
    }
  }
  const terminal = new Set(domain.values.filter((v) => v.terminal).map((v) => v.code));
  for (const t of domain.transitions) {
    if (t.from !== NEW && !unique.has(t.from)) {
      problems.push(`${domain.domain}: unknown from ${t.from}`);
    }
    if (!unique.has(t.to)) problems.push(`${domain.domain}: unknown to ${t.to}`);
    if (t.from !== NEW && terminal.has(t.from)) {
      problems.push(`${domain.domain}: transition out of terminal ${t.from}`);
    }
    if (!t.operation.trim()) problems.push(`${domain.domain}: transition without operation`);
  }
  if (!domain.transitions.some((t) => t.from === NEW)) {
    problems.push(`${domain.domain}: no creation transition`);
  }
  return problems;
}
