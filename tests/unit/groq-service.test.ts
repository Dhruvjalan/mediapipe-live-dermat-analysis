import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GroqService } from '../../src/services/groq-service';
import type { SkinMetrics } from '../../src/services/skin-interpretation';

const metrics: SkinMetrics = {
  version: 2,
  health: 92,
  glow: 70,
  hydration: 78,
  melanin: 30,
  erythema: 3,
  oiliness: 2,
  pores: 2,
  texture: 82,
  wrinkles: 6,
  fatigue: 0.3,
  darkCircles: 20,
  heartRate: 0,
  perfusion: 0,
  yellowness: 58,
  imageQuality: 85,
  acne: 0.2,
  uvDamage: 5,
  elasticity: 88,
  pigmentation: 5,
};

interface Captured {
  model: string;
  temperature: number;
  stream: boolean;
  messages: { role: string; content: string }[];
}

const question = (message: string) => JSON.stringify({ message, options: [], isReport: false });
const report = JSON.stringify({ message: '## The Most Important Thing\n\nPlease see a doctor.', isReport: true });

let restore: (() => void) | null = null;
afterEach(() => restore?.());

/** Stands in for the Groq API: records every chat request and replies with the given contents in order. */
function fakeGroq(
  replies: string[],
  opts: { failingModels?: string[]; servedModels?: string[]; outage?: () => boolean } = {}
) {
  const requests: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      const ids = opts.servedModels ?? ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'allam-2-7b'];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    }
    const body = JSON.parse(String(init?.body)) as Captured;
    if (opts.failingModels?.includes(body.model) || opts.outage?.()) {
      return new Response('model overloaded', { status: 503 });
    }
    requests.push(body);
    const content = replies.shift() ?? question('Anything else?');
    if (body.stream) {
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return requests;
}

async function startedService() {
  const service = new GroqService('test-key');
  service.initConversation(metrics);
  await service.chat('');
  return service;
}

const allText = (r: Captured) => r.messages.map((m) => m.content).join('\n');

describe('GroqService conversation', () => {
  test('describes the scan to the model using the shared interpretation', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?')]);
    await startedService();
    assert.match(requests[0].messages[0].content, /noticeable dark circles under the eyes/);
  });

  test('asks the model for a caring follow-up after a worrying answer', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?'), question('How long has that been going on?')]);
    const service = await startedService();
    await service.chat("I don't eat");
    const notes = requests[1].messages.filter((m) => m.role === 'system').slice(1);
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /Not eating/);
  });

  test('does not add a follow-up note for an ordinary answer', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?'), question('How much water do you drink?')]);
    const service = await startedService();
    await service.chat('About 7 hours');
    assert.equal(requests[1].messages.filter((m) => m.role === 'system').length, 1);
  });

  test('uses the strongest pinned model first', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?')]);
    await startedService();
    assert.deepEqual(
      requests.map((r) => r.model),
      ['openai/gpt-oss-120b']
    );
  });

  test('falls back to the next pinned model when one is over capacity', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?')], { failingModels: ['openai/gpt-oss-120b'] });
    await startedService();
    assert.deepEqual(
      requests.map((r) => r.model),
      ['qwen/qwen3.8-27b']
    );
  });

  test('asks for complete JSON replies, not a stream (Groq JSON mode does not stream)', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?'), question('And water?')]);
    const service = await startedService();
    await service.chat('About 7 hours');
    assert.deepEqual(
      requests.map((r) => r.stream),
      [false, false]
    );
  });

  test('forgets a turn that failed, so sending it again does not duplicate it', async () => {
    let down = false;
    const requests = fakeGroq([question('How many hours do you sleep?'), question('And water?')], { outage: () => down });
    const service = await startedService();
    down = true;
    await assert.rejects(service.chat('About 7 hours'));
    down = false;
    await service.chat('About 7 hours');
    const sent = requests[requests.length - 1].messages.filter((m) => m.content === 'About 7 hours');
    assert.equal(sent.length, 1);
  });

  test('never falls back to a model outside the pinned list', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?')], {
      servedModels: ['allam-2-7b', 'openai/gpt-oss-20b'],
    });
    await startedService();
    assert.deepEqual(
      requests.map((r) => r.model),
      ['openai/gpt-oss-20b']
    );
  });
});

describe('GroqService report', () => {
  const extraction = (facts: object) => JSON.stringify({ ...facts });

  test('writes the report from the app assessment, with critical answers marked as such', async () => {
    const requests = fakeGroq([
      question('How many hours do you sleep?'),
      question('How much water do you drink?'),
      extraction({ sleepHours: 0, waterLiters: 0.75 }),
      report,
    ]);
    const service = await startedService();
    await service.chat("I don't sleep");
    const result = await service.generateReport();

    assert.equal(result.isReport, true);
    assert.equal(result.assessment?.verdict.level, 'urgent');

    const [extractRequest, reportRequest] = requests.slice(-2);
    assert.equal(extractRequest.temperature, 0);
    assert.match(allText(extractRequest), /User: I don't sleep/);
    assert.match(allText(reportRequest), /Severe sleep deprivation/);
    assert.match(allText(reportRequest), /CRITICAL/);
    assert.match(allText(reportRequest), /Please see a doctor/);
  });

  test('keeps a critical answer even when the fact extraction returns garbage', async () => {
    fakeGroq([question('How many hours do you sleep?'), question('And water?'), 'not json at all', report]);
    const service = await startedService();
    await service.chat("I don't eat at all");
    const result = await service.generateReport();
    assert.equal(result.assessment?.lifestyle.level, 'critical');
    assert.equal(result.assessment?.lifestyle.risks[0].label, 'Not eating');
  });

  test('counts what the user typed along with the report request', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?'), extraction({}), report]);
    const service = await startedService();
    const result = await service.generateReport(undefined, "generate my report, also I don't eat");
    assert.equal(result.assessment?.lifestyle.level, 'critical');
    assert.match(allText(requests[1]), /User: generate my report, also I don't eat/);
  });

  test('retries the fact extraction once when it fails', async () => {
    fakeGroq([
      question('How many hours do you sleep?'),
      question('And water?'),
      'not json',
      extraction({ sleepHours: 3 }),
      report,
    ]);
    const service = await startedService();
    await service.chat('Less than 4 hours');
    const result = await service.generateReport();
    assert.equal(result.assessment?.lifestyle.risks[0]?.label, 'Severe sleep deprivation');
    assert.equal(result.assessment?.incomplete, false);
  });

  test('never calls a consultation good when the answers could not be read', async () => {
    const requests = fakeGroq([
      question('How many hours do you sleep?'),
      question('And water?'),
      'not json',
      'still not json',
      report,
    ]);
    const service = await startedService();
    await service.chat('Less than 4 hours');
    const result = await service.generateReport();
    assert.equal(result.assessment?.incomplete, true);
    assert.notEqual(result.assessment?.verdict.level, 'good');
    assert.match(allText(requests[requests.length - 1]), /could not be read/);
  });

  test('treats an extraction with none of the expected answers as unread', async () => {
    fakeGroq([
      question('How many hours do you sleep?'),
      JSON.stringify({ summary: 'sleeps very little' }),
      JSON.stringify({ summary: 'sleeps very little' }),
      report,
    ]);
    const service = await startedService();
    await service.chat('About 3 hours');
    const result = await service.generateReport();
    assert.equal(result.assessment?.incomplete, true);
    assert.notEqual(result.assessment?.verdict.level, 'good');
  });

  test('forgets text typed with a report request when the report fails, so a retry does not duplicate it', async () => {
    let down = false;
    const requests = fakeGroq([question('How many hours do you sleep?'), extraction({ sleepHours: 7 }), report], {
      outage: () => down,
    });
    const service = await startedService();
    down = true;
    await assert.rejects(service.generateReport(undefined, 'generate my report, I sleep 7 hours'));
    down = false;
    await service.generateReport(undefined, 'generate my report, I sleep 7 hours');
    const copies = allText(requests[requests.length - 1]).split('User: generate my report, I sleep 7 hours').length - 1;
    assert.equal(copies, 1);
  });

  test('rates a consultation with healthy answers and clear skin as good', async () => {
    fakeGroq([
      question('How many hours do you sleep?'),
      question('How much water do you drink?'),
      extraction({ sleepHours: 8, waterLiters: 2.5, eatingPattern: 'regular', mealsPerDay: 3, stress: 'low' }),
      report,
    ]);
    const service = await startedService();
    await service.chat('About 8 hours');
    const result = await service.generateReport();
    assert.equal(result.assessment?.verdict.level, 'good');
  });

  test('redoes a report the model writes mid-conversation through the assessment', async () => {
    const requests = fakeGroq([question('How many hours do you sleep?'), report, extraction({ sleepHours: 3 }), report]);
    const service = await startedService();
    const result = await service.chat('Less than 4 hours');
    assert.equal(result.isReport, true);
    assert.equal(result.assessment?.lifestyle.risks[0].severity, 'critical');
    assert.equal(requests.length, 4);
  });
});
