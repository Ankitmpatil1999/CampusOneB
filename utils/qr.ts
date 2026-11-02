/**
 * QR codes for merchant counters and payment requests (9.2, 9.3). Generated on the server so the web
 * console and the app show the same code without a QR library of their own: an SVG for screens, and
 * the module grid for the printable QR card (PDF).
 */
import qrcode from 'qrcode-generator';
import { PdfDocument, type Rgb } from './pdf';

const make = (payload: string) => {
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();
  return qr;
};

/** A scalable SVG (viewBox only, so it fills its box) with the 4-module quiet zone. */
export function qrSvg(payload: string): string {
  return make(payload).createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

/** The dark modules, row by row. */
export function qrModules(payload: string): boolean[][] {
  const qr = make(payload);
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_r, r) =>
    Array.from({ length: n }, (_c, c) => qr.isDark(r, c)),
  );
}

const INK: Rgb = [17, 33, 38];
const BRAND: Rgb = [13, 107, 115];
const MUTED: Rgb = [102, 115, 120];

/** A one-page QR card for the counter: the institution, the merchant, the kind and the code. */
export function qrCardPdf(card: {
  readonly institution: string;
  readonly merchant: string;
  readonly kindLabel: string;
  readonly code: string;
  readonly payload: string;
}): Buffer {
  const pdf = new PdfDocument(`${card.merchant} — ${card.kindLabel} QR`);
  const width = pdf.width;
  pdf.rect(0, 0, width, 120, { fill: BRAND });
  pdf.text(40, 50, 'CampusOne', { size: 26, bold: true, color: [255, 255, 255] });
  pdf.text(40, 82, card.institution, { size: 13, color: [255, 255, 255] });
  pdf.text(40, 170, card.merchant, { size: 22, bold: true, color: INK });
  pdf.text(40, 198, `${card.kindLabel} QR · ${card.code}`, { size: 12, color: MUTED });
  const grid = qrModules(card.payload);
  const size = 330;
  const cell = size / grid.length;
  const left = (width - size) / 2;
  const top = 240;
  pdf.rect(left - 16, top - 16, size + 32, size + 32, { stroke: [216, 224, 226] });
  grid.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) pdf.rect(left + c * cell, top + r * cell, cell + 0.2, cell + 0.2, { fill: INK });
    }),
  );
  pdf.text(40, top + size + 70, 'Scan with the CampusOne app to pay from your campus wallet.', {
    size: 12,
    color: INK,
  });
  pdf.text(40, top + size + 92, 'You confirm every payment with your transaction PIN.', {
    size: 11,
    color: MUTED,
  });
  return pdf.toBuffer();
}
