/**
 * Groq LLM Service — runs the consultation and writes the report via Groq's
 * OpenAI-compatible API. No SDK needed, just fetch + SSE parsing.
 *
 * The report is never written freely: the user's answers are first extracted
 * into structured facts and scored in code (lifestyle-risk), and the model then
 * writes the letter from that assessment, so worrying answers can't be glossed over.
 */

import {
  assessLifestyle,
  detectSafetyFlags,
  emptyProfile,
  overallVerdict,
  parseLifestyleProfile,
  type LifestyleAssessment,
  type LifestyleProfile,
  type SafetyFlag,
  type Verdict,
} from './lifestyle-risk';
import { healthLevel, interpretSkin, type SkinMetrics } from './skin-interpretation';

export type { SkinMetrics } from './skin-interpretation';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OptionCard {
  emoji: string;
  label: string;
  value: string;
}

/** What the report was written from: computed by the app, not by the LLM. */
export interface ReportAssessment {
  verdict: Verdict;
  lifestyle: LifestyleAssessment;
  skinHealth: number;
  /** The user's answers couldn't be read, so the verdict is capped and the report says so. */
  incomplete: boolean;
}

export interface LLMQuestion {
  message: string;
  options?: OptionCard[];
  isReport?: boolean;
  /** Set on reports. */
  assessment?: ReportAssessment;
}

interface TranscriptEntry {
  speaker: 'advisor' | 'user';
  text: string;
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

/**
 * Strongest first; only these are ever used (very small models follow the honesty
 * rules poorly). Models Groq stops serving are skipped automatically.
 */
const CHAT_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const CHAT_TEMPERATURE = 0.5;
const REPORT_TEMPERATURE = 0.3;

// ── Prompts ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(metrics: SkinMetrics): string {
  const readings = interpretSkin(metrics);
  const overall = {
    good: 'looking healthy overall',
    fair: 'in a decent range, with a few things to improve',
    concern: 'showing several things that need attention',
  }[healthLevel(metrics.health)];
  const observations = readings.map((r) => `- ${r.label}: ${r.phrase}`).join('\n');
  const worthAsking = readings.filter((r) => r.level !== 'good').map((r) => r.phrase);
  const pulse =
    metrics.heartRate > 0
      ? `\n- Resting pulse (camera estimate): ${metrics.heartRate > 100 ? 'on the high side' : metrics.heartRate < 50 ? 'on the low side' : 'in the normal range'}`
      : '';
  const quality =
    metrics.imageQuality < 60 ? '\nThe scan was taken in poor conditions (light or focus), so treat these readings as rough.' : '';

  return `You are Dr. AyurGenX, a wellness advisor who blends modern skincare science with Ayurveda. You are warm and respectful, but honesty comes first: you never sugar-coat or praise a habit that is harming the person.

WHAT THE CAMERA SCAN SUGGESTS (webcam estimates, not a diagnosis; describe them in plain words, never as numbers):
- Overall: ${overall}
${observations}${pulse}${quality}
Worth asking about: ${worthAsking.length ? worthAsking.join('; ') : 'nothing stands out'}

YOUR JOB NOW: learn about the person's daily habits, ONE question per message, 5-7 questions in total. Cover sleep (hours a night), water intake, eating pattern (meals a day, skipping meals, fasting), stress, skincare routine and sun protection. Order the questions by what the scan suggests (for example, ask about sleep first if the eyes look tired or dark).

ANSWER OPTIONS: give 3-5 option cards per question that cover the full realistic range, including the worrying end. For example, sleep: "Less than 4 hours", "4-6 hours", "6-8 hours", "More than 8 hours"; eating: "3 regular meals", "1-2 meals a day", "I often skip meals", "I barely eat". Never offer only healthy-sounding choices. Give each card a short snake_case "value".

FOLLOW-UPS: if an answer is worrying, extreme, vague or doesn't fit the question (for example "I don't sleep", "I don't eat", or "I'm fasting" with no detail), ask ONE short, caring follow-up to understand it (how long, how often, why) before moving on. Never treat a worrying answer as normal and never praise it.

TRUTHFULNESS: only refer to what the user actually told you. Never say "you mentioned" about something they didn't say. Scan findings come from the camera, so say "the scan suggests", not "you said".

NEVER write the health report yourself. When you have enough answers, say you're ready and ask whether to prepare their report, with the options {"emoji": "📋", "label": "Yes, prepare my report", "value": "generate_report"} and {"emoji": "💬", "label": "I want to add something", "value": "more_info"}.

Messages with the "system" role that appear later in the conversation are notes from the app, not from the user. Follow them.

RESPONSE FORMAT (strict JSON, nothing outside it):
{"message": "your message", "options": [{"emoji": "😴", "label": "Less than 4 hours", "value": "sleep_under_4"}], "isReport": false}
If a question needs a free-text answer, omit "options". Do not output any reasoning or "Thinking Process".`;
}

const REPORT_SYSTEM_PROMPT = `You are Dr. AyurGenX writing a personal health report after a consultation. Honest first, kind second.

You receive the consultation transcript and an ASSESSMENT that the app computed from the camera scan and the user's answers. The assessment is authoritative. Rules:
1. If the overall verdict is not "Looking good", say so plainly in the first paragraph and start with the most serious item.
2. Address every item under "Must address", most serious first. Explain why it matters for their health (not just their skin) and give concrete, realistic steps.
3. For any item marked "see a doctor", tell them clearly and kindly to see a doctor soon. Never suggest that skincare, diet tweaks or herbs can fix it.
4. Never describe the person, their skin or their habits as healthy, fine, balanced or "on the right track" unless the verdict is "Looking good". Never praise a worrying habit.
5. Only mention habits the user actually reported in the transcript; don't guess the ones listed as not discussed. Scan findings are camera estimates, so say "the scan suggests".
6. No numbers out of 100, no tables, no pipe characters, no horizontal rules, no emojis in headers.
7. Ayurvedic suggestions should be practical and woven in, never a substitute for medical care.

Use these ## sections in this order:
## The Most Important Thing (only when the verdict is not "Looking good")
## How Your Skin is Doing
## Your Habits and Your Health
## What I'd Suggest
## Your Morning and Evening Routine
## This Week's Focus
Write 350-600 words of flowing paragraphs. Close with encouragement that is realistic: being supportive never means pretending things are fine.

Respond with strict JSON only: {"message": "<the report in markdown>", "isReport": true}`;

const EXTRACTION_PROMPT = `You extract facts from a skincare consultation transcript. Use ONLY what the User said, never the Advisor's questions or suggestions. If something was not clearly stated, use null.
Convert ranges to one number (use the midpoint; "less than 4 hours" -> 3, "under 1 litre" -> 0.75, "8+ hours" -> 8.5). If the user says they don't sleep, sleepHours is 0. If they say they don't eat, eatingPattern is "not_eating" and mealsPerDay is 0. "extended_fasting" means going a day or more without food; time-restricted eating windows are "intermittent_fasting".

Return strict JSON with exactly these keys:
{"sleepHours": number|null, "waterLiters": number|null, "mealsPerDay": number|null,
 "eatingPattern": "regular"|"irregular"|"skips_meals"|"intermittent_fasting"|"extended_fasting"|"not_eating"|null,
 "stress": "low"|"moderate"|"high"|"severe"|null,
 "skincare": "none"|"basic"|"full"|"prescription"|null,
 "sunProtection": "daily"|"sometimes"|"never"|null,
 "smoking": true|false|null,
 "alcohol": "none"|"occasional"|"frequent"|"heavy"|null,
 "exercise": "none"|"light"|"regular"|null}`;

function followUpNote(flags: SafetyFlag[]): string {
  const concerns = flags.map((f) => `${f.label} (${f.severity})`).join('; ');
  return `App note, not from the user: their last answer suggests ${concerns}. Before moving on, ask ONE short, caring follow-up question to understand it (how long, how often, why). Do not treat it as normal and do not praise it.`;
}

function formatTranscript(entries: TranscriptEntry[]): string {
  return entries.map((e) => `${e.speaker === 'user' ? 'User' : 'Advisor'}: ${e.text}`).join('\n');
}

const SEVERITY_TAGS = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MODERATE' } as const;

/** Core habits the report should only talk about if the user actually covered them. */
function topicsNotDiscussed(a: LifestyleAssessment): string[] {
  const p: LifestyleProfile = a.profile;
  const covered = new Set(a.risks.map((r) => r.topic));
  const topics: [string, boolean][] = [
    ['sleep', p.sleepHours !== null || covered.has('sleep')],
    ['water intake', p.waterLiters !== null || covered.has('water')],
    [
      'eating pattern',
      p.eatingPattern !== null || p.mealsPerDay !== null || covered.has('eating') || covered.has('disordered_eating'),
    ],
    ['stress', p.stress !== null || covered.has('stress')],
    ['skincare routine', p.skincare !== null],
    ['sun protection', p.sunProtection !== null || covered.has('sun')],
  ];
  return topics.filter(([, known]) => !known).map(([name]) => name);
}

function buildReportBrief(metrics: SkinMetrics, a: ReportAssessment, transcript: string): string {
  const readings = interpretSkin(metrics);
  const phrasesAt = (level: string) =>
    readings
      .filter((r) => r.level === level)
      .map((r) => r.phrase)
      .join('; ') || 'none';
  const risks = a.lifestyle.risks.length
    ? a.lifestyle.risks
        .map((r, i) => `${i + 1}. [${SEVERITY_TAGS[r.severity]}${r.seeDoctor ? ', see a doctor' : ''}] ${r.label}: ${r.detail}`)
        .join('\n')
    : 'Nothing worrying in their answers.';
  const notDiscussed = topicsNotDiscussed(a.lifestyle);

  return [
    'CONSULTATION TRANSCRIPT',
    transcript || '(no answers recorded)',
    '',
    'ASSESSMENT (computed by the app; follow it)',
    `Overall verdict: ${a.verdict.label}`,
    `Skin scan overall: ${{ good: 'good', fair: 'fair', concern: 'needs care' }[healthLevel(a.skinHealth)]}`,
    'Must address (most serious first):',
    risks,
    'Skin scan (camera estimates):',
    `- Concerns: ${phrasesAt('concern')}`,
    `- Fair: ${phrasesAt('fair')}`,
    `- Looking good: ${phrasesAt('good')}`,
    ...(notDiscussed.length ? [`Not discussed, so don't guess: ${notDiscussed.join(', ')}`] : []),
    ...(a.incomplete
      ? [
          "Some of the user's answers could not be read: do not describe their habits as healthy, and suggest they repeat the consultation.",
        ]
      : []),
  ].join('\n');
}

function readApiKeyFromEnv(): string {
  try {
    return import.meta.env.VITE_GROQ_API_KEY || '';
  } catch {
    return ''; // outside Vite (e.g. unit tests)
  }
}

// ── API Client ───────────────────────────────────────────────────────────────

export class GroqService {
  private apiKey: string;
  private conversationHistory: ChatMessage[] = [];
  private systemPrompt: string = '';
  private metrics: SkinMetrics | null = null;
  private transcript: TranscriptEntry[] = [];
  private safetyFlags: SafetyFlag[] = [];

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? readApiKeyFromEnv();
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiKey !== 'your_groq_api_key_here';
  }

  /**
   * Transcribe recorded audio using Groq Whisper API endpoint.
   */
  async transcribeAudio(audioBlob: Blob): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Groq API key not configured');
    }
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq Whisper API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.text || '';
  }

  private mockMetrics: SkinMetrics | null = null;
  private mockStep: number = 0;

  initConversation(metrics: SkinMetrics): void {
    this.metrics = metrics;
    this.mockMetrics = metrics;
    this.mockStep = 0;
    this.transcript = [];
    this.safetyFlags = [];
    this.systemPrompt = buildSystemPrompt(metrics);
    this.conversationHistory = [{ role: 'system', content: this.systemPrompt }];
  }

  /** Worrying statements the user has made so far (detected in code, not by the LLM). */
  getSafetyFlags(): SafetyFlag[] {
    return [...this.safetyFlags];
  }

  private cachedActiveModels: string[] | null = null;

  /**
   * The pinned models that Groq currently serves, strongest first.
   */
  async fetchAvailableChatModels(): Promise<string[]> {
    if (this.cachedActiveModels) return this.cachedActiveModels;

    try {
      const res = await fetch(GROQ_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const served = new Set((data?.data ?? []).map((m: any) => m.id));
        const available = CHAT_MODELS.filter((m) => served.has(m));
        if (available.length > 0) {
          this.cachedActiveModels = available;
          return available;
        }
      }
    } catch (e) {
      console.warn('Could not query Groq /models, trying the pinned models directly:', e);
    }

    // Let the chat request itself report what's wrong.
    this.cachedActiveModels = CHAT_MODELS;
    return CHAT_MODELS;
  }

  /**
   * Sends a request to the first pinned model that responds and returns the
   * text of its reply. Not streamed: Groq's JSON mode doesn't support streaming,
   * and nothing here shows partial replies.
   */
  private async complete(messages: ChatMessage[], temperature: number): Promise<string> {
    let lastErrorText = '';

    for (const model of await this.fetchAvailableChatModels()) {
      try {
        const res = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: 4096,
            response_format: { type: 'json_object' },
            stream: false,
          }),
        });

        if (!res.ok) {
          lastErrorText = await res.text();
          console.warn(`Groq model '${model}' failed (${res.status}): ${lastErrorText}. Trying the next pinned model...`);
          continue;
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
      } catch (err: any) {
        lastErrorText = err.message || String(err);
        console.warn(`Network/Request error on model '${model}':`, err);
      }
    }

    throw new Error(`Groq API error: ${lastErrorText || 'All pinned models failed'}`);
  }

  /**
   * Adds the user's words to the conversation and transcript. Worrying
   * statements are caught in code, and the model is told to follow up on them.
   * Returns a function that undoes the turn (used when the request fails).
   */
  private recordUserTurn(text: string): () => void {
    const lengths = [this.conversationHistory.length, this.transcript.length, this.safetyFlags.length];
    this.conversationHistory.push({ role: 'user', content: text });
    this.transcript.push({ speaker: 'user', text });

    const fresh = detectSafetyFlags(text).filter((f) => !this.safetyFlags.some((k) => k.id === f.id));
    if (fresh.length > 0) {
      this.safetyFlags.push(...fresh);
      this.conversationHistory.push({ role: 'system', content: followUpNote(fresh) });
    }

    return () => {
      this.conversationHistory.length = lengths[0];
      this.transcript.length = lengths[1];
      this.safetyFlags.length = lengths[2];
    };
  }

  /**
   * Send a message and get the advisor's next question.
   * @param userMessage  The user's reply (or empty string for the opening question)
   * @param onChunk      Called with the reply text once it arrives
   */
  async chat(userMessage: string, onChunk?: (chunk: string) => void): Promise<LLMQuestion> {
    let undoTurn = () => {};
    if (userMessage) {
      undoTurn = this.recordUserTurn(userMessage);
    } else {
      // Opening message — prompt the LLM to start
      this.conversationHistory.push({
        role: 'user',
        content: "Hi! I just completed my skin scan. Let's start the health consultation!",
      });
    }

    if (!this.isConfigured()) {
      return this.generateMockStepResponse(userMessage, onChunk);
    }

    let raw: string;
    try {
      raw = await this.complete(this.conversationHistory, CHAT_TEMPERATURE);
    } catch (err) {
      undoTurn(); // so sending the same answer again doesn't duplicate it
      throw err;
    }
    const parsed = this.parseResponse(raw);

    if (parsed.isReport) {
      // Reports are only ever written from the app's assessment, never ad hoc mid-conversation.
      return this.generateReport(onChunk);
    }

    this.conversationHistory.push({ role: 'assistant', content: raw });
    this.transcript.push({ speaker: 'advisor', text: parsed.message });
    onChunk?.(parsed.message);
    return parsed;
  }

  private async generateMockStepResponse(userMessage: string, onChunk?: (chunk: string) => void): Promise<LLMQuestion> {
    const m: SkinMetrics = this.mockMetrics || {
      health: 75,
      glow: 70,
      hydration: 60,
      melanin: 18,
      erythema: 25,
      oiliness: 12,
      pores: 8,
      texture: 65,
      wrinkles: 2,
      fatigue: 0.3,
      darkCircles: 15,
      heartRate: 72,
      perfusion: 70,
      yellowness: 120,
      imageQuality: 85,
      acne: 5,
      uvDamage: 20,
      elasticity: 75,
      pigmentation: 15,
    };

    if (userMessage.toLowerCase().includes('report') || userMessage === 'generate_report' || this.mockStep >= 4) {
      const healthDesc = m.health >= 70 ? 'doing quite well overall' : m.health >= 50 ? 'in a decent place with some areas to work on' : 'showing signs that need a little extra care';
      const hydrationDesc = m.hydration >= 60 ? 'reasonably well-hydrated' : m.hydration >= 40 ? 'a bit on the dry side' : 'noticeably lacking moisture';
      const textureDesc = m.texture >= 65 ? 'smooth and even' : 'showing some uneven patches';

      const reportMarkdown = `## How Your Skin is Doing

First off, thanks for taking the time to go through this with me! Based on everything I've seen from your scan and what you've shared, your skin is ${healthDesc}. There's a nice foundation to work with here, and with a few small adjustments, I think you'll notice a real difference in how your skin looks and feels.

## What I Noticed

Looking at your scan results, a few things stood out to me. Your skin's hydration is ${hydrationDesc} — ${m.hydration < 50 ? "this is probably the most important thing we can address, because when your skin doesn't have enough moisture, everything else suffers too" : "which is great, but there's always room to keep it topped up"}. Your skin texture is ${textureDesc}, and ${m.oiliness > 12 ? "I noticed your oil levels are a bit elevated, especially around the forehead and nose area — that's completely normal, but managing it will help prevent breakouts" : "your oil balance looks healthy, which is a really good sign"}.

${m.darkCircles > 20 ? "I also noticed some shadows under your eyes. This usually comes down to a combination of sleep quality and hydration, and it's one of the easiest things to improve." : ""}

## Your Lifestyle and How It Connects

From what you've told me about your daily routine, I can see how some of your habits are directly showing up on your skin. ${m.hydration < 50 ? "The dryness I'm seeing lines up with what you mentioned about your water intake — your skin is essentially asking for more hydration from the inside out." : "Your habits seem to be supporting your skin pretty well."} Sleep is another big one — it's when your skin does most of its repair work, so ${m.fatigue < 0.25 ? "the tiredness I'm picking up from your scan suggests your skin isn't getting quite enough recovery time" : "it looks like you're getting decent rest, which your skin is grateful for"}.

## A Few Things to Keep an Eye On

${m.erythema > 130 ? "Your skin is showing some sensitivity and redness, which can flare up with stress, spicy foods, or harsh skincare products. Being gentle with your skin — both in what you put on it and what you eat — will help calm things down." : "Nothing major to worry about here."}

${m.uvDamage > 25 ? "I'm also seeing some early signs of sun exposure. Sunscreen really is your best friend here, even on cloudy days. Think of it as an investment in how your skin will look five years from now." : ""}

## What I'd Suggest

Here's where the good stuff comes in. I like to blend the best of modern skincare with some tried-and-true Ayurvedic wisdom:

**For hydration**, try applying a lightweight hyaluronic acid serum on slightly damp skin — it works like a moisture magnet. On the Ayurvedic side, warm sesame oil applied before your shower (called abhyanga) is wonderful for locking in moisture and calming your nervous system at the same time.

${m.oiliness > 12 ? "**For oil balance**, niacinamide is your go-to ingredient — it helps regulate sebum without stripping your skin. And try cutting back on refined sugar for a couple weeks; you might be surprised how much it helps." : ""}

**For that natural glow**, cooling botanicals like aloe vera gel and rosewater make a lovely toner. Gotu kola (Centella) is another gem — it supports collagen and helps with overall skin recovery.

## Your Morning and Evening Routine

**Morning**: Start with a gentle cleanser, follow up with a vitamin C serum for protection and brightness, then your moisturizer, and always finish with SPF. Keep it simple.

**Evening**: Double cleanse to remove the day, apply your niacinamide or treatment serum, and finish with a rich night moisturizer. This is when your skin heals, so give it good ingredients to work with.

## This Week's Focus

Let's keep it manageable — just three things to focus on this week:

- Drink a little more water than you usually do. Even one extra glass makes a difference.
- Be consistent with your evening skincare, even when you're tired. Your future skin will thank you.
- Try the sesame oil abhyanga before your shower, even just twice this week. It's deeply nourishing and surprisingly relaxing.

You're already on the right track by paying attention to your skin and taking this assessment. Small, consistent steps will get you where you want to be. Take care of yourself! 🌿
`;

      if (onChunk) {
        for (let i = 0; i < reportMarkdown.length; i += 20) {
          onChunk(reportMarkdown.slice(i, i + 20));
          await new Promise((r) => setTimeout(r, 15));
        }
      }

      this.conversationHistory.push({ role: 'assistant', content: reportMarkdown });
      return { message: reportMarkdown, isReport: true };
    }

    let result: LLMQuestion;

    if (this.mockStep === 0) {
      result = {
        message: `Hello! I'm **Dr. AyurGenX** 🌿. I've reviewed your dermal scan results (Overall Skin Health: **${m.health.toFixed(0)}/100**). To help me generate a tailored health report, how much water do you drink daily?`,
        options: [
          { emoji: '💧', label: 'Under 1.5 Liters', value: 'low_water' },
          { emoji: '🥛', label: '1.5 - 2.5 Liters', value: 'moderate_water' },
          { emoji: '🚰', label: '2.5+ Liters (Hydro Homie)', value: 'high_water' },
        ],
      };
    } else if (this.mockStep === 1) {
      result = {
        message: `Got it! Water intake directly impacts cellular turgor and hydration metrics. How many hours of restful sleep do you average per night?`,
        options: [
          { emoji: '😴', label: 'Under 6 hours', value: 'low_sleep' },
          { emoji: '🌙', label: '6 - 7.5 hours', value: 'normal_sleep' },
          { emoji: '🛌', label: '8+ hours', value: 'optimal_sleep' },
        ],
      };
    } else if (this.mockStep === 2) {
      result = {
        message: `Sleep quality is crucial for collagen synthesis and reducing under-eye dark circles. How would you describe your typical diet?`,
        options: [
          { emoji: '🥗', label: 'Fresh, balanced & whole foods', value: 'clean_diet' },
          { emoji: '🍕', label: 'Mixed with occasional fast food', value: 'mixed_diet' },
          { emoji: '🌶️', label: 'High spice, processed, or sugary', value: 'spicy_diet' },
        ],
      };
    } else if (this.mockStep === 3) {
      result = {
        message: `Diet plays a big role in skin sebum levels and inflammation! What is your typical daily stress level?`,
        options: [
          { emoji: '🧘', label: 'Low & well managed', value: 'low_stress' },
          { emoji: '💼', label: 'Moderate work stress', value: 'moderate_stress' },
          { emoji: '🔥', label: 'High stress / heavy schedule', value: 'high_stress' },
        ],
      };
    } else {
      result = {
        message: `Thank you! I have synthesized your skin telemetry data and lifestyle profile. Ready to generate your personalized health report?`,
        options: [
          { emoji: '📋', label: 'Yes, generate my report!', value: 'generate_report' },
          { emoji: '💬', label: 'I have more details to add', value: 'more_info' },
        ],
      };
    }

    this.mockStep++;
    if (onChunk) {
      onChunk(result.message);
    }

    this.conversationHistory.push({ role: 'assistant', content: JSON.stringify(result) });
    return result;
  }

  /**
   * Writes the final report in two steps: extract the user's answers as facts,
   * score them in code, then have the model write the letter from that assessment.
   */
  /**
   * @param userMessage  Anything the user typed along with the request ("generate my
   *                     report, also I don't eat"), so it counts like any other answer.
   */
  async generateReport(onChunk?: (chunk: string) => void, userMessage?: string): Promise<LLMQuestion> {
    if (!this.isConfigured() || !this.metrics) {
      return this.chat(
        "I'm ready! Please generate my comprehensive health report now based on everything we've discussed and my skin scan data.",
        onChunk
      );
    }
    const undoTurn = userMessage && userMessage !== 'generate_report' ? this.recordUserTurn(userMessage) : () => {};

    try {
      const extraction = await this.extractLifestyle();
      const lifestyle = assessLifestyle(extraction.profile, this.safetyFlags);
      const incomplete = !extraction.ok;
      const assessment: ReportAssessment = {
        verdict: overallVerdict(this.metrics.health, lifestyle.level, { incomplete }),
        lifestyle,
        skinHealth: this.metrics.health,
        incomplete,
      };

      const raw = await this.complete(
        [
          { role: 'system', content: REPORT_SYSTEM_PROMPT },
          { role: 'user', content: buildReportBrief(this.metrics, assessment, formatTranscript(this.transcript)) },
        ],
        REPORT_TEMPERATURE
      );
      const message = this.parseResponse(raw).message;
      onChunk?.(message);
      return { message, isReport: true, assessment };
    } catch (err) {
      undoTurn(); // so asking again doesn't duplicate what they typed
      throw err;
    }
  }

  /**
   * Step 1 of the report: the user's answers as structured, validated facts.
   * Tried twice; `ok` is false when no usable answer came back (no JSON, or
   * none of the expected answers), so the report is never rated "good" blind.
   */
  private async extractLifestyle(): Promise<{ profile: LifestyleProfile; ok: boolean }> {
    const transcript = formatTranscript(this.transcript);
    if (!transcript) return { profile: emptyProfile(), ok: true };

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await this.complete(
          [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: transcript },
          ],
          0
        );
        const [facts] = this.extractJsonObjects(this.stripThinkingBlocks(raw));
        const profile = parseLifestyleProfile(facts);
        if (Object.values(profile).some((v) => v !== null)) return { profile, ok: true };
        console.warn(`Lifestyle extraction attempt ${attempt} returned no usable answers.`);
      } catch (err) {
        console.warn(`Lifestyle extraction attempt ${attempt} failed:`, err);
      }
    }
    return { profile: emptyProfile(), ok: false };
  }

  private stripThinkingBlocks(text: string): string {
    if (!text) return '';
    let cleaned = text;

    // Remove <think>...</think> XML tags
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Remove "Thinking Process: ... " until JSON object or actual response
    cleaned = cleaned.replace(/^Thinking Process:[\s\S]*?(?=\n\n\s*\{|\n\n\s*#|\n\n\s*\[|\{|\n\n[A-Z]|$)/gi, '');
    cleaned = cleaned.replace(/Thinking Process:[\s\S]*?(?=(\{[\s\S]*"message"))/gi, '');

    return cleaned.trim();
  }

  /**
   * Extract all valid JSON objects from a text string, including concatenated JSON blocks.
   */
  private extractJsonObjects(str: string): any[] {
    const results: any[] = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIdx = -1;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          if (depth === 0) {
            startIdx = i;
          }
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0 && startIdx !== -1) {
            const jsonSubstring = str.substring(startIdx, i + 1);
            try {
              const parsed = JSON.parse(jsonSubstring);
              if (parsed && typeof parsed === 'object') {
                results.push(parsed);
              }
            } catch {
              // Ignore invalid sub-blocks
            }
            startIdx = -1;
          }
        }
      }
    }
    return results;
  }

  private parseResponse(raw: string): LLMQuestion {
    let cleanedRaw = this.stripThinkingBlocks(raw).trim();
    let msgText = cleanedRaw;
    let options: OptionCard[] | undefined = undefined;
    let isReport = false;

    // 1. Remove markdown code fences if present
    if (cleanedRaw.startsWith('```json')) {
      cleanedRaw = cleanedRaw.slice(7);
    } else if (cleanedRaw.startsWith('```')) {
      cleanedRaw = cleanedRaw.slice(3);
    }
    if (cleanedRaw.endsWith('```')) {
      cleanedRaw = cleanedRaw.slice(0, -3);
    }
    cleanedRaw = cleanedRaw.trim();

    // 2. Extract structured JSON objects using balanced brace scanner
    const extractedObjects = this.extractJsonObjects(cleanedRaw);

    if (extractedObjects.length > 0) {
      // If multiple JSON objects were concatenated, take the most recent valid one containing 'message'
      const validObj = extractedObjects.reverse().find((o) => o.message || o.report || o.options) || extractedObjects[0];
      msgText = validObj.message || validObj.report || validObj.content || '';
      options = Array.isArray(validObj.options) ? validObj.options : undefined;
      isReport = !!validObj.isReport;
    } else {
      // 3. Regex Fallback: If standard JSON parsing failed, extract "message" and "options" via regex
      const msgMatch = cleanedRaw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (msgMatch && msgMatch[1]) {
        try {
          msgText = JSON.parse(`"${msgMatch[1]}"`);
        } catch {
          msgText = msgMatch[1];
        }
      }

      const optMatch = cleanedRaw.match(/"options"\s*:\s*(\[[^\]]+\])/);
      if (optMatch && optMatch[1]) {
        try {
          const parsedOpts = JSON.parse(optMatch[1]);
          if (Array.isArray(parsedOpts)) {
            options = parsedOpts;
          }
        } catch {}
      }

      if (cleanedRaw.includes('"isReport": true') || cleanedRaw.includes('"isReport":true')) {
        isReport = true;
      }
    }

    // 4. Clean any residual JSON tags, braces, or quotes if msgText still looks like raw JSON
    if (msgText.trim().startsWith('{') && msgText.includes('"message"')) {
      const innerMatch = msgText.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (innerMatch && innerMatch[1]) {
        try {
          msgText = JSON.parse(`"${innerMatch[1]}"`);
        } catch {
          msgText = innerMatch[1];
        }
      } else {
        msgText = msgText.replace(/\{|\}|"message":|"options":|"questionNumber":\s*\d+,?|"totalExpected":\s*\d+,?|"isReport":\s*(true|false),?/g, '').trim();
      }
    }

    // 5. Clean any residual markdown fences if present in message text
    if (msgText.startsWith('```markdown')) {
      msgText = msgText.slice(11);
    } else if (msgText.startsWith('```md')) {
      msgText = msgText.slice(5);
    } else if (msgText.startsWith('```')) {
      msgText = msgText.slice(3);
    }
    if (msgText.endsWith('```')) {
      msgText = msgText.slice(0, -3);
    }

    msgText = this.stripThinkingBlocks(msgText);

    // 6. Auto-detect report if standard report sections are present
    const reportKeywords = [
      'The Most Important Thing',
      'Your Habits and Your Health',
      'How Your Skin is Doing',
      'What I Noticed',
      'What I\'d Suggest',
      'Your Lifestyle and How It Connects',
      'A Few Things to Keep an Eye On',
      'Your Morning and Evening Routine',
      'This Week\'s Focus',
      'What I\'d Recommend',
    ];

    const hasReportHeader = reportKeywords.some((kw) => msgText.includes(kw) || raw.includes(kw));
    if (hasReportHeader) {
      isReport = true;
    }

    // 7. Ultimate fallback
    if (!msgText) {
      msgText =
        "I have collected your skin scan data and lifestyle responses! I'm ready to generate your comprehensive health report.";
    }

    return {
      message: msgText,
      options: options,
      isReport: isReport,
    };
  }

  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  getQuestionCount(): number {
    return this.conversationHistory.filter((m) => m.role === 'assistant').length;
  }
}
