/**
 * Registers and limits for clients (PLT-007, PLT-008; RNG-GOV-011, 27.4). The server remains the
 * authority; clients use these to render labels, translate codes and pre-validate fields.
 */
import { createHash } from 'node:crypto';
import { ALL_STATUS_DOMAINS, NEW, allLimits, allMessages } from '../config/registers';

/** Source of the limit values in force (the settings service; register defaults without it). */
export interface LimitValuesSource {
  values(): Promise<Readonly<Record<string, number>>>;
}

export interface CachedDocument {
  readonly body: string;
  readonly etag: string;
}

function cache(value: unknown): CachedDocument {
  const body = JSON.stringify(value);
  const hash = createHash('sha256').update(body).digest('base64url').slice(0, 27);
  return { body, etag: `"${hash}"` };
}

export function platformService(settings?: LimitValuesSource) {
  const registersPayload = {
    statuses: ALL_STATUS_DOMAINS.map((d) => ({
      domain: d.domain,
      values: d.values.map((v) => ({
        code: v.code,
        labelKey: v.labelKey,
        label: v.label,
        tone: v.tone,
        terminal: v.terminal,
      })),
      transitions: d.transitions
        .filter((t) => t.from !== NEW)
        .map((t) => ({ from: t.from, to: t.to })),
    })),
    messages: allMessages().map((m) => ({
      key: m.key,
      type: m.type,
      text: m.en,
      placeholders: [...(m.placeholders ?? [])],
    })),
  };
  const versionHash = cache(registersPayload).etag.slice(1, -1);
  const registers = cache({ version: versionHash, ...registersPayload });

  const numeric = allLimits().filter((l) => typeof l.value === 'number');
  const render = (values: Readonly<Record<string, number>>) =>
    cache({
      limits: Object.fromEntries(
        numeric.map((l) => [l.key, { value: values[l.key] ?? (l.value as number), unit: l.unit }]),
      ),
    });
  const defaults = render({});
  let last: { key: string; doc: CachedDocument } | undefined;

  return {
    registers: async () => registers,
    /** Limits in force (operator settings over the register defaults), with an ETag. */
    limits: async (): Promise<CachedDocument> => {
      if (!settings) return defaults;
      const values = await settings.values();
      const key = JSON.stringify(values);
      if (last?.key !== key) last = { key, doc: render(values) };
      return last.doc;
    },
  };
}

export type PlatformService = ReturnType<typeof platformService>;
