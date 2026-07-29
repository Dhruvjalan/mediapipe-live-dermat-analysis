/**
 * Health Chat — LLM-powered health consultation that combines skin analysis
 * metrics with adaptive questioning to generate a comprehensive health report.
 */

import { GroqService, type SkinMetrics, type OptionCard } from '../services/groq-service';
import { renderReport } from '../services/report-generator';

// @ts-ignore
import template from '../templates/health-chat.html?raw';

// ── State ────────────────────────────────────────────────────────────────────

let groqService: GroqService;
let skinMetrics: SkinMetrics | null = null;
let isWaitingForResponse = false;
let questionCount = 0;

// ── DOM References ───────────────────────────────────────────────────────────

let messagesArea: HTMLElement;
let optionsContainer: HTMLElement;
let chatInput: HTMLInputElement;
let sendBtn: HTMLElement;
let questionCounter: HTMLElement;
let inputBar: HTMLElement;
let reportContainer: HTMLElement;

// ── Setup / Cleanup ──────────────────────────────────────────────────────────

export async function setupHealthChat(container: HTMLElement) {
  container.innerHTML = `
    <div class="task-container health-chat-task">
      <div class="health-chat-panel">
        ${template}
      </div>
    </div>
  `;

  // Grab DOM refs
  messagesArea = document.getElementById('chat-messages')!;
  optionsContainer = document.getElementById('chat-options')!;
  chatInput = document.getElementById('chat-input') as HTMLInputElement;
  sendBtn = document.getElementById('chat-send-btn')!;
  questionCounter = document.getElementById('chat-question-counter')!;
  inputBar = document.getElementById('chat-input-bar')!;
  reportContainer = document.getElementById('chat-report')!;

  // Load metrics from sessionStorage
  const stored = sessionStorage.getItem('ayurgenx-skin-metrics');
  if (stored) {
    try {
      skinMetrics = JSON.parse(stored);
    } catch {
      skinMetrics = null;
    }
  }

  // If no metrics, show a fallback / demo mode
  if (!skinMetrics) {
    skinMetrics = getDefaultMetrics();
    addSystemMessage(
      "⚠️ No skin scan data found. Using demo values. For best results, run a skin scan first from the Face Landmarker page, then click 'Get Health Report'."
    );
  }

  // Populate metrics bar
  populateMetricsBar(skinMetrics);

  // Setup metrics toggle
  const toggleBtn = document.getElementById('metrics-toggle-btn');
  const metricsGrid = document.getElementById('chat-metrics-grid');
  if (toggleBtn && metricsGrid) {
    toggleBtn.addEventListener('click', () => {
      metricsGrid.classList.toggle('collapsed');
      const icon = toggleBtn.querySelector('.material-icons');
      if (icon) {
        icon.textContent = metricsGrid.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
      }
    });
  }

  // Initialize Groq service
  groqService = new GroqService();

  if (!groqService.isConfigured()) {
    addSystemMessage(
      '🔑 Groq API key not configured. Please add your API key to the .env file:\n\nVITE_GROQ_API_KEY=your_key_here\n\nGet a free key at console.groq.com'
    );
    disableInput();
    return;
  }

  groqService.initConversation(skinMetrics);

  // Event listeners
  sendBtn.addEventListener('click', handleSend);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Start the conversation with a welcome + first question
  addWelcomeMessage();
  await askFirstQuestion();
}

export function cleanupHealthChat() {
  skinMetrics = null;
  questionCount = 0;
  isWaitingForResponse = false;
}

// ── Metrics Bar ──────────────────────────────────────────────────────────────

function populateMetricsBar(m: SkinMetrics) {
  const set = (id: string, val: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  set('chat-m-health', `${m.health.toFixed(0)}/100`);
  set('chat-m-glow', `${m.glow.toFixed(0)}/100`);
  set('chat-m-hydration', `${m.hydration.toFixed(0)}/100`);
  set('chat-m-oiliness', `${m.oiliness.toFixed(1)}%`);
  set('chat-m-texture', `${m.texture.toFixed(0)}/100`);
  set('chat-m-elasticity', `${m.elasticity.toFixed(0)}/100`);
}

// ── Chat Messages ────────────────────────────────────────────────────────────

function addWelcomeMessage() {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-system chat-welcome';
  msg.innerHTML = `
    <div class="chat-avatar chat-avatar-ai">
      <span>🩺</span>
    </div>
    <div class="chat-bubble chat-bubble-ai chat-welcome-bubble">
      <div class="chat-welcome-title">Welcome to AyurGenX Health Consultation</div>
      <p>I've analyzed your skin scan data and I'll ask you a few fun questions to understand your lifestyle better. Then I'll generate a personalized health report just for you!</p>
      <div class="chat-welcome-badges">
        <span class="chat-badge">🔬 AI-Powered Analysis</span>
        <span class="chat-badge">🌿 Ayurvedic Insights</span>
        <span class="chat-badge">📋 Personalized Report</span>
      </div>
    </div>
  `;
  messagesArea.appendChild(msg);
}

function addAIMessage(text: string, animate: boolean = true): HTMLElement {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-ai';
  msg.innerHTML = `
    <div class="chat-avatar chat-avatar-ai">
      <span>🩺</span>
    </div>
    <div class="chat-bubble chat-bubble-ai">
      <div class="chat-bubble-content"></div>
    </div>
  `;
  messagesArea.appendChild(msg);

  const contentEl = msg.querySelector('.chat-bubble-content')!;

  if (animate) {
    // Typewriter effect
    typewriterEffect(contentEl as HTMLElement, text);
  } else {
    contentEl.innerHTML = formatMessageText(text);
  }

  scrollToBottom();
  return msg;
}

function addUserMessage(text: string) {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-user';
  msg.innerHTML = `
    <div class="chat-bubble chat-bubble-user">
      <div class="chat-bubble-content">${escapeHTML(text)}</div>
    </div>
    <div class="chat-avatar chat-avatar-user">
      <span>👤</span>
    </div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
}

function addSystemMessage(text: string) {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-system-info';
  msg.innerHTML = `
    <div class="chat-system-bubble">
      <span class="material-icons" style="font-size: 16px;">info</span>
      <span>${formatMessageText(text)}</span>
    </div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
}

function addTypingIndicator(): HTMLElement {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-ai';
  msg.id = 'typing-indicator';
  msg.innerHTML = `
    <div class="chat-avatar chat-avatar-ai">
      <span>🩺</span>
    </div>
    <div class="chat-bubble chat-bubble-ai chat-typing-bubble">
      <div class="chat-typing-dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
  return msg;
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

// ── Option Cards ─────────────────────────────────────────────────────────────

function renderOptionCards(options: OptionCard[]) {
  optionsContainer.innerHTML = '';
  optionsContainer.style.display = 'flex';

  options.forEach((opt) => {
    const card = document.createElement('button');
    card.className = 'chat-option-card';
    card.innerHTML = `
      <span class="chat-option-emoji">${opt.emoji}</span>
      <span class="chat-option-label">${escapeHTML(opt.label)}</span>
    `;
    card.addEventListener('click', () => {
      selectOption(opt);
    });
    optionsContainer.appendChild(card);
  });

  // Animate in
  requestAnimationFrame(() => {
    optionsContainer.querySelectorAll('.chat-option-card').forEach((card, i) => {
      setTimeout(() => {
        (card as HTMLElement).classList.add('visible');
      }, i * 80);
    });
  });
}

function clearOptionCards() {
  optionsContainer.style.display = 'none';
  optionsContainer.innerHTML = '';
}

async function selectOption(opt: OptionCard) {
  clearOptionCards();
  addUserMessage(`${opt.emoji} ${opt.label}`);
  await sendToLLM(opt.value);
}

// ── Input Handling ───────────────────────────────────────────────────────────

async function handleSend() {
  const text = chatInput.value.trim();
  if (!text || isWaitingForResponse) return;

  chatInput.value = '';
  addUserMessage(text);
  await sendToLLM(text);
}

function disableInput() {
  chatInput.disabled = true;
  sendBtn.classList.add('disabled');
}

function enableInput() {
  chatInput.disabled = false;
  sendBtn.classList.remove('disabled');
  chatInput.focus();
}

// ── LLM Communication ───────────────────────────────────────────────────────

async function askFirstQuestion() {
  isWaitingForResponse = true;
  disableInput();
  addTypingIndicator();

  try {
    const response = await groqService.chat('');
    removeTypingIndicator();
    questionCount++;
    updateQuestionCounter();

    addAIMessage(response.message);

    if (response.options && response.options.length > 0) {
      // Delay option cards slightly so the message renders first
      setTimeout(
        () => {
          renderOptionCards(response.options!);
        },
        Math.min(response.message.length * 15, 1500)
      );
    }
  } catch (err: any) {
    removeTypingIndicator();
    addSystemMessage(`❌ Error: ${err.message}`);
  } finally {
    isWaitingForResponse = false;
    enableInput();
  }
}

async function sendToLLM(userInput: string) {
  isWaitingForResponse = true;
  disableInput();
  clearOptionCards();
  addTypingIndicator();

  try {
    const response = await groqService.chat(userInput);
    removeTypingIndicator();
    questionCount++;
    updateQuestionCounter();

    if (response.isReport) {
      // Hide chat UI elements so report renders from the top
      messagesArea.style.display = 'none';
      optionsContainer.style.display = 'none';
      inputBar.style.display = 'none';
      reportContainer.style.display = 'block';
      renderReport(response.message, skinMetrics!, reportContainer);

      // Setup "New Consultation" button
      const newChatBtn = document.getElementById('report-new-chat-btn');
      if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
          window.location.hash = '#/health/health_chat';
          window.location.reload();
        });
      }

      reportContainer.scrollTop = 0;
    } else {
      addAIMessage(response.message);

      if (response.options && response.options.length > 0) {
        setTimeout(
          () => {
            renderOptionCards(response.options!);
          },
          Math.min(response.message.length * 15, 1500)
        );
      }

      // Check if the LLM is asking if user is ready for report
      const isReadyPrompt =
        response.message.toLowerCase().includes('ready to generate') ||
        response.message.toLowerCase().includes('generate your report') ||
        response.message.toLowerCase().includes('ready for your report');

      if (isReadyPrompt && (!response.options || response.options.length === 0)) {
        // Add "Generate Report" button
        setTimeout(
          () => {
            renderOptionCards([
              { emoji: '📋', label: 'Yes, generate my report!', value: 'generate_report' },
              { emoji: '💬', label: 'I have more to share', value: 'more_info' },
            ]);
          },
          Math.min(response.message.length * 15, 1500)
        );
      }
    }
  } catch (err: any) {
    removeTypingIndicator();
    addSystemMessage(`❌ Error: ${err.message}`);
  } finally {
    isWaitingForResponse = false;
    enableInput();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function updateQuestionCounter() {
  if (questionCounter) {
    questionCounter.textContent = `Question ${questionCount} of ~6`;
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

function typewriterEffect(el: HTMLElement, text: string) {
  const formatted = formatMessageText(text);
  el.innerHTML = '';

  // For HTML content, we insert the full HTML but reveal it character by character
  // using a simpler approach: insert all at once with a fade-in
  el.innerHTML = formatted;
  el.style.opacity = '0';
  el.style.transform = 'translateY(4px)';
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
}

function formatMessageText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getDefaultMetrics(): SkinMetrics {
  return {
    health: 55,
    glow: 50,
    hydration: 40,
    melanin: 18,
    erythema: 128,
    oiliness: 12,
    pores: 8,
    texture: 45,
    wrinkles: 3,
    fatigue: 0.28,
    darkCircles: 20,
    heartRate: 72,
    perfusion: 65,
    yellowness: 125,
    imageQuality: 75,
    acne: 5,
    uvDamage: 25,
    elasticity: 60,
  };
}
