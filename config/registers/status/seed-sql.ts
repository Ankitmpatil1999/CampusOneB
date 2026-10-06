import { NEW, type StatusDomain } from './types';

const sqlString = (value: string | null): string =>
  value === null ? 'NULL' : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/**
 * Renders idempotent seed SQL for `ref_status_values` and `ref_status_transitions`
 * (docs/04 §9, migration 0002). Creation transitions ("(new)" in 27.3) are enforced in code only:
 * the table's foreign key needs a real `from_code`.
 */
export function renderStatusSeedSql(domains: readonly StatusDomain[]): string {
  const lines: string[] = [
    '-- Generated from config/registers — do not edit by hand.',
    '-- Source: docs/01c-status-register.md (SRS v2.1 27.2 / 27.3 + register changes).',
  ];
  for (const d of domains) {
    lines.push(
      '',
      `-- ${d.domain}${d.srsDomain ? ` (27.2: ${d.srsDomain})` : ''}${d.rc ? ` — ${d.rc}` : ''}`,
    );
    d.values.forEach((v, i) => {
      lines.push(
        'INSERT INTO ref_status_values (domain, code, label_key, tone, is_terminal, sort_order, register_value, srs_ref, rc_ref) VALUES (' +
          [
            sqlString(d.domain),
            sqlString(v.code),
            sqlString(v.labelKey),
            sqlString(v.tone),
            v.terminal ? 'TRUE' : 'FALSE',
            String(i + 1),
            sqlString(v.registerValue),
            sqlString(d.srsDomain),
            sqlString(v.registerValue === null ? d.rc : null),
          ].join(', ') +
          ') ON DUPLICATE KEY UPDATE label_key = VALUES(label_key), tone = VALUES(tone), is_terminal = VALUES(is_terminal), sort_order = VALUES(sort_order), register_value = VALUES(register_value), srs_ref = VALUES(srs_ref), rc_ref = VALUES(rc_ref);',
      );
    });
    for (const t of d.transitions) {
      if (t.from === NEW) continue;
      lines.push(
        'INSERT INTO ref_status_transitions (domain, from_code, to_code, operation, register_ref) VALUES (' +
          [
            sqlString(d.domain),
            sqlString(t.from),
            sqlString(t.to),
            sqlString(t.operation),
            sqlString(d.rc ?? d.srsDomain),
          ].join(', ') +
          ') ON DUPLICATE KEY UPDATE operation = VALUES(operation), register_ref = VALUES(register_ref);',
      );
    }
  }
  return lines.join('\n') + '\n';
}
