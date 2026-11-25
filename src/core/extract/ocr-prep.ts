/**
 * The de-identified sample policies print personal fields (name, registration number) in faint grey, around
 * 200/255. Tesseract drops text that light: in the browser's pdf.js render the Go Digit schedule loses its
 * registration number, and on the HDFC Ergo schedule it misreads the mark ("FB8" for "FB").
 * A gamma curve darkens grey text while white stays white and black stays black.
 *
 * The darkened render is a second OCR pass, never a replacement: darkening also darkens shaded table rows, and
 * on the samples that loses lines the plain pass reads (Reliance "TOTAL PREMIUM PAYABLE", the HDFC Ergo page-1
 * RTO). The agent therefore reads facts from the plain pass and only fills facts it left missing from this one
 * (src/core/agent.ts). Gamma 2 reads the Go Digit registration number and name; Tesseract's adaptive
 * thresholding (Sauvola, local Otsu) on the plain render reads neither.
 */
export const OCR_GAMMA = 2;

const LUT = Uint8ClampedArray.from({ length: 256 }, (_, v) => Math.round((v / 255) ** OCR_GAMMA * 255));

/**
 * Applies the gamma curve in place to the colour channels of a pixel buffer.
 * `stride` is 4 for canvas RGBA (alpha is left alone) and 3 for binary PPM RGB.
 */
export function darkenFaintText(px: Uint8Array | Uint8ClampedArray, stride: 3 | 4): void {
  for (let i = 0; i < px.length; i += stride) {
    px[i] = LUT[px[i]];
    px[i + 1] = LUT[px[i + 1]];
    px[i + 2] = LUT[px[i + 2]];
  }
}
