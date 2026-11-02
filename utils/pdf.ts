/**
 * A small PDF writer for server-rendered documents (GST invoices; later receipts and statements):
 * A4 pages, text in the standard Helvetica and Helvetica-Bold fonts (WinAnsi encoding), lines,
 * filled rectangles and pictures (utils/pdf-image). Coordinates are in points from the top-left
 * corner. Characters outside Windows-1252 are written as "?" (the rupee sign as "Rs."), so callers
 * keep text to plain Latin — institution names and addresses already are
 * (PATTERNS.institutionName).
 */
import type { PdfImage } from './pdf-image';

export type Rgb = readonly [number, number, number];

/** Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32…126 (Adobe AFM). */
const WIDTHS = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
} as const;

/** Windows-1252 bytes for the few non-Latin-1 characters our documents use. */
const CP1252: Readonly<Record<string, number>> = {
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '…': 0x85,
};

/** The text as Windows-1252 bytes (one per character). */
function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.replace(/₹/g, 'Rs. ').replace(/‌|‍/g, '')) {
    const cp = ch.codePointAt(0)!;
    if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
    else if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else out.push(0x3f);
  }
  return out;
}

function widthOf(bytes: readonly number[], bold: boolean): number {
  const table = bold ? WIDTHS.bold : WIDTHS.regular;
  let w = 0;
  for (const b of bytes) {
    if (b >= 32 && b <= 126) w += table[b - 32]!;
    else if (b === 0x97) w += 1000;
    else if (b === 0xb7 || b === 0x95) w += 278;
    else w += 556;
  }
  return w;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const color = (c: Rgb) => c.map((v) => num(v / 255)).join(' ');

export interface TextOptions {
  readonly size?: number;
  readonly bold?: boolean;
  readonly color?: Rgb;
  readonly align?: 'left' | 'right' | 'center';
}

export class PdfDocument {
  readonly width = 595.28;
  readonly height = 841.89;
  private readonly pages: string[][] = [[]];
  private readonly images: PdfImage[] = [];
  /** The pictures each page draws (indexes into `images`). */
  private readonly pageImages: Set<number>[] = [new Set()];

  constructor(private readonly title = 'Document') {}

  private get ops() {
    return this.pages[this.pages.length - 1]!;
  }

  addPage() {
    this.pages.push([]);
    this.pageImages.push(new Set());
  }

  /**
   * Draws a picture in the box w × h at (x, y) from the top, turned upright. The caller keeps its
   * proportions (`img.width` : `img.height`).
   */
  image(img: PdfImage, x: number, y: number, w: number, h: number) {
    let k = this.images.indexOf(img);
    if (k < 0) k = this.images.push(img) - 1;
    this.pageImages[this.pageImages.length - 1]!.add(k);
    const b = this.height - y - h;
    const m =
      img.rotate === 90
        ? [0, -h, w, 0, x, b + h]
        : img.rotate === 270
          ? [0, h, -w, 0, x + w, b]
          : img.rotate === 180
            ? [-w, 0, 0, -h, x + w, b + h]
            : [w, 0, 0, h, x, b];
    this.ops.push(`q ${m.map(num).join(' ')} cm /Im${k} Do Q`);
  }

  /** Width of `text` in points. */
  measure(text: string, size = 10, bold = false) {
    return (widthOf(encode(text), bold) * size) / 1000;
  }

  /** Splits `text` into lines no wider than `maxWidth`. */
  wrap(text: string, maxWidth: number, size = 10, bold = false): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.measure(next, size, bold) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Writes one line of text; `y` is the baseline from the top. */
  text(x: number, y: number, text: string, o: TextOptions = {}) {
    const size = o.size ?? 10;
    const bytes = encode(text);
    const w = (widthOf(bytes, o.bold ?? false) * size) / 1000;
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    const escaped = bytes
      .map((b) =>
        b === 0x28 || b === 0x29 || b === 0x5c
          ? `\\${String.fromCharCode(b)}`
          : b < 0x20 || b > 0x7e
            ? `\\${b.toString(8).padStart(3, '0')}`
            : String.fromCharCode(b),
      )
      .join('');
    this.ops.push(
      `BT ${color(o.color ?? [17, 24, 39])} rg /${o.bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${num(this.height - y)} Td (${escaped}) Tj ET`,
    );
    return w;
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; color?: Rgb } = {}) {
    this.ops.push(
      `${color(o.color ?? [209, 213, 219])} RG ${num(o.width ?? 0.75)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`,
    );
  }

  rect(x: number, y: number, w: number, h: number, o: { fill?: Rgb; stroke?: Rgb } = {}) {
    const box = `${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`;
    if (o.fill && o.stroke) {
      this.ops.push(`${color(o.fill)} rg ${color(o.stroke)} RG 0.75 w ${box} B`);
    } else if (o.fill) this.ops.push(`${color(o.fill)} rg ${box} f`);
    else this.ops.push(`${color(o.stroke ?? [209, 213, 219])} RG 0.75 w ${box} S`);
  }

  /** The finished file. */
  toBuffer(): Buffer {
    const objects: (string | Buffer)[] = [];
    const add = (body: string | Buffer) => objects.push(body);
    /** A stream object with binary data (a picture). */
    const binary = (dict: string, data: Buffer) =>
      Buffer.concat([
        Buffer.from(`${dict.replace(/ >>$/, '')} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]);
    const pageIds = this.pages.map((_, i) => 5 + i * 2);
    let nextId = 5 + this.pages.length * 2;
    const imageIds = this.images.map((img) => {
      const id = nextId;
      nextId += img.smask ? 2 : 1;
      return id;
    });
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
    );
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const [i, ops] of this.pages.entries()) {
      const contentId = pageIds[i]! + 1;
      const pictures = [...this.pageImages[i]!].map((k) => `/Im${k} ${imageIds[k]} 0 R`);
      const xObjects = pictures.length ? ` /XObject << ${pictures.join(' ')} >>` : '';
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xObjects} >> /Contents ${contentId} 0 R >>`,
      );
      const stream = ops.join('\n');
      add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    }
    for (const [k, img] of this.images.entries()) {
      const size = `/Width ${img.pixelsWide} /Height ${img.pixelsHigh} /BitsPerComponent 8`;
      add(
        binary(
          `<< /Type /XObject /Subtype /Image ${size} /ColorSpace /${img.colorSpace} /Filter /${img.filter}${
            img.decode ? ` /Decode [${img.decode}]` : ''
          }${img.smask ? ` /SMask ${imageIds[k]! + 1} 0 R` : ''} >>`,
          img.data,
        ),
      );
      if (img.smask) {
        add(
          binary(
            `<< /Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray /Filter /FlateDecode >>`,
            img.smask,
          ),
        );
      }
    }
    const info = objects.length + 1;
    add(`<< /Title (${this.title.replace(/[()\\]/g, '')}) /Producer (CampusOne) >>`);

    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let length = parts[0]!.length;
    const push = (b: Buffer) => {
      parts.push(b);
      length += b.length;
    };
    const offsets: number[] = [];
    for (const [i, body] of objects.entries()) {
      offsets.push(length);
      push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
      push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
      push(Buffer.from('\nendobj\n', 'latin1'));
    }
    const xref = length;
    let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`;
    tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    push(Buffer.from(tail, 'latin1'));
    return Buffer.concat(parts);
  }
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number) {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function belowThousand(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** An amount in words in the Indian system: "Rupees Two Lakh Twelve Thousand Four Hundred Only". */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 1_00_00_000);
  n %= 1_00_00_000;
  const lakh = Math.floor(n / 1_00_000);
  n %= 1_00_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  const words = parts.length ? parts.join(' ') : 'Zero';
  return `Rupees ${words}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}
