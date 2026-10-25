import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportTags, renderReport, safetyNotice } from '../../src/services/report-generator';
import { assessLifestyle, detectSafetyFlags, emptyProfile, overallVerdict } from '../../src/services/lifestyle-risk';
import type { ReportAssessment } from '../../src/services/groq-service';
import type { SkinMetrics } from '../../src/services/skin-interpretation';

const metrics: SkinMetrics = {
  version: 2,
  health: 90,
  glow: 70,
  hydration: 78,
  melanin: 30,
  erythema: 3,
  oiliness: 2,
  pores: 2,
  texture: 82,
  wrinkles: 6,
  fatigue: 0.3,
  darkCircles: 4,
  heartRate: 0,
  perfusion: 0,
  yellowness: 58,
  imageQuality: 85,
  acne: 0.2,
  uvDamage: 5,
  elasticity: 88,
  pigmentation: 5,
};

function assessment(answers: Partial<ReturnType<typeof emptyProfile>>, said = ''): ReportAssessment {
  const lifestyle = assessLifestyle({ ...emptyProfile(), ...answers }, detectSafetyFlags(said));
  return { lifestyle, verdict: overallVerdict(metrics.health, lifestyle.level), skinHealth: metrics.health, incomplete: false };
}

describe('buildReportTags', () => {
  test('puts lifestyle risks first, marked for attention', () => {
    const tags = buildReportTags(metrics, assessment({ sleepHours: 3, waterLiters: 2.5 }));
    assert.deepEqual(tags[0], { text: 'Severe sleep deprivation', mood: 'attention' });
  });

  test('marks moderate lifestyle risks as neutral', () => {
    const tags = buildReportTags(metrics, assessment({ waterLiters: 1.2 }));
    assert.deepEqual(tags[0], { text: 'Low water intake', mood: 'neutral' });
  });

  test('shows skin concerns for attention and key healthy metrics as positive', () => {
    const tags = buildReportTags({ ...metrics, acne: 6 }, assessment({}));
    assert.ok(tags.some((t) => t.text === 'Active breakouts' && t.mood === 'attention'));
    assert.ok(tags.some((t) => t.text === 'Skin looks well moisturised' && t.mood === 'positive'));
  });

  test('does not show a positive skin-moisture tag next to a water-intake risk', () => {
    const tags = buildReportTags(metrics, assessment({ waterLiters: 0.5 }));
    assert.ok(tags.some((t) => t.text === 'Very low water intake'));
    assert.equal(
      tags.some((t) => /moist|hydrat/i.test(t.text) && t.mood === 'positive'),
      false
    );
  });

  test('lists every skin concern before any positive tag', () => {
    const tags = buildReportTags({ ...metrics, acne: 6, darkCircles: 20 }, assessment({}));
    const lastAttention = tags.map((t) => t.mood).lastIndexOf('attention');
    const firstPositive = tags.map((t) => t.mood).indexOf('positive');
    assert.ok(lastAttention < firstPositive);
  });
});

describe('safetyNotice', () => {
  test('lists the risks that need a doctor', () => {
    const notice = safetyNotice(assessment({}, "I don't eat"));
    assert.deepEqual(notice?.items, ['Not eating']);
    assert.equal(notice?.crisis, false);
  });

  test('adds crisis support when the user mentions self-harm', () => {
    assert.equal(safetyNotice(assessment({}, 'I want to kill myself'))?.crisis, true);
  });

  test('is absent when nothing needs a doctor', () => {
    assert.equal(safetyNotice(assessment({ waterLiters: 1.2 })), null);
  });
});

describe('renderReport', () => {
  /** Just enough of an element for renderReport, which only writes innerHTML and looks up its buttons. */
  const container = () => ({ innerHTML: '', querySelector: () => null }) as unknown as HTMLElement;

  test('in the chat, offers a new consultation and a way to see progress', () => {
    const chat = container();
    renderReport('## How Your Skin is Doing\n\nClear.', metrics, chat, assessment({}));
    assert.match(chat.innerHTML, /report-new-chat-btn/);
    assert.match(chat.innerHTML, /href="#\/dashboard"/);
  });

  test('opened from history, shows the date it was written and leaves out the chat-only buttons', () => {
    const saved = container();
    renderReport('## How Your Skin is Doing\n\nClear.', metrics, saved, assessment({}), {
      writtenAt: new Date(2026, 4, 3),
      fromHistory: true,
    });
    assert.match(saved.innerHTML, /May 3, 2026/);
    assert.doesNotMatch(saved.innerHTML, /report-new-chat-btn|report-download-pdf-btn|#\/dashboard/);
    assert.match(saved.innerHTML, /report-download-html-btn/);
  });
});

describe('renderReport safety', () => {
  const container = () => ({ innerHTML: '', querySelector: () => null }) as unknown as HTMLElement;

  test("shows the model's text as text, never as HTML, while keeping its formatting", () => {
    const c = container();
    renderReport('## Your Skin\n\n**Drink water** <img src=x onerror="alert(1)"> & rest\n\n- Sleep early', metrics, c, assessment({}));
    assert.doesNotMatch(c.innerHTML, /<img/);
    assert.match(c.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; rest/);
    assert.match(c.innerHTML, /<h3 class="report-section-title">Your Skin<\/h3>/);
    assert.match(c.innerHTML, /<strong>Drink water<\/strong>/);
    assert.match(c.innerHTML, /<li>Sleep early<\/li>/);
  });
});
