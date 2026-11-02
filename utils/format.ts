/**
 * Shared file. The master is CampusOne_Backend_API/utils/format.ts; identical copies live in
 * CampusOne_Web_App/src/components/Utils/ and CampusOne_Mobile_App/src/utils/. Edit the master,
 * then run `npm run shared:sync` in CampusOne_Backend_API (`npm run shared:check` fails on drift).
 *
 * Indian display formatting (brief §7.8): ₹1,24,560.00 · 30 Sep 2026 · 12:40 PM.
 * Computed without Intl so server, Angular and Hermes (React Native) print identically.
 * India Standard Time is UTC+05:30 with no daylight saving.
 */
import { formatAmount } from './money';

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Groups an integer string the Indian way: 1234567 → 12,34,567. */
export function groupIndian(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new Error('groupIndian expects digits only');
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Paise → "₹1,24,560.00" (negative: "-₹1,240.50"). */
export function formatInr(paise: number | bigint): string {
  const plain = formatAmount(paise);
  const negative = plain.startsWith('-');
  const [rupees = '0', fraction = '00'] = (negative ? plain.slice(1) : plain).split('.');
  return `${negative ? '-' : ''}₹${groupIndian(rupees)}.${fraction}`;
}

interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function toDate(value: Date | string | number): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d;
}

export function istParts(value: Date | string | number): IstParts {
  const shifted = new Date(toDate(value).getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** "30 Sep 2026" in IST. A bare "YYYY-MM-DD" is treated as a calendar date, not an instant. */
export function formatDate(value: Date | string | number): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return `${String(d).padStart(2, '0')} ${MONTHS[m - 1] ?? '?'} ${y}`;
  }
  const p = istParts(value);
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1] ?? '?'} ${p.year}`;
}

/** "12:40 PM" in IST (12-hour clock). */
export function formatTime(value: Date | string | number): string {
  const p = istParts(value);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${hour12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "30 Sep 2026 · 12:40 PM" in IST. */
export function formatDateTime(value: Date | string | number): string {
  return `${formatDate(value)} · ${formatTime(value)}`;
}

/** Business date in Asia/Kolkata as "YYYY-MM-DD" (jobs, settlement windows, statements). */
export function istBusinessDate(value: Date | string | number = new Date()): string {
  const p = istParts(value);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Masks all but the last four characters: "9876543210" → "••••••3210" (display, brief §6.4). */
export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return value;
  return '•'.repeat(value.length - visible) + value.slice(-visible);
}

/** Indian mobile for display: "9880012345" → "+91 98800 12345" (prototype fmt.mobile). */
export function formatMobile(digits: string): string {
  return /^\d{10}$/.test(digits) ? `+91 ${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
}

/** Names are stored in capitals (27.4 §5); shown in title case: "MEERA HEGDE" → "Meera Hegde". */
export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
