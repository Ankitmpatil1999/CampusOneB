import { inflateSync } from 'node:zlib';
import { admissionFormPdf, type FormView } from '../services/admission-form-pdf';
import { PdfDocument } from '../utils/pdf';
import { pdfImage, type PdfImage } from '../utils/pdf-image';
import { pngOf } from './png';

/** A JPEG's header as a camera writes it: an EXIF orientation, Adobe's marker, the frame size. */
function jpegOf(o: {
  width: number;
  height: number;
  comps?: number;
  orientation?: number;
  littleEndian?: boolean;
  adobe?: boolean;
}): Buffer {
  const seg = (marker: number, body: Buffer) => {
    const h = Buffer.from([0xff, marker, 0, 0]);
    h.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([h, body]);
  };
  const parts = [Buffer.from([0xff, 0xd8])];
  if (o.orientation) {
    const t = Buffer.alloc(8 + 2 + 12 + 4);
    const le = !!o.littleEndian;
    t.write(le ? 'II' : 'MM', 0, 'latin1');
    const u16 = (v: number, at: number) => (le ? t.writeUInt16LE(v, at) : t.writeUInt16BE(v, at));
    const u32 = (v: number, at: number) => (le ? t.writeUInt32LE(v, at) : t.writeUInt32BE(v, at));
    u16(42, 2);
    u32(8, 4);
    u16(1, 8);
    u16(0x0112, 10);
    u16(3, 12);
    u32(1, 14);
    u16(o.orientation, 18);
    parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t])));
  }
  if (o.adobe) parts.push(seg(0xee, Buffer.from('Adobe\0d\0\0\0\0\u0002', 'latin1')));
  const comps = o.comps ?? 3;
  const sof = Buffer.alloc(6 + 3 * comps);
  sof[0] = 8;
  sof.writeUInt16BE(o.height, 1);
  sof.writeUInt16BE(o.width, 3);
  sof[5] = comps;
  parts.push(seg(0xc0, sof), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

describe('pictures in generated PDFs (client 2026-10-14)', () => {
  it('reads a JPEG as it is, turned upright by its EXIF orientation', () => {
    const plain = jpegOf({ width: 400, height: 300 });
    expect(pdfImage(plain, 'image/jpeg')).toMatchObject({
      pixelsWide: 400,
      pixelsHigh: 300,
      colorSpace: 'DeviceRGB',
      filter: 'DCTDecode',
      data: plain,
      rotate: 0,
      width: 400,
      height: 300,
    });
    // A phone held upright: stored sideways, shown turned a quarter clockwise.
    expect(
      pdfImage(jpegOf({ width: 400, height: 300, orientation: 6 }), 'image/jpeg'),
    ).toMatchObject({ rotate: 90, width: 300, height: 400 });
    expect(
      pdfImage(
        jpegOf({ width: 400, height: 300, orientation: 8, littleEndian: true }),
        'image/jpeg',
      ),
    ).toMatchObject({ rotate: 270, width: 300, height: 400 });
    expect(pdfImage(jpegOf({ width: 4, height: 3, orientation: 3 }), 'image/jpeg')?.rotate).toBe(
      180,
    );
    expect(pdfImage(jpegOf({ width: 4, height: 3, comps: 1 }), 'image/jpeg')?.colorSpace).toBe(
      'DeviceGray',
    );
    expect(
      pdfImage(jpegOf({ width: 4, height: 3, comps: 4, adobe: true }), 'image/jpeg'),
    ).toMatchObject({ colorSpace: 'DeviceCMYK', decode: '1 0 1 0 1 0 1 0' });
  });

  it('decodes a PNG through every row filter, with its transparency as a soft mask', () => {
    const px = [
      [10, 20, 30, 255, 200, 100, 50, 128, 1, 2, 3, 0],
      [40, 50, 60, 255, 90, 80, 70, 255, 7, 8, 9, 64],
      [11, 12, 13, 1, 14, 15, 16, 2, 17, 18, 19, 3],
      [250, 240, 230, 220, 210, 200, 190, 180, 170, 160, 150, 140],
      [0, 0, 0, 0, 255, 255, 255, 255, 128, 128, 128, 128],
    ];
    const img = pdfImage(
      pngOf({ width: 3, height: 5, type: 6, rows: px, filters: [0, 1, 2, 3, 4] }),
      'image/png',
    )!;
    expect(img).toMatchObject({
      pixelsWide: 3,
      pixelsHigh: 5,
      colorSpace: 'DeviceRGB',
      filter: 'FlateDecode',
      rotate: 0,
    });
    const rgb = px.flatMap((r) => r.filter((_, i) => i % 4 !== 3));
    const alpha = px.flatMap((r) => r.filter((_, i) => i % 4 === 3));
    expect([...inflateSync(img.data)]).toEqual(rgb);
    expect([...inflateSync(img.smask!)]).toEqual(alpha);
  });

  it('reads palette, grey and 16-bit PNGs; an opaque one has no mask', () => {
    // Two bits a pixel: indexes 0, 1, 2 — the first see-through, the second half.
    const pal = pdfImage(
      pngOf({
        width: 3,
        height: 1,
        type: 3,
        depth: 2,
        rows: [[0b00011000]],
        palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
        trns: [0, 128],
      }),
      'image/png',
    )!;
    expect([...inflateSync(pal.data)]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    expect([...inflateSync(pal.smask!)]).toEqual([0, 128, 255]);

    const grey = pdfImage(
      pngOf({ width: 4, height: 1, type: 0, depth: 1, rows: [[0b10100000]] }),
      'image/png',
    )!;
    expect(grey.colorSpace).toBe('DeviceGray');
    expect([...inflateSync(grey.data)]).toEqual([255, 0, 255, 0]);
    expect(grey.smask).toBeUndefined();

    const deep = pdfImage(
      pngOf({ width: 1, height: 1, type: 2, depth: 16, rows: [[0x12, 0x34, 0xab, 0xcd, 0xff, 0]] }),
      'image/png',
    )!;
    expect([...inflateSync(deep.data)]).toEqual([0x12, 0xab, 0xff]);
    expect(deep.smask).toBeUndefined();
  });

  it('answers null for what it can’t read: the caller shows the name', () => {
    expect(pdfImage(Buffer.from('%PDF-1.4'), 'application/pdf')).toBeNull();
    expect(pdfImage(Buffer.from('not a picture'), 'image/png')).toBeNull();
    expect(pdfImage(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    const interlaced = pngOf({ width: 1, height: 1, type: 0, rows: [[7]], interlaced: true });
    expect(pdfImage(interlaced, 'image/png')).toBeNull();
  });

  it('draws a picture with the object offsets right around its binary data', () => {
    const doc = new PdfDocument('Pictures');
    const photo = pdfImage(jpegOf({ width: 400, height: 300, orientation: 6 }), 'image/jpeg')!;
    const logo = pdfImage(
      pngOf({ width: 1, height: 1, type: 6, rows: [[1, 2, 3, 4]] }),
      'image/png',
    ) as PdfImage;
    doc.text(48, 60, 'First page');
    doc.image(photo, 100, 100, 50, 80);
    doc.addPage();
    doc.image(logo, 48, 48, 20, 20);
    doc.image(photo, 48, 100, 50, 80);
    const out = doc.toBuffer();
    const pdf = out.toString('latin1');
    // Turned a quarter clockwise into its box.
    expect(pdf).toContain('q 0 -80 50 0 100 741.89 cm /Im0 Do Q');
    expect(pdf).toContain('q 20 0 0 20 48 773.89 cm /Im1 Do Q');
    // Each page names the pictures it draws; the PNG's soft mask is its own object.
    expect(pdf).toMatch(/\/XObject << \/Im0 9 0 R >>/);
    expect(pdf).toMatch(/\/XObject << \/Im1 10 0 R \/Im0 9 0 R >>/);
    expect(pdf).toContain('/Filter /DCTDecode /Length');
    expect(pdf).toContain('/SMask 11 0 R');
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(3);
    // The cross-reference table points at every object.
    const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    const entries = pdf
      .slice(xrefAt)
      .split('\n')
      .filter((l) => / 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    expect(entries).toHaveLength(12);
    for (const [i, at] of entries.entries()) {
      expect(pdf.slice(at, at + 12)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`));
    }
  });

  it('shows the attached pictures in the application form PDF, any other file by its name', () => {
    const view: FormView = {
      applicationNo: 'ADM/2026/0001',
      status: 'SUBMITTED',
      year: { label: '2026-27' },
      class: { name: 'Grade 1' },
      midTerm: false,
      joiningDate: null,
      midTermReason: null,
      student: {
        firstName: 'ANVI',
        middleName: null,
        lastName: 'RAO',
        gender: 'FEMALE',
        dob: null,
      },
      addresses: null,
      previous: null,
      parents: null,
      customFields: {},
      tc: null,
      references: [],
      documents: [
        { type: 'PHOTO', name: 'photo.png' },
        { type: 'BIRTH', name: 'birth-certificate.pdf' },
      ],
      fees: [],
      declaration: null,
      submittedAt: null,
    };
    const rows = Array.from({ length: 4 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const photo = pdfImage(pngOf({ width: 3, height: 4, type: 2, rows }), 'image/png')!;
    const pdf = admissionFormPdf(
      { name: 'Tunga Valley Public School' },
      view,
      [],
      new Date('2026-10-14T06:00:00Z'),
      new Map([['PHOTO', photo]]),
    ).toString('latin1');
    expect(pdf).toContain('photo.png');
    expect(pdf).toContain('birth-certificate.pdf');
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
    // Never enlarged: 3 × 4 pixels drawn 3 × 4 points.
    expect(pdf).toMatch(/q 3 0 0 4 210 [\d.]+ cm \/Im0 Do Q/);
  });
});
