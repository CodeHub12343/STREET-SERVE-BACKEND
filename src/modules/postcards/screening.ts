import type { ArtworkMetadata } from './prepress';

/**
 * ═══ AUTOMATED FIRST-PASS SCREENING (F-7) ═══
 *
 * ## What this is, and what it deliberately is not
 *
 * The roadmap called for an "automated first pass" over uploaded artwork. It is worth being exact
 * about what that can mean here, because the honest answer is narrower than the phrase suggests.
 *
 * StreetServe would be **physically printing and mailing third-party artwork into people's homes**.
 * The content risks — hate speech, adult imagery, fraudulent claims, someone else's trademark,
 * material the USPS will not carry — are all things you can only find by LOOKING AT THE IMAGE. That
 * needs vision inference, which this service does not currently do for moderation.
 *
 * So this module raises suspicion; it never clears it. Every asset still reaches a human. A
 * screener that returned "clean" would be worse than no screener at all: it would create a
 * defensible-looking approval nobody actually performed.
 *
 * ## The seam
 *
 * `ContentScreener` is the injection point. The obvious real implementation is the Gemini provider
 * already integrated in this codebase — it is multimodal, and an advisory "does this look like it
 * contains X" pass in front of a human reviewer is exactly the shape of use the AI provider note
 * allows (narration and assistance, never an authoritative decision). Deliberately not wired yet:
 * doing it properly means prompt design, a cost model, and a false-positive policy, and shipping a
 * half-built version would be the same false assurance described above.
 *
 * ## What the default DOES do
 *
 * Structural checks that need no vision and catch real problems: a file whose real format
 * contradicts what was declared, and dimensions consistent with a screenshot rather than artwork.
 * These are signals for the reviewer's queue ordering, not verdicts.
 */

export interface ScreeningInput {
  declaredContentType: string;
  metadata: ArtworkMetadata;
  sizeBytes: number;
}

export interface ScreeningResult {
  /**
   * Reasons to look harder. An empty list means "nothing structural stood out" — **not** "safe".
   * There is intentionally no `approved` field: this type cannot express approval.
   */
  flags: string[];
}

export interface ContentScreener {
  screen(input: ScreeningInput): Promise<ScreeningResult>;
}

const DECLARED_TO_FORMAT: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

export const structuralScreener: ContentScreener = {
  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async for real screeners
  async screen(input: ScreeningInput): Promise<ScreeningResult> {
    const flags: string[] = [];

    const expected = DECLARED_TO_FORMAT[input.declaredContentType];
    if (expected && expected !== input.metadata.format) {
      /**
       * The file is not what it claimed. Pre-press already accepts it on sniffed format so nothing
       * is broken by it, but a mismatch is worth a reviewer's attention: it is either a confused
       * export or someone probing what the upload path accepts.
       */
      flags.push('declared_type_mismatch');
    }

    if (input.metadata.colorSpace === 'grayscale') {
      // Not a problem — but full-colour artwork is the norm, so a mono file is unusual enough to note.
      flags.push('grayscale_artwork');
    }

    if (input.sizeBytes < 50 * 1024 && input.metadata.format !== 'pdf') {
      // A print-resolution raster is megabytes. A tiny one is usually a screenshot or a placeholder.
      flags.push('unusually_small_file');
    }

    return { flags };
  },
};

let screener: ContentScreener = structuralScreener;

export function setContentScreener(next: ContentScreener): void {
  screener = next;
}
export function resetContentScreener(): void {
  screener = structuralScreener;
}
export function contentScreener(): ContentScreener {
  return screener;
}
