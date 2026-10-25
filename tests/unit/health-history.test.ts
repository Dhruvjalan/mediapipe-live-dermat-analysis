import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryHistoryStore,
  recordConsultation,
  userKeyFrom,
  type HistoryConsultation,
} from '../../src/services/health-history';
import { emptyProfile } from '../../src/services/lifestyle-risk';
import type { SkinMetrics } from '../../src/services/skin-interpretation';

const metrics = (over: Partial<SkinMetrics> = {}): SkinMetrics => ({
  version: 2,
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
  ...over,
});

const consultation = (verdict: string, completedAt = 5000): HistoryConsultation => ({
  completedAt,
  report: `## Report\n\n${verdict}`,
  assessment: {
    verdict: { level: 'good', label: verdict },
    lifestyle: { level: 'low', risks: [], profile: emptyProfile() },
    skinHealth: 85,
    incomplete: false,
  },
});

describe('MemoryHistoryStore', () => {
  test("lists a user's scans newest first", async () => {
    const store = new MemoryHistoryStore();
    await store.addScan('a@x.com', metrics({ health: 70 }), 1000);
    await store.addScan('a@x.com', metrics({ health: 80 }), 3000);
    await store.addScan('a@x.com', metrics({ health: 75 }), 2000);
    const listed = await store.list('a@x.com');
    assert.deepEqual(
      listed.map((e) => e.metrics.health),
      [80, 75, 70]
    );
  });

  test("keeps each user's history separate", async () => {
    const store = new MemoryHistoryStore();
    await store.addScan('a@x.com', metrics(), 1000);
    await store.addScan('b@x.com', metrics(), 2000);
    assert.equal((await store.list('a@x.com')).length, 1);
    assert.equal((await store.list('b@x.com')).length, 1);
    assert.equal((await store.list('guest')).length, 0);
  });

  test('attaches a consultation to its scan, replacing an earlier one', async () => {
    const store = new MemoryHistoryStore();
    const scan = await store.addScan('a@x.com', metrics(), 1000);
    await store.attachConsultation(scan.id, consultation('Needs attention'));
    const updated = await store.attachConsultation(scan.id, consultation('Looking good'));
    assert.equal(updated?.consultation?.assessment.verdict.label, 'Looking good');
    assert.equal((await store.get(scan.id))?.consultation?.assessment.verdict.label, 'Looking good');
  });

  test('returns null when attaching to an entry that no longer exists', async () => {
    const store = new MemoryHistoryStore();
    assert.equal(await store.attachConsultation('missing', consultation('Looking good')), null);
  });

  test("deletes one entry, or all of one user's entries", async () => {
    const store = new MemoryHistoryStore();
    const first = await store.addScan('a@x.com', metrics(), 1000);
    await store.addScan('a@x.com', metrics(), 2000);
    await store.addScan('b@x.com', metrics(), 3000);
    await store.remove(first.id);
    assert.equal((await store.list('a@x.com')).length, 1);
    await store.clear('a@x.com');
    assert.equal((await store.list('a@x.com')).length, 0);
    assert.equal((await store.list('b@x.com')).length, 1);
  });

  test('hands out copies, so changing a listed entry does not change what is stored', async () => {
    const store = new MemoryHistoryStore();
    const scan = await store.addScan('a@x.com', metrics({ health: 70 }), 1000);
    scan.metrics.health = 1;
    (await store.list('a@x.com'))[0].metrics.health = 2;
    assert.equal((await store.get(scan.id))?.metrics.health, 70);
  });
});

describe('recordConsultation', () => {
  test('adds the consultation to the scan it followed', async () => {
    const store = new MemoryHistoryStore();
    const scan = await store.addScan('a@x.com', metrics(), 1000);
    await recordConsultation(store, scan.id, 'a@x.com', metrics(), consultation('Looking good'));
    const entries = await store.list('a@x.com');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].consultation?.assessment.verdict.label, 'Looking good');
  });

  test('saves the scan as well when it was never saved, or was deleted since', async () => {
    const store = new MemoryHistoryStore();
    await recordConsultation(store, null, 'a@x.com', metrics({ health: 66 }), consultation('Needs attention', 9000));
    await recordConsultation(store, 'deleted-id', 'a@x.com', metrics({ health: 67 }), consultation('Needs attention'));
    const entries = await store.list('a@x.com');
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.consultation));
    assert.equal(entries.find((e) => e.metrics.health === 66)?.createdAt, 9000);
  });

  test('dates a scan it has to save again by when the scan was taken, not when the report was written', async () => {
    const store = new MemoryHistoryStore();
    await recordConsultation(store, null, 'a@x.com', metrics(), consultation('Looking good', 9000), 4000);
    assert.equal((await store.list('a@x.com'))[0].createdAt, 4000);
  });

  test("keeps the user's verbatim words out of the saved risks", async () => {
    const store = new MemoryHistoryStore();
    const said = consultation('Please see a doctor');
    said.assessment.lifestyle.risks = [
      { topic: 'self_harm', severity: 'critical', label: 'Thoughts of self-harm', detail: 'Said: "I want to die"', seeDoctor: true },
    ];
    await recordConsultation(store, null, 'a@x.com', metrics(), said);
    const saved = (await store.list('a@x.com'))[0].consultation!.assessment.lifestyle.risks[0];
    assert.equal(saved.label, 'Thoughts of self-harm');
    assert.doesNotMatch(saved.detail, /want to die/);
  });

  test("never attaches to another user's scan", async () => {
    const store = new MemoryHistoryStore();
    const theirs = await store.addScan('b@x.com', metrics(), 1000);
    await recordConsultation(store, theirs.id, 'a@x.com', metrics(), consultation('Looking good'));
    assert.equal((await store.get(theirs.id))?.consultation, undefined);
    assert.equal((await store.list('a@x.com')).length, 1);
  });
});

describe('userKeyFrom', () => {
  test('uses the signed-in email, in lower case', () => {
    assert.equal(userKeyFrom('{"email":" Dhruv@Example.com "}'), 'dhruv@example.com');
  });

  test('falls back to guest when nobody is signed in or the value is unreadable', () => {
    assert.equal(userKeyFrom(null), 'guest');
    assert.equal(userKeyFrom('not json'), 'guest');
    assert.equal(userKeyFrom('{}'), 'guest');
  });
});
