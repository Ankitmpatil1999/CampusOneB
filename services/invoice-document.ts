/**
 * The GST invoice as a PDF (FR-SAS-07; SAS-042/043; prototype c.subscription "Download" → "GST
 * invoice"). Supplier: CampusOne's billing profile (example values are marked "SAMPLE" until the client
 * supplies them — Q25, Q26). Recipient: the institution, its state from the PIN code (place of
 * supply); CGST + SGST within the supplier's state, IGST otherwise. Amounts in rupees with paise
 * and in words (Indian system).
 */
import { formatDate, formatInr } from '../utils/format';
import { splitTax, stateOfCode, stateOfPin } from '../utils/gst';
import { PdfDocument, rupeesInWords, type Rgb } from '../utils/pdf';

export interface InvoiceDocumentData {
  readonly profile: {
    readonly legalName: string;
    readonly gstin: string;
    readonly address: string;
    readonly stateCode: string;
    readonly sacCode: string;
    readonly payeeName: string;
    readonly payeeBank: string;
    readonly payeeAccountNo: string;
    readonly payeeIfsc: string;
    readonly example: boolean;
  };
  readonly institution: {
    readonly name: string;
    readonly identifier: string;
    readonly address: string;
    readonly city: string;
    readonly pin: string | null;
  };
  readonly invoice: {
    readonly invoiceNo: string;
    readonly issuedOn: string;
    readonly dueOn: string;
    readonly period: string;
    readonly status: string;
    readonly amountPaise: number;
    readonly taxBp: number;
    readonly taxPaise: number;
    readonly totalPaise: number;
    readonly paid: { readonly on: string; readonly reference: string | null } | null;
    readonly lines: readonly {
      readonly description: string;
      readonly quantity: number;
      readonly unitPricePaise: number;
      readonly amountPaise: number;
    }[];
  };
}

const INK: Rgb = [17, 24, 39];
const MUTED: Rgb = [100, 116, 139];
const BRAND: Rgb = [11, 92, 104];
const LINE: Rgb = [214, 222, 226];
const SOFT: Rgb = [240, 246, 247];
const WARN: Rgb = [180, 83, 9];
const WARN_SOFT: Rgb = [254, 243, 199];

/** Rupees with Indian grouping; the PDF writer prints the rupee sign as "Rs.". */
const inr = (paise: number) => formatInr(paise);

export function renderInvoicePdf(d: InvoiceDocumentData): Buffer {
  const doc = new PdfDocument(`CampusOne invoice ${d.invoice.invoiceNo}`);
  const L = 40;
  const R = doc.width - 40;
  let y = 40;

  if (d.profile.example) {
    doc.rect(L, y, R - L, 26, { fill: WARN_SOFT });
    doc.text(
      L + 10,
      y + 17,
      'SAMPLE - example CampusOne details; not a valid tax invoice until the real details are entered.',
      { size: 9, bold: true, color: WARN },
    );
    y += 38;
  }

  // Supplier and title.
  doc.text(L, y + 14, d.profile.legalName, { size: 14, bold: true, color: BRAND });
  doc.text(R, y + 14, 'TAX INVOICE', { size: 16, bold: true, align: 'right' });
  y += 30;
  for (const l of doc.wrap(d.profile.address, 300, 9)) {
    doc.text(L, y, l, { size: 9, color: MUTED });
    y += 12;
  }
  const supplierState = stateOfCode(d.profile.stateCode);
  doc.text(
    L,
    y,
    `GSTIN ${d.profile.gstin} · State ${supplierState?.name ?? ''} (${d.profile.stateCode})`,
    { size: 9, color: MUTED },
  );
  // Invoice facts on the right.
  let ry = 70 + (d.profile.example ? 38 : 0);
  const fact = (k: string, v: string) => {
    doc.text(R - 150, ry, k, { size: 9, color: MUTED });
    doc.text(R, ry, v, { size: 9, bold: true, align: 'right' });
    ry += 14;
  };
  fact('Invoice no.', d.invoice.invoiceNo);
  fact('Invoice date', formatDate(d.invoice.issuedOn));
  fact('Due date', formatDate(d.invoice.dueOn));
  fact('Status', d.invoice.status);
  y = Math.max(y, ry) + 16;
  doc.line(L, y, R, y, { color: LINE });
  y += 20;

  // Recipient and place of supply.
  const recipientState = stateOfPin(d.institution.pin);
  doc.text(L, y, 'BILL TO', { size: 8, bold: true, color: MUTED });
  doc.text(R - 200, y, 'PLACE OF SUPPLY', { size: 8, bold: true, color: MUTED });
  y += 15;
  doc.text(L, y, d.institution.name, { size: 11, bold: true });
  doc.text(
    R - 200,
    y,
    recipientState ? `${recipientState.name} (${recipientState.code})` : 'Not known (IGST)',
    { size: 10, bold: true },
  );
  y += 14;
  const billTo = [
    ...doc.wrap(d.institution.address, 280, 9),
    [d.institution.city, d.institution.pin].filter(Boolean).join(' '),
    `CampusOne institution id ${d.institution.identifier}`,
  ];
  for (const l of billTo) {
    doc.text(L, y, l, { size: 9, color: MUTED });
    y += 12;
  }
  doc.text(R - 200, y - 12 * billTo.length + 2, `Period: ${d.invoice.period}`, {
    size: 9,
    color: MUTED,
  });
  y += 14;

  // Lines.
  const cols = { desc: L + 8, sac: R - 230, qty: R - 165, rate: R - 90, amt: R - 8 };
  doc.rect(L, y, R - L, 22, { fill: SOFT });
  doc.text(cols.desc, y + 15, 'Description', { size: 9, bold: true });
  doc.text(cols.sac, y + 15, 'SAC', { size: 9, bold: true });
  doc.text(cols.qty, y + 15, 'Qty', { size: 9, bold: true, align: 'right' });
  doc.text(cols.rate, y + 15, 'Rate', { size: 9, bold: true, align: 'right' });
  doc.text(cols.amt, y + 15, 'Amount', { size: 9, bold: true, align: 'right' });
  y += 22;
  for (const l of d.invoice.lines) {
    const desc = doc.wrap(l.description, cols.sac - cols.desc - 12, 9);
    const h = Math.max(24, 12 * desc.length + 12);
    desc.forEach((t, i) => doc.text(cols.desc, y + 16 + i * 12, t, { size: 9 }));
    doc.text(cols.sac, y + 16, d.profile.sacCode, { size: 9 });
    doc.text(cols.qty, y + 16, l.quantity.toLocaleString('en-IN'), { size: 9, align: 'right' });
    doc.text(cols.rate, y + 16, inr(l.unitPricePaise), { size: 9, align: 'right' });
    doc.text(cols.amt, y + 16, inr(l.amountPaise), { size: 9, align: 'right' });
    y += h;
    doc.line(L, y, R, y, { color: LINE });
  }
  y += 16;

  // Totals.
  const tax = splitTax(d.invoice.taxPaise, d.profile.stateCode, recipientState);
  const rate = d.invoice.taxBp / 100;
  const total = (k: string, v: number, bold = false) => {
    doc.text(R - 200, y, k, { size: 9.5, bold, color: bold ? INK : MUTED });
    doc.text(R - 8, y, inr(v), { size: bold ? 11 : 9.5, bold, align: 'right' });
    y += bold ? 18 : 14;
  };
  total('Taxable value', d.invoice.amountPaise);
  if (tax.kind === 'INTRA') {
    total(`CGST @ ${rate / 2}%`, tax.cgst);
    total(`SGST @ ${rate / 2}%`, tax.sgst);
  } else {
    total(`IGST @ ${rate}%`, tax.igst);
  }
  doc.line(R - 200, y - 6, R, y - 6, { color: LINE });
  y += 4;
  total('Total', d.invoice.totalPaise, true);
  doc.text(L, y, rupeesInWords(d.invoice.totalPaise), { size: 9, bold: true });
  y += 28;

  // Payment.
  doc.rect(L, y, R - L, d.invoice.paid ? 44 : 74, { fill: SOFT });
  y += 16;
  if (d.invoice.paid) {
    doc.text(L + 10, y, 'Paid', { size: 9, bold: true, color: BRAND });
    y += 14;
    doc.text(
      L + 10,
      y,
      `Received on ${formatDate(d.invoice.paid.on)}${d.invoice.paid.reference ? ` · reference ${d.invoice.paid.reference}` : ''}`,
      { size: 9 },
    );
    y += 28;
  } else {
    doc.text(L + 10, y, 'Pay by bank transfer', { size: 9, bold: true, color: BRAND });
    y += 14;
    doc.text(L + 10, y, `Account name: ${d.profile.payeeName}`, { size: 9 });
    doc.text(L + 290, y, `Bank: ${d.profile.payeeBank}`, { size: 9 });
    y += 13;
    doc.text(L + 10, y, `Account number: ${d.profile.payeeAccountNo}`, { size: 9 });
    doc.text(L + 290, y, `IFSC: ${d.profile.payeeIfsc}`, { size: 9 });
    y += 13;
    doc.text(L + 10, y, `Quote the invoice number ${d.invoice.invoiceNo} as the reference.`, {
      size: 9,
      color: MUTED,
    });
    y += 30;
  }

  doc.text(L, doc.height - 40, 'This is a computer-generated invoice and needs no signature.', {
    size: 8,
    color: MUTED,
  });
  doc.text(R, doc.height - 40, 'CampusOne', { size: 8, bold: true, color: BRAND, align: 'right' });
  return doc.toBuffer();
}
