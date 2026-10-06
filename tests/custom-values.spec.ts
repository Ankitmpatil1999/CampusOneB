/**
 * Custom field values (CR-12; RNG-ONB-103…114): every type is checked on save — required, number,
 * date, Yes/No, Dropdown and Multi-select by option label, e-mail, phone, text length — and unknown
 * fields are refused. Partial saves skip fields not sent.
 */
import { parseValues, showValue, type CfField } from '../services/custom-values.service';

const field = (id: string, type: string, extra: Partial<CfField> = {}): CfField => ({
  id,
  dbId: `db-${id}`,
  label: id.toUpperCase(),
  type,
  required: false,
  unique: false,
  listColumn: false,
  filterable: false,
  options: [],
  ...extra,
});

const FIELDS: readonly CfField[] = [
  field('house', 'DROPDOWN', {
    required: true,
    options: [
      { id: 'o1', label: 'Red' },
      { id: 'o2', label: 'Blue' },
    ],
  }),
  field('clubs', 'MULTI_SELECT', {
    options: [
      { id: 'c1', label: 'Chess' },
      { id: 'c2', label: 'Music' },
    ],
  }),
  field('height', 'NUMBER'),
  field('joined', 'DATE'),
  field('bus', 'YES_NO'),
  field('mail', 'EMAIL'),
  field('phone', 'PHONE'),
  field('notes', 'LONG_TEXT'),
  field('nick', 'TEXT'),
];

describe('custom field values', () => {
  it('parses every type from labels and plain text', () => {
    const { parsed, errors } = parseValues(
      FIELDS,
      {
        house: 'red',
        clubs: 'chess; Music',
        height: '1,42',
        joined: '2026-06-01',
        bus: 'yes',
        mail: 'Parent@Example.IN',
        phone: '9845012345',
        notes: 'Allergic to peanuts',
        nick: 'Ashu',
      },
      { partial: false },
    );
    expect(errors).toEqual([]);
    const by = Object.fromEntries(parsed.map((p) => [p.field.id, p]));
    expect(by['house']).toMatchObject({ optionIds: ['o1'], uniqueKey: 'red' });
    expect(by['clubs']!.optionIds).toEqual(['c1', 'c2']);
    expect(by['height']).toMatchObject({ number: '142' });
    expect(by['joined']).toMatchObject({ date: '2026-06-01' });
    expect(by['bus']).toMatchObject({ bool: true });
    expect(by['mail']).toMatchObject({ text: 'parent@example.in' });
    expect(by['phone']).toMatchObject({ text: '9845012345' });
    expect(by['nick']).toMatchObject({ text: 'Ashu', uniqueKey: 'ashu' });
  });

  it('refuses wrong values with the field’s code, and unknown fields', () => {
    const { errors } = parseValues(
      FIELDS,
      {
        house: 'Green',
        clubs: ['Chess', 'Dance'],
        height: 'tall',
        joined: '01-06-2026',
        bus: 'maybe',
        mail: 'not-an-email',
        phone: '1234567890',
        notes: 'x'.repeat(2001),
        nick: 'y'.repeat(201),
        shoe: '7',
      },
      { partial: false },
    );
    expect(errors.map((e) => `${e.field}:${e.code}`).sort()).toEqual(
      [
        'customFields.bus:CF.VALUE_OPTION',
        'customFields.clubs:CF.VALUE_OPTION',
        'customFields.height:CF.VALUE_NUMBER',
        'customFields.house:CF.VALUE_OPTION',
        'customFields.joined:VALIDATION.DATE',
        'customFields.mail:VALIDATION.EMAIL',
        'customFields.nick:VALIDATION.FORMAT',
        'customFields.notes:VALIDATION.FORMAT',
        'customFields.phone:CF.VALUE_PHONE',
        'customFields.shoe:VALIDATION.UNKNOWN_FIELD',
      ].sort(),
    );
  });

  it('requires a required field on a full save, skips absent fields on a partial one', () => {
    const full = parseValues(FIELDS, { nick: '' }, { partial: false });
    expect(full.errors).toEqual([
      { field: 'customFields.house', code: 'CF.VALUE_REQUIRED', params: { label: 'house' } },
    ]);
    expect(full.parsed.find((p) => p.field.id === 'nick')).toMatchObject({ empty: true });
    const partial = parseValues(FIELDS, { bus: false, height: 7 }, { partial: true });
    expect(partial.errors).toEqual([]);
    expect(partial.parsed.map((p) => p.field.id).sort()).toEqual(['bus', 'height']);
    expect(partial.parsed.find((p) => p.field.id === 'bus')).toMatchObject({ bool: false });
  });

  it('shows values for lists', () => {
    expect(showValue(['Chess', 'Music'])).toContain('Chess');
    expect(showValue(true)).not.toBe('');
    expect(showValue(null)).toBe('');
  });
});
