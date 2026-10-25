/**
 * History Insights — turns saved scans and consultations into progress: the
 * health score over time, what changed since the last scan, and how habits
 * changed between consultations. Honest by design: scans measured by a
 * different version of the scan are never compared, and a reading only counts
 * as better or worse once it moves by a meaningful amount.
 */

import { newestFirst, type HistoryEntry } from './health-history';
import type { LifestyleProfile, RiskTopic, Severity } from './lifestyle-risk';
import { interpretSkin, SKIN_METRICS_VERSION, type SkinMetrics } from './skin-interpretation';

const oldestFirst = (a: HistoryEntry, b: HistoryEntry) => a.createdAt - b.createdAt;
const versionOf = (e: HistoryEntry) => e.metrics.version ?? 1;

/** Scans measured the same way as the newest one; older engine versions used different scales. */
function comparable(entries: HistoryEntry[]): HistoryEntry[] {
  const newest = [...entries].sort(newestFirst)[0];
  const version = newest ? versionOf(newest) : SKIN_METRICS_VERSION;
  return entries.filter((e) => versionOf(e) === version);
}

// ── Score over time ──────────────────────────────────────────────────────────

export interface TrendPoint {
  id: string;
  at: number;
  score: number;
}

/** The health score of each comparable scan, oldest first; `olderVersion` counts scans left out. */
export function scoreTrend(entries: HistoryEntry[]): { points: TrendPoint[]; olderVersion: number } {
  const current = comparable(entries);
  const points = current
    .filter((e) => Number.isFinite(e.metrics.health))
    .sort(oldestFirst)
    .map((e) => ({ id: e.id, at: e.createdAt, score: e.metrics.health }));
  return { points, olderVersion: entries.length - current.length };
}

export type Change = 'better' | 'worse' | 'same';

/** Health-score points two scans of the same face can differ by without anything changing. */
const MEANINGFUL_SCORE_CHANGE = 4;

/** The latest score's change since the previous comparable scan; null until there are two. */
export function latestScoreChange(points: TrendPoint[]): { delta: number; change: Change } | null {
  if (points.length < 2) return null;
  const delta = Math.round(points[points.length - 1].score - points[points.length - 2].score);
  const change: Change =
    delta >= MEANINGFUL_SCORE_CHANGE ? 'better' : delta <= -MEANINGFUL_SCORE_CHANGE ? 'worse' : 'same';
  return { delta, change };
}

// ── What changed since the last scan ─────────────────────────────────────────

export interface ReadingChange {
  key: keyof SkinMetrics;
  label: string;
  before: number;
  after: number;
  change: Change;
}

export interface ScanComparison {
  previous: HistoryEntry;
  latest: HistoryEntry;
  changes: ReadingChange[];
  /** Either scan was taken in poor light or focus, so differences may come from the conditions. */
  poorConditions: boolean;
}

/** Below this image quality a scan's readings are rough (the same bar the consultation uses). */
const POOR_SCAN_QUALITY = 60;

/**
 * How far a reading must move, as a share of the way from its healthy level to
 * its concern level, to count as better or worse. Smaller moves are within the
 * normal difference between two scans of the same face.
 */
const MEANINGFUL_CHANGE = 0.25;

/** Every measured reading of the two latest comparable scans; null until there are two. */
export function changesSinceLastScan(entries: HistoryEntry[]): ScanComparison | null {
  const [latest, previous] = comparable(entries).sort(newestFirst);
  if (!latest || !previous) return null;
  const before = new Map(interpretSkin(previous.metrics).map((r) => [r.key, r]));
  const changes = interpretSkin(latest.metrics).flatMap((now): ReadingChange[] => {
    const then = before.get(now.key);
    const from = previous.metrics[now.key] as number;
    const to = latest.metrics[now.key] as number;
    if (!then || !Number.isFinite(from) || !Number.isFinite(to)) return [];
    // `concern` is 0 anywhere in the healthy range, so moves within it count as the same.
    const shift = now.concern - then.concern;
    const change: Change = shift >= MEANINGFUL_CHANGE ? 'worse' : shift <= -MEANINGFUL_CHANGE ? 'better' : 'same';
    return [{ key: now.key, label: now.label, before: from, after: to, change }];
  });
  const poorConditions = [previous, latest].some((e) => e.metrics.imageQuality < POOR_SCAN_QUALITY);
  return { previous, latest, changes, poorConditions };
}

// ── Habits over time ─────────────────────────────────────────────────────────

export interface HabitCell {
  /** A lifestyle risk, an answer with no risk, or not discussed in that consultation. */
  status: 'risk' | 'fine' | 'unknown';
  label: string;
  severity?: Severity;
}

export interface HabitRow {
  topic: RiskTopic;
  label: string;
  cells: HabitCell[];
}

export interface HabitTimeline {
  /** The consultations shown, oldest first (one column each). */
  sessions: { id: string; at: number }[];
  rows: HabitRow[];
}

const amount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

const EATING_PATTERNS: Record<NonNullable<LifestyleProfile['eatingPattern']>, string> = {
  regular: 'Regular meals',
  irregular: 'Irregular meals',
  skips_meals: 'Skips meals',
  intermittent_fasting: 'Intermittent fasting',
  extended_fasting: 'Long fasts',
  not_eating: 'Not eating',
};

/** Each habit, and what the user's answer looks like when it carries no risk. */
const HABITS: { topic: RiskTopic; label: string; answer?: (p: LifestyleProfile) => string | null }[] = [
  { topic: 'sleep', label: 'Sleep', answer: (p) => (p.sleepHours === null ? null : `${amount(p.sleepHours)} h`) },
  {
    topic: 'eating',
    label: 'Eating',
    answer: (p) =>
      p.mealsPerDay !== null
        ? `${amount(p.mealsPerDay)} meal${p.mealsPerDay === 1 ? '' : 's'}`
        : p.eatingPattern && EATING_PATTERNS[p.eatingPattern],
  },
  { topic: 'water', label: 'Water', answer: (p) => (p.waterLiters === null ? null : `${amount(p.waterLiters)} L`) },
  { topic: 'stress', label: 'Stress', answer: (p) => p.stress && capitalised(p.stress) },
  { topic: 'sun', label: 'Sun protection', answer: (p) => p.sunProtection && capitalised(p.sunProtection) },
  { topic: 'smoking', label: 'Smoking', answer: (p) => (p.smoking === null ? null : p.smoking ? 'Yes' : 'No') },
  { topic: 'alcohol', label: 'Alcohol', answer: (p) => p.alcohol && capitalised(p.alcohol) },
  { topic: 'exercise', label: 'Exercise', answer: (p) => p.exercise && capitalised(p.exercise) },
  // Raised only by what the user said, never by an extracted answer.
  { topic: 'disordered_eating', label: 'Eating behaviour' },
  { topic: 'fainting', label: 'Fainting' },
  { topic: 'self_harm', label: 'Thoughts of self-harm' },
];

/**
 * Each habit across the latest consultations (oldest first): the risk it
 * carried, the answer when it carried none, or "not discussed". Habits never
 * discussed in any of them are left out. Null until a consultation is finished.
 */
export function habitTimeline(entries: HistoryEntry[], maxSessions = 6): HabitTimeline | null {
  const consulted = entries
    .filter((e) => e.consultation)
    .sort((a, b) => a.consultation!.completedAt - b.consultation!.completedAt)
    .slice(-maxSessions);
  if (!consulted.length) return null;

  const rows = HABITS.map(({ topic, label, answer }): HabitRow => {
    const cells = consulted.map(({ consultation }): HabitCell => {
      const { lifestyle, incomplete } = consultation!.assessment;
      const risk = lifestyle.risks.find((r) => r.topic === topic);
      if (risk) return { status: 'risk', label: risk.label, severity: risk.severity };
      const said = answer?.(lifestyle.profile);
      if (said) return { status: 'fine', label: said };
      return { status: 'unknown', label: incomplete ? "Couldn't be read" : 'Not discussed' };
    });
    return { topic, label, cells };
  }).filter((row) => row.cells.some((c) => c.status !== 'unknown'));

  return { sessions: consulted.map((e) => ({ id: e.id, at: e.consultation!.completedAt })), rows };
}
