import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSkin, skinHealthScore, type SkinMetrics } from '../../src/services/skin-interpretation';

// A face with nothing to worry about, on the scales the scan engine produces.
const clear: SkinMetrics = {
  version: 2,
  health: 0,
  glow: 80,
  hydration: 80,
  melanin: 30,
  erythema: 3,
  oiliness: 2,
  pores: 1.5,
  texture: 85,
  wrinkles: 8,
  fatigue: 0.3,
  darkCircles: 4,
  heartRate: 70,
  perfusion: 50,
  yellowness: 60,
  imageQuality: 90,
  acne: 0.2,
  uvDamage: 10,
  elasticity: 85,
  pigmentation: 10,
};

const levelOf = (m: SkinMetrics, key: keyof SkinMetrics) => interpretSkin(m).find((r) => r.key === key)?.level;

describe('interpretSkin', () => {
  test('rates clearly healthy skin as good on every metric', () => {
    const notGood = interpretSkin(clear).filter((r) => r.level !== 'good');
    assert.deepEqual(notGood, []);
  });

  test('rates a value past the concern threshold as a concern and one in between as fair', () => {
    assert.equal(levelOf({ ...clear, acne: 6 }, 'acne'), 'concern');
    assert.equal(levelOf({ ...clear, acne: 2 }, 'acne'), 'fair');
  });

  test('reads higher-is-better metrics in the right direction', () => {
    assert.equal(levelOf({ ...clear, texture: 30 }, 'texture'), 'concern');
    assert.equal(levelOf({ ...clear, texture: 90 }, 'texture'), 'good');
    assert.equal(levelOf({ ...clear, hydration: 35 }, 'hydration'), 'concern');
  });

  test('never treats skin tone as a problem', () => {
    assert.equal(
      interpretSkin({ ...clear, melanin: 70 }).some((r) => r.level !== 'good'),
      false
    );
    assert.equal(skinHealthScore({ ...clear, melanin: 70 }), skinHealthScore(clear));
  });

  test('does not read the hue of very light or brown skin as a yellow tint', () => {
    // Hue angles of Fitzpatrick I and III-IV skin colours.
    assert.equal(levelOf({ ...clear, yellowness: 68 }, 'yellowness'), 'good');
    assert.equal(levelOf({ ...clear, yellowness: 62 }, 'yellowness'), 'good');
    assert.equal(levelOf({ ...clear, yellowness: 80 }, 'yellowness'), 'concern');
  });

  test('does not read the natural hue of dark skin as redness', () => {
    // Redness index of Fitzpatrick VI skin (hue 52 degrees) vs flushed skin (hue 38 degrees).
    assert.equal(levelOf({ ...clear, erythema: 8 }, 'erythema'), 'good');
    assert.equal(levelOf({ ...clear, erythema: 22 }, 'erythema'), 'concern');
  });

  test('gives every reading a plain-language phrase for the report', () => {
    for (const reading of interpretSkin({ ...clear, acne: 6, darkCircles: 20 })) {
      assert.ok(reading.phrase.length > 0, `${reading.key} has no phrase`);
    }
  });
});

describe('unmeasured values', () => {
  test('are never read as good and do not poison the health score', () => {
    const reading = interpretSkin({ ...clear, acne: Number.NaN }).find((r) => r.key === 'acne');
    assert.notEqual(reading?.level, 'good');
    assert.ok(Number.isFinite(skinHealthScore({ ...clear, acne: Number.NaN })));
  });

  test('say which reading could not be measured, so two of them are not identical', () => {
    const readings = interpretSkin({ ...clear, erythema: Number.NaN, yellowness: Number.NaN });
    const redness = readings.find((r) => r.key === 'erythema')!;
    const yellow = readings.find((r) => r.key === 'yellowness')!;
    assert.equal(redness.tag, 'Redness: not measured');
    assert.equal(redness.phrase, 'redness could not be measured');
    assert.notEqual(redness.tag, yellow.tag);
    assert.equal(redness.status, 'Not measured');
  });
});

describe('skinHealthScore', () => {
  test('scores clearly healthy skin at 90 or above', () => {
    assert.ok(skinHealthScore(clear) >= 90, `got ${skinHealthScore(clear)}`);
  });

  test('drops as a single problem gets worse', () => {
    const mild = skinHealthScore({ ...clear, acne: 2 });
    const severe = skinHealthScore({ ...clear, acne: 6 });
    assert.ok(mild < skinHealthScore(clear), `mild ${mild}`);
    assert.ok(severe < mild, `severe ${severe} vs mild ${mild}`);
  });

  test('scores skin with several clear concerns below 60', () => {
    const troubled = { ...clear, acne: 6, erythema: 23, darkCircles: 20, texture: 35, hydration: 35 };
    assert.ok(skinHealthScore(troubled) < 60, `got ${skinHealthScore(troubled)}`);
  });

  test('stays within 0 to 100 however bad the readings are', () => {
    const worst = {
      ...clear,
      acne: 90,
      erythema: 60,
      darkCircles: 90,
      wrinkles: 100,
      texture: 0,
      pores: 90,
      pigmentation: 100,
      hydration: 0,
      oiliness: 90,
      yellowness: 120,
    };
    assert.equal(skinHealthScore(worst), 0);
  });
});
