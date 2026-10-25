/**
 * Skin Interpretation — the single place that decides what a scan value means.
 * The scan table, the LLM prompt and the report tags all read from here, so a
 * value can't be "Excellent" in one place and a concern in another.
 */

/** Bumped whenever the scan engine's scales change, so stale stored scans are ignored. */
export const SKIN_METRICS_VERSION = 2;

export interface SkinMetrics {
  version?: number;
  /** 0-100, from skinHealthScore(). */
  health: number;
  /** 0-100: tone evenness plus natural sheen. */
  glow: number;
  /** 0-100: visual estimate from texture, sheen and fine lines. */
  hydration: number;
  /** Melanin index (skin tone). Informational only, never graded. */
  melanin: number;
  /** Redness index: degrees the cheeks' CIELAB hue sits below 60 (0 = none). */
  erythema: number;
  /** % of T-zone pixels showing specular shine. */
  oiliness: number;
  /** % of skin pixels that are small dark points. */
  pores: number;
  /** 0-100, higher is smoother. */
  texture: number;
  /** 0-100 line density on the forehead and under the eyes. */
  wrinkles: number;
  /** Eye aspect ratio (lower = more closed/tired). */
  fatigue: number;
  /** % darker under the eyes than on the cheeks. */
  darkCircles: number;
  /** BPM from the camera pulse signal; 0 = not measured. */
  heartRate: number;
  /** 0-100 relative pulse strength; 0 = not measured. */
  perfusion: number;
  /** CIELAB hue angle of the skin in degrees (higher = more yellow). */
  yellowness: number;
  /** 0-100 frame quality. */
  imageQuality: number;
  /** % of skin area covered by small red spots. */
  acne: number;
  /** 0-100 estimate from spots and lines. */
  uvDamage: number;
  /** 0-100 estimate from lines and texture. */
  elasticity: number;
  /** 0-100 dark-spot coverage (freckles, sun spots, uneven tone). */
  pigmentation: number;
}

export type ReadingLevel = 'good' | 'fair' | 'concern';

export interface SkinReading {
  key: keyof SkinMetrics;
  label: string;
  level: ReadingLevel;
  /** 0 = fine, 1 = at the concern threshold, above 1 = worse. */
  concern: number;
  /** Plain-language description for the LLM and the report. */
  phrase: string;
  /** Short text for report tags. */
  tag: string;
  /** Short text for the scan table badge. */
  status: string;
}

interface MetricRule {
  key: keyof SkinMetrics;
  label: string;
  higherIsBetter: boolean;
  good: number;
  concern: number;
  /** Share of the health score (all weights add up to 100). 0 = shown but not scored. */
  weight: number;
  /** [good, fair, concern] */
  phrases: [string, string, string];
  tags: [string, string, string];
  statuses: [string, string, string];
}

const RULES: MetricRule[] = [
  {
    key: 'acne',
    label: 'Acne',
    higherIsBetter: false,
    good: 0.5,
    concern: 4,
    weight: 16,
    phrases: ['skin looks mostly clear', 'a few small red spots', 'several active red spots or breakouts'],
    tags: ['Mostly clear skin', 'A few red spots', 'Active breakouts'],
    statuses: ['Clear', 'Mild', 'Active'],
  },
  {
    key: 'erythema',
    label: 'Redness',
    higherIsBetter: false,
    // Hue-based so naturally darker skin (hue ~52-55) isn't read as red; flushed skin is ~20+.
    good: 10,
    concern: 20,
    weight: 12,
    phrases: ['normal redness', 'some mild redness', 'noticeable redness or irritation'],
    tags: ['Calm skin', 'Mild redness', 'Noticeable redness'],
    statuses: ['Normal', 'Mild', 'Elevated'],
  },
  {
    key: 'darkCircles',
    label: 'Dark circles',
    higherIsBetter: false,
    good: 8,
    concern: 18,
    weight: 10,
    phrases: ['minimal under-eye darkness', 'slight under-eye darkness', 'noticeable dark circles under the eyes'],
    tags: ['Bright under-eyes', 'Slight dark circles', 'Noticeable dark circles'],
    statuses: ['Minimal', 'Mild', 'Noticeable'],
  },
  {
    key: 'wrinkles',
    label: 'Fine lines',
    higherIsBetter: false,
    good: 15,
    concern: 40,
    weight: 12,
    phrases: ['few visible fine lines', 'some fine lines', 'visible lines and wrinkles'],
    tags: ['Few fine lines', 'Some fine lines', 'Visible lines'],
    statuses: ['Minimal', 'Mild', 'Visible'],
  },
  {
    key: 'texture',
    label: 'Texture',
    higherIsBetter: true,
    good: 70,
    concern: 40,
    weight: 12,
    phrases: ['smooth, even texture', 'slightly uneven texture', 'rough or uneven texture'],
    tags: ['Smooth texture', 'Some uneven patches', 'Rough texture'],
    statuses: ['Smooth', 'Uneven', 'Rough'],
  },
  {
    key: 'pores',
    label: 'Pores',
    higherIsBetter: false,
    good: 3,
    concern: 10,
    weight: 8,
    phrases: ['pores barely visible', 'some visible pores', 'enlarged, visible pores'],
    tags: ['Fine pores', 'Some visible pores', 'Enlarged pores'],
    statuses: ['Fine', 'Visible', 'Enlarged'],
  },
  {
    key: 'pigmentation',
    label: 'Pigmentation',
    higherIsBetter: false,
    good: 20,
    concern: 50,
    weight: 10,
    phrases: ['even skin tone', 'a few spots or uneven patches', 'noticeably uneven tone or dark spots'],
    tags: ['Even tone', 'A few spots', 'Uneven tone'],
    statuses: ['Even', 'Mild', 'Uneven'],
  },
  {
    // A visual estimate of the skin's surface, not of how much the person drinks.
    key: 'hydration',
    label: 'Skin moisture',
    higherIsBetter: true,
    good: 65,
    concern: 40,
    weight: 10,
    phrases: ['skin surface looks well moisturised', 'skin looks a little dry', 'skin looks dry'],
    tags: ['Skin looks well moisturised', 'Skin could use more moisture', 'Skin looks dry'],
    statuses: ['Good', 'A bit dry', 'Dry'],
  },
  {
    key: 'oiliness',
    label: 'Oiliness',
    higherIsBetter: false,
    good: 4,
    concern: 10,
    weight: 5,
    phrases: ['balanced oil levels', 'a bit of shine', 'quite oily, especially in the T-zone'],
    tags: ['Balanced oil levels', 'Slightly oily', 'Oily in T-zone'],
    statuses: ['Balanced', 'Shiny', 'Oily'],
  },
  {
    key: 'yellowness',
    label: 'Yellow tint',
    higherIsBetter: false,
    // Hue angle: skin of every tone sits around 52-68 degrees; jaundiced skin is ~80+.
    good: 72,
    concern: 78,
    weight: 5,
    phrases: ['normal skin tint', 'a slight yellowish tint', 'a noticeable yellowish tint'],
    tags: ['Normal tint', 'Slight yellow tint', 'Yellowish tint'],
    statuses: ['Normal', 'Slight', 'Elevated'],
  },
  {
    key: 'glow',
    label: 'Glow',
    higherIsBetter: true,
    good: 65,
    concern: 40,
    weight: 0,
    phrases: ['a healthy natural glow', 'glow could be brighter', 'looking a bit dull'],
    tags: ['Nice natural glow', 'Glow could be brighter', 'Looking a bit dull'],
    statuses: ['Radiant', 'Fair', 'Dull'],
  },
  {
    key: 'elasticity',
    label: 'Firmness',
    higherIsBetter: true,
    good: 70,
    concern: 45,
    weight: 0,
    phrases: ['firm-looking skin', 'firmness is okay', 'skin looks less firm'],
    tags: ['Firm and bouncy', 'Elasticity is okay', 'Could be firmer'],
    statuses: ['Firm', 'Fair', 'Lax'],
  },
  {
    key: 'uvDamage',
    label: 'Sun damage',
    higherIsBetter: false,
    good: 20,
    concern: 45,
    weight: 0,
    phrases: ['little sign of sun damage', 'some signs of sun exposure', 'clear signs of sun damage'],
    tags: ['Little sun damage', 'Some sun exposure', 'Sun damage'],
    statuses: ['Minimal', 'Moderate', 'High'],
  },
  {
    key: 'fatigue',
    label: 'Tired eyes',
    higherIsBetter: true,
    good: 0.25,
    concern: 0.19,
    weight: 0,
    phrases: ['eyes look rested', 'eyes look a little tired', 'eyes look very tired'],
    tags: ['Rested eyes', 'Slightly tired eyes', 'Tired eyes'],
    statuses: ['Awake', 'Tired', 'Very tired'],
  },
];

function concernLevel(rule: MetricRule, value: number): number {
  const distance = rule.higherIsBetter ? rule.good - value : value - rule.good;
  return Math.max(0, distance / Math.abs(rule.concern - rule.good));
}

/**
 * Grades every scored metric. Skin tone (melanin) is deliberately not graded.
 * A missing or non-numeric value reads as "Not measured", never as good.
 */
export function interpretSkin(m: SkinMetrics): SkinReading[] {
  return RULES.map((rule) => {
    const value = m[rule.key] as number;
    if (!Number.isFinite(value)) {
      return {
        key: rule.key,
        label: rule.label,
        level: 'fair',
        concern: 0,
        phrase: `${rule.label.toLowerCase()} could not be measured`,
        tag: `${rule.label}: not measured`,
        status: 'Not measured',
      };
    }
    const concern = concernLevel(rule, value);
    const index = concern >= 1 ? 2 : concern > 0 ? 1 : 0;
    return {
      key: rule.key,
      label: rule.label,
      level: (['good', 'fair', 'concern'] as const)[index],
      concern,
      phrase: rule.phrases[index],
      tag: rule.tags[index],
      status: rule.statuses[index],
    };
  });
}

/** 100 minus weighted concerns; each metric can cost at most 1.5x its weight. Unmeasured values are skipped. */
export function skinHealthScore(m: SkinMetrics): number {
  let penalty = 0;
  for (const rule of RULES) {
    const value = m[rule.key] as number;
    if (Number.isFinite(value)) penalty += rule.weight * Math.min(1.5, concernLevel(rule, value));
  }
  return Math.round(Math.min(100, Math.max(0, 100 - penalty)));
}

export function healthLevel(score: number): ReadingLevel {
  return score >= 80 ? 'good' : score >= 60 ? 'fair' : 'concern';
}
