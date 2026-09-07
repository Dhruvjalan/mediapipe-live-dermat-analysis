/**
 * Climate Zone Service — Maps Indian states & union territories to climate zones,
 * and provides the variable metrics that should be highlighted for each zone.
 *
 * Based on the AyurGenX Area-Wise Metrics Specification:
 *   - Fixed Metrics (Universal Baseline): always shown
 *   - Variable Metrics: dynamically shown based on user's detected location
 */

// ── Climate Zone Definitions ────────────────────────────────────────────────

export type ClimateZone =
  'WET_HUMID' | 'ARID_HOT' | 'TROPICAL_COASTAL' | 'POLLUTION_LANDLOCKED' | 'COLD_HIGH_ALTITUDE' | 'UNKNOWN';

export interface ClimateZoneInfo {
  zone: ClimateZone;
  label: string;
  emoji: string;
  description: string;
  ayurvedicFocus: string;
  /** The metric keys highlighted for this zone */
  variableMetrics: VariableMetricKey[];
}

/**
 * All possible variable metric keys.
 * These map directly to keys in the results object from face-landmarker.
 */
export type VariableMetricKey =
  'oiliness' | 'pores' | 'acne' | 'hydration' | 'uvDamage' | 'melanin' | 'erythema' | 'texture' | 'glow' | 'elasticity';

/** Metadata for rendering each variable metric row in the UI */
export interface VariableMetricMeta {
  key: VariableMetricKey;
  icon: string;
  label: string;
  subtitle: string;
  valId: string;
  statId: string;
}

// ── Complete Variable Metric Metadata Registry ──────────────────────────────

export const VARIABLE_METRIC_REGISTRY: Record<VariableMetricKey, VariableMetricMeta> = {
  oiliness: {
    key: 'oiliness',
    icon: '🧴',
    label: 'Oiliness',
    subtitle: 'Specular Glare',
    valId: 'val-oiliness',
    statId: 'stat-oiliness',
  },
  pores: {
    key: 'pores',
    icon: '🕳️',
    label: 'Pore Density',
    subtitle: 'Texture Variance',
    valId: 'val-pores',
    statId: 'stat-pores',
  },
  acne: {
    key: 'acne',
    icon: '🔴',
    label: 'Acne Severity',
    subtitle: 'Inflammation Density',
    valId: 'val-acne',
    statId: 'stat-acne',
  },
  hydration: {
    key: 'hydration',
    icon: '💧',
    label: 'Hydration',
    subtitle: 'Moisture Estimate',
    valId: 'val-hydration',
    statId: 'stat-hydration',
  },
  uvDamage: {
    key: 'uvDamage',
    icon: '☀️',
    label: 'UV Damage Score',
    subtitle: 'Sun Damage',
    valId: 'val-uv',
    statId: 'stat-uv',
  },
  melanin: {
    key: 'melanin',
    icon: '🌞',
    label: 'Pigmentation',
    subtitle: 'Melanin Index',
    valId: 'val-melanin',
    statId: 'stat-melanin',
  },
  erythema: {
    key: 'erythema',
    icon: '🔴',
    label: 'Redness',
    subtitle: 'Vascular Erythema',
    valId: 'val-erythema',
    statId: 'stat-erythema',
  },
  texture: {
    key: 'texture',
    icon: '🪞',
    label: 'Texture Score',
    subtitle: 'Surface Smoothness',
    valId: 'val-texture',
    statId: 'stat-texture',
  },
  glow: {
    key: 'glow',
    icon: '✨',
    label: 'Glow Score',
    subtitle: 'Skin Luminance',
    valId: 'val-luminance',
    statId: 'stat-luminance',
  },
  elasticity: {
    key: 'elasticity',
    icon: '🧘‍♀️',
    label: 'Elasticity Score',
    subtitle: 'Skin Firmness',
    valId: 'val-elasticity',
    statId: 'stat-elasticity',
  },
};

// ── Climate Zone Metadata ───────────────────────────────────────────────────

const CLIMATE_ZONES: Record<Exclude<ClimateZone, 'UNKNOWN'>, ClimateZoneInfo> = {
  WET_HUMID: {
    zone: 'WET_HUMID',
    label: 'Wet & Humid',
    emoji: '🌧️',
    description: 'High moisture, microbial risk',
    ayurvedicFocus: 'Detoxifying herbs (Kashaya Rasa), deep cleansing, Kapha-Pitta balance',
    variableMetrics: ['oiliness', 'pores', 'acne'],
  },
  ARID_HOT: {
    zone: 'ARID_HOT',
    label: 'Arid & Hot Plains',
    emoji: '🏜️',
    description: 'Dry heat, high UV index',
    ayurvedicFocus: 'Barrier nourishment (Snehana), cooling sun soothers, Vata-Pitta balance',
    variableMetrics: ['hydration', 'uvDamage', 'melanin'],
  },
  TROPICAL_COASTAL: {
    zone: 'TROPICAL_COASTAL',
    label: 'Tropical Coastal',
    emoji: '🌴',
    description: 'Saline humidity, intense sun',
    ayurvedicFocus: 'Pigment regulation, antioxidant repair, Pitta pacification',
    variableMetrics: ['melanin', 'oiliness', 'uvDamage'],
  },
  POLLUTION_LANDLOCKED: {
    zone: 'POLLUTION_LANDLOCKED',
    label: 'Pollution & Landlocked',
    emoji: '🏭',
    description: 'Smog, high SPM₂.₅',
    ayurvedicFocus: 'Clarifying herbs, micro-pollutant barrier repair, removing Ama (toxins)',
    variableMetrics: ['erythema', 'texture', 'glow'],
  },
  COLD_HIGH_ALTITUDE: {
    zone: 'COLD_HIGH_ALTITUDE',
    label: 'Cold & High-Altitude',
    emoji: '🏔️',
    description: 'Low moisture, wind chill',
    ayurvedicFocus: 'Deep lipid replenishment, warming hydration (Abhyanga), Vata balance',
    variableMetrics: ['hydration', 'erythema', 'elasticity'],
  },
};

// ── State → Climate Zone Mapping ────────────────────────────────────────────
// Normalized to lowercase for case-insensitive matching

const STATE_TO_ZONE: Record<string, ClimateZone> = {
  // Wet & Humid
  assam: 'WET_HUMID',
  goa: 'WET_HUMID',
  kerala: 'WET_HUMID',
  meghalaya: 'WET_HUMID',
  mizoram: 'WET_HUMID',
  tripura: 'WET_HUMID',
  'west bengal': 'WET_HUMID',
  'andaman and nicobar islands': 'WET_HUMID',
  'andaman and nicobar': 'WET_HUMID',
  'andaman & nicobar': 'WET_HUMID',
  lakshadweep: 'WET_HUMID',

  // Arid & Hot Plains
  'andhra pradesh': 'ARID_HOT',
  gujarat: 'ARID_HOT',
  haryana: 'ARID_HOT',
  rajasthan: 'ARID_HOT',
  telangana: 'ARID_HOT',
  'dadra and nagar haveli and daman and diu': 'ARID_HOT',
  'dadra and nagar haveli': 'ARID_HOT',
  'dadra & nagar haveli': 'ARID_HOT',
  'daman and diu': 'ARID_HOT',
  'daman & diu': 'ARID_HOT',

  // Tropical Coastal
  karnataka: 'TROPICAL_COASTAL',
  maharashtra: 'TROPICAL_COASTAL',
  odisha: 'TROPICAL_COASTAL',
  'tamil nadu': 'TROPICAL_COASTAL',
  puducherry: 'TROPICAL_COASTAL',
  pondicherry: 'TROPICAL_COASTAL',

  // Pollution & Landlocked
  bihar: 'POLLUTION_LANDLOCKED',
  chhattisgarh: 'POLLUTION_LANDLOCKED',
  jharkhand: 'POLLUTION_LANDLOCKED',
  'madhya pradesh': 'POLLUTION_LANDLOCKED',
  punjab: 'POLLUTION_LANDLOCKED',
  'uttar pradesh': 'POLLUTION_LANDLOCKED',
  chandigarh: 'POLLUTION_LANDLOCKED',
  delhi: 'POLLUTION_LANDLOCKED',
  'new delhi': 'POLLUTION_LANDLOCKED',
  'nct of delhi': 'POLLUTION_LANDLOCKED',

  // Cold & High-Altitude
  'arunachal pradesh': 'COLD_HIGH_ALTITUDE',
  'himachal pradesh': 'COLD_HIGH_ALTITUDE',
  manipur: 'COLD_HIGH_ALTITUDE',
  nagaland: 'COLD_HIGH_ALTITUDE',
  sikkim: 'COLD_HIGH_ALTITUDE',
  uttarakhand: 'COLD_HIGH_ALTITUDE',
  'jammu and kashmir': 'COLD_HIGH_ALTITUDE',
  'jammu & kashmir': 'COLD_HIGH_ALTITUDE',
  ladakh: 'COLD_HIGH_ALTITUDE',
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Determine the climate zone from a state/region name string.
 * Performs fuzzy case-insensitive matching.
 */
export function getClimateZoneFromState(stateName: string): ClimateZone {
  if (!stateName) return 'UNKNOWN';
  const normalized = stateName.trim().toLowerCase();

  // Direct match
  if (STATE_TO_ZONE[normalized]) return STATE_TO_ZONE[normalized];

  // Partial/fuzzy match — check if stateName contains a known state name
  for (const [key, zone] of Object.entries(STATE_TO_ZONE)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return zone;
    }
  }

  return 'UNKNOWN';
}

/**
 * Get the full climate zone info including variable metrics,
 * Ayurvedic focus, and display metadata.
 */
export function getClimateZoneInfo(zone: ClimateZone): ClimateZoneInfo | null {
  if (zone === 'UNKNOWN') return null;
  return CLIMATE_ZONES[zone] || null;
}

/**
 * Get the variable metric metadata for a given climate zone.
 * Returns all variable metrics if zone is unknown (fallback).
 */
export function getVariableMetricsForZone(zone: ClimateZone): VariableMetricMeta[] {
  if (zone === 'UNKNOWN') {
    // Fallback: show ALL variable metrics
    return Object.values(VARIABLE_METRIC_REGISTRY);
  }

  const zoneInfo = CLIMATE_ZONES[zone];
  if (!zoneInfo) return Object.values(VARIABLE_METRIC_REGISTRY);

  return zoneInfo.variableMetrics.map((key) => VARIABLE_METRIC_REGISTRY[key]);
}

/**
 * Convenience: detect zone from a location's state field and return full info.
 */
export function detectClimateFromLocation(state: string): {
  zone: ClimateZone;
  info: ClimateZoneInfo | null;
  metrics: VariableMetricMeta[];
} {
  const zone = getClimateZoneFromState(state);
  return {
    zone,
    info: getClimateZoneInfo(zone),
    metrics: getVariableMetricsForZone(zone),
  };
}

/**
 * Get ALL variable metric keys (used for fallback / non-Indian locations).
 */
export function getAllVariableMetricKeys(): VariableMetricKey[] {
  return Object.keys(VARIABLE_METRIC_REGISTRY) as VariableMetricKey[];
}
