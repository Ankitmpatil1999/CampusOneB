/**
 * CSV (RFC 4180) for onboarding sheets: quoted fields, doubled quotes, CRLF or LF, an optional
 * byte-order mark (Excel's "CSV UTF-8"). Cells that look like formulas are written with a leading
 * apostrophe so a spreadsheet never runs them (CSV injection).
 */

/**
 * The separator of a sheet, from its first line: a comma, or the semicolon or tab Excel writes in
 * some regional settings and as "Unicode text" (client 2026-10-13). A comma when unsure.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  const outside = first.replace(/"[^"]*"/g, '');
  const count = (c: string) => outside.split(c).length - 1;
  const commas = count(',');
  if (count('\t') > commas && count('\t') >= count(';')) return '\t';
  if (count(';') > commas) return ';';
  return ',';
}

export function parseCsv(text: string, delimiter: ',' | ';' | '\t' = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Rows with nothing in them (a trailing blank line, an empty row) are not data.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const needsQuotes = /[",\r\n]/;

export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            let c = v === null || v === undefined ? '' : String(v);
            if (/^[=+\-@\t\r]/.test(c)) c = `'${c}`;
            return needsQuotes.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}
