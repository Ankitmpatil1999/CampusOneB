/**
 * Build status register (docs/01c-status-register.md, ADR-0008).
 *
 * Each value maps one-to-one to a row of SRS v2.1 27.2 (`registerValue`) or to an approved
 * register change (`rc`). Transitions follow 27.3 or the RC that introduced them; anything not
 * listed is refused (RNG-GOV-009…012).
 */

/** Chip tones of the prototype design tokens (one status-chip component, OI-GAS-13). */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand' | 'violet' | 'accent';

export interface StatusValue<C extends string = string> {
  /** Stored code (upper-case, 01c Part D). */
  readonly code: C;
  /** The 27.2 stored value this code maps to; `null` for a value added by a register change. */
  readonly registerValue: string | null;
  /** i18n key of the displayed label (RNG-GOV-011). */
  readonly labelKey: string;
  /** English label (default bundle). */
  readonly label: string;
  readonly tone: StatusTone;
  /** Terminal values have no outgoing transitions (RNG-GOV-012). */
  readonly terminal: boolean;
}

/** Pseudo-state for creation transitions ("(new)" in 27.3). */
export const NEW = '(new)' as const;
export type NewState = typeof NEW;

export interface StatusTransition<C extends string = string> {
  readonly from: C | NewState;
  readonly to: C;
  /** The one operation allowed to make the change (RNG-GOV-010). */
  readonly operation: string;
}

export interface StatusDomain<C extends string = string> {
  /** Domain key, also the `ref_status_values.domain` value. */
  readonly domain: string;
  /** 27.2 domain name, or `null` for a domain introduced by a register change. */
  readonly srsDomain: string | null;
  /** Register change that introduced or changed the domain (01c Part C), if any. */
  readonly rc: string | null;
  readonly values: readonly StatusValue<C>[];
  readonly transitions: readonly StatusTransition<C>[];
}

export type CodeOf<D> = D extends StatusDomain<infer C> ? C : never;
