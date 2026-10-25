import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { changesSinceLastScan, habitTimeline, latestScoreChange, scoreTrend } from '../../src/services/history-insights';
import type { HistoryEntry } from '../../src/services/health-history';
import { emptyProfile, type LifestyleProfile, type LifestyleRisk } from '../../src/services/lifestyle-risk';
import { SKIN_METRICS_VERSION, type SkinMetrics } from '../../src/services/skin-interpretation';

const healthy: SkinMetrics = {
  version: SKIN_METRICS_VERSION,
  health: 85,
  glow: 70,
  hydration: 75,
  melanin: 30,
  erythema: 4,
  oiliness: 2,
  pores: 2,
  texture: 80,
  wrinkles: 8,
  fatigue: 0.3,
  darkCircles: 6,
  heartRate: 0,
  perfusion: 0,
  yellowness: 58,
  imageQuality: 85,
  acne: 0.2,
  uvDamage: 5,
  elasticity: 86,
  pigmentation: 4,
};

let counter = 0;
/** A history entry; `at` is the day number, entries are given in any order. */
function entry(
  day: number,
  opts: { metrics?: Partial<SkinMetrics>; risks?: LifestyleRisk[]; profile?: Partial<LifestyleProfile> } = {}
): HistoryEntry {
  const at = day * 86_400_000;
  const consulted = opts.risks || opts.profile;
  return {
    id: `entry-${++counter}`,
    userKey: 'a@x.com',
    createdAt: at,
    metrics: { ...healthy, ...opts.metrics },
    consultation: consulted
      ? {
          completedAt: at + 60_000,
          report: '## Report',
          assessment: {
            verdict: { level: 'good', label: 'Looking good' },
            lifestyle: {
              level: opts.risks?.[0]?.severity ?? 'low',
              risks: opts.risks ?? [],
              profile: { ...emptyProfile(), ...opts.profile },
            },
            skinHealth: 85,
            incomplete: false,
          },
        }
      : undefined,
  };
}

const sleepRisk: LifestyleRisk = {
  topic: 'sleep',
  severity: 'critical',
  label: 'Severe sleep deprivation',
  detail: 'Sleeps about 3 hours a night',
  seeDoctor: true,
};

describe('scoreTrend', () => {
  test('plots the health score of each scan, oldest first', () => {
    const trend = scoreTrend([entry(3, { metrics: { health: 81 } }), entry(1, { metrics: { health: 70 } }), entry(2, { metrics: { health: 76 } })]);
    assert.deepEqual(
      trend.points.map((p) => p.score),
      [70, 76, 81]
    );
    assert.equal(trend.olderVersion, 0);
  });

  test('leaves out scans measured by an older version of the scan, and says how many', () => {
    const trend = scoreTrend([entry(2, { metrics: { health: 80 } }), entry(1, { metrics: { health: 95, version: 1 } })]);
    assert.deepEqual(
      trend.points.map((p) => p.score),
      [80]
    );
    assert.equal(trend.olderVersion, 1);
  });
});

describe('latestScoreChange', () => {
  const trend = (...scores: number[]) => scoreTrend(scores.map((health, day) => entry(day, { metrics: { health } }))).points;

  test('gives the change since the previous scan, and whether it is better or worse', () => {
    assert.deepEqual(latestScoreChange(trend(70, 81)), { delta: 11, change: 'better' });
    assert.deepEqual(latestScoreChange(trend(81, 70)), { delta: -11, change: 'worse' });
  });

  test('calls a move of a few points the same, since two scans of one face differ that much', () => {
    assert.deepEqual(latestScoreChange(trend(79, 81)), { delta: 2, change: 'same' });
  });

  test('needs two scans', () => {
    assert.equal(latestScoreChange(trend(80)), null);
  });
});

describe('changesSinceLastScan', () => {
  const changeOf = (result: ReturnType<typeof changesSinceLastScan>, key: string) =>
    result?.changes.find((c) => c.key === key)?.change;

  test('compares the two latest scans that were measured the same way', () => {
    const latest = entry(5, { metrics: { texture: 60 } });
    const previous = entry(4, { metrics: { texture: 75 } });
    const older = entry(1);
    const result = changesSinceLastScan([older, latest, previous, entry(0, { metrics: { version: 1 } })]);
    assert.equal(result?.latest.id, latest.id);
    assert.equal(result?.previous.id, previous.id);
  });

  test('calls a reading better or worse only when it moves a meaningful amount', () => {
    const result = changesSinceLastScan([
      entry(1, { metrics: { texture: 60, acne: 0.49, darkCircles: 10 } }),
      entry(2, { metrics: { texture: 72, acne: 0.51, darkCircles: 25 } }),
    ]);
    assert.equal(changeOf(result, 'texture'), 'better');
    assert.equal(changeOf(result, 'acne'), 'same'); // crossed the "clear" line by a hair
    assert.equal(changeOf(result, 'darkCircles'), 'worse');
  });

  test('treats readings that stay in the healthy range as the same', () => {
    const result = changesSinceLastScan([entry(1, { metrics: { texture: 92 } }), entry(2, { metrics: { texture: 74 } })]);
    assert.equal(changeOf(result, 'texture'), 'same');
  });

  test('skips readings the camera could not measure', () => {
    const result = changesSinceLastScan([entry(1, { metrics: { erythema: Number.NaN } }), entry(2)]);
    assert.equal(changeOf(result, 'erythema'), undefined);
  });

  test('flags a comparison where either scan was taken in poor conditions', () => {
    assert.equal(changesSinceLastScan([entry(1), entry(2)])?.poorConditions, false);
    assert.equal(changesSinceLastScan([entry(1, { metrics: { imageQuality: 45 } }), entry(2)])?.poorConditions, true);
  });

  test('needs two comparable scans', () => {
    assert.equal(changesSinceLastScan([entry(1)]), null);
    assert.equal(changesSinceLastScan([entry(1, { metrics: { version: 1 } }), entry(2)]), null);
  });
});

describe('habitTimeline', () => {
  test('shows each habit across the consultations, oldest first', () => {
    const timeline = habitTimeline([
      entry(9, { profile: { sleepHours: 7.5, waterLiters: 2 } }),
      entry(2, { risks: [sleepRisk], profile: { sleepHours: 3, waterLiters: 2 } }),
    ]);
    const sleep = timeline?.rows.find((r) => r.topic === 'sleep');
    assert.deepEqual(
      sleep?.cells.map((c) => [c.status, c.label]),
      [
        ['risk', 'Severe sleep deprivation'],
        ['fine', '7.5 h'],
      ]
    );
    assert.equal(sleep?.cells[0].severity, 'critical');
    assert.deepEqual(
      timeline?.rows.find((r) => r.topic === 'water')?.cells.map((c) => c.label),
      ['2 L', '2 L']
    );
  });

  test('marks a habit that was not discussed in a consultation, and leaves out habits never discussed', () => {
    const timeline = habitTimeline([entry(1, { profile: { sleepHours: 8 } }), entry(2, { profile: { stress: 'high' } })]);
    assert.deepEqual(
      timeline?.rows.map((r) => r.topic),
      ['sleep', 'stress']
    );
    assert.deepEqual(
      timeline?.rows.find((r) => r.topic === 'sleep')?.cells.map((c) => c.status),
      ['fine', 'unknown']
    );
  });

  test('shows at most the six latest consultations, and skips scans without one', () => {
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((day) => entry(day, { profile: { sleepHours: day } }));
    const timeline = habitTimeline([...entries, entry(20)]);
    assert.deepEqual(
      timeline?.sessions.map((s) => s.id),
      entries.slice(2).map((e) => e.id)
    );
  });

  test("says a habit couldn't be read, rather than not discussed, when the answers weren't readable", () => {
    const unreadable = entry(1, { profile: { sleepHours: 8 } });
    unreadable.consultation!.assessment.incomplete = true;
    unreadable.consultation!.assessment.lifestyle.profile = emptyProfile();
    const timeline = habitTimeline([unreadable, entry(2, { profile: { sleepHours: 8 } })]);
    assert.deepEqual(timeline?.rows.find((r) => r.topic === 'sleep')?.cells[0], {
      status: 'unknown',
      label: "Couldn't be read",
    });
  });

  test('is empty until a consultation has been finished', () => {
    assert.equal(habitTimeline([entry(1), entry(2)]), null);
  });
});
