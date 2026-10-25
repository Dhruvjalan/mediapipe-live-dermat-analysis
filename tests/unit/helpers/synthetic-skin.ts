// Synthetic skin images with known properties, for testing the scan engine
// without a camera. Every generator is deterministic (seeded).
import type { Landmark, RgbaImage } from '../../../src/tasks/dermatology-engine';

export type Rgb = [number, number, number];

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function skinPatch(width: number, height: number, rgb: Rgb): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { data, width, height };
}

function mapPixels(img: RgbaImage, fn: (x: number, y: number, rgb: Rgb) => Rgb): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = fn(x, y, [img.data[i], img.data[i + 1], img.data[i + 2]]);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: img.width, height: img.height };
}

/** Grain: the same random brightness offset on all three channels of each pixel. */
export function withNoise(img: RgbaImage, sigma: number, seed = 1): RgbaImage {
  const rand = seededRandom(seed);
  return mapPixels(img, (_x, _y, [r, g, b]) => {
    const n = sigma * gaussian(rand);
    return [r + n, g + n, b + n];
  });
}

/** Independent noise on each colour channel (colour noise from a dim camera). */
export function withColourNoise(img: RgbaImage, sigma: number, seed = 1): RgbaImage {
  const rand = seededRandom(seed);
  return mapPixels(img, (_x, _y, [r, g, b]) => [
    r + sigma * gaussian(rand),
    g + sigma * gaussian(rand),
    b + sigma * gaussian(rand),
  ]);
}

/**
 * Rough skin: smooth random bumps a few pixels across, as relative brightness
 * changes with the given standard deviation. Unlike pixel grain, these are
 * spatially correlated, which is what separates texture from camera noise.
 */
export function withBumps(img: RgbaImage, opts: { amplitude: number; seed: number }): RgbaImage {
  const { width: w, height: h } = img;
  const rand = seededRandom(opts.seed);
  let field = Float64Array.from({ length: w * h }, () => gaussian(rand));
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += field[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
          }
        }
        out[y * w + x] = sum / 9;
      }
    }
    field = out;
  }
  const sd = Math.sqrt(field.reduce((s, v) => s + v * v, 0) / field.length);
  return mapPixels(img, (x, y, [r, g, b]) => {
    const k = 1 + (opts.amplitude * field[y * w + x]) / sd;
    return [r * k, g * k, b * k];
  });
}

/** The same scene under brighter or dimmer light. */
export function scaledBrightness(img: RgbaImage, factor: number): RgbaImage {
  return mapPixels(img, (_x, _y, [r, g, b]) => [r * factor, g * factor, b * factor]);
}

/** Horizontal dark lines, like forehead wrinkles. */
export function withHorizontalLines(img: RgbaImage, opts: { every: number; darken: number; thickness?: number }) {
  const thickness = opts.thickness ?? 1;
  const offset = Math.floor(opts.every / 2);
  return mapPixels(img, (_x, y, [r, g, b]) => {
    if ((y + offset) % opts.every >= thickness) return [r, g, b];
    const k = 1 - opts.darken;
    return [r * k, g * k, b * k];
  });
}

/** Round spots: darker (pigment, pores) and/or tinted (red acne spots). */
export function withSpots(
  img: RgbaImage,
  opts: { count: number; radius: number; seed: number; darken?: number; tint?: Rgb }
): RgbaImage {
  const rand = seededRandom(opts.seed);
  const centers = Array.from({ length: opts.count }, () => [
    Math.floor(rand() * img.width),
    Math.floor(rand() * img.height),
  ]);
  const k = 1 - (opts.darken ?? 0);
  const tint = opts.tint ?? [0, 0, 0];
  const r2 = opts.radius * opts.radius;
  return mapPixels(img, (x, y, [r, g, b]) => {
    const inside = centers.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= r2);
    return inside ? [r * k + tint[0], g * k + tint[1], b * k + tint[2]] : [r, g, b];
  });
}

/** Turns exactly `fraction` of the pixels into a given colour (white = specular shine). */
export function withHighlights(img: RgbaImage, opts: { fraction: number; seed: number; color?: Rgb }): RgbaImage {
  const rand = seededRandom(opts.seed);
  const total = img.width * img.height;
  const order = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = new Set(order.slice(0, Math.round(total * opts.fraction)));
  const color = opts.color ?? [248, 248, 248];
  return mapPixels(img, (x, y, rgb) => (chosen.has(y * img.width + x) ? color : rgb));
}

/** Soft, patchy brightness variation (uneven tone). */
export function withBlotches(img: RgbaImage, opts: { amplitude: number; period: number }): RgbaImage {
  return mapPixels(img, (x, y, [r, g, b]) => {
    const k = 1 + opts.amplitude * Math.sin((2 * Math.PI * x) / opts.period) * Math.sin((2 * Math.PI * y) / opts.period);
    return [r * k, g * k, b * k];
  });
}

/** Darkens a rectangle of the image (e.g. under the eyes in a full frame). */
export function withDarkenedRect(
  img: RgbaImage,
  rect: { x: number; y: number; width: number; height: number },
  darken: number
): RgbaImage {
  return mapPixels(img, (x, y, [r, g, b]) => {
    const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    const k = inside ? 1 - darken : 1;
    return [r * k, g * k, b * k];
  });
}

/**
 * A frontal face in a 640x480 frame: eye centres at (270,200) and (370,200),
 * so the inter-ocular distance is 100 px. Only the landmarks the engine uses are placed.
 */
export function frontalLandmarks(opts: { scale?: number; shiftX?: number } = {}): Landmark[] {
  const scale = opts.scale ?? 1;
  const shiftX = opts.shiftX ?? 0;
  const landmarks: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const place = (index: number, x: number, y: number) => {
    landmarks[index] = { x: (320 + (x - 320) * scale + shiftX) / 640, y: (200 + (y - 200) * scale) / 480, z: 0 };
  };
  // Subject's right eye (image left): corners, lids, and EAR points.
  place(33, 250, 200);
  place(133, 290, 200);
  place(159, 270, 192);
  place(145, 270, 208);
  place(160, 262, 194);
  place(158, 278, 194);
  place(153, 278, 206);
  place(144, 262, 206);
  // Subject's left eye.
  place(362, 350, 200);
  place(263, 390, 200);
  place(386, 370, 192);
  place(374, 370, 208);
  place(385, 362, 194);
  place(387, 378, 194);
  place(380, 362, 206);
  place(373, 378, 206);
  // Forehead midline, nose and cheeks.
  place(10, 320, 110);
  place(151, 320, 140);
  place(9, 320, 175);
  place(6, 320, 210);
  place(195, 320, 245);
  place(4, 320, 265);
  place(205, 270, 270);
  place(425, 370, 270);
  return landmarks;
}
