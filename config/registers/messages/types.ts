/**
 * Message register (docs/01 §4, ADR-0008, Q22).
 *
 * Every message is keyed to its SRS v2.1 27.5 id. Wording class:
 * - K — keep: the 27.5 wording is used verbatim (placeholders substituted);
 * - R — reword: the 27.5 wording is defective or an open item asks for new wording; prototype
 *   wording replaces it, or it is drafted at design time;
 * - S — standard: an internal or technical message replaced by a standard problem title;
 * - N — new: a string the v2.1 change requests leave to design time (no 27.5 id).
 * Classes R, S and N are message-register changes that need approval (`approval`).
 */
export type MessageClass = 'K' | 'R' | 'S' | 'N';
export type MessageType = 'error' | 'warning' | 'info' | 'success';
export type ApprovalState = 'register' | 'pending' | 'approved';

export interface MessageDefinition {
  /** Catalogue key returned as `code` (MODULE.REASON). */
  readonly key: string;
  /** SRS 27.5 id, or `null` for a new (N) message. */
  readonly register: string | null;
  /** The 27.5 wording, for traceability (null for N). */
  readonly srsText: string | null;
  readonly class: MessageClass;
  readonly type: MessageType;
  /** Default HTTP status when the message is a refusal. */
  readonly http?: number;
  /** English text; `{name}` marks a placeholder. */
  readonly en: string;
  readonly placeholders?: readonly string[];
  /** `register` for class K (no change), otherwise the approval state of the change. */
  readonly approval: ApprovalState;
  /** Approval batch: the phase that introduced the message (Q22: one batch per phase). Default 1. */
  readonly batch?: number;
  /** Requirement or open item that motivates the wording. */
  readonly refs?: readonly string[];
}
