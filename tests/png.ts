import { crc32, deflateSync } from 'node:zlib';

/** A PNG row filter: None, Sub, Up, Average or Paeth. */
export type PngFilter = 0 | 1 | 2 | 3 | 4;

/**
 * A PNG for the tests, written the way an encoder does: IHDR, PLTE and tRNS when given, the rows
 * filtered (one filter per row, cycling through `filters`) and deflated into IDAT, then IEND.
 */
export function pngOf(o: {
  width: number;
  height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA. */
  type: 0 | 2 | 3 | 4 | 6;
  depth?: number;
  /** The rows, unfiltered, packed as the PNG stores them. */
  rows: readonly (readonly number[])[];
  palette?: readonly number[];
  trns?: readonly number[];
  filters?: readonly PngFilter[];
  interlaced?: boolean;
}): Buffer {
  const depth = o.depth ?? 8;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.type];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const filters = o.filters ?? [0];
  const chunk = (name: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(name, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = depth;
  ihdr[9] = o.type;
  ihdr[12] = o.interlaced ? 1 : 0;
  const out: number[] = [];
  let prev: readonly number[] = o.rows[0]!.map(() => 0);
  for (const [y, row] of o.rows.entries()) {
    const f = filters[y % filters.length]!;
    out.push(f);
    for (let x = 0; x < row.length; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const up = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      const p = a + up - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - up) <= Math.abs(p - c)
            ? up
            : c;
      const pred = [0, a, up, (a + up) >> 1, paeth][f]!;
      out.push((row[x]! - pred) & 0xff);
    }
    prev = row;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(o.palette ? [chunk('PLTE', Buffer.from(o.palette))] : []),
    ...(o.trns ? [chunk('tRNS', Buffer.from(o.trns))] : []),
    chunk('IDAT', deflateSync(Buffer.from(out))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
