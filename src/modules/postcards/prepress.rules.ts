import {
  POSTCARD_ASPECT_TOLERANCE,
  POSTCARD_BLEED_IN,
  POSTCARD_MIN_DPI,
  POSTCARD_SAFE_AREA_IN,
  POSTCARD_TARGET_DPI,
  type PostcardProduct,
} from '../../config/constants';
import type { ArtworkMetadata } from './prepress';

/**
 * Turning file metadata into a verdict a human can act on.
 *
 * ## The rule about wording
 *
 * Every message here is written for a food-truck owner, not a prepress operator. "Insufficient DPI"
 * tells someone nothing they can do; "this will look blurry when printed — the image is 900 pixels
 * wide but needs about 1,875" tells them to go back and export bigger. Buyers do not know what
 * bleed is, and it is not their job to.
 *
 * ## Errors versus warnings
 *
 * An ERROR blocks the order. A WARNING is shown and can be accepted. The split is not cosmetic: a
 * blocked upload is the platform overruling a buyer, so it is reserved for files that will
 * genuinely print badly or that the vendor will reject outright. Anything arguable — a slightly
 * soft image, an RGB file the press can convert — is the buyer's call to make with their eyes open.
 */

export interface PrepressSpec {
  /** Finished size. */
  trimWidthIn: number;
  trimHeightIn: number;
  /** Trim plus bleed on all four edges — the size artwork should actually be. */
  fullWidthIn: number;
  fullHeightIn: number;
  bleedIn: number;
  safeAreaIn: number;
  targetDpi: number;
  minDpi: number;
  /** Pixel dimensions that hit the target resolution at full size. */
  recommendedWidthPx: number;
  recommendedHeightPx: number;
  minimumWidthPx: number;
  minimumHeightPx: number;
  acceptedFormats: readonly string[];
}

export const ACCEPTED_ARTWORK_FORMATS = ['jpeg', 'png', 'pdf'] as const;

/** The exact requirements for a product — also what the buyer-facing spec endpoint returns. */
export function prepressSpecFor(product: PostcardProduct): PrepressSpec {
  const fullWidthIn = product.widthIn + POSTCARD_BLEED_IN * 2;
  const fullHeightIn = product.heightIn + POSTCARD_BLEED_IN * 2;
  return {
    trimWidthIn: product.widthIn,
    trimHeightIn: product.heightIn,
    fullWidthIn,
    fullHeightIn,
    bleedIn: POSTCARD_BLEED_IN,
    safeAreaIn: POSTCARD_SAFE_AREA_IN,
    targetDpi: POSTCARD_TARGET_DPI,
    minDpi: POSTCARD_MIN_DPI,
    recommendedWidthPx: Math.ceil(fullWidthIn * POSTCARD_TARGET_DPI),
    recommendedHeightPx: Math.ceil(fullHeightIn * POSTCARD_TARGET_DPI),
    minimumWidthPx: Math.ceil(fullWidthIn * POSTCARD_MIN_DPI),
    minimumHeightPx: Math.ceil(fullHeightIn * POSTCARD_MIN_DPI),
    acceptedFormats: ACCEPTED_ARTWORK_FORMATS,
  };
}

export interface PrepressFinding {
  code: string;
  message: string;
}

export interface PrepressVerdict {
  passed: boolean;
  errors: PrepressFinding[];
  warnings: PrepressFinding[];
  /** Effective resolution once the image is scaled to the printed size. The number that matters. */
  effectiveDpi: number | null;
}

/**
 * Checks artwork against a product.
 *
 * The central idea: **embedded DPI is nearly meaningless, effective DPI is what prints.** A file
 * tagged 72 DPI with 2,000 pixels across prints beautifully on a 6" card; one tagged 300 DPI with
 * 400 pixels does not. So resolution is derived from pixel count over the printed size, and the
 * tag is ignored except as a fallback for working out what size the designer intended.
 */
export function evaluateArtwork(meta: ArtworkMetadata, spec: PrepressSpec): PrepressVerdict {
  const errors: PrepressFinding[] = [];
  const warnings: PrepressFinding[] = [];

  if (meta.format === 'pdf') {
    return evaluatePdf(meta, spec);
  }

  const { widthPx, heightPx } = meta;
  if (!widthPx || !heightPx) {
    errors.push({
      code: 'unreadable',
      message: 'We could not read this image. Try exporting it again as a JPG, PNG or PDF.',
    });
    return { passed: false, errors, warnings, effectiveDpi: null };
  }

  // Orientation-agnostic: a landscape file for a portrait card is a rotation, not a wrong size.
  const longEdgePx = Math.max(widthPx, heightPx);
  const shortEdgePx = Math.min(widthPx, heightPx);
  const longEdgeIn = Math.max(spec.fullWidthIn, spec.fullHeightIn);
  const shortEdgeIn = Math.min(spec.fullWidthIn, spec.fullHeightIn);

  const effectiveDpi = Math.floor(Math.min(longEdgePx / longEdgeIn, shortEdgePx / shortEdgeIn));

  if (effectiveDpi < spec.minDpi) {
    errors.push({
      code: 'too_low_resolution',
      message:
        `This image will look blurry when printed. It is ${widthPx} × ${heightPx} pixels, ` +
        `and a ${spec.trimWidthIn}" × ${spec.trimHeightIn}" postcard needs at least ` +
        `${spec.minimumWidthPx} × ${spec.minimumHeightPx}. Export it again at a larger size — ` +
        'enlarging the file you have will not add detail.',
    });
  } else if (effectiveDpi < spec.targetDpi) {
    warnings.push({
      code: 'below_target_resolution',
      message:
        `This will print acceptably but not sharply. For the crispest result, export at ` +
        `${spec.recommendedWidthPx} × ${spec.recommendedHeightPx} pixels or larger.`,
    });
  }

  const aspect = longEdgePx / shortEdgePx;
  const wantedAspect = longEdgeIn / shortEdgeIn;
  if (Math.abs(aspect - wantedAspect) / wantedAspect > POSTCARD_ASPECT_TOLERANCE) {
    warnings.push({
      code: 'aspect_mismatch',
      message:
        `This image is not quite the shape of a ${spec.trimWidthIn}" × ${spec.trimHeightIn}" ` +
        'postcard, so some of it will be cropped. Check that nothing important sits near the edges.',
    });
  }

  if (meta.colorSpace === 'rgb') {
    /**
     * A warning, not an error. Presses want CMYK and the vendor converts RGB, but the conversion
     * shifts bright colours — so the buyer should know, and should still be allowed to proceed.
     * Blocking here would reject the majority of files real small businesses produce.
     */
    warnings.push({
      code: 'rgb_colour',
      message:
        'This image uses screen colours (RGB). It will be converted for printing, which can make ' +
        'very bright colours look slightly duller on paper.',
    });
  }

  return { passed: errors.length === 0, errors, warnings, effectiveDpi };
}

/**
 * PDFs are checked on physical size only.
 *
 * Vector artwork has no resolution to fall short of, and any raster images placed inside it are
 * beyond a header parse. A correctly sized PDF is the best thing a buyer can send.
 */
function evaluatePdf(meta: ArtworkMetadata, spec: PrepressSpec): PrepressVerdict {
  const errors: PrepressFinding[] = [];
  const warnings: PrepressFinding[] = [];

  if (!meta.widthIn || !meta.heightIn) {
    errors.push({
      code: 'unreadable',
      message: 'We could not read the page size of this PDF. Try exporting it again.',
    });
    return { passed: false, errors, warnings, effectiveDpi: null };
  }

  const longIn = Math.max(meta.widthIn, meta.heightIn);
  const shortIn = Math.min(meta.widthIn, meta.heightIn);
  const wantLongIn = Math.max(spec.fullWidthIn, spec.fullHeightIn);
  const wantShortIn = Math.min(spec.fullWidthIn, spec.fullHeightIn);

  /** 6 → `6`, 8.5 → `8.5`, 6.25 → `6.25`. Trailing zeros read as machine output, not a size. */
  const fmt = (n: number): string => n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  /**
   * Sized against trim OR trim-plus-bleed, both accepted. A designer who exported at the finished
   * size did nothing wrong — the vendor can add bleed — and rejecting that would fail the more
   * careful half of users.
   */
  const matchesFull = withinTolerance(longIn, wantLongIn) && withinTolerance(shortIn, wantShortIn);
  const matchesTrim =
    withinTolerance(longIn, Math.max(spec.trimWidthIn, spec.trimHeightIn)) &&
    withinTolerance(shortIn, Math.min(spec.trimWidthIn, spec.trimHeightIn));

  if (!matchesFull && !matchesTrim) {
    errors.push({
      code: 'wrong_page_size',
      message:
        `This PDF is ${fmt(meta.widthIn)}" × ${fmt(meta.heightIn)}". It needs to be ` +
        `${fmt(spec.trimWidthIn)}" × ${fmt(spec.trimHeightIn)}" (or ` +
        `${fmt(spec.fullWidthIn)}" × ${fmt(spec.fullHeightIn)}" if you are including bleed).`,
    });
  } else if (matchesTrim && !matchesFull) {
    warnings.push({
      code: 'no_bleed',
      message:
        'This PDF is exactly the finished size, with no bleed. If your design has colour running ' +
        'to the edge, a thin white line can appear after trimming.',
    });
  }

  return { passed: errors.length === 0, errors, warnings, effectiveDpi: null };
}

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) / expected <= POSTCARD_ASPECT_TOLERANCE;
}
