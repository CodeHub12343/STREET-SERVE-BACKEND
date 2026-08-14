/**
 * ═══ PRE-PRESS INSPECTION (NF-2) ═══
 *
 * Reads what a print vendor cares about straight out of a file's header: real format, pixel
 * dimensions, embedded resolution, and colour space.
 *
 * ## Why this parses bytes instead of importing an image library
 *
 * The job is to read a few dozen header bytes. `sharp` is the usual answer and it is a ~30 MB
 * native dependency with its own toolchain, added to a Windows dev box and a CI image, to avoid
 * roughly two hundred lines of well-specified parsing. The formats here are stable and decades old;
 * the trade did not look close.
 *
 * ## The security half
 *
 * Format is decided by MAGIC BYTES, never by the declared content type or the file extension. Both
 * are attacker-controlled: a `.png` that is actually an HTML document is the classic stored-XSS
 * upload, and `image/jpeg` on a PDF would sail through a naive check. Anything that is not
 * recognisably JPEG, PNG or PDF is rejected without further inspection.
 *
 * **SVG is deliberately not supported** even though it is a fine print format, because it is an
 * executable document: scripts, external entities, and remote fetches. Accepting it would mean
 * sanitising XML, and there is nothing a buyer can do in SVG that they cannot do in a PDF.
 */

export type ArtworkFormat = 'jpeg' | 'png' | 'pdf';
export type ColorSpace = 'rgb' | 'cmyk' | 'grayscale' | 'unknown';

export interface ArtworkMetadata {
  format: ArtworkFormat;
  /** Raster pixel dimensions. Null for PDF, which is vector and has none. */
  widthPx: number | null;
  heightPx: number | null;
  /** Physical size in inches when the file states one (PDF always; raster only if tagged). */
  widthIn: number | null;
  heightIn: number | null;
  /** Embedded resolution. Null when the file carries none — common and not itself an error. */
  dpiX: number | null;
  dpiY: number | null;
  colorSpace: ColorSpace;
}

/** How many header bytes are worth fetching. Enough for a JFIF/Adobe marker run and a PDF header. */
export const PREPRESS_HEADER_BYTES = 256 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffFormat(buf: Buffer): ArtworkFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

/**
 * Parses header metadata, or returns null when the bytes are not a format we accept.
 *
 * Never throws on malformed input: a truncated or corrupt file is a validation result to explain to
 * the buyer, not an exception to surface as a 500.
 */
export function readArtworkMetadata(buf: Buffer): ArtworkMetadata | null {
  const format = sniffFormat(buf);
  if (!format) return null;
  try {
    if (format === 'png') return readPng(buf);
    if (format === 'jpeg') return readJpeg(buf);
    return readPdf(buf);
  } catch {
    return null;
  }
}

// ─── PNG ────────────────────────────────────────────────────────────────────────────────────
/**
 * IHDR is always the first chunk and carries dimensions plus colour type. `pHYs`, when present,
 * gives pixels per unit; unit 1 is metres, which is the only defined value.
 *
 * PNG has no CMYK colour type at all — the format simply cannot express it. That is reported
 * honestly as `rgb`/`grayscale` rather than `unknown`, because it is a fact about the format.
 */
function readPng(buf: Buffer): ArtworkMetadata {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const colorType = buf.readUInt8(25);
  const colorSpace: ColorSpace = colorType === 0 || colorType === 4 ? 'grayscale' : 'rgb';

  let dpiX: number | null = null;
  let dpiY: number | null = null;

  // Walk the chunk list looking for pHYs. Bounded by the buffer, so a corrupt length cannot loop.
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'pHYs' && offset + 8 + 9 <= buf.length) {
      const ppuX = buf.readUInt32BE(offset + 8);
      const ppuY = buf.readUInt32BE(offset + 12);
      const unit = buf.readUInt8(offset + 16);
      if (unit === 1) {
        // pixels per metre → per inch
        dpiX = Math.round(ppuX * 0.0254);
        dpiY = Math.round(ppuY * 0.0254);
      }
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break; // pixel data begins; no pHYs present
    offset += 12 + length; // length + type + data + CRC
    if (length < 0 || offset <= 0) break;
  }

  return {
    format: 'png',
    widthPx: width,
    heightPx: height,
    widthIn: dpiX ? width / dpiX : null,
    heightIn: dpiY ? height / dpiY : null,
    dpiX,
    dpiY,
    colorSpace,
  };
}

// ─── JPEG ───────────────────────────────────────────────────────────────────────────────────
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Walks the marker segments for a Start-Of-Frame (dimensions and component count) and a JFIF APP0
 * (pixel density).
 *
 * Component count is how colour space is determined: 1 is grayscale, 3 is YCbCr (i.e. RGB), 4 is
 * CMYK. That matters here because CMYK is what a press wants, and telling a buyer their file is RGB
 * is only possible if we actually looked.
 */
function readJpeg(buf: Buffer): ArtworkMetadata {
  let offset = 2; // past SOI
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  let components: number | null = null;
  let dpiX: number | null = null;
  let dpiY: number | null = null;

  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++; // resynchronise across padding rather than giving up
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // scan data / end — nothing more in the header

    const length = buf.readUInt16BE(offset + 2);
    const segment = offset + 4;

    if (marker === 0xe0 && buf.subarray(segment, segment + 5).toString('latin1') === 'JFIF\0') {
      const units = buf.readUInt8(segment + 7);
      const xDensity = buf.readUInt16BE(segment + 8);
      const yDensity = buf.readUInt16BE(segment + 10);
      // 1 = pixels per inch, 2 = pixels per cm, 0 = aspect ratio only (no physical meaning)
      if (units === 1 && xDensity > 0) {
        dpiX = xDensity;
        dpiY = yDensity || xDensity;
      } else if (units === 2 && xDensity > 0) {
        dpiX = Math.round(xDensity * 2.54);
        dpiY = Math.round((yDensity || xDensity) * 2.54);
      }
    }

    if (SOF_MARKERS.has(marker) && segment + 6 <= buf.length) {
      heightPx = buf.readUInt16BE(segment + 1);
      widthPx = buf.readUInt16BE(segment + 3);
      components = buf.readUInt8(segment + 5);
      // Dimensions are all we need; densities always precede the frame in practice.
      if (dpiX !== null) break;
    }

    if (length < 2) break; // malformed: a segment cannot be shorter than its own length field
    offset += 2 + length;
  }

  const colorSpace: ColorSpace =
    components === 4 ? 'cmyk' : components === 1 ? 'grayscale' : components === 3 ? 'rgb' : 'unknown';

  return {
    format: 'jpeg',
    widthPx,
    heightPx,
    widthIn: widthPx && dpiX ? widthPx / dpiX : null,
    heightIn: heightPx && dpiY ? heightPx / dpiY : null,
    dpiX,
    dpiY,
    colorSpace,
  };
}

// ─── PDF ────────────────────────────────────────────────────────────────────────────────────
/**
 * Reads the first MediaBox to get the page size in points (1/72 inch).
 *
 * A PDF is vector, so resolution is not a property of the file the way it is for a raster — a
 * correctly sized PDF is press-ready whatever it contains. Colour space is left `unknown` rather
 * than guessed: it lives per-object inside the content stream, and answering it properly means
 * parsing the document, not the header.
 *
 * `TrimBox`/`BleedBox` are preferred when present, because a file prepared with bleed reports a
 * MediaBox larger than the finished piece and comparing that against trim would fail good artwork.
 */
function readPdf(buf: Buffer): ArtworkMetadata {
  const text = buf.toString('latin1');
  const box = findBox(text, 'TrimBox') ?? findBox(text, 'MediaBox');
  if (!box) {
    return {
      format: 'pdf',
      widthPx: null,
      heightPx: null,
      widthIn: null,
      heightIn: null,
      dpiX: null,
      dpiY: null,
      colorSpace: 'unknown',
    };
  }
  const [x0, y0, x1, y1] = box;
  return {
    format: 'pdf',
    widthPx: null,
    heightPx: null,
    widthIn: Math.abs(x1 - x0) / 72,
    heightIn: Math.abs(y1 - y0) / 72,
    dpiX: null,
    dpiY: null,
    colorSpace: 'unknown',
  };
}

function findBox(text: string, name: string): [number, number, number, number] | null {
  const match = new RegExp(`/${name}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`).exec(
    text,
  );
  if (!match) return null;
  const nums = match.slice(1, 5).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums as [number, number, number, number];
}
