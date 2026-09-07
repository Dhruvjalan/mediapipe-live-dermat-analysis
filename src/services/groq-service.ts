/**
 * Groq LLM Service — Handles streaming chat completions via Groq's
 * OpenAI-compatible API.  No SDK needed, just fetch + SSE parsing.
 */

import { getCachedLocation } from './location-service';

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

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

const CANDIDATE_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.6-27b',
  'groq/compound',
];

// ── System Prompt Builder ────────────────────────────────────────────────────

function _buildLocationBlock(): string {
  const loc = getCachedLocation();
  if (!loc) return 'USER LOCATION: Not detected\n';

  return `USER LOCATION (auto-detected):
• City: ${loc.city}${loc.state ? ', ' + loc.state : ''}
• Country: ${loc.country}
• Coordinates: ${loc.latitude.toFixed(4)}°N, ${loc.longitude.toFixed(4)}°E
Use this location to tailor advice (local climate, water quality, UV exposure, regional diet, available botanicals).
`;
}

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

${_buildLocationBlock()}
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
# 🌍 Location-Based Insights (if location detected — climate, UV, water quality, local botanicals)
# 🌿 Ayurvedic Recommendations
# 💊 Modern Health Tips
# 📋 Personalized Daily Routine
# 🎯 Priority Actions — Top 3 This Week

CRITICAL INSTRUCTIONS:
- DO NOT output any internal scratchpad, reasoning, or "Thinking Process:".
- Respond ONLY with the strict JSON object. No conversational preamble or postscript outside the JSON.`;
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
    this.mockMetrics = metrics;
    this.mockStep = 0;
    this.systemPrompt = buildSystemPrompt(metrics);
    this.conversationHistory = [{ role: 'system', content: this.systemPrompt }];
  }

  private cachedActiveModels: string[] | null = null;

  /**
   * Fetch active chat models dynamically from Groq's /models endpoint.
   */
  async fetchAvailableChatModels(): Promise<string[]> {
    if (this.cachedActiveModels && this.cachedActiveModels.length > 0) {
      return this.cachedActiveModels;
    }

    try {
      const res = await fetch(GROQ_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.data)) {
          // Filter out whisper, tts, embedding, and guard models
          const chatModels = data.data
            .map((m: any) => m.id)
            .filter(
              (id: string) =>
                typeof id === 'string' &&
                !id.includes('whisper') &&
                !id.includes('tts') &&
                !id.includes('embed') &&
                !id.includes('guard')
            );

          if (chatModels.length > 0) {
            // Prioritize top recommended models
            const prioritized = CANDIDATE_MODELS.filter((m) => chatModels.includes(m));
            const others = chatModels.filter((m: string) => !CANDIDATE_MODELS.includes(m));
            this.cachedActiveModels = [...prioritized, ...others];
            console.log('Dynamic Groq Active Models Loaded:', this.cachedActiveModels);
            return this.cachedActiveModels;
          }
        }
      }
    } catch (e) {
      console.warn('Could not query Groq /models dynamically, using fallback candidates list:', e);
    }

    this.cachedActiveModels = CANDIDATE_MODELS;
    return CANDIDATE_MODELS;
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

    if (!this.isConfigured()) {
      return this.generateMockStepResponse(userMessage, onChunk);
    }

    const availableModels = await this.fetchAvailableChatModels();
    let response: Response | null = null;
    let lastErrorText = '';

    for (const modelCandidate of availableModels) {
      try {
        const res = await fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: modelCandidate,
            messages: this.conversationHistory,
            temperature: 0.7,
            max_tokens: 4096,
            stream: true,
          }),
        });

        if (res.ok) {
          response = res;
          break;
        }

        const errText = await res.text();
        lastErrorText = errText;
        console.warn(
          `Groq model '${modelCandidate}' failed (${res.status}): ${errText}. Trying next candidate model...`
        );
      } catch (err: any) {
        lastErrorText = err.message || String(err);
        console.warn(`Network/Request error on model '${modelCandidate}':`, err);
      }
    }

    if (!response || !response.ok) {
      throw new Error(`Groq API error: ${lastErrorText || 'All candidate models failed'}`);
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
    };

    if (userMessage.toLowerCase().includes('report') || userMessage === 'generate_report' || this.mockStep >= 4) {
      const reportMarkdown = `
# 🏥 Overall Health Summary
Based on your biometric skin scan, your overall **Skin Health Score is ${m.health.toFixed(0)}/100**. Your skin exhibits moderate physiological equilibrium with localized telemetry markers indicating areas for targeted hydration and barrier restoration.

# 🔬 Skin Analysis Breakdown
- **Hydration Level**: ${m.hydration.toFixed(0)}/100 ${m.hydration < 50 ? '⚠️ (Needs attention)' : '✅ (Optimal)'}
- **Melanin & Pigmentation Index**: ${m.melanin.toFixed(1)}
- **Redness / Erythema Index**: ${m.erythema.toFixed(1)} ${m.erythema > 100 ? '⚠️ (Elevated vascular sensitivity)' : '✅ (Normal)'}
- **Specular Glare / Oiliness**: ${m.oiliness.toFixed(1)}%
- **Texture & Elasticity**: ${m.texture.toFixed(0)}/100

# 🧬 Lifestyle Assessment
Your responses indicate consistent activity patterns. Restoring optimal hydration and improving restorative sleep cycles will directly accelerate dermal barrier recovery.

# ⚠️ Risk Factors Identified
- Micro-vascular reactivity under stress or environmental changes.
- Trans-epidermal water loss during extended screen time or dry air exposure.

# 🌿 Ayurvedic Recommendations (Dosha Alignment)
- **Pitta Balancing**: Incorporate cooling botanicals such as Aloe Vera, Rosewater, and Gotu Kola.
- **Vata Support**: Warm sesame oil abhyanga massage prior to baths to lock in lipid moisture.

# 💊 Modern Health Tips
- Apply a hyaluronic acid-based serum on damp skin twice daily.
- Use a broad-spectrum SPF 50+ mineral sunscreen to shield against UV and blue light exposure.

# 📋 Personalized Daily Routine
- **Morning**: Gentle cleanser → Vitamin C / Antioxidant serum → Barrier cream → SPF 50+.
- **Evening**: Double cleanse → Niacinamide serum → Hydrating night moisturizer.

# 🎯 Priority Actions — Top 3 This Week
1. Increase water intake to at least 2.5 Liters daily.
2. Maintain consistent 7-8 hours of nighttime rest.
3. Apply cooling topical moisturizer following multi-angle camera scans.
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
   * Request the final report generation.
   */
  async generateReport(onChunk?: (chunk: string) => void): Promise<LLMQuestion> {
    return this.chat(
      "I'm ready! Please generate my comprehensive health report now based on everything we've discussed and my skin scan data.",
      onChunk
    );
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

  private parseResponse(raw: string): LLMQuestion {
    let cleanedRaw = this.stripThinkingBlocks(raw);
    let msgText = cleanedRaw;
    let options: OptionCard[] | undefined = undefined;
    let isReport = false;

    try {
      let jsonStr = cleanedRaw.trim();

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

      // If there is surrounding text outside the JSON object, extract between first { and last }
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(jsonStr);
      msgText = parsed.message || parsed.report || parsed.content || cleanedRaw;
      options = parsed.options || undefined;
      isReport = !!parsed.isReport;
    } catch {
      msgText = cleanedRaw;
    }

    // Clean any residual JSON or markdown code wrapping if the raw output was direct markdown
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

    // Auto-detect report if headers are present even if isReport flag was omitted in JSON
    const reportKeywords = [
      'Overall Health Summary',
      'Skin Analysis Breakdown',
      'Ayurvedic Recommendations',
      'Risk Factors Identified',
      'Lifestyle Assessment',
      'Personalized Daily Routine',
      'Priority Actions',
      'Modern Health Tips',
    ];

    const hasReportHeader = reportKeywords.some((kw) => msgText.includes(kw) || raw.includes(kw));

    if (hasReportHeader) {
      isReport = true;
    }

    // Fallback if msgText is still empty or whitespace
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
