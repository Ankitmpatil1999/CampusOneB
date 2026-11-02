/**
 * Values of institution-defined fields (CR-12; RNG-ONB-103…114; prototype CM.cfGroup / CM.cfRead):
 * read for lists and records, validated by type on save — required, number, date, e-mail, phone,
 * an option of a Dropdown, options of a Multi-select, Yes/No — and kept unique where the field says
 * so. Values are keyed by the record's public id. Dropdown and Multi-select values are given and
 * returned as option labels.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { CfEntityCode, Database } from '../models/campusone_models';
import { CustomAPIError } from '../utils/CustomAPIError';
import { PATTERNS, type FieldError } from '../utils/validators';
import { binToUuid } from '../utils/idGenerator';

type Db = Kysely<Database>;

export interface CfField {
  readonly id: string;
  readonly dbId: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly listColumn: boolean;
  readonly filterable: boolean;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

export type CfValue = string | number | boolean | readonly string[] | null;

const bool = (v: unknown) => v === true || v === 1 || v === '1';
const PHONE = /^[6-9]\d{9}$/;

/** The active fields of an entity, in their order, with the options of choice fields. */
export async function activeFields(db: Db, institutionId: string, entity: CfEntityCode) {
  const fields = await db
    .selectFrom('custom_field_definitions')
    .select([
      'id',
      'public_id',
      'label',
      'data_type',
      'is_required',
      'is_unique',
      'list_column',
      'filterable',
    ])
    .where('institution_id', '=', institutionId)
    .where('entity', '=', entity)
    .where('status', '=', 'ACTIVE')
    .orderBy('position')
    .execute();
  const ids = fields.map((f) => f.id);
  const options = ids.length
    ? await db
        .selectFrom('custom_field_options')
        .select(['id', 'field_id', 'label'])
        .where('field_id', 'in', ids)
        .where('active', '=', true)
        .orderBy('position')
        .execute()
    : [];
  return fields.map((f): CfField => ({
    id: binToUuid(f.public_id),
    dbId: String(f.id),
    label: f.label,
    type: f.data_type,
    required: bool(f.is_required),
    unique: bool(f.is_unique),
    listColumn: bool(f.list_column),
    filterable: bool(f.filterable),
    options: options
      .filter((o) => String(o.field_id) === String(f.id))
      .map((o) => ({ id: String(o.id), label: o.label })),
  }));
}

/** Values of many records: record public id (hex) → field public id → value. */
export async function readValues(
  db: Db,
  institutionId: string,
  fields: readonly CfField[],
  refs: readonly Buffer[],
) {
  const out = new Map<string, Record<string, CfValue>>();
  if (!fields.length || !refs.length) return out;
  const rows = await db
    .selectFrom('custom_field_values as v')
    .leftJoin('custom_field_value_options as vo', 'vo.value_id', 'v.id')
    .leftJoin('custom_field_options as o', 'o.id', 'vo.option_id')
    .select([
      'v.id',
      'v.field_id',
      'v.entity_ref',
      'v.value_text',
      'v.value_number',
      'v.value_date',
      'v.value_bool',
      'o.label as option_label',
    ])
    .where('v.institution_id', '=', institutionId)
    .where(
      'v.field_id',
      'in',
      fields.map((f) => f.dbId),
    )
    .where('v.entity_ref', 'in', [...refs])
    .execute();
  for (const r of rows) {
    const f = fields.find((x) => x.dbId === String(r.field_id));
    if (!f) continue;
    const key = Buffer.from(r.entity_ref).toString('hex');
    const rec = out.get(key) ?? {};
    if (f.type === 'MULTI_SELECT') {
      const list = (rec[f.id] as string[] | undefined) ?? [];
      if (r.option_label) list.push(r.option_label);
      rec[f.id] = list;
    } else if (f.type === 'DROPDOWN') rec[f.id] = r.option_label ?? r.value_text;
    else if (f.type === 'NUMBER')
      rec[f.id] = r.value_number === null ? null : Number(r.value_number);
    else if (f.type === 'DATE') {
      rec[f.id] = r.value_date
        ? new Date(r.value_date as unknown as Date).toISOString().slice(0, 10)
        : null;
    } else if (f.type === 'YES_NO') rec[f.id] = r.value_bool === null ? null : bool(r.value_bool);
    else rec[f.id] = r.value_text;
    out.set(key, rec);
  }
  return out;
}

/** A value as text, for lists, filters and sheets. */
export function showValue(v: CfValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

interface Parsed {
  readonly field: CfField;
  readonly empty: boolean;
  readonly text: string | null;
  readonly number: string | null;
  readonly date: string | null;
  readonly bool: boolean | null;
  readonly optionIds: readonly string[];
  readonly uniqueKey: string | null;
}

/** Checks the given values against the fields; returns the parsed values or field errors. */
export function parseValues(
  fields: readonly CfField[],
  input: Readonly<Record<string, unknown>>,
  opts: { partial: boolean },
): { parsed: Parsed[]; errors: FieldError[] } {
  const parsed: Parsed[] = [];
  const errors: FieldError[] = [];
  for (const k of Object.keys(input)) {
    if (!fields.some((f) => f.id === k)) {
      errors.push({ field: `customFields.${k}`, code: 'VALIDATION.UNKNOWN_FIELD' });
    }
  }
  for (const f of fields) {
    const present = Object.prototype.hasOwnProperty.call(input, f.id);
    if (!present && opts.partial) continue;
    const raw = input[f.id];
    const field = `customFields.${f.id}`;
    const empty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '') ||
      (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (f.required) {
        errors.push({ field, code: 'CF.VALUE_REQUIRED', params: { label: f.label.toLowerCase() } });
      } else {
        parsed.push({
          field: f,
          empty: true,
          text: null,
          number: null,
          date: null,
          bool: null,
          optionIds: [],
          uniqueKey: null,
        });
      }
      continue;
    }
    const base = { field: f, empty: false, text: null, number: null, date: null, bool: null };
    const text = String(raw).trim();
    switch (f.type) {
      case 'NUMBER': {
        const n = typeof raw === 'number' ? raw : Number(text.replace(/,/g, ''));
        if (!Number.isFinite(n)) errors.push({ field, code: 'CF.VALUE_NUMBER' });
        else parsed.push({ ...base, number: String(n), optionIds: [], uniqueKey: String(n) });
        break;
      }
      case 'DATE': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
          errors.push({ field, code: 'VALIDATION.DATE' });
        } else parsed.push({ ...base, date: text, optionIds: [], uniqueKey: text });
        break;
      }
      case 'YES_NO': {
        const yes = raw === true || /^(yes|true|y|1)$/i.test(text);
        const no = raw === false || /^(no|false|n|0)$/i.test(text);
        if (!yes && !no) errors.push({ field, code: 'CF.VALUE_OPTION' });
        else parsed.push({ ...base, bool: yes, optionIds: [], uniqueKey: null });
        break;
      }
      case 'DROPDOWN': {
        const o = f.options.find((x) => x.label.toLowerCase() === text.toLowerCase());
        if (!o) errors.push({ field, code: 'CF.VALUE_OPTION' });
        else parsed.push({ ...base, optionIds: [o.id], uniqueKey: o.label.toLowerCase() });
        break;
      }
      case 'MULTI_SELECT': {
        const labels = (Array.isArray(raw) ? raw : text.split(/[,;]/))
          .map((x) => String(x).trim())
          .filter(Boolean);
        const ids = labels.map(
          (l) => f.options.find((x) => x.label.toLowerCase() === l.toLowerCase())?.id,
        );
        if (ids.some((x) => !x)) errors.push({ field, code: 'CF.VALUE_OPTION' });
        else parsed.push({ ...base, optionIds: [...new Set(ids as string[])], uniqueKey: null });
        break;
      }
      case 'EMAIL':
        // The platform's one e-mail rule (client 2026-10-15).
        if (!PATTERNS.email.test(text.trim().toLowerCase())) {
          errors.push({ field, code: 'VALIDATION.EMAIL' });
        } else
          parsed.push({
            ...base,
            text: text.toLowerCase(),
            optionIds: [],
            uniqueKey: text.toLowerCase(),
          });
        break;
      case 'PHONE':
        if (!PHONE.test(text)) errors.push({ field, code: 'CF.VALUE_PHONE' });
        else parsed.push({ ...base, text, optionIds: [], uniqueKey: text });
        break;
      default:
        if (text.length > (f.type === 'LONG_TEXT' ? 2000 : 200)) {
          errors.push({ field, code: 'VALIDATION.FORMAT' });
        } else {
          parsed.push({
            ...base,
            text,
            optionIds: [],
            uniqueKey: text.toLowerCase().slice(0, 255),
          });
        }
    }
  }
  return { parsed, errors };
}

/** Writes parsed values for one record; a unique value used by another record is refused. */
export async function saveValues(
  trx: Db,
  institutionId: string,
  ref: Buffer,
  parsed: readonly Parsed[],
) {
  for (const p of parsed) {
    const uniqueKey = p.field.unique ? p.uniqueKey : null;
    if (uniqueKey) {
      const clash = await trx
        .selectFrom('custom_field_values')
        .select('id')
        .where('institution_id', '=', institutionId)
        .where('field_id', '=', p.field.dbId)
        .where('unique_key', '=', uniqueKey)
        .where('entity_ref', '!=', ref)
        .executeTakeFirst();
      if (clash) {
        throw new CustomAPIError(409, 'CF.VALUE_TAKEN', {
          params: { label: p.field.label, value: p.text ?? p.number ?? p.date ?? uniqueKey },
          errors: [
            {
              field: `customFields.${p.field.id}`,
              code: 'CF.VALUE_TAKEN',
              params: { label: p.field.label, value: p.text ?? p.number ?? p.date ?? uniqueKey },
            },
          ],
        });
      }
    }
    const existing = await trx
      .selectFrom('custom_field_values')
      .select('id')
      .where('institution_id', '=', institutionId)
      .where('field_id', '=', p.field.dbId)
      .where('entity_ref', '=', ref)
      .executeTakeFirst();
    if (existing) {
      await trx
        .deleteFrom('custom_field_value_options')
        .where('value_id', '=', existing.id)
        .execute();
    }
    if (p.empty) {
      if (existing)
        await trx.deleteFrom('custom_field_values').where('id', '=', existing.id).execute();
      continue;
    }
    const values = {
      value_text: p.text,
      value_number: p.number,
      value_date: p.date,
      value_bool: p.bool,
      unique_key: uniqueKey,
    };
    let valueId: string;
    if (existing) {
      await trx
        .updateTable('custom_field_values')
        .set({ ...values, updated_at: sql<Date>`UTC_TIMESTAMP(3)` })
        .where('id', '=', existing.id)
        .execute();
      valueId = String(existing.id);
    } else {
      const r = await trx
        .insertInto('custom_field_values')
        .values({
          institution_id: institutionId,
          field_id: p.field.dbId,
          entity_ref: ref,
          ...values,
        })
        .executeTakeFirstOrThrow();
      valueId = String(r.insertId);
    }
    for (const o of p.optionIds) {
      await trx
        .insertInto('custom_field_value_options')
        .values({ value_id: valueId, option_id: o })
        .execute();
    }
  }
}
