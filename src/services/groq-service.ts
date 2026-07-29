/**
 * Groq LLM Service — Handles streaming chat completions via Groq's
 * OpenAI-compatible API.  No SDK needed, just fetch + SSE parsing.
 */

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

export interface LLMQuestion {
  message: string;
  options?: OptionCard[];
  isReport?: boolean;
}

export interface SkinMetrics {
  health: number;
  glow: number;
  hydration: number;
  melanin: number;
  erythema: number;
  oiliness: number;
  pores: number;
  texture: number;
  wrinkles: number;
  fatigue: number;
  darkCircles: number;
  heartRate: number;
  perfusion: number;
  yellowness: number;
  imageQuality: number;
  acne: number;
  uvDamage: number;
  elasticity: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

// ── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(metrics: SkinMetrics): string {
  // Interpret key flags the LLM should branch on
  const flags: string[] = [];
  if (metrics.hydration < 40) flags.push('LOW_HYDRATION');
  if (metrics.oiliness > 15) flags.push('HIGH_OILINESS');
  if (metrics.pores > 10) flags.push('ELEVATED_PORES');
  if (metrics.erythema > 140) flags.push('HIGH_REDNESS');
  if (metrics.acne > 10) flags.push('ACNE_PRESENT');
  if (metrics.darkCircles > 25) flags.push('DARK_CIRCLES');
  if (metrics.fatigue < 0.22) flags.push('FATIGUED');
  if (metrics.wrinkles > 4) flags.push('WRINKLES_ELEVATED');
  if (metrics.uvDamage > 30) flags.push('UV_DAMAGE');
  if (metrics.yellowness > 135) flags.push('YELLOWNESS_HIGH');
  if (metrics.elasticity < 50) flags.push('LOW_ELASTICITY');
  if (metrics.health < 50) flags.push('LOW_OVERALL_HEALTH');

  return `You are Dr. AyurGenX — a friendly, witty, and knowledgeable health consultant who blends modern dermatology with Ayurvedic wisdom. You use emojis, analogies, and a warm conversational tone. You're NOT clinical or robotic.

REAL-TIME SKIN SCAN DATA (from the user's webcam analysis):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Skin Health Score: ${metrics.health.toFixed(0)}/100
• Glow Score: ${metrics.glow.toFixed(0)}/100
• Hydration: ${metrics.hydration.toFixed(0)}/100
• Melanin Index: ${metrics.melanin.toFixed(1)}
• Redness (Erythema): ${metrics.erythema.toFixed(1)}
• Oiliness: ${metrics.oiliness.toFixed(1)}%
• Pore Density: ${metrics.pores.toFixed(1)}%
• Texture Score: ${metrics.texture.toFixed(0)}/100
• Wrinkle Density: ${metrics.wrinkles.toFixed(1)}%
• Fatigue (EAR): ${metrics.fatigue.toFixed(3)}
• Dark Circles: ${metrics.darkCircles.toFixed(0)}%
• Heart Rate: ${metrics.heartRate > 0 ? metrics.heartRate.toFixed(0) + ' BPM' : 'Not measured'}
• Skin Perfusion: ${metrics.perfusion.toFixed(0)}/100
• Yellowness Index: ${metrics.yellowness.toFixed(1)}
• Acne Severity: ${metrics.acne.toFixed(1)}%
• UV Damage: ${metrics.uvDamage.toFixed(0)}/100
• Elasticity: ${metrics.elasticity.toFixed(0)}/100
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FLAGGED CONCERNS: ${flags.length > 0 ? flags.join(', ') : 'NONE — skin looks healthy!'}

YOUR TASK:
1. Ask 5-7 smart, fun questions — ONE at a time — to understand the user's lifestyle.
2. Adapt questions based on the skin data flags above. For example:
   - HIGH_OILINESS → ask about diet/sugar
   - LOW_HYDRATION + DARK_CIRCLES → ask about water intake and sleep
   - ACNE_PRESENT → ask about skincare routine
   - FATIGUED → ask about sleep quality
3. Use "option cards" when possible so the user can tap instead of type.
4. After gathering enough info (5-7 questions), tell the user you're ready to generate their report.

RESPONSE FORMAT (STRICT JSON):
You MUST respond with valid JSON in this exact format:
{
  "message": "Your conversational message here with emojis",
  "options": [
    {"emoji": "🏃", "label": "Active & outdoors", "value": "active_outdoors"},
    {"emoji": "💻", "label": "Desk warrior", "value": "desk_job"}
  ],
  "questionNumber": 1,
  "totalExpected": 6,
  "isReport": false
}

If no options (free text question), omit the "options" field or set it to null.
When ready to generate the report, set "isReport": false and "message" to ask if they're ready.
When the user confirms, respond with the FULL REPORT in "message" (rich markdown) and "isReport": true.

REPORT STRUCTURE (when isReport is true):
The report message should be a comprehensive health report in markdown with these sections:
# 🏥 Overall Health Summary
# 🔬 Skin Analysis Breakdown
# 🧬 Lifestyle Assessment
# ⚠️ Risk Factors Identified
# 🌿 Ayurvedic Recommendations
# 💊 Modern Health Tips
# 📋 Personalized Daily Routine
# 🎯 Priority Actions — Top 3 This Week

IMPORTANT: Always respond with ONLY valid JSON. No text before or after the JSON.`;
}

// ── API Client ───────────────────────────────────────────────────────────────

export class GroqService {
  private apiKey: string;
  private conversationHistory: ChatMessage[] = [];
  private systemPrompt: string = '';

  constructor() {
    this.apiKey = import.meta.env.VITE_GROQ_API_KEY || '';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiKey !== 'your_groq_api_key_here';
  }

  initConversation(metrics: SkinMetrics): void {
    this.systemPrompt = buildSystemPrompt(metrics);
    this.conversationHistory = [{ role: 'system', content: this.systemPrompt }];
  }

  /**
   * Send a message and get a streaming response.
   * @param userMessage  The user's reply (or empty string for the opening question)
   * @param onChunk      Called with each text chunk as it arrives
   * @returns            The full accumulated response text
   */
  async chat(userMessage: string, onChunk?: (chunk: string) => void): Promise<LLMQuestion> {
    if (userMessage) {
      this.conversationHistory.push({ role: 'user', content: userMessage });
    } else {
      // Opening message — prompt the LLM to start
      this.conversationHistory.push({
        role: 'user',
        content: "Hi! I just completed my skin scan. Let's start the health consultation!",
      });
    }

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: this.conversationHistory,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error (${response.status}): ${errorText}`);
    }

    // ── Stream SSE ───────────────────────────────────────────────────────────
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            accumulated += delta;
            onChunk?.(delta);
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    // Save assistant response to history
    this.conversationHistory.push({ role: 'assistant', content: accumulated });

    // Parse the structured response
    return this.parseResponse(accumulated);
  }

  /**
   * Request the final report generation.
   */
  async generateReport(onChunk?: (chunk: string) => void): Promise<LLMQuestion> {
    return this.chat(
      "I'm ready! Please generate my comprehensive health report now based on everything we've discussed and my skin scan data.",
      onChunk
    );
  }

  private parseResponse(raw: string): LLMQuestion {
    let msgText = raw;
    let options: OptionCard[] | undefined = undefined;
    let isReport = false;

    try {
      // Try to extract JSON from the response (LLM sometimes wraps in markdown)
      let jsonStr = raw.trim();

      // Remove markdown code fences if present
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }
      jsonStr = jsonStr.trim();

      const parsed = JSON.parse(jsonStr);
      msgText = parsed.message || raw;
      options = parsed.options || undefined;
      isReport = !!parsed.isReport;
    } catch {
      msgText = raw;
    }

    // Auto-detect report if headers are present even if isReport flag was omitted in JSON
    const reportKeywords = [
      'Overall Health Summary',
      'Skin Analysis Breakdown',
      'Ayurvedic Recommendations',
      'Risk Factors Identified',
      'Lifestyle Assessment',
      'Personalized Daily Routine',
      'Priority Actions',
    ];

    const hasReportHeader = reportKeywords.some((kw) => msgText.includes(kw) || raw.includes(kw));

    if (hasReportHeader) {
      isReport = true;
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
