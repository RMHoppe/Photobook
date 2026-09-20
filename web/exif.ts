// exif.ts — Minimal EXIF reader: capture timestamp + GPS position only.
//
// Handles JPEG (APP1 "Exif" segment) and PNG (eXIf chunk). Reads just the
// file head so opening a 30 MB photo doesn't pull it fully into memory.
// Anything unparseable yields an empty result — never throws.

export interface ExifInfo {
  /** Capture time (DateTimeOriginal, falling back to DateTime), local time. */
  timestamp: Date | null;
  /** True when `timestamp` is the file's modification time, not an EXIF date. */
  timestampIsFileTime?: boolean;
  /** WGS-84 decimal degrees; null when the file has no GPS tags. */
  location: { lat: number; lon: number } | null;
}

const EMPTY: ExifInfo = { timestamp: null, location: null };
/** EXIF must sit near the file start; 512 KB covers even large maker notes. */
const HEAD_BYTES = 512 * 1024;

export async function readExif(file: Blob): Promise<ExifInfo> {
  try {
    const buf  = await file.slice(0, HEAD_BYTES).arrayBuffer();
    const tiff = findTiffBlock(new DataView(buf));
    return tiff ? parseTiff(tiff) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Locate the embedded TIFF structure (starting at the byte-order mark). */
function findTiffBlock(dv: DataView): DataView | null {
  if (dv.byteLength < 8) return null;
  // JPEG: FF D8, then segments FF xx [len16 big-endian] ...
  if (dv.getUint16(0) === 0xFFD8) {
    let pos = 2;
    while (pos + 4 <= dv.byteLength) {
      if (dv.getUint8(pos) !== 0xFF) return null;
      const marker = dv.getUint8(pos + 1);
      if (marker === 0xDA || marker === 0xD9) return null;         // SOS / EOI — no EXIF ahead
      const len = dv.getUint16(pos + 2);
      if (marker === 0xE1 && pos + 10 <= dv.byteLength && readAscii(dv, pos + 4, 4) === 'Exif') {
        const start = pos + 10;
        const end   = Math.min(pos + 2 + len, dv.byteLength);
        return new DataView(dv.buffer, dv.byteOffset + start, end - start);
      }
      pos += 2 + len;
    }
    return null;
  }
  // PNG: 8-byte signature, then chunks [len32][type4][data][crc4]
  if (dv.getUint32(0) === 0x89504E47) {
    let pos = 8;
    while (pos + 8 <= dv.byteLength) {
      const len  = dv.getUint32(pos);
      const type = readAscii(dv, pos + 4, 4);
      if (type === 'eXIf') {
        const end = Math.min(pos + 8 + len, dv.byteLength);
        return new DataView(dv.buffer, dv.byteOffset + pos + 8, end - pos - 8);
      }
      if (type === 'IDAT' || type === 'IEND') return null;
      pos += 12 + len;
    }
  }
  return null;
}

function readAscii(dv: DataView, off: number, n: number): string {
  let s = '';
  for (let i = 0; i < n && off + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

const TAG_DATETIME          = 0x0132;
const TAG_EXIF_IFD          = 0x8769;
const TAG_GPS_IFD           = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const GPS_LAT_REF = 0x0001, GPS_LAT = 0x0002, GPS_LON_REF = 0x0003, GPS_LON = 0x0004;

interface Entry { type: number; count: number; valueOff: number }

function parseTiff(dv: DataView): ExifInfo {
  const bom = dv.getUint16(0);
  const le  = bom === 0x4949;
  if (!le && bom !== 0x4D4D) return EMPTY;
  if (dv.getUint16(2, le) !== 42) return EMPTY;

  const readIfd = (off: number): Map<number, Entry> => {
    const entries = new Map<number, Entry>();
    if (off <= 0 || off + 2 > dv.byteLength) return entries;
    const n = dv.getUint16(off, le);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      entries.set(dv.getUint16(e, le), {
        type:     dv.getUint16(e + 2, le),
        count:    dv.getUint32(e + 4, le),
        valueOff: e + 8,
      });
    }
    return entries;
  };
  // Values ≤ 4 bytes are stored inline; larger ones via offset from TIFF start.
  const dataOff = (en: Entry, size: number): number =>
    size * en.count <= 4 ? en.valueOff : dv.getUint32(en.valueOff, le);

  const ascii = (en: Entry | undefined): string | null => {
    if (!en || en.type !== 2) return null;
    const off = dataOff(en, 1);
    if (off + en.count > dv.byteLength) return null;
    return readAscii(dv, off, en.count).replace(/\0+$/, '');
  };
  const rationals = (en: Entry | undefined): number[] | null => {
    if (!en || en.type !== 5) return null;
    const off = dataOff(en, 8);
    if (off + en.count * 8 > dv.byteLength) return null;
    const out: number[] = [];
    for (let i = 0; i < en.count; i++) {
      const num = dv.getUint32(off + i * 8, le), den = dv.getUint32(off + i * 8 + 4, le);
      out.push(den === 0 ? 0 : num / den);
    }
    return out;
  };
  const subIfd = (en: Entry | undefined): Map<number, Entry> =>
    en && (en.type === 4 || en.type === 13) ? readIfd(dv.getUint32(en.valueOff, le)) : new Map();

  const ifd0 = readIfd(dv.getUint32(4, le));
  const exif = subIfd(ifd0.get(TAG_EXIF_IFD));
  const gps  = subIfd(ifd0.get(TAG_GPS_IFD));

  const timestamp = parseExifDate(ascii(exif.get(TAG_DATETIME_ORIGINAL)) ?? ascii(ifd0.get(TAG_DATETIME)));

  let location: ExifInfo['location'] = null;
  const lat = rationals(gps.get(GPS_LAT)), lon = rationals(gps.get(GPS_LON));
  if (lat && lon && lat.length >= 3 && lon.length >= 3) {
    let latD = lat[0] + lat[1] / 60 + lat[2] / 3600;
    let lonD = lon[0] + lon[1] / 60 + lon[2] / 3600;
    if ((ascii(gps.get(GPS_LAT_REF)) ?? 'N').toUpperCase().startsWith('S')) latD = -latD;
    if ((ascii(gps.get(GPS_LON_REF)) ?? 'E').toUpperCase().startsWith('W')) lonD = -lonD;
    if (Number.isFinite(latD) && Number.isFinite(lonD) && (latD !== 0 || lonD !== 0)) {
      location = { lat: latD, lon: lonD };
    }
  }
  return { timestamp, location };
}

/** EXIF dates are "YYYY:MM:DD HH:MM:SS" with no zone — treat as local time. */
function parseExifDate(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) || +m[1] < 1900 ? null : d;
}
