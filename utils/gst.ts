/**
 * GST helpers for RingPe's invoices: formats and the place of supply. The recipient's state is
 * taken from the institution's PIN code (postal circles follow states, with the exceptions listed
 * below); when the PIN code is missing the state is unknown and the invoice charges IGST. A
 * school's own GSTIN, once collected, takes precedence (its first two digits are the state code).
 */

/** GSTIN: state code, PAN, entity number, "Z", check character. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const SAC_PATTERN = /^\d{6}$/;
export const ACCOUNT_NO_PATTERN = /^\d{9,18}$/;

export interface GstState {
  readonly code: string;
  readonly name: string;
}

const S = (code: string, name: string): GstState => ({ code, name });
const STATES = {
  JK: S('01', 'Jammu and Kashmir'),
  HP: S('02', 'Himachal Pradesh'),
  PB: S('03', 'Punjab'),
  CH: S('04', 'Chandigarh'),
  UK: S('05', 'Uttarakhand'),
  HR: S('06', 'Haryana'),
  DL: S('07', 'Delhi'),
  RJ: S('08', 'Rajasthan'),
  UP: S('09', 'Uttar Pradesh'),
  BR: S('10', 'Bihar'),
  SK: S('11', 'Sikkim'),
  AR: S('12', 'Arunachal Pradesh'),
  NL: S('13', 'Nagaland'),
  MN: S('14', 'Manipur'),
  MZ: S('15', 'Mizoram'),
  TR: S('16', 'Tripura'),
  ML: S('17', 'Meghalaya'),
  AS: S('18', 'Assam'),
  WB: S('19', 'West Bengal'),
  JH: S('20', 'Jharkhand'),
  OD: S('21', 'Odisha'),
  CG: S('22', 'Chhattisgarh'),
  MP: S('23', 'Madhya Pradesh'),
  GJ: S('24', 'Gujarat'),
  MH: S('27', 'Maharashtra'),
  KA: S('29', 'Karnataka'),
  GA: S('30', 'Goa'),
  KL: S('32', 'Kerala'),
  TN: S('33', 'Tamil Nadu'),
  PY: S('34', 'Puducherry'),
  AN: S('35', 'Andaman and Nicobar Islands'),
  TS: S('36', 'Telangana'),
  AP: S('37', 'Andhra Pradesh'),
  LA: S('38', 'Ladakh'),
} as const;

/** First three PIN digits → state, as ranges [from, to, state]; the exceptions come first. */
const RANGES: readonly (readonly [number, number, GstState])[] = [
  [160, 160, STATES.CH],
  [194, 194, STATES.LA],
  [246, 246, STATES.UK],
  [248, 249, STATES.UK],
  [262, 263, STATES.UK],
  [403, 403, STATES.GA],
  [605, 605, STATES.PY],
  [737, 737, STATES.SK],
  [744, 744, STATES.AN],
  [813, 816, STATES.JH],
  [822, 822, STATES.JH],
  [825, 835, STATES.JH],
  [110, 110, STATES.DL],
  [121, 136, STATES.HR],
  [140, 159, STATES.PB],
  [171, 177, STATES.HP],
  [180, 193, STATES.JK],
  [201, 285, STATES.UP],
  [301, 345, STATES.RJ],
  [360, 396, STATES.GJ],
  [400, 445, STATES.MH],
  [450, 488, STATES.MP],
  [490, 497, STATES.CG],
  [500, 509, STATES.TS],
  [515, 535, STATES.AP],
  [560, 591, STATES.KA],
  [600, 643, STATES.TN],
  [670, 695, STATES.KL],
  [700, 743, STATES.WB],
  [751, 770, STATES.OD],
  [781, 788, STATES.AS],
  [790, 792, STATES.AR],
  [793, 794, STATES.ML],
  [795, 795, STATES.MN],
  [796, 796, STATES.MZ],
  [797, 798, STATES.NL],
  [799, 799, STATES.TR],
  [800, 855, STATES.BR],
];

/** The state of a PIN code, or null when it is missing or not recognised. */
export function stateOfPin(pin: string | null | undefined): GstState | null {
  if (!pin || !/^[1-9]\d{5}$/.test(pin)) return null;
  const p = Number(pin.slice(0, 3));
  return RANGES.find(([from, to]) => p >= from && p <= to)?.[2] ?? null;
}

/** The state of a GST state code ("29" → Karnataka). */
export function stateOfCode(code: string): GstState | null {
  return Object.values(STATES).find((s) => s.code === code) ?? null;
}

/** Tax split: CGST + SGST within the supplier's state, IGST otherwise. */
export function splitTax(taxPaise: number, supplierState: string, recipient: GstState | null) {
  if (recipient && recipient.code === supplierState) {
    const cgst = Math.floor(taxPaise / 2);
    return { kind: 'INTRA' as const, cgst, sgst: taxPaise - cgst, igst: 0 };
  }
  return { kind: 'INTER' as const, cgst: 0, sgst: 0, igst: taxPaise };
}
