/**
 * Pictures for the PDF writer (client 2026-10-14: the attachments in the application form PDF).
 * A JPEG goes in as it is (DCTDecode), turned upright by its EXIF orientation as a phone camera
 * records it; a PNG is decoded and compressed again (FlateDecode), its transparency kept as a soft
 * mask. Anything else — or a picture this can't read — answers null, and the caller shows the name.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface PdfImage {
  /** The stored pixels. */
  readonly pixelsWide: number;
  readonly pixelsHigh: number;
  readonly colorSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
  readonly filter: 'DCTDecode' | 'FlateDecode';
  readonly data: Buffer;
  /** An inverted CMYK JPEG (Adobe's) is read with this decode array. */
  readonly decode?: string;
  /** The transparency, 8-bit grey, flate-compressed. */
  readonly smask?: Buffer;
  /** Degrees clockwise to turn the stored pixels to show them upright. */
  readonly rotate: 0 | 90 | 180 | 270;
  /** Proportions as shown (after turning). */
  readonly width: number;
  readonly height: number;
}

/** A PNG larger than this many pixels is not decoded (its name is shown instead). */
const MAX_PIXELS = 30_000_000;

export function pdfImage(data: Buffer, mimeType: string): PdfImage | null {
  try {
    if (mimeType === 'image/jpeg') return jpeg(data);
    if (mimeType === 'image/png') return png(data);
  } catch {
    // Unreadable: the caller shows the name.
  }
  return null;
}

const shown = (
  w: number,
  h: number,
  rotate: PdfImage['rotate'],
): Pick<PdfImage, 'width' | 'height' | 'rotate'> =>
  rotate === 90 || rotate === 270
    ? { width: h, height: w, rotate }
    : { width: w, height: h, rotate };

// --- JPEG ---------------------------------------------------------------------------------------------

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Buffer): PdfImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let rotate: PdfImage['rotate'] = 0;
  let adobe = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = b.readUInt16BE(i + 2);
    const body = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1) rotate = exifRotation(body) ?? rotate;
    if (marker === 0xee && body.subarray(0, 5).toString('latin1') === 'Adobe') adobe = true;
    if (SOF.has(marker)) {
      const height = body.readUInt16BE(1);
      const width = body.readUInt16BE(3);
      const comps = body[5];
      if (body[0] !== 8 || !width || !height) return null;
      const colorSpace =
        comps === 1 ? 'DeviceGray' : comps === 3 ? 'DeviceRGB' : comps === 4 ? 'DeviceCMYK' : null;
      if (!colorSpace) return null;
      return {
        pixelsWide: width,
        pixelsHigh: height,
        colorSpace,
        filter: 'DCTDecode',
        data: b,
        ...(comps === 4 && adobe ? { decode: '1 0 1 0 1 0 1 0' } : {}),
        ...shown(width, height, rotate),
      };
    }
    i += 2 + len;
  }
  return null;
}

/** The turn an EXIF orientation asks for (a mirrored one is taken as its turn). */
function exifRotation(app1: Buffer): PdfImage['rotate'] | null {
  if (app1.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return null;
  const t = app1.subarray(6);
  const le = t.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) !== 0x0112) continue;
    const o = u16(e + 8);
    return o === 3 || o === 4 ? 180 : o === 5 || o === 6 ? 90 : o === 7 || o === 8 ? 270 : 0;
  }
  return null;
}

// --- PNG ----------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): PdfImage | null {
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let i = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlaced = false;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const name = b.subarray(i + 4, i + 8).toString('latin1');
    const body = b.subarray(i + 8, i + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlaced = body[12] === 1;
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    i += 12 + len;
  }
  // Adam7-interlaced pictures are rare from cameras and scanners; their name is shown instead.
  if (!width || !height || interlaced || width * height > MAX_PIXELS) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  if (type === 3 && !palette) return null;

  const bits = channels * depth;
  const bpp = Math.max(1, bits >> 3);
  const stride = Math.ceil((width * bits) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) return null;
  const rows = unfilter(raw, height, stride, bpp);

  // To 8-bit samples: grey, RGB (a palette's colours) and, where there is any, the alpha.
  const rgb = type === 2 || type === 6 || type === 3;
  const out = Buffer.alloc(width * height * (rgb ? 3 : 1));
  const alphaOn = type === 4 || type === 6 || (trns !== null && (type === 3 || type === 0));
  const alpha = alphaOn ? Buffer.alloc(width * height) : null;
  const sample = (row: Buffer, x: number, c: number): number => {
    if (depth === 8) return row[x * channels + c]!;
    if (depth === 16) return row[(x * channels + c) * 2]!;
    // 1, 2 or 4 bits: grey or a palette index (one channel).
    const per = 8 / depth;
    const byte = row[Math.floor(x / per)]!;
    const shift = 8 - depth * ((x % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const greyOf = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  const greyKey = type === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (type === 3) {
        const k = sample(row, x, 0);
        palette!.copy(out, p * 3, k * 3, k * 3 + 3);
        if (alpha) alpha[p] = k < trns!.length ? trns![k]! : 255;
      } else if (type === 0 || type === 4) {
        const raw0 = sample(row, x, 0);
        out[p] = greyOf(raw0);
        if (alpha) {
          if (type === 4) alpha[p] = sample(row, x, 1);
          else {
            const exact = depth === 16 ? row.readUInt16BE(x * 2) : raw0;
            alpha[p] = exact === greyKey ? 0 : 255;
          }
        }
      } else {
        out[p * 3] = sample(row, x, 0);
        out[p * 3 + 1] = sample(row, x, 1);
        out[p * 3 + 2] = sample(row, x, 2);
        if (alpha && type === 6) alpha[p] = sample(row, x, 3);
      }
    }
  }
  const opaque = !alpha || alpha.every((v) => v === 255);
  return {
    pixelsWide: width,
    pixelsHigh: height,
    colorSpace: rgb ? 'DeviceRGB' : 'DeviceGray',
    filter: 'FlateDecode',
    data: deflateSync(out),
    ...(opaque ? {} : { smask: deflateSync(alpha) }),
    ...shown(width, height, 0),
  };
}

/** Undoes the PNG row filters (None, Sub, Up, Average, Paeth). */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer[] {
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const f = raw[at]!;
    const row = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const up = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = up;
      else if (f === 3) add = (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) throw new Error('bad PNG filter');
      row[x] = (row[x]! + add) & 0xff;
    }
    rows.push(row);
    prev = row;
  }
  return rows;
}
