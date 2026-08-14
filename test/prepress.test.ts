import { describe, expect, it } from 'vitest';

import { POSTCARD_PRODUCTS } from '../src/config/constants';
import { readArtworkMetadata, sniffFormat } from '../src/modules/postcards/prepress';
import { evaluateArtwork, prepressSpecFor } from '../src/modules/postcards/prepress.rules';

/**
 * Pre-press parsing and rules.
 *
 * The fixtures are real file headers assembled byte by byte rather than mocks, because the whole
 * point of this module is that it reads actual bytes. A stubbed parser would test nothing.
 */

const PRODUCT = POSTCARD_PRODUCTS.find((p) => p.sku === '68')!; // 6" x 8.5"
const SPEC = prepressSpecFor(PRODUCT);

// ─── Fixture builders ───────────────────────────────────────────────────────────────────────

/** A real PNG header: signature, IHDR, and optionally pHYs. */
function png(width: number, height: number, opts: { dpi?: number; grayscale?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];

  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(opts.grayscale ? 0 : 6, 17); // 0 = grayscale, 6 = RGBA
  chunks.push(ihdr);

  if (opts.dpi) {
    const phys = Buffer.alloc(21);
    phys.writeUInt32BE(9, 0);
    phys.write('pHYs', 4);
    const ppm = Math.round(opts.dpi / 0.0254);
    phys.writeUInt32BE(ppm, 8);
    phys.writeUInt32BE(ppm, 12);
    phys.writeUInt8(1, 16); // unit = metres
    chunks.push(phys);
  }

  const idat = Buffer.alloc(12);
  idat.writeUInt32BE(0, 0);
  idat.write('IDAT', 4);
  chunks.push(idat);

  return Buffer.concat(chunks);
}

/** A real JPEG header: SOI, optional JFIF APP0, then an SOF0 frame. */
function jpeg(
  width: number,
  height: number,
  opts: { dpi?: number; components?: number } = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (opts.dpi) {
    const app0 = Buffer.alloc(20);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    app0.write('JFIF\0', 4, 'latin1');
    app0.writeUInt8(1, 9); // major
    app0.writeUInt8(2, 10); // minor
    app0.writeUInt8(1, 11); // units = DPI
    app0.writeUInt16BE(opts.dpi, 12);
    app0.writeUInt16BE(opts.dpi, 14);
    parts.push(app0.subarray(0, 18));
  }

  const components = opts.components ?? 3;
  const sof = Buffer.alloc(4 + 6);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + components * 3, 2);
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(components, 9);
  parts.push(sof);

  return Buffer.concat(parts);
}

/** A minimal PDF whose MediaBox is the given size in inches. */
function pdf(widthIn: number, heightIn: number, boxName = 'MediaBox'): Buffer {
  const w = (widthIn * 72).toFixed(2);
  const h = (heightIn * 72).toFixed(2);
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /${boxName} [0 0 ${w} ${h}] >>\nendobj\n`,
    'latin1',
  );
}

// ─── Format sniffing ────────────────────────────────────────────────────────────────────────

describe('prepress — format is decided by bytes, never by what the client claims', () => {
  it('recognises the three accepted formats', () => {
    expect(sniffFormat(png(100, 100))).toBe('png');
    expect(sniffFormat(jpeg(100, 100))).toBe('jpeg');
    expect(sniffFormat(pdf(6, 8.5))).toBe('pdf');
  });

  it('rejects an HTML document dressed as an image', () => {
    // The classic stored-XSS upload: content-type says image/png, bytes say otherwise.
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    expect(sniffFormat(html)).toBeNull();
    expect(readArtworkMetadata(html)).toBeNull();
  });

  it('rejects SVG, which is an executable document rather than a picture', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    expect(sniffFormat(svg)).toBeNull();
  });

  it('returns null rather than throwing on truncated or garbage input', () => {
    // A corrupt upload is a message for the buyer, not a 500.
    expect(readArtworkMetadata(Buffer.alloc(0))).toBeNull();
    expect(readArtworkMetadata(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(readArtworkMetadata(png(100, 100).subarray(0, 12))).toBeNull();
  });
});

// ─── Metadata parsing ───────────────────────────────────────────────────────────────────────

describe('prepress — metadata parsing', () => {
  it('reads PNG dimensions, resolution and colour space', () => {
    const meta = readArtworkMetadata(png(1875, 2588, { dpi: 300 }))!;
    expect(meta.format).toBe('png');
    expect(meta.widthPx).toBe(1875);
    expect(meta.heightPx).toBe(2588);
    expect(meta.dpiX).toBe(300);
    expect(meta.colorSpace).toBe('rgb');
  });

  it('reports PNG greyscale, and never claims a PNG is CMYK', () => {
    // PNG cannot express CMYK at all, so saying so would be a lie about the format.
    const meta = readArtworkMetadata(png(100, 100, { grayscale: true }))!;
    expect(meta.colorSpace).toBe('grayscale');
  });

  it('handles a PNG with no pHYs chunk', () => {
    const meta = readArtworkMetadata(png(1875, 2588))!;
    expect(meta.widthPx).toBe(1875);
    // Untagged resolution is normal and not an error — effective DPI is what matters.
    expect(meta.dpiX).toBeNull();
  });

  it('reads JPEG dimensions and detects CMYK from the component count', () => {
    const rgb = readArtworkMetadata(jpeg(1875, 2588, { dpi: 300, components: 3 }))!;
    expect(rgb.widthPx).toBe(1875);
    expect(rgb.heightPx).toBe(2588);
    expect(rgb.dpiX).toBe(300);
    expect(rgb.colorSpace).toBe('rgb');

    // Four components is the only way to know a JPEG is press-ready CMYK.
    const cmyk = readArtworkMetadata(jpeg(1875, 2588, { components: 4 }))!;
    expect(cmyk.colorSpace).toBe('cmyk');
  });

  it('reads a PDF page size in inches, preferring TrimBox over MediaBox', () => {
    const media = readArtworkMetadata(pdf(6.25, 8.75))!;
    expect(media.widthIn).toBeCloseTo(6.25, 2);
    expect(media.heightIn).toBeCloseTo(8.75, 2);

    // A file prepared with bleed has a MediaBox bigger than the finished piece; TrimBox is the
    // finished size, so comparing MediaBox against trim would fail good artwork.
    const trimmed = readArtworkMetadata(pdf(6, 8.5, 'TrimBox'))!;
    expect(trimmed.widthIn).toBeCloseTo(6, 2);
  });
});

// ─── Rules ──────────────────────────────────────────────────────────────────────────────────

describe('prepress — the spec is derived, never hardcoded', () => {
  it('computes bleed, full size and required pixels from the product', () => {
    // 6 x 8.5 trim + 0.125" bleed each edge = 6.25 x 8.75, at 300 DPI = 1875 x 2625.
    expect(SPEC.fullWidthIn).toBeCloseTo(6.25, 3);
    expect(SPEC.fullHeightIn).toBeCloseTo(8.75, 3);
    expect(SPEC.recommendedWidthPx).toBe(1875);
    expect(SPEC.recommendedHeightPx).toBe(2625);
    expect(SPEC.minimumWidthPx).toBe(1250); // 6.25" at the 200 DPI floor
  });
});

describe('prepress — raster verdicts', () => {
  it('passes artwork at the recommended size', () => {
    const v = evaluateArtwork(readArtworkMetadata(jpeg(1875, 2625, { components: 4 }))!, SPEC);
    expect(v.passed).toBe(true);
    expect(v.errors).toHaveLength(0);
    expect(v.effectiveDpi).toBe(300);
  });

  it('BLOCKS artwork that would print blurry, and says so without jargon', () => {
    const v = evaluateArtwork(readArtworkMetadata(jpeg(600, 840))!, SPEC);
    expect(v.passed).toBe(false);

    const message = v.errors[0]!.message;
    expect(v.errors[0]!.code).toBe('too_low_resolution');
    // Written for a food-truck owner: what is wrong, and what to do about it.
    expect(message).toMatch(/blurry/i);
    expect(message).toMatch(/1250/); // the number they need to beat
    expect(message).not.toMatch(/DPI|resolution|bleed/i);
  });

  it('WARNS but allows artwork between the floor and the target', () => {
    // 250 DPI prints acceptably. Blocking it would be the platform overruling the buyer.
    const v = evaluateArtwork(readArtworkMetadata(jpeg(1563, 2188))!, SPEC);
    expect(v.passed).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('below_target_resolution');
  });

  it('ignores the embedded DPI tag and uses effective resolution', () => {
    /**
     * The heart of the rule. A file tagged 72 DPI with enough pixels prints beautifully; one tagged
     * 300 DPI with too few does not. Trusting the tag would reject the first and pass the second.
     */
    const bigButTagged72 = evaluateArtwork(
      readArtworkMetadata(jpeg(1875, 2625, { dpi: 72 }))!,
      SPEC,
    );
    expect(bigButTagged72.passed).toBe(true);

    const smallButTagged300 = evaluateArtwork(
      readArtworkMetadata(jpeg(400, 560, { dpi: 300 }))!,
      SPEC,
    );
    expect(smallButTagged300.passed).toBe(false);
  });

  it('accepts a rotated file — orientation is not a size error', () => {
    const landscape = evaluateArtwork(readArtworkMetadata(jpeg(2625, 1875))!, SPEC);
    expect(landscape.passed).toBe(true);
    expect(landscape.warnings.map((w) => w.code)).not.toContain('aspect_mismatch');
  });

  it('warns about cropping when the shape is wrong', () => {
    const square = evaluateArtwork(readArtworkMetadata(jpeg(2625, 2625))!, SPEC);
    expect(square.warnings.map((w) => w.code)).toContain('aspect_mismatch');
    // A wrong shape crops; it does not stop the press.
    expect(square.passed).toBe(true);
  });

  it('warns about RGB without blocking it', () => {
    // Presses want CMYK, but blocking RGB would reject most files a small business produces.
    const v = evaluateArtwork(readArtworkMetadata(jpeg(1875, 2625, { components: 3 }))!, SPEC);
    expect(v.passed).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('rgb_colour');

    const cmyk = evaluateArtwork(readArtworkMetadata(jpeg(1875, 2625, { components: 4 }))!, SPEC);
    expect(cmyk.warnings.map((w) => w.code)).not.toContain('rgb_colour');
  });
});

describe('prepress — PDF verdicts', () => {
  it('accepts the finished size and the bleed size, warning only about the former', () => {
    const withBleed = evaluateArtwork(readArtworkMetadata(pdf(6.25, 8.75))!, SPEC);
    expect(withBleed.passed).toBe(true);
    expect(withBleed.warnings).toHaveLength(0);

    // Exporting at trim is not a mistake — the vendor can add bleed — but it is worth flagging.
    const trimOnly = evaluateArtwork(readArtworkMetadata(pdf(6, 8.5))!, SPEC);
    expect(trimOnly.passed).toBe(true);
    expect(trimOnly.warnings.map((w) => w.code)).toContain('no_bleed');
  });

  it('blocks a PDF that is the wrong size and states both acceptable sizes', () => {
    const letter = evaluateArtwork(readArtworkMetadata(pdf(8.5, 11))!, SPEC);
    expect(letter.passed).toBe(false);
    expect(letter.errors[0]!.code).toBe('wrong_page_size');
    expect(letter.errors[0]!.message).toMatch(/6" × 8\.5"/);
  });

  it('never fails a PDF for resolution, because vector artwork has none', () => {
    const v = evaluateArtwork(readArtworkMetadata(pdf(6.25, 8.75))!, SPEC);
    expect(v.effectiveDpi).toBeNull();
    expect(v.errors.map((e) => e.code)).not.toContain('too_low_resolution');
  });
});
