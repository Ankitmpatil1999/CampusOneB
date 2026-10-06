/**
 * What may be uploaded, per purpose (CR-07, RNG-GAS-109…117, 5.11). The type is decided from the
 * file's bytes, never from its name or the browser's claim. Every purpose has the 2 MB limit of the
 * limits register; generated documents (statements, exports, receipts) are not uploads.
 */
export const MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
} as const;

export interface FilePurpose {
  readonly types: readonly string[];
  /** Label of the allowed types for the refusal message ("PNG, JPEG"). */
  readonly label: string;
}

export const FILE_PURPOSES = {
  /** Institution logo (INS-012) — re-encoded on use. */
  logo: { types: [MIME.png, MIME.jpeg], label: 'PNG, JPEG' },
  /** Member photo. */
  photo: { types: [MIME.png, MIME.jpeg], label: 'PNG, JPEG' },
  /** Supporting documents (address proof, admission documents). */
  document: { types: [MIME.pdf, MIME.png, MIME.jpeg], label: 'PDF, PNG, JPEG' },
  /** Evidence for a personal-details correction (CR-06). */
  evidence: { types: [MIME.pdf, MIME.png, MIME.jpeg], label: 'PDF, PNG, JPEG' },
  /** Bulk onboarding sheet (IDN-049). */
  sheet: { types: [MIME.xlsx, MIME.csv], label: 'XLSX, CSV' },
} as const satisfies Record<string, FilePurpose>;

export type FilePurposeKey = keyof typeof FILE_PURPOSES;

export const isFilePurpose = (v: unknown): v is FilePurposeKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(FILE_PURPOSES, v);
