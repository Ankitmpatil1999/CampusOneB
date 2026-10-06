/**
 * The authenticated caller, derived only from a verified access token (ADR-0011). The tenant
 * (`institutionId`) is taken from here and never from the request (golden rule).
 */
export type Surface = 'member' | 'console' | 'ops' | 'portal' | 'terminal' | 'partner';

export const SURFACES: readonly Surface[] = [
  'member',
  'console',
  'ops',
  'portal',
  'terminal',
  'partner',
];

export interface Principal {
  /** Platform account (or terminal / partner client) public id — token `sub`. */
  readonly subject: string;
  /** Token audience = the surface the session belongs to. */
  readonly surface: Surface;
  /** Session id — token `sid`. */
  readonly sessionId: string;
  /** Institution public id for tenant-scoped sessions — token `ins`. */
  readonly institutionId?: string;
  /** Active institution profile public id — token `prf`. */
  readonly profileId?: string;
  /** Granted sub-tasks, `task.subtask` (role → task → sub-task, IDN 6.28) — token `st`. */
  readonly subTasks: readonly string[];
}
