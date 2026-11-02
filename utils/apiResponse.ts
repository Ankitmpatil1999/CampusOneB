/**
 * RFC 9457 problem details (brief §7.1, ADR-0006): `type`, `title`, `status`, `code`, `detail`,
 * `correlationId`, `params`, `errors[]`. `params` fill the placeholders of the message so an app can render
 * it in the member's language. Text comes from the message register; nothing internal (stack, SQL,
 * library messages) ever reaches the client.
 */
import { z } from 'zod';
import { getMessage, renderMessage, type MessageKey } from '../config/registers';
import type { FieldError } from './validators';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const fieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const problemSchema = z
  .object({
    type: z.string().describe('URN identifying the problem type (urn:campusone:problem:<code>)'),
    title: z.string(),
    status: z.number().int(),
    code: z.string().describe('Message register key, e.g. VALIDATION.FAILED'),
    detail: z.string(),
    instance: z.string().optional(),
    correlationId: z.string(),
    params: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe('Values for the placeholders of the message, e.g. {minutes}'),
    errors: z.array(fieldErrorSchema).optional(),
    check: z
      .string()
      .optional()
      .describe(
        'Payment refusals: the engine step that refused (G2…G6, P1…P8, V1…V13, docs/03 §8.2)',
      ),
    stage: z
      .string()
      .optional()
      .describe(
        'Payment refusals: the stage shown on the processing screen (identify, balance, …)',
      ),
    attempt: z
      .object({ id: z.uuid(), reference: z.string() })
      .optional()
      .describe(
        'Payment refusals after the record was written: the failed attempt ("View attempt")',
      ),
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof problemSchema>;

/** RFC 9457 extension members a refusal may add (payment engine steps). */
export interface ProblemExtensions {
  readonly check?: string;
  readonly stage?: string;
  readonly attempt?: { readonly id: string; readonly reference: string };
}

export function buildProblem(args: {
  status: number;
  code: MessageKey;
  correlationId: string;
  params?: Readonly<Record<string, string | number>>;
  errors?: readonly FieldError[];
  instance?: string;
  extensions?: ProblemExtensions;
}): Problem {
  const definition = getMessage(args.code);
  const detail = renderMessage(args.code, args.params);
  const problem: Problem = {
    type: `urn:campusone:problem:${args.code.toLowerCase()}`,
    title: definition.en.includes('{') ? detail : definition.en,
    status: args.status,
    code: args.code,
    detail,
    correlationId: args.correlationId,
  };
  if (args.instance) problem.instance = args.instance;
  if (args.extensions?.check) problem.check = args.extensions.check;
  if (args.extensions?.stage) problem.stage = args.extensions.stage;
  if (args.extensions?.attempt) problem.attempt = { ...args.extensions.attempt };
  if (args.params && Object.keys(args.params).length > 0) problem.params = { ...args.params };
  if (args.errors && args.errors.length > 0) {
    problem.errors = args.errors.map((e) => ({
      field: e.field,
      code: e.code,
      message: renderKnown(e.code, e.params),
      ...(e.params ? { params: e.params } : {}),
    }));
  }
  return problem;
}

function renderKnown(code: string, params?: Readonly<Record<string, string | number>>): string {
  try {
    return renderMessage(code as MessageKey, params);
  } catch {
    return renderMessage('VALIDATION.FORMAT');
  }
}
