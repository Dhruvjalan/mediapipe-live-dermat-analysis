import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acneScore,
  aggregateScan,
  analyzeFrame,
  darkCircleScore,
  deriveCompositeMetrics,
  downsample,
  estimatePulse,
  eyeAspectRatio,
  faceRegions,
  frameQuality,
  noiseLevel,
  pigmentationScore,
  poreDensity,
  rednessIndex,
  sheenScore,
  skinColour,
  specularFraction,
  steadyPulse,
  PulseTracker,
  confirmPulse,
  textureScore,
  toneEvenness,
  wrinkleScore,
  yellownessIndex,
  type FrameMeasures,
  type PulseSample,
  type RgbaImage,
} from '../../src/tasks/dermatology-engine';
import {
  frontalLandmarks,
  gaussian,
  scaledBrightness,
  seededRandom,
  skinPatch,
  withBlotches,
  withBumps,
  withColourNoise,
  withDarkenedRect,
  withHighlights,
  withHorizontalLines,
  withNoise,
  withSpots,
  type Rgb,
} from './helpers/synthetic-skin';

const SKIN: Rgb = [190, 140, 115];
const W = 96;
const H = 48;
const plain = () => withNoise(skinPatch(W, H, SKIN), 2);

// Fitzpatrick I-VI reference colours.
const SKIN_TONES: Rgb[] = [
  [244, 208, 177],
  [232, 183, 148],
  [210, 158, 120],
  [186, 126, 86],
  [140, 85, 54],
  [80, 50, 35],
];

describe('textureScore', () => {
  test('reads a perfectly even patch as fully smooth', () => {
    assert.equal(textureScore(skinPatch(W, H, SKIN)), 100);
  });

  test('reads bumpy skin as rough and even skin as smooth', () => {
    const bumpy = textureScore(withBumps(skinPatch(W, H, SKIN), { amplitude: 0.06, seed: 4 }));
    assert.ok(bumpy <= 45, `bumpy ${bumpy}`);
    assert.ok(textureScore(plain()) >= 85, `plain ${textureScore(plain())}`);
  });

  test('gives the same reading in dim light, with the same camera noise', () => {
    // Sensor noise stays the same in absolute terms when the light drops. When grain
    // dominates, single frames wobble by several points, so like the scan this takes
    // the median over several frames.
    const skin = withBumps(skinPatch(W, H, SKIN), { amplitude: 0.03, seed: 4 });
    const medianOverFrames = (img: RgbaImage) =>
      [8, 9, 10, 11, 12].map((seed) => textureScore(withNoise(img, 3, seed))).sort((a, b) => a - b)[2];
    const bright = medianOverFrames(skin);
    const dim = medianOverFrames(scaledBrightness(skin, 0.5));
    assert.ok(Math.abs(bright - dim) <= 8, `bright ${bright} dim ${dim}`);
  });
});

describe('fairness across skin tones', () => {
  test('reads flawless skin with ordinary camera noise as clear on every skin tone', () => {
    for (const tone of SKIN_TONES) {
      const skin = withNoise(skinPatch(W, H, tone), 3, 21);
      const readings = {
        texture: textureScore(skin),
        pores: poreDensity(skin),
        wrinkles: wrinkleScore(skin),
        pigmentation: pigmentationScore(skin),
        acne: acneScore(skin),
      };
      const ok =
        readings.texture >= 85 &&
        readings.pores < 3 &&
        readings.wrinkles <= 8 &&
        readings.pigmentation <= 5 &&
        readings.acne < 0.3;
      assert.ok(ok, `${tone}: ${JSON.stringify(readings)}`);
    }
  });

  test('reads flawless skin as smooth on every skin tone at in-between noise levels too', () => {
    for (const sigma of [2.2, 2.4, 2.6]) {
      for (const tone of SKIN_TONES) {
        const texture = textureScore(withNoise(skinPatch(W, H, tone), sigma, 31));
        assert.ok(texture >= 85, `${tone} at sigma ${sigma}: texture ${texture}`);
      }
    }
  });

  test('does not read colour noise from a dim camera as acne', () => {
    for (const tone of SKIN_TONES) {
      const acne = acneScore(withColourNoise(skinPatch(W, H, tone), 4, 22));
      assert.ok(acne < 0.3, `${tone}: ${acne}`);
    }
  });

  test('still finds real pores and lines on dark skin', () => {
    const darkSkin = () => withNoise(skinPatch(W, H, SKIN_TONES[4]), 3, 23);
    const pores = poreDensity(withSpots(darkSkin(), { count: 100, radius: 0.5, darken: 0.35, seed: 24 }));
    const lines = wrinkleScore(withHorizontalLines(darkSkin(), { every: 6, darken: 0.2 }));
    assert.ok(pores >= 1.5, `pores ${pores}`);
    assert.ok(lines >= 30, `lines ${lines}`);
  });
});

describe('wrinkleScore', () => {
  const lined = (darken: number) => withHorizontalLines(plain(), { every: 6, darken });

  test('finds horizontal lines across the forehead', () => {
    assert.ok(wrinkleScore(lined(0.15)) >= 40, `got ${wrinkleScore(lined(0.15))}`);
  });

  test('reads plain skin as line-free', () => {
    assert.ok(wrinkleScore(plain()) <= 5, `got ${wrinkleScore(plain())}`);
  });

  test('scores deeper lines higher than faint ones', () => {
    assert.ok(wrinkleScore(lined(0.25)) > wrinkleScore(lined(0.06)));
  });

  test('does not mistake round spots for lines', () => {
    const spotted = withSpots(plain(), { count: 60, radius: 1.5, darken: 0.15, seed: 3 });
    assert.ok(wrinkleScore(spotted) < wrinkleScore(lined(0.15)) / 3, `spots ${wrinkleScore(spotted)}`);
  });
});

describe('poreDensity', () => {
  test('counts small dark points', () => {
    const pores = withSpots(plain(), { count: 300, radius: 0.5, darken: 0.2, seed: 5 });
    assert.ok(poreDensity(pores) >= 4, `got ${poreDensity(pores)}`);
  });

  test('reads even skin with camera noise as nearly pore-free', () => {
    assert.ok(poreDensity(plain()) < 1, `got ${poreDensity(plain())}`);
  });

  test('never reads more pores as fewer, however dense they are', () => {
    const readings = [150, 300, 600, 1200].map((count) =>
      poreDensity(withSpots(plain(), { count, radius: 0.5, darken: 0.2, seed: 5 }))
    );
    for (let i = 1; i < readings.length; i++) assert.ok(readings[i] > readings[i - 1], readings.join(' -> '));
  });

  test('reads densely pitted skin as rougher than lightly pitted skin', () => {
    const light = textureScore(withSpots(plain(), { count: 300, radius: 0.5, darken: 0.2, seed: 5 }));
    const dense = textureScore(withSpots(plain(), { count: 1200, radius: 0.5, darken: 0.2, seed: 5 }));
    assert.ok(dense < light, `light ${light}, dense ${dense}`);
  });
});

describe('pigmentationScore', () => {
  test('measures dark spots covering part of the skin', () => {
    const spotted = withSpots(plain(), { count: 16, radius: 3, darken: 0.2, seed: 7 });
    assert.ok(pigmentationScore(spotted) >= 25, `got ${pigmentationScore(spotted)}`);
  });

  test('reads even skin as even', () => {
    assert.ok(pigmentationScore(plain()) <= 5, `got ${pigmentationScore(plain())}`);
  });

  test('does not count tiny pores as pigment spots', () => {
    const pores = withSpots(plain(), { count: 300, radius: 0.5, darken: 0.2, seed: 5 });
    assert.ok(pigmentationScore(pores) <= 5, `got ${pigmentationScore(pores)}`);
  });
});

describe('darkCircleScore', () => {
  const cheek = skinPatch(40, 20, SKIN);

  test('measures how much darker the under-eye is than the cheek, in percent', () => {
    const score = darkCircleScore(scaledBrightness(cheek, 0.8), cheek);
    assert.ok(Math.abs(score - 20) <= 1, `got ${score}`);
  });

  test('reads a matching under-eye and cheek as no dark circles', () => {
    assert.equal(darkCircleScore(cheek, cheek), 0);
  });

  test('never goes below zero when the under-eye is brighter', () => {
    assert.equal(darkCircleScore(cheek, scaledBrightness(cheek, 0.8)), 0);
  });
});

describe('acneScore', () => {
  test('finds small red spots', () => {
    const spots = withSpots(plain(), { count: 10, radius: 2, tint: [35, -30, -20], seed: 9 });
    assert.ok(acneScore(spots) >= 1.5, `got ${acneScore(spots)}`);
  });

  test('does not count evenly red skin as acne', () => {
    assert.ok(acneScore(skinPatch(W, H, [200, 120, 100])) < 0.3);
  });

  test('does not count dark (non-red) spots as acne', () => {
    const dark = withSpots(plain(), { count: 10, radius: 2, darken: 0.25, seed: 9 });
    assert.ok(acneScore(dark) < 0.3, `got ${acneScore(dark)}`);
  });

  test('never reads more red spots as fewer, however dense they are', () => {
    const readings = [60, 150, 300].map((count) =>
      acneScore(withSpots(plain(), { count, radius: 1, tint: [35, -30, -20], seed: 9 }))
    );
    for (let i = 1; i < readings.length; i++) assert.ok(readings[i] > readings[i - 1], readings.join(' -> '));
  });
});

describe('rednessIndex and yellownessIndex', () => {
  test('read every normal skin tone as low redness', () => {
    for (const tone of SKIN_TONES) {
      const index = rednessIndex(skinPatch(20, 20, tone));
      assert.ok(index <= 10, `${tone} gave ${index}`);
    }
  });

  test('read flushed skin as high redness', () => {
    assert.ok(rednessIndex(skinPatch(20, 20, [225, 150, 140])) >= 20);
    assert.ok(rednessIndex(skinPatch(20, 20, [200, 120, 100])) >= 18);
  });

  test('report a greyish, almost colourless image as not measured rather than normal', () => {
    for (const grey of [
      [145, 148, 155],
      [150, 152, 146],
    ] as Rgb[]) {
      assert.ok(Number.isNaN(rednessIndex(skinPatch(20, 20, grey))), `${grey}`);
      assert.ok(Number.isNaN(yellownessIndex(skinPatch(20, 20, grey))), `${grey}`);
    }
  });

  test('keep every normal skin tone below the yellow-tint threshold and jaundiced skin above it', () => {
    for (const tone of SKIN_TONES) {
      assert.ok(yellownessIndex(skinPatch(20, 20, tone)) <= 70, `${tone}`);
    }
    assert.ok(yellownessIndex(skinPatch(20, 20, [230, 200, 120])) >= 78);
    assert.ok(yellownessIndex(skinPatch(20, 20, [160, 120, 50])) >= 78);
  });
});

describe('specularFraction', () => {
  test('measures the share of shiny highlight pixels, in percent', () => {
    const shiny = withHighlights(skinPatch(W, H, SKIN), { fraction: 0.05, seed: 11 });
    assert.ok(Math.abs(specularFraction(shiny) - 5) <= 0.5, `got ${specularFraction(shiny)}`);
  });

  test('reads matte skin as zero', () => {
    assert.equal(specularFraction(plain()), 0);
  });

  test('ignores bright pixels that are strongly coloured', () => {
    const yellow = withHighlights(skinPatch(W, H, SKIN), { fraction: 0.05, seed: 11, color: [250, 235, 120] });
    assert.equal(specularFraction(yellow), 0);
  });
});

describe('toneEvenness', () => {
  test('reads camera noise on even skin as even', () => {
    assert.ok(toneEvenness(plain()) >= 85, `got ${toneEvenness(plain())}`);
  });

  test('reads blotchy skin as uneven', () => {
    const blotchy = withBlotches(plain(), { amplitude: 0.1, period: 24 });
    assert.ok(toneEvenness(blotchy) <= 70, `got ${toneEvenness(blotchy)}`);
  });
});

describe('downsample', () => {
  test('averages each block of pixels', () => {
    const img = skinPatch(4, 2, [0, 0, 0]);
    [10, 20, 30, 40, 50, 60, 70, 80].forEach((v, i) => img.data.set([v, v, v], i * 4));
    const small = downsample(img, 2);
    assert.equal(small.width, 2);
    assert.equal(small.height, 1);
    assert.equal(small.data[0], 35); // (10 + 20 + 50 + 60) / 4
    assert.equal(small.data[4], 55); // (30 + 40 + 70 + 80) / 4
  });
});

describe('sheenScore and deriveCompositeMetrics', () => {
  test('rewards a light natural sheen over both matte and greasy skin', () => {
    assert.ok(sheenScore(1.5) > sheenScore(0));
    assert.ok(sheenScore(1.5) > sheenScore(12));
  });

  test('lower elasticity and hydration, and higher sun damage, as lines deepen', () => {
    const base = { texture: 80, wrinkles: 10, pigmentation: 10, evenness: 90, oiliness: 2 };
    const lined = deriveCompositeMetrics({ ...base, wrinkles: 50 });
    const smooth = deriveCompositeMetrics(base);
    assert.ok(lined.elasticity < smooth.elasticity);
    assert.ok(lined.hydration < smooth.hydration);
    assert.ok(lined.uvDamage > smooth.uvDamage);
  });

  test('gives even skin with a light sheen more glow than uneven matte skin', () => {
    const glowing = deriveCompositeMetrics({ texture: 80, wrinkles: 10, pigmentation: 10, evenness: 95, oiliness: 1.5 });
    const dull = deriveCompositeMetrics({ texture: 80, wrinkles: 10, pigmentation: 10, evenness: 40, oiliness: 0 });
    assert.ok(glowing.glow > dull.glow + 20, `glowing ${glowing.glow} dull ${dull.glow}`);
  });
});

describe('eyeAspectRatio', () => {
  test('is about 0.3 for an open eye and near zero for a closed one', () => {
    const eye = (open: number) => [
      { x: 0, y: 0 },
      { x: 13, y: -open / 2 },
      { x: 27, y: -open / 2 },
      { x: 40, y: 0 },
      { x: 27, y: open / 2 },
      { x: 13, y: open / 2 },
    ];
    assert.ok(Math.abs(eyeAspectRatio(eye(12)) - 0.3) < 0.01);
    assert.ok(eyeAspectRatio(eye(1)) < 0.05);
  });
});

describe('noiseLevel', () => {
  test('estimates the strength of added camera grain', () => {
    const level = noiseLevel(withNoise(skinPatch(W, H, SKIN), 8));
    assert.ok(Math.abs(level - 8) <= 1.5, `got ${level}`);
  });

  test('follows the grain smoothly instead of snapping to whole pixel levels', () => {
    const sigmas = [1.5, 2, 2.5, 3, 3.5];
    const levels = sigmas.map((sigma) => noiseLevel(withNoise(skinPatch(W, H, SKIN), sigma, 3)));
    const shown = levels.map((l) => l.toFixed(2)).join(' -> ');
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] > levels[i - 1], shown);
    sigmas.forEach((sigma, i) => assert.ok(Math.abs(levels[i] - sigma) <= 0.45, shown));
  });

  test('is not fooled by dense pores into reporting heavy grain', () => {
    const pitted = withSpots(withNoise(skinPatch(W, H, SKIN), 3, 1), { count: 1200, radius: 0.5, darken: 0.2, seed: 5 });
    const level = noiseLevel(pitted);
    assert.ok(level < 4.5, `got ${level}`);
  });

  test('reads a clean patch, even with soft shading, as nearly noise-free', () => {
    assert.ok(noiseLevel(withBlotches(skinPatch(W, H, SKIN), { amplitude: 0.1, period: 24 })) < 1);
  });
});

describe('frameQuality', () => {
  // noise is relative to the skin's brightness (sensor noise / mean luma)
  const good = { sharpness: 150, meanLuma: 140, clipped: 0, faceSize: 100, uniformity: 95, noise: 0.015 };

  test('rates a grainy low-light frame below the 65 cut-off', () => {
    assert.ok(frameQuality({ ...good, noise: 0.1 }) < 65);
  });

  test('keeps dark skin under ordinary camera noise usable', () => {
    // Fitzpatrick VI (mean luma ~57) with sensor noise of 3 levels
    assert.ok(frameQuality({ ...good, meanLuma: 57, noise: 3 / 57 }) >= 65);
  });

  test('rates a sharp, well-lit, close frame highly', () => {
    assert.ok(frameQuality(good) >= 90);
  });

  test('rates blurry, dark, overexposed or distant frames below the 65 cut-off', () => {
    assert.ok(frameQuality({ ...good, sharpness: 5 }) < 65);
    assert.ok(frameQuality({ ...good, meanLuma: 35 }) < 65);
    assert.ok(frameQuality({ ...good, meanLuma: 235, clipped: 0.4 }) < 65);
    assert.ok(frameQuality({ ...good, faceSize: 25 }) < 65);
  });

  test('keeps a frame of a turned head usable', () => {
    assert.ok(frameQuality({ ...good, uniformity: 65 }) >= 65);
  });
});

describe('faceRegions', () => {
  test('places each under-eye region just below its lower eyelid', () => {
    const regions = faceRegions(frontalLandmarks(), 640, 480)!;
    for (const [rect, lidY, eyeX] of [
      [regions.rightUnderEye, 208, 270],
      [regions.leftUnderEye, 208, 370],
    ] as const) {
      assert.ok(rect.y > lidY && rect.y < lidY + 20, `top ${rect.y}`);
      assert.ok(Math.abs(rect.x + rect.width / 2 - eyeX) <= 2, `centre ${rect.x + rect.width / 2}`);
    }
  });

  test('centres the cheek regions on the cheek landmarks', () => {
    const { rightCheek, leftCheek } = faceRegions(frontalLandmarks(), 640, 480)!;
    assert.ok(Math.abs(rightCheek.x + rightCheek.width / 2 - 270) <= 1);
    assert.ok(Math.abs(leftCheek.y + leftCheek.height / 2 - 270) <= 1);
  });

  test('scales the regions with the size of the face', () => {
    const near = faceRegions(frontalLandmarks({ scale: 2 }), 640, 480)!;
    const far = faceRegions(frontalLandmarks(), 640, 480)!;
    assert.equal(far.faceSize, 100);
    assert.ok(Math.abs(near.forehead.width - 2 * far.forehead.width) <= 2);
  });

  test('gives up on a face that is too small or partly out of frame', () => {
    assert.equal(faceRegions(frontalLandmarks({ scale: 0.2 }), 640, 480), null);
    assert.equal(faceRegions(frontalLandmarks({ shiftX: -300 }), 640, 480), null);
  });
});

describe('analyzeFrame', () => {
  const frame = () => withNoise(skinPatch(640, 480, SKIN), 2);

  test('measures a clean, evenly lit face as good quality with no dark circles', () => {
    const result = analyzeFrame(frame(), frontalLandmarks())!;
    assert.ok(result.measures.quality >= 80, `quality ${result.measures.quality}`);
    assert.ok(result.measures.darkCircles < 2, `dark circles ${result.measures.darkCircles}`);
  });

  test('picks up darkness painted under both eyes', () => {
    let img = withDarkenedRect(frame(), { x: 240, y: 210, width: 60, height: 30 }, 0.25);
    img = withDarkenedRect(img, { x: 340, y: 210, width: 60, height: 30 }, 0.25);
    const result = analyzeFrame(img, frontalLandmarks())!;
    assert.ok(result.measures.darkCircles >= 15, `dark circles ${result.measures.darkCircles}`);
  });

  test('returns null when there is no measurable face', () => {
    assert.equal(analyzeFrame(frame(), frontalLandmarks({ scale: 0.2 })), null);
  });

  test('reads the same skin colour whatever colour the wall behind is', () => {
    const face = { x: 190, y: 90, width: 260, height: 240 };
    const onWall = (wall: Rgb) => {
      const img = skinPatch(640, 480, wall);
      const skin = withNoise(skinPatch(face.width, face.height, SKIN), 2);
      for (let y = 0; y < face.height; y++) {
        img.data.set(skin.data.subarray(y * face.width * 4, (y + 1) * face.width * 4), ((face.y + y) * 640 + face.x) * 4);
      }
      return analyzeFrame(img, frontalLandmarks())!.measures;
    };
    const readings = ([[60, 90, 200], [240, 240, 240], [230, 140, 50]] as Rgb[]).map(onWall);
    for (const m of readings) {
      assert.ok(Math.abs(m.erythema - readings[1].erythema) <= 1, `redness ${readings.map((r) => r.erythema)}`);
      assert.ok(Math.abs(m.yellowness - readings[1].yellowness) <= 1, `hue ${readings.map((r) => r.yellowness)}`);
    }
  });

  test('keeps the true skin hue when the face fills the frame', () => {
    // SKIN has a CIELAB hue of 52.9 degrees.
    const { yellowness, erythema } = analyzeFrame(frame(), frontalLandmarks())!.measures;
    assert.ok(Math.abs(yellowness - 52.9) <= 2, `hue ${yellowness}`);
    assert.ok(Math.abs(erythema - 7.1) <= 2, `redness ${erythema}`);
  });
});

// ── Pulse ────────────────────────────────────────────────────────────────────

describe('skinColour', () => {
  test('averages the colour of all the skin patches, weighted by their size', () => {
    const colour = skinColour([skinPatch(10, 10, [200, 100, 50]), skinPatch(30, 10, [100, 60, 50])]);
    assert.deepEqual(colour, { r: 125, g: 70, b: 50 });
  });
});

// Blood volume pulse changes the green channel most (relative strengths from de Haan & van Leest, 2014).
const PULSE_SIGNATURE = [0.33, 0.77, 0.53];

function pulseSamples(opts: {
  bpm: number;
  seconds: number;
  fps?: number;
  amplitude?: number;
  noise?: number;
  /** Linear brightness change over the whole recording. */
  drift?: number;
  /** Per-sample step of a random walk in each colour channel (auto-exposure/white-balance wander). */
  walk?: number;
  seed?: number;
}): PulseSample[] {
  const { bpm, seconds, fps = 25, amplitude = 0.01, noise = 0.002, drift = 0, walk = 0, seed = 1 } = opts;
  const rand = seededRandom(seed);
  const base = [150, 110, 90];
  const wander = [0, 0, 0];
  const samples: PulseSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += (1000 / fps) * (0.8 + 0.4 * rand())) {
    const wave = Math.sin(2 * Math.PI * (bpm / 60) * (t / 1000));
    const light = 1 + drift * (t / (seconds * 1000));
    for (let i = 0; i < 3; i++) wander[i] += walk * gaussian(rand);
    const [r, g, b] = base.map(
      (c, i) => c * light * (1 + wander[i] + amplitude * PULSE_SIGNATURE[i] * wave + noise * gaussian(rand))
    );
    samples.push({ t, r, g, b });
  }
  return samples;
}

describe('estimatePulse', () => {
  test('recovers a 72 BPM pulse within 3 BPM', () => {
    const pulse = estimatePulse(pulseSamples({ bpm: 72, seconds: 10 }));
    assert.equal(pulse.reliable, true);
    assert.ok(Math.abs(pulse.bpm - 72) <= 3, `got ${pulse.bpm}`);
  });

  test('recovers a fast 110 BPM pulse', () => {
    const pulse = estimatePulse(pulseSamples({ bpm: 110, seconds: 10, seed: 2 }));
    assert.equal(pulse.reliable, true);
    assert.ok(Math.abs(pulse.bpm - 110) <= 3, `got ${pulse.bpm}`);
  });

  test('copes with the room light slowly changing', () => {
    const pulse = estimatePulse(pulseSamples({ bpm: 65, seconds: 10, drift: 0.05, seed: 3 }));
    assert.equal(pulse.reliable, true);
    assert.ok(Math.abs(pulse.bpm - 65) <= 3, `got ${pulse.bpm}`);
  });

  test('finds the pulse anywhere from 50 to 160 BPM', () => {
    for (const bpm of [50, 75, 100, 130, 160]) {
      const pulse = estimatePulse(pulseSamples({ bpm, seconds: 12, seed: bpm }));
      assert.equal(pulse.reliable, true, `${bpm} BPM unreliable (snr ${pulse.snr})`);
      assert.ok(Math.abs(pulse.bpm - bpm) <= 3, `${bpm} BPM read as ${pulse.bpm}`);
    }
  });

  test('reports no reliable pulse from noise alone', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const pulse = estimatePulse(pulseSamples({ bpm: 72, seconds: 10, amplitude: 0, noise: 0.003, seed }));
      assert.equal(pulse.reliable, false, `seed ${seed} gave ${pulse.bpm} BPM (snr ${pulse.snr})`);
    }
  });

  test('needs at least 6 seconds of signal', () => {
    assert.equal(estimatePulse(pulseSamples({ bpm: 72, seconds: 4 })).reliable, false);
  });

  test('does not report the edge of the heart-rate band as a pulse', () => {
    // A brightness ramp has its spectral maximum at the lowest frequency checked.
    const ramp = pulseSamples({ bpm: 72, seconds: 10, amplitude: 0, noise: 0.0005, drift: 0.15 });
    assert.equal(estimatePulse(ramp).reliable, false);
  });

  test('gives no reading at too low a frame rate', () => {
    assert.equal(estimatePulse(pulseSamples({ bpm: 72, seconds: 10, fps: 5 })).reliable, false);
  });

  test('reports a stronger perfusion for a stronger pulse', () => {
    const strong = estimatePulse(pulseSamples({ bpm: 72, seconds: 10, amplitude: 0.02 }));
    const weak = estimatePulse(pulseSamples({ bpm: 72, seconds: 10, amplitude: 0.006 }));
    assert.ok(strong.perfusion > weak.perfusion, `strong ${strong.perfusion} weak ${weak.perfusion}`);
  });
});

describe('confirmPulse', () => {
  test('confirms a real pulse while the camera colour slowly wanders', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const bpm = 56 + seed * 10;
      const pulse = confirmPulse(pulseSamples({ bpm, seconds: 12, walk: 0.0006, seed }));
      assert.ok(pulse && Math.abs(pulse.bpm - bpm) <= 3, `seed ${seed}: got ${pulse?.bpm} for ${bpm} BPM`);
    }
  });

  test('never confirms a pulse from camera noise alone', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const pulse = confirmPulse(pulseSamples({ bpm: 72, seconds: 12, amplitude: 0, noise: 0.003, seed }));
      assert.equal(pulse, null, `seed ${seed} gave ${pulse?.bpm} BPM`);
    }
  });

  test('never confirms a pulse from slow colour drift alone', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const pulse = confirmPulse(pulseSamples({ bpm: 72, seconds: 12, amplitude: 0, noise: 0.001, walk: 0.0006, seed }));
      assert.equal(pulse, null, `seed ${seed} gave ${pulse?.bpm} BPM`);
    }
  });
});

describe('steadyPulse', () => {
  const found = (bpm: number) => ({ bpm, snr: 2, prominence: 9, reliable: true, perfusion: 40 });

  test('locks once four of the last six checks agree, at their average rate', () => {
    assert.equal(steadyPulse([found(70), null, found(72), found(73), null, found(71)])?.bpm, 72);
  });

  test('waits until enough recent checks agree', () => {
    assert.equal(steadyPulse([found(70), found(72), found(73)]), null);
    assert.equal(steadyPulse([found(70), found(71), null, null, found(72), found(73), null, found(71)]), null);
  });

  test('waits while the latest check found nothing', () => {
    assert.equal(steadyPulse([found(70), found(71), found(72), found(71), found(70), null]), null);
  });

  test('does not lock while the rate jumps around', () => {
    assert.equal(steadyPulse([found(60), found(72), found(85), found(66), found(79), found(72)]), null);
  });
});

describe('PulseTracker', () => {
  // A real pulse changes skin colour by only ~0.1-0.5%; these runs use 0.2%, at a laptop's 15 fps.
  const track = (samples: PulseSample[]) => {
    const tracker = new PulseTracker();
    for (const sample of samples) tracker.add(sample);
    return tracker.locked;
  };

  test('locks onto a realistic pulse during the 20 s centre pose, never at a wrong rate', () => {
    // A wider simulation (60 runs) locks ~93% of these; a broken tracker would lock few or none.
    let correct = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const bpm = 58 + seed * 5;
      const pulse = track(pulseSamples({ bpm, seconds: 20, fps: 15, amplitude: 0.002, noise: 0.0005, walk: 0.0002, seed }));
      if (pulse) assert.ok(Math.abs(pulse.bpm - bpm) <= 4, `seed ${seed}: ${pulse.bpm} BPM for ${bpm}`);
      if (pulse) correct++;
    }
    assert.ok(correct >= 6, `locked ${correct} of 8 times`);
  });

  test('never locks onto camera noise or colour drift', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const noise = [0.0005, 0.001, 0.0015][seed % 3];
      const pulse = track(pulseSamples({ bpm: 72, seconds: 20, fps: 15, amplitude: 0, noise, walk: 0.0003, seed: 100 + seed }));
      assert.equal(pulse, null, `seed ${seed} gave ${pulse?.bpm} BPM`);
    }
  });
});

// ── Aggregation ──────────────────────────────────────────────────────────────

function frame(over: Partial<FrameMeasures>): FrameMeasures {
  return {
    erythema: 5,
    yellowness: 60,
    melanin: 30,
    pigmentation: 10,
    texture: 80,
    pores: 2,
    wrinkles: 10,
    darkCircles: 5,
    acne: 0.5,
    oiliness: 2,
    evenness: 90,
    fatigue: 0.3,
    luminance: 140,
    sharpness: 150,
    faceSize: 100,
    quality: 90,
    lighting: { lightingType: 'Even', uniformity: 95 },
    ...over,
  };
}

describe('aggregateScan', () => {
  test('uses the median so one bad frame cannot skew the result', () => {
    const stage = [80, 82, 81, 79, 20].map((texture) => frame({ texture }));
    assert.equal(aggregateScan([stage], 5).texture, 80);
  });

  test('prefers good-quality frames over poor ones', () => {
    const stage = [
      ...[1, 2, 3].map(() => frame({ texture: 80, quality: 90 })),
      ...[1, 2, 3].map(() => frame({ texture: 40, quality: 30 })),
    ];
    assert.equal(aggregateScan([stage], 3).texture, 80);
  });

  test('still uses the best frame of a stage when none meet the quality bar', () => {
    const result = aggregateScan([[frame({ texture: 50, quality: 40 }), frame({ texture: 30, quality: 20 })]], 3);
    assert.equal(result.texture, 50);
  });

  test('combines frames from every pose', () => {
    const result = aggregateScan([[frame({ wrinkles: 10 })], [frame({ wrinkles: 20 })], [frame({ wrinkles: 30 })]], 3);
    assert.equal(result.wrinkles, 20);
  });

  test('leaves out frames where a reading could not be measured', () => {
    const stage = [frame({ erythema: 4 }), frame({ erythema: Number.NaN }), frame({ erythema: 6 })];
    assert.equal(aggregateScan([stage], 3).erythema, 5);
  });

  test('keeps a reading that no frame could measure as not measured', () => {
    const stage = [frame({ yellowness: Number.NaN }), frame({ yellowness: Number.NaN })];
    assert.ok(Number.isNaN(aggregateScan([stage], 3).yellowness));
  });
});
