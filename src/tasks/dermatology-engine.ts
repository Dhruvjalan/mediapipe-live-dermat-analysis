/**
 * AyurGenX Dermatology Engine — measures skin features from camera pixels.
 *
 * Plain TypeScript over RGBA pixel arrays, so every number is deterministic and
 * unit-tested. Texture-type measures work on "flat-fielded" luminance (each pixel
 * divided by its neighbourhood average), so they don't change with room
 * brightness. Colour measures use CIELAB hue, so skin tone itself is never read
 * as redness or yellowness. These are camera estimates, not clinical measurements.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** MediaPipe landmark: x and y normalised to 0-1. */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export type LightingType = 'Even' | 'Dark' | 'Overexposed' | 'Side-lit' | 'Uneven';

export interface LightingInfo {
  lightingType: LightingType;
  /** 0-100: how evenly the two cheeks are lit. */
  uniformity: number;
}

/** Everything measured on one video frame (scales match SkinMetrics). */
export interface FrameMeasures {
  erythema: number;
  yellowness: number;
  melanin: number;
  pigmentation: number;
  texture: number;
  pores: number;
  wrinkles: number;
  darkCircles: number;
  acne: number;
  oiliness: number;
  /** 0-100 tone evenness, used for glow. */
  evenness: number;
  fatigue: number;
  /** Mean skin luma, 0-255. */
  luminance: number;
  /** Laplacian variance around the eyes. */
  sharpness: number;
  /** Inter-ocular distance in pixels. */
  faceSize: number;
  /** 0-100 frame quality. */
  quality: number;
  lighting: LightingInfo;
}

export interface PulseSample {
  /** Milliseconds. */
  t: number;
  r: number;
  g: number;
  b: number;
}

export interface PulseEstimate {
  bpm: number;
  /** Spectral signal-to-noise ratio in dB. */
  snr: number;
  /** dB the peak rises above the spectrum just either side of it. */
  prominence: number;
  reliable: boolean;
  /** 0-100 relative pulse strength; 0 when not reliable. */
  perfusion: number;
}

export interface FaceRegions {
  forehead: Rect;
  nose: Rect;
  rightCheek: Rect;
  leftCheek: Rect;
  rightUnderEye: Rect;
  leftUnderEye: Rect;
  eyes: Rect;
  /** Inter-ocular distance in pixels. */
  faceSize: number;
}

export interface FrameAnalysis {
  measures: FrameMeasures;
}

// ── Pixel helpers ────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp100 = (v: number) => Math.min(100, Math.max(0, v));

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function luma(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return values.length ? sum / values.length : 0;
}

function std(values: ArrayLike<number>): number {
  const m = mean(values);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i] - m) ** 2;
  return values.length ? Math.sqrt(sum / values.length) : 0;
}

/** Separable box blur with clamped edges (running sums, O(n)). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src.slice();
  const size = 2 * r + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / size;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

const illuminationRadius = (img: RgbaImage) => Math.max(2, Math.round(Math.min(img.width, img.height) / 4));

/** Luminance divided by its local average: ~1 everywhere, whatever the lighting level. */
function flatField(img: RgbaImage, radius = illuminationRadius(img)): Float32Array {
  const lum = luma(img);
  const local = boxBlur(lum, img.width, img.height, radius);
  for (let i = 0; i < lum.length; i++) lum[i] = lum[i] / Math.max(1, local[i]);
  return lum;
}

/** Spread (75th percentile minus median) of the median residual for unit-sigma Gaussian noise. */
const MEDIAN_RESIDUAL_GAIN = 0.575;
/** Share an even spread of one value step adds to the estimate (in step units, squared). */
const STEP_SPREAD_SHARE = (0.6745 / MEDIAN_RESIDUAL_GAIN) ** 2 / 12;
const GOLDEN_RATIO = 0.6180339887;

/**
 * Camera noise (sigma) of a single-channel map, from each pixel's difference to
 * the median of its 3x3 neighbourhood. Skin features push that difference one
 * way only (pores and lines darker, spots redder) while grain pushes both ways
 * equally, so the cleaner side is used: even dense pores or spots can't pass
 * for grain and raise the bar they are measured against.
 *
 * `step` is the size of the map's value steps (1 for 8-bit luma). Each
 * difference is spread evenly across one step, so the estimate follows the
 * grain smoothly instead of jumping a whole step at a time; that spread's own
 * share is then taken back out.
 */
function robustNoise(src: Float32Array, w: number, h: number, step = 0): number {
  if (w < 3 || h < 3) return 0;
  const residuals = new Float32Array((w - 2) * (h - 2));
  const neighbourhood = new Float32Array(9);
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let j = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) neighbourhood[j++] = src[(y + dy) * w + x + dx];
      }
      neighbourhood.sort();
      residuals[k++] = src[y * w + x] - neighbourhood[4];
    }
  }
  if (step > 0) {
    // Golden-ratio offsets: evenly spread, and the same on every run.
    for (let i = 0; i < residuals.length; i++) residuals[i] += (((i * GOLDEN_RATIO) % 1) - 0.5) * step;
  }
  residuals.sort();
  const quantile = (q: number) => residuals[Math.min(residuals.length - 1, Math.floor(q * residuals.length))];
  const centre = quantile(0.5);
  const spread = Math.min(quantile(0.75) - centre, centre - quantile(0.25)) / MEDIAN_RESIDUAL_GAIN;
  return Math.sqrt(Math.max(0, spread * spread - STEP_SPREAD_SHARE * step * step));
}

/**
 * Camera noise relative to brightness (sigma / mean luma): the noise of the
 * flat-fielded image. Measured on the raw luma, where the 8-bit steps are a
 * known size (1) and can be smoothed out.
 */
function relativeNoise(img: RgbaImage): number {
  const lum = luma(img);
  return robustNoise(lum, img.width, img.height, 1) / Math.max(1, mean(lum));
}

const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** Linear-light RGB (0-1) to CIELAB (D65). */
function linearToLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const fx = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** Below this CIELAB chroma a colour is too grey to have a meaningful hue (skin is ~15-35). */
const MIN_CHROMA = 8;

/**
 * CIELAB hue angle (degrees) of the image's average colour, averaged in linear
 * light; null when the colour is too grey for its hue to mean anything.
 */
function hueAngle(img: RgbaImage): number | null {
  const n = img.width * img.height;
  const d = img.data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += SRGB_TO_LINEAR[d[i * 4]];
    g += SRGB_TO_LINEAR[d[i * 4 + 1]];
    b += SRGB_TO_LINEAR[d[i * 4 + 2]];
  }
  const lab = linearToLab(r / n, g / n, b / n);
  if (Math.hypot(lab.a, lab.b) < MIN_CHROMA) return null;
  return (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
}

export function cropImage(img: RgbaImage, rect: Rect): RgbaImage {
  const data = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * img.width + rect.x) * 4;
    data.set(img.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
  }
  return { data, width: rect.width, height: rect.height };
}

/** Block-averages the image by an integer factor (used to bring faces to a common scale). */
export function downsample(img: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return img;
  const width = Math.floor(img.width / factor);
  const height = Math.floor(img.height / factor);
  const data = new Uint8ClampedArray(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) sum += img.data[((y * factor + dy) * img.width + x * factor + dx) * 4 + c];
        }
        data[(y * width + x) * 4 + c] = Math.round(sum / area);
      }
    }
  }
  return { data, width, height };
}

// ── Colour measures ──────────────────────────────────────────────────────────

// Both colour readings are NaN ("not measured") when the image is too grey to
// have a hue, e.g. under a strong colour cast, rather than a made-up "normal".

/** Degrees the skin's hue sits below 60 (normal skin of every tone: 0-8; flushed: 20+). */
export function rednessIndex(img: RgbaImage): number {
  const hue = hueAngle(img);
  return hue === null ? Number.NaN : Math.max(0, 60 - hue);
}

/** The skin's hue angle in degrees (normal skin of every tone: 52-68; jaundiced: ~80+). */
export function yellownessIndex(img: RgbaImage): number {
  return hueAngle(img) ?? Number.NaN;
}

/** Melanin index, 100*log10(255/R). Describes skin tone only; never graded. */
export function melaninIndex(img: RgbaImage): number {
  let r = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) r += img.data[i * 4];
  return 100 * Math.log10(255 / Math.max(1, r / n));
}

// ── Texture measures ─────────────────────────────────────────────────────────

// RMS Laplacian of the flat-fielded, lightly smoothed luminance (after removing
// the camera-noise share) at which skin reads as perfectly smooth / fully rough.
const TEXTURE_SMOOTH = 0.005;
const TEXTURE_ROUGH = 0.045;
/** RMS of the smoothed Laplacian produced by unit-sigma pixel noise: sqrt(32/81). */
const LAPLACIAN_NOISE_GAIN = Math.sqrt(32 / 81);

/**
 * 0-100, higher is smoother. Camera noise is relative to brightness, so dark
 * skin or a dim room would otherwise read as rough: its expected share is
 * measured and subtracted.
 */
export function textureScore(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const ff = flatField(img);
  const noise = relativeNoise(img);
  const s = boxBlur(ff, w, h, 1);
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      sumSq += (4 * s[i] - s[i - 1] - s[i + 1] - s[i - w] - s[i + w]) ** 2;
      n++;
    }
  }
  const total = n ? sumSq / n : 0;
  const roughness = Math.sqrt(Math.max(0, total - (LAPLACIAN_NOISE_GAIN * noise) ** 2));
  return Math.round(100 * (1 - clamp01((roughness - TEXTURE_SMOOTH) / (TEXTURE_ROUGH - TEXTURE_SMOOTH))));
}

// Curvature below which a valley is treated as noise (at least LINE_NOISE_SIGMAS
// times the noise's own curvature), and the scale from mean excess line strength
// to the 0-100 score.
const LINE_NOISE_FLOOR = 0.008;
const LINE_NOISE_SIGMAS = 4;
/** Curvature sigma produced by unit pixel noise after the double 3x3 smoothing. */
const CURVATURE_NOISE_GAIN = 0.1318;
const LINE_SCALE = 12000;

/**
 * 0-100 line density. Uses the Hessian: a wrinkle is a dark valley that curves
 * strongly across and hardly at all along its length, unlike round pores or spots.
 */
export function wrinkleScore(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const ff = flatField(img);
  const floor = Math.max(LINE_NOISE_FLOOR, LINE_NOISE_SIGMAS * CURVATURE_NOISE_GAIN * relativeNoise(img));
  const s = boxBlur(boxBlur(ff, w, h, 1), w, h, 1);
  let excess = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const dxx = s[i - 1] - 2 * s[i] + s[i + 1];
      const dyy = s[i - w] - 2 * s[i] + s[i + w];
      const dxy = (s[i - w - 1] + s[i + w + 1] - s[i - w + 1] - s[i + w - 1]) / 4;
      const half = (dxx + dyy) / 2;
      const root = Math.sqrt(((dxx - dyy) / 2) ** 2 + dxy * dxy);
      const across = half + root;
      const along = half - root;
      if (across > 0) excess += Math.max(0, across - Math.abs(along) - floor);
      n++;
    }
  }
  return Math.round(clamp100((n ? excess / n : 0) * LINE_SCALE));
}

/** Morphological closing (3x3 dilate then erode) of a single-channel map. */
function closing3x3(src: Float32Array, w: number, h: number): Float32Array {
  const filter = (input: Float32Array, pick: (a: number, b: number) => number) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = input[y * w + x];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            v = pick(v, input[yy * w + xx]);
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return filter(filter(src, Math.max), Math.min);
}

/**
 * How much darker than its surroundings a point must be to count as a pore:
 * at least 5%, and at least 4x the camera noise (so grain on dark skin isn't counted).
 */
const PORE_CONTRAST = 0.05;
const PORE_NOISE_SIGMAS = 4;

/** % of skin pixels that are small dark points (black-hat transform). */
export function poreDensity(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const ff = flatField(img);
  const threshold = Math.max(PORE_CONTRAST, PORE_NOISE_SIGMAS * relativeNoise(img));
  const closed = closing3x3(ff, w, h);
  let count = 0;
  for (let i = 0; i < ff.length; i++) if (closed[i] - ff[i] > threshold) count++;
  return (100 * count) / ff.length;
}

/**
 * A smoothed pixel this much darker than the local brightness counts as a dark
 * spot (at least 10%, and at least 4x the noise left after the 3x3 smoothing).
 */
const SPOT_DEPTH = 0.1;
const PIGMENT_SCALE = 5;

/** 0-100 coverage of dark spots larger than pores (freckles, sun spots, uneven tone). */
export function pigmentationScore(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const ff = flatField(img);
  const level = 1 - Math.max(SPOT_DEPTH, (4 * relativeNoise(img)) / 3);
  const s = boxBlur(ff, w, h, 1);
  let count = 0;
  for (let i = 0; i < s.length; i++) if (s[i] < level) count++;
  return Math.round(clamp100(((100 * count) / s.length) * PIGMENT_SCALE));
}

/** % darker the under-eye is than the cheek. */
export function darkCircleScore(underEye: RgbaImage, cheek: RgbaImage): number {
  const cheekLuma = mean(luma(cheek));
  if (cheekLuma <= 0) return 0;
  return Math.max(0, ((cheekLuma - mean(luma(underEye))) / cheekLuma) * 100);
}

/** CIELAB a* points a spot must exceed its surroundings by to count as an inflamed spot. */
const ACNE_REDNESS = 6;

/** % of skin area covered by small spots that are redder than the skin around them. */
export function acneScore(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const d = img.data;
    a[i] = linearToLab(SRGB_TO_LINEAR[d[i * 4]], SRGB_TO_LINEAR[d[i * 4 + 1]], SRGB_TO_LINEAR[d[i * 4 + 2]]).a;
  }
  // Colour noise (worse on dark skin and in dim rooms) mustn't read as spots.
  const threshold = Math.max(ACNE_REDNESS, (4 * robustNoise(a, w, h)) / 3);
  const spot = boxBlur(a, w, h, 1);
  const surroundings = boxBlur(a, w, h, illuminationRadius(img));
  let count = 0;
  for (let i = 0; i < a.length; i++) if (spot[i] - surroundings[i] > threshold) count++;
  return (100 * count) / a.length;
}

/** % of pixels that are bright, near-white highlights (oily shine). */
export function specularFraction(img: RgbaImage): number {
  const n = img.width * img.height;
  const d = img.data;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const max = Math.max(r, g, b);
    const bright = 0.299 * r + 0.587 * g + 0.114 * b >= 230;
    if (bright && max - Math.min(r, g, b) <= 0.25 * max) count++;
  }
  return (100 * count) / n;
}

/** Relative brightness variation (blotchiness) at which tone evenness reaches 0. */
const BLOTCH_FULL_SCALE = 0.06;

/** 0-100: how even the skin tone is, ignoring pixel noise and the broad lighting falloff. */
export function toneEvenness(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const lum = luma(img);
  const patches = boxBlur(lum, w, h, 2);
  // Same local scale as the flat field: removes the face's 3D shading, keeps patches.
  const lighting = boxBlur(lum, w, h, illuminationRadius(img));
  const ratio = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) ratio[i] = patches[i] / Math.max(1, lighting[i]);
  return Math.round(100 * (1 - clamp01(std(ratio) / BLOTCH_FULL_SCALE)));
}

/** Camera noise in luma levels (sigma). High in dim rooms. */
export function noiseLevel(img: RgbaImage): number {
  return robustNoise(luma(img), img.width, img.height, 1);
}

/** Laplacian variance of luminance: low means blurry. */
function sharpness(img: RgbaImage): number {
  const { width: w, height: h } = img;
  const lum = luma(img);
  const values: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      values.push(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
    }
  }
  return std(values) ** 2;
}

/** Eye aspect ratio from six eye points [outer, upper, upper, inner, lower, lower]. */
export function eyeAspectRatio(eye: { x: number; y: number }[]): number {
  if (eye.length < 6) return 0.3;
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = dist(eye[0], eye[3]);
  return width > 0 ? (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * width) : 0.3;
}

// ── Composite estimates ──────────────────────────────────────────────────────

/** 0-100: a light natural sheen scores best; matte (dull) and greasy skin score lower. */
export function sheenScore(oiliness: number): number {
  if (oiliness <= 0.2) return 55;
  if (oiliness <= 1.5) return 55 + ((oiliness - 0.2) / 1.3) * 45;
  if (oiliness <= 4) return 100;
  if (oiliness <= 10) return 100 - ((oiliness - 4) / 6) * 60;
  return 40;
}

/** Visual estimates derived from the measured features (not measured directly). */
export function deriveCompositeMetrics(m: {
  texture: number;
  wrinkles: number;
  pigmentation: number;
  evenness: number;
  oiliness: number;
}): { glow: number; hydration: number; elasticity: number; uvDamage: number } {
  const sheen = sheenScore(m.oiliness);
  return {
    glow: Math.round(clamp100(0.65 * m.evenness + 0.35 * sheen)),
    hydration: Math.round(clamp100(0.5 * m.texture + 0.25 * sheen + 0.25 * (100 - m.wrinkles))),
    elasticity: Math.round(clamp100(100 - 0.7 * m.wrinkles - 0.3 * (100 - m.texture))),
    uvDamage: Math.round(clamp100(0.6 * m.pigmentation + 0.4 * m.wrinkles)),
  };
}

// ── Frame quality ────────────────────────────────────────────────────────────

/** 0-100. Frames under 65 aren't used when better frames of the same pose exist. */
export function frameQuality(f: {
  sharpness: number;
  meanLuma: number;
  clipped: number;
  faceSize: number;
  uniformity: number;
  /** Camera noise relative to the skin's brightness (sigma / mean luma). */
  noise: number;
}): number {
  let quality = 100;
  if (f.sharpness < 15) quality -= 40;
  else if (f.sharpness < 40) quality -= 15;
  // Very grainy frames make every texture reading less certain.
  if (f.noise > 0.09) quality -= 40;
  else if (f.noise > 0.05) quality -= 15;
  if (f.meanLuma < 45) quality -= 45;
  else if (f.meanLuma < 70) quality -= 15;
  if (f.meanLuma > 220) quality -= 40;
  else if (f.meanLuma > 200) quality -= 15;
  if (f.clipped > 0.25) quality -= 25;
  else if (f.clipped > 0.1) quality -= 10;
  if (f.faceSize < 35) quality -= 45;
  else if (f.faceSize < 55) quality -= 15;
  if (f.uniformity < 60) quality -= 15;
  else if (f.uniformity < 75) quality -= 5;
  return Math.max(0, quality);
}

export function describeLighting(meanLuma: number, clipped: number, uniformity: number): LightingInfo {
  let lightingType: LightingType = 'Even';
  if (meanLuma < 55) lightingType = 'Dark';
  else if (meanLuma > 215 || clipped > 0.2) lightingType = 'Overexposed';
  else if (uniformity < 70) lightingType = 'Side-lit';
  else if (uniformity < 85) lightingType = 'Uneven';
  return { lightingType, uniformity: Math.round(uniformity) };
}

// ── Face regions ─────────────────────────────────────────────────────────────

const MIN_FACE_SIZE = 30;

/**
 * Skin regions sized relative to the inter-ocular distance, so they cover the
 * same part of the face at any distance from the camera. Returns null when the
 * face is too small or any region falls outside the frame.
 */
export function faceRegions(landmarks: Landmark[], width: number, height: number): FaceRegions | null {
  if (landmarks.length < 468) return null;
  const px = (i: number) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });
  const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  const rightEye = midpoint(px(33), px(133));
  const leftEye = midpoint(px(263), px(362));
  const iod = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  if (iod < MIN_FACE_SIZE) return null;

  const centred = (c: { x: number; y: number }, w: number, h: number): Rect => ({
    x: Math.round(c.x - w / 2),
    y: Math.round(c.y - h / 2),
    width: Math.round(w),
    height: Math.round(h),
  });
  // Below the lower eyelid, clear of the lashes and the lid crease (which would read as a line).
  const underEye = (eye: { x: number; y: number }, lowerLid: { x: number; y: number }): Rect => ({
    x: Math.round(eye.x - 0.18 * iod),
    y: Math.round(lowerLid.y + 0.12 * iod),
    width: Math.round(0.36 * iod),
    height: Math.round(0.16 * iod),
  });
  const eyePoints = [33, 133, 263, 362, 159, 145, 386, 374].map(px);
  const margin = 0.1 * iod;
  const eyesLeft = Math.min(...eyePoints.map((p) => p.x)) - margin;
  const eyesTop = Math.min(...eyePoints.map((p) => p.y)) - margin;

  const regions: FaceRegions = {
    forehead: centred(px(151), 0.9 * iod, 0.32 * iod),
    nose: centred(px(195), 0.24 * iod, 0.4 * iod),
    rightCheek: centred(px(205), 0.42 * iod, 0.34 * iod),
    leftCheek: centred(px(425), 0.42 * iod, 0.34 * iod),
    rightUnderEye: underEye(rightEye, px(145)),
    leftUnderEye: underEye(leftEye, px(374)),
    eyes: {
      x: Math.round(eyesLeft),
      y: Math.round(eyesTop),
      width: Math.round(Math.max(...eyePoints.map((p) => p.x)) + margin - eyesLeft),
      height: Math.round(Math.max(...eyePoints.map((p) => p.y)) + margin - eyesTop),
    },
    faceSize: iod,
  };

  const rects = [
    regions.forehead,
    regions.nose,
    regions.rightCheek,
    regions.leftCheek,
    regions.rightUnderEye,
    regions.leftUnderEye,
    regions.eyes,
  ];
  const fits = (r: Rect) =>
    r.width >= 4 && r.height >= 4 && r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height;
  return rects.every(fits) ? regions : null;
}

// ── Whole-frame analysis ─────────────────────────────────────────────────────

/** Faces bigger than this (inter-ocular px) are scaled down so texture is measured at a common scale. */
const CANONICAL_FACE_SIZE = 80;

function areaWeighted(images: RgbaImage[], measure: (img: RgbaImage) => number): number {
  let sum = 0;
  let area = 0;
  for (const img of images) {
    const a = img.width * img.height;
    sum += measure(img) * a;
    area += a;
  }
  return area ? sum / area : 0;
}

export function analyzeFrame(frame: RgbaImage, landmarks: Landmark[]): FrameAnalysis | null {
  const regions = faceRegions(landmarks, frame.width, frame.height);
  if (!regions) return null;

  // No white balance of our own: a gray-world correction is skewed by the wall
  // behind and, when the face fills the frame, neutralises the skin itself.
  // Colour therefore relies on the camera's own white balance.
  const factor = Math.max(1, Math.floor(regions.faceSize / CANONICAL_FACE_SIZE));
  const raw = (rect: Rect) => cropImage(frame, rect);
  const prepared = (rect: Rect) => downsample(raw(rect), factor);

  const rawSkin = [raw(regions.forehead), raw(regions.rightCheek), raw(regions.leftCheek)];
  const forehead = prepared(regions.forehead);
  const rightCheek = prepared(regions.rightCheek);
  const leftCheek = prepared(regions.leftCheek);
  const rightUnderEye = prepared(regions.rightUnderEye);
  const leftUnderEye = prepared(regions.leftUnderEye);
  const skin = [forehead, rightCheek, leftCheek];

  // Exposure and lighting, from the camera's raw pixels.
  const skinLuma = rawSkin.map(luma);
  const meanLuma = mean(skinLuma.flatMap((l) => Array.from(l)));
  const clipped = skinLuma.reduce((n, l) => n + l.filter((v) => v >= 250).length, 0) / skinLuma.reduce((n, l) => n + l.length, 0);
  const cheekLuma = [mean(skinLuma[1]), mean(skinLuma[2])];
  const uniformity = (100 * Math.min(...cheekLuma)) / Math.max(1, ...cheekLuma);
  const eyesSharpness = sharpness(raw(regions.eyes));
  const noise = areaWeighted(rawSkin, (img) => noiseLevel(img) / Math.max(1, mean(luma(img))));

  const pixels = (indices: number[]) => indices.map((i) => ({ x: landmarks[i].x * frame.width, y: landmarks[i].y * frame.height }));
  const fatigue =
    (eyeAspectRatio(pixels([33, 160, 158, 133, 153, 144])) + eyeAspectRatio(pixels([263, 387, 385, 362, 380, 373]))) / 2;

  const measures: FrameMeasures = {
    erythema: areaWeighted([rightCheek, leftCheek], rednessIndex),
    yellowness: areaWeighted(skin, yellownessIndex),
    melanin: areaWeighted(skin, melaninIndex),
    pigmentation: areaWeighted(skin, pigmentationScore),
    texture: areaWeighted(skin, textureScore),
    pores: areaWeighted(skin, poreDensity),
    // The more lined of the two areas, so deep forehead lines aren't averaged away by smooth under-eyes.
    wrinkles: Math.max(wrinkleScore(forehead), areaWeighted([rightUnderEye, leftUnderEye], wrinkleScore)),
    darkCircles: (darkCircleScore(rightUnderEye, rightCheek) + darkCircleScore(leftUnderEye, leftCheek)) / 2,
    acne: areaWeighted(skin, acneScore),
    oiliness: areaWeighted([forehead, prepared(regions.nose)], specularFraction),
    evenness: areaWeighted(skin, toneEvenness),
    fatigue,
    luminance: meanLuma,
    sharpness: eyesSharpness,
    faceSize: regions.faceSize,
    quality: frameQuality({ sharpness: eyesSharpness, meanLuma, clipped, faceSize: regions.faceSize, uniformity, noise }),
    lighting: describeLighting(meanLuma, clipped, uniformity),
  };
  return { measures };
}

// ── Pulse (remote photoplethysmography) ──────────────────────────────────────

/**
 * Mean raw colour of the skin patches (forehead and cheeks): one sample of the
 * pulse signal. Cheap, so it can be taken on every video frame.
 */
export function skinColour(patches: RgbaImage[]): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const img of patches) {
    for (let i = 0; i < img.data.length; i += 4) {
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}

const PULSE_RATE_HZ = 20;
const MIN_PULSE_SECONDS = 6;
const MIN_PULSE_FPS = 8;
const PULSE_MIN_HZ = 0.7; // 42 BPM
const PULSE_MAX_HZ = 3.5; // 210 BPM
/** The spectrum is computed a little beyond the band, so a peak near its edge still has flanks. */
const SPECTRUM_MIN_HZ = 0.3;
const SPECTRUM_MAX_HZ = 4;
/** A maximum this close to the band's edge is the tail of drift or noise, not a peak. */
const EDGE_MARGIN_HZ = 0.05;
const PULSE_SNR_DB = 0;
/** How far (dB) the peak must rise above the spectrum just either side of it. */
const PULSE_PROMINENCE_DB = 6;
/** Green-channel pulse amplitude (% of its mean) that maps to perfusion 100. */
const PERFUSION_FULL_SCALE = 1;

function detrendAndWindow(signal: Float64Array): Float64Array {
  const n = signal.length;
  // Least-squares line through the samples, then a Hann window.
  const xMean = (n - 1) / 2;
  const yMean = mean(signal);
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (k - xMean) * (signal[k] - yMean);
    den += (k - xMean) ** 2;
  }
  const slope = den ? num / den : 0;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    out[k] = (signal[k] - yMean - slope * (k - xMean)) * hann;
  }
  return out;
}

function dft(signal: Float64Array, hz: number): { re: number; im: number } {
  let re = 0;
  let im = 0;
  for (let k = 0; k < signal.length; k++) {
    const phase = (2 * Math.PI * hz * k) / PULSE_RATE_HZ;
    re += signal[k] * Math.cos(phase);
    im -= signal[k] * Math.sin(phase);
  }
  return { re, im };
}

/**
 * Heart rate from the skin's colour over time, using the POS method
 * (Wang et al., 2017) and the strongest spectral peak between 42 and 210 BPM.
 * Needs about 6+ seconds of a still face; motion makes it unreliable, and then
 * it says so rather than guessing.
 */
export function estimatePulse(
  samples: PulseSample[],
  minSeconds = MIN_PULSE_SECONDS,
  minProminence = PULSE_PROMINENCE_DB,
  minSnr = PULSE_SNR_DB
): PulseEstimate {
  const none: PulseEstimate = { bpm: 0, snr: -Infinity, prominence: -Infinity, reliable: false, perfusion: 0 };
  if (samples.length < 2) return none;
  const t0 = samples[0].t;
  const duration = (samples[samples.length - 1].t - t0) / 1000;
  if (duration < minSeconds || (samples.length - 1) / duration < MIN_PULSE_FPS) return none;

  // 1. Resample to an even rate.
  const n = Math.floor(duration * PULSE_RATE_HZ) + 1;
  const rgb = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + (k * 1000) / PULSE_RATE_HZ;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j];
    const b = samples[j + 1];
    const f = b.t > a.t ? clamp01((t - a.t) / (b.t - a.t)) : 0;
    rgb[0][k] = a.r + (b.r - a.r) * f;
    rgb[1][k] = a.g + (b.g - a.g) * f;
    rgb[2][k] = a.b + (b.b - a.b) * f;
  }

  // 2. POS: in short overlapping windows, normalise each channel and project out skin tone.
  const win = Math.round(1.6 * PULSE_RATE_HZ);
  const pulse = new Float64Array(n);
  const s1 = new Float64Array(win);
  const s2 = new Float64Array(win);
  for (let start = 0; start + win <= n; start++) {
    const m = rgb.map((channel) => mean(channel.subarray(start, start + win)));
    for (let k = 0; k < win; k++) {
      const r = rgb[0][start + k] / m[0];
      const g = rgb[1][start + k] / m[1];
      const b = rgb[2][start + k] / m[2];
      s1[k] = g - b;
      s2[k] = g + b - 2 * r;
    }
    const sd2 = std(s2);
    const alpha = sd2 > 0 ? std(s1) / sd2 : 0;
    let segMean = 0;
    for (let k = 0; k < win; k++) segMean += s1[k] + alpha * s2[k];
    segMean /= win;
    for (let k = 0; k < win; k++) pulse[start + k] += s1[k] + alpha * s2[k] - segMean;
  }

  // 3. Spectrum on a fine grid. The pulse is the strongest true peak inside the
  //    heart-rate band: a maximum at the band's edge is the tail of slow drift.
  const windowed = detrendAndWindow(pulse);
  const freqs: number[] = [];
  const power: number[] = [];
  for (let hz = SPECTRUM_MIN_HZ; hz <= SPECTRUM_MAX_HZ + 1e-9; hz += 0.01) {
    const { re, im } = dft(windowed, hz);
    freqs.push(hz);
    power.push(re * re + im * im);
  }
  let peak = -1;
  for (let i = 1; i < freqs.length - 1; i++) {
    if (freqs[i] < PULSE_MIN_HZ + EDGE_MARGIN_HZ || freqs[i] > PULSE_MAX_HZ - EDGE_MARGIN_HZ) continue;
    if (power[i] < power[i - 1] || power[i] < power[i + 1]) continue;
    if (peak < 0 || power[i] > power[peak]) peak = i;
  }
  if (peak < 0) return none;
  const peakHz = freqs[peak];

  // 4. Two checks: the peak's share of the whole band (SNR), and how far it rises
  //    above the spectrum just either side of it, which a sloping drift spectrum can't fake.
  const halfWidth = Math.max(0.2, 2 / duration); // Hann main lobe
  const flankInner = halfWidth + 0.1;
  const flankOuter = flankInner + 0.5;
  let signal = 0;
  let signalBins = 0;
  let bandSignal = 0;
  let band = 0;
  let flank = 0;
  let flankBins = 0;
  for (let i = 0; i < freqs.length; i++) {
    const offset = Math.abs(freqs[i] - peakHz);
    const inBand = freqs[i] >= PULSE_MIN_HZ;
    if (inBand) band += power[i];
    if (offset <= halfWidth) {
      signal += power[i];
      signalBins++;
      if (inBand) bandSignal += power[i];
    } else if (offset >= flankInner && offset <= flankOuter) {
      flank += power[i];
      flankBins++;
    }
  }
  const snr = 10 * Math.log10(bandSignal / Math.max(1e-30, band - bandSignal));
  const prominence = 10 * Math.log10(signal / signalBins / Math.max(1e-30, flank / Math.max(1, flankBins)));
  if (!(snr >= minSnr && prominence >= minProminence)) return { ...none, snr, prominence };

  // 5. Perfusion: the pulse's amplitude in the green channel, relative to its mean.
  const greenMean = mean(rgb[1]);
  const green = detrendAndWindow(rgb[1].map((v) => v / greenMean - 1));
  let windowSum = 0;
  for (let k = 0; k < n; k++) windowSum += 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
  const { re, im } = dft(green, peakHz);
  const amplitudePercent = ((2 * Math.hypot(re, im)) / windowSum) * 100;

  return {
    bpm: Math.round(peakHz * 60),
    snr,
    prominence,
    reliable: true,
    perfusion: Math.round(clamp100((amplitudePercent / PERFUSION_FULL_SCALE) * 100)),
  };
}

const CONFIRM_TOLERANCE_BPM = 6;
const MIN_HALF_SECONDS = 5;
/** Half windows have coarser resolution; their agreement with the full window is the real test. */
const HALF_PROMINENCE_DB = 3;
/**
 * A real skin pulse is faint (0.1-0.5% colour change), so the band SNR gate is
 * gentler here than for a lone estimate; the halves and the steadiness check
 * (steadyPulse) keep noise out.
 */
const CONFIRM_SNR_DB = -3;

/**
 * The pulse, only if the whole window and each half of it (two independent
 * stretches of video) all find the same rate; otherwise null. Noise peaks and
 * colour drift rarely agree with themselves like that.
 */
export function confirmPulse(samples: PulseSample[]): PulseEstimate | null {
  const full = estimatePulse(samples, MIN_PULSE_SECONDS, PULSE_PROMINENCE_DB, CONFIRM_SNR_DB);
  if (!full.reliable) return null;
  const middle = (samples[0].t + samples[samples.length - 1].t) / 2;
  const halves = [samples.filter((s) => s.t <= middle), samples.filter((s) => s.t >= middle)];
  const agree = halves.every((half) => {
    const estimate = estimatePulse(half, MIN_HALF_SECONDS, HALF_PROMINENCE_DB, CONFIRM_SNR_DB);
    return estimate.reliable && Math.abs(estimate.bpm - full.bpm) <= CONFIRM_TOLERANCE_BPM;
  });
  return agree ? full : null;
}

/** Checks looked back over (3 s at two a second), how many must agree, and how closely. */
const STEADY_WINDOW = 6;
const STEADY_AGREEING = 4;
const STEADY_SPREAD_BPM = 4;

/**
 * The pulse to lock in, from the latest checks (null where a check confirmed
 * nothing): the latest and enough of the recent ones must agree. A real pulse
 * holds its rate as new video comes in; chance peaks in noise move around.
 */
export function steadyPulse(checks: (PulseEstimate | null)[]): PulseEstimate | null {
  const latest = checks[checks.length - 1];
  if (!latest) return null;
  const agreeing = checks
    .slice(-STEADY_WINDOW)
    .filter((p): p is PulseEstimate => !!p && Math.abs(p.bpm - latest.bpm) <= STEADY_SPREAD_BPM);
  const rates = agreeing.map((p) => p.bpm);
  if (rates.length < STEADY_AGREEING || Math.max(...rates) - Math.min(...rates) > STEADY_SPREAD_BPM) return null;
  return { ...latest, bpm: Math.round(mean(rates)) };
}

const PULSE_WINDOW_MS = 12000;
const PULSE_CHECK_INTERVAL_MS = 500;

/**
 * Follows the skin colour during the still centre pose: keeps the last 12 s,
 * checks for a confirmed pulse twice a second, and locks it once it is steady
 * (usually 11-13 s into a still pose; faint pulses can take up to ~20 s).
 */
export class PulseTracker {
  /** The colour samples in the current window (oldest first). */
  readonly samples: PulseSample[] = [];
  locked: PulseEstimate | null = null;
  private checks: (PulseEstimate | null)[] = [];
  private lastCheck = -Infinity;

  /** Adds one colour sample (t in ms); returns the pulse once it is locked. */
  add(sample: PulseSample): PulseEstimate | null {
    if (this.locked) return this.locked;
    this.samples.push(sample);
    while (sample.t - this.samples[0].t > PULSE_WINDOW_MS) this.samples.shift();
    if (sample.t - this.lastCheck < PULSE_CHECK_INTERVAL_MS) return null;
    this.lastCheck = sample.t;
    this.checks.push(confirmPulse(this.samples));
    this.locked = steadyPulse(this.checks);
    return this.locked;
  }
}

// ── Scan aggregation ─────────────────────────────────────────────────────────

/** Median of the measured values; NaN when none of them could be measured. */
function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Combines the frames of a multi-pose scan: per pose, the best frames that meet
 * the quality bar (or just the single best one if none do), then the median of
 * every measure across all of them, so a single odd frame can't move the result.
 */
export function aggregateScan(stageFrames: FrameMeasures[][], topPerStage = 3, minQuality = 65): FrameMeasures | null {
  const picked: FrameMeasures[] = [];
  for (const frames of stageFrames) {
    const ranked = [...frames].sort((a, b) => b.quality - a.quality);
    const good = ranked.filter((f) => f.quality >= minQuality);
    picked.push(...(good.length ? good.slice(0, topPerStage) : ranked.slice(0, 1)));
  }
  if (!picked.length) return null;

  const best = picked.reduce((a, b) => (b.quality > a.quality ? b : a));
  const result: FrameMeasures = { ...best };
  for (const key of Object.keys(best) as (keyof FrameMeasures)[]) {
    if (typeof best[key] === 'number') {
      (result[key] as number) = median(picked.map((f) => f[key] as number));
    }
  }
  return result;
}
