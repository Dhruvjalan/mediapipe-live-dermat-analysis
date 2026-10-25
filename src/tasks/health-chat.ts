/**
 * Health Chat — LLM-powered health consultation that combines skin analysis
 * metrics with adaptive questioning to generate a comprehensive health report.
 */

import { GroqService, type SkinMetrics, type OptionCard } from '../services/groq-service';
import { CRISIS_SUPPORT, renderReport } from '../services/report-generator';
import { detectSafetyFlags } from '../services/lifestyle-risk';
import { SKIN_METRICS_VERSION } from '../services/skin-interpretation';
import { isReportRequest, offersReport, questionCounterText } from '../services/consultation-flow';
import { saveConsultationToHistory } from '../services/history-store';
import { transcribeAudioClientSide, preloadLocalWhisper } from '../services/local-whisper-service';

// @ts-ignore
import template from '../templates/health-chat.html?raw';

// ── State ────────────────────────────────────────────────────────────────────

let groqService: GroqService;
let skinMetrics: SkinMetrics | null = null;
let isWaitingForResponse = false;
let questionCount = 0;
/** Whether the latest message offered the report (so a plain "yes" means "generate it"). */
let reportOffered = false;
/** Safety messages already shown, so each appears once per consultation. */
const shownSafetyFlags = new Set<string>();

const REPORT_OPTIONS: OptionCard[] = [
  { emoji: '📋', label: 'Yes, generate my report!', value: 'generate_report' },
  { emoji: '💬', label: 'I have more to share', value: 'more_info' },
];

// ── DOM & Speech References ──────────────────────────────────────────────────

let messagesArea: HTMLElement;
let optionsContainer: HTMLElement;
let chatInput: HTMLInputElement;
let sendBtn: HTMLElement;
let micBtn: HTMLElement;
let questionCounter: HTMLElement;
let inputBar: HTMLElement;
let reportContainer: HTMLElement;

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let mediaStream: MediaStream | null = null;
let recognition: any = null;
let isRecording = false;

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
  micBtn = (document.getElementById('chat-voice-btn') || document.getElementById('chat-mic-btn'))!;
  questionCounter = document.getElementById('chat-question-counter')!;
  inputBar = document.getElementById('chat-input-bar')!;
  reportContainer = document.getElementById('chat-report')!;

  // Setup Voice Input & Preload Local Whisper AI
  setupSpeechRecognition();
  preloadLocalWhisper();

  // Load metrics from sessionStorage (scans saved on an older scale are ignored)
  const stored = sessionStorage.getItem('ayurgenx-skin-metrics');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      skinMetrics = parsed?.version === SKIN_METRICS_VERSION ? parsed : null;
    } catch {
      skinMetrics = null;
    }
  }

  // The report describes the user's own scan, so without one there's nothing honest to report.
  if (!skinMetrics) {
    addSystemMessage(
      '📷 No completed face scan found. Please complete the <a href="#/face-landmarker">Multi-Angle Scan</a> first, then tap <b>Continue to Health Consultation</b>.'
    );
    disableInput();
    return;
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
  if (isRecording) {
    stopRecordingAndTranscribe();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  mediaRecorder = null;
  recognition = null;
  skinMetrics = null;
  questionCount = 0;
  reportOffered = false;
  isWaitingForResponse = false;
  shownSafetyFlags.clear();
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
  msg.className = 'chat-message chat-message-ai chat-welcome';
  msg.innerHTML = `
    <div class="chat-avatar chat-avatar-ai">
      <span>🩺</span>
      <span class="avatar-online-dot"></span>
    </div>
    <div class="chat-bubble chat-bubble-ai chat-welcome-bubble">
      <div class="chat-welcome-header">
        <span class="doctor-badge">🌿 Dr. AyurGenX AI &bull; Clinical Dermal Specialist</span>
        <div class="chat-welcome-title">Personalized Ayurvedic Health Consultation</div>
      </div>
      <p>I've analyzed your high-resolution facial scan and loaded your dermal biomarker telemetry. I'll ask you a few targeted lifestyle questions to uncover your unique doshic balance and generate a customized holistic health protocol!</p>
      <div class="chat-welcome-badges">
        <span class="chat-badge">🔬 Dermal Telemetry Ingested</span>
        <span class="chat-badge">🍃 Dosha Diagnostics</span>
        <span class="chat-badge">📋 Customized Protocol</span>
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
      <span class="avatar-online-dot"></span>
    </div>
    <div class="chat-bubble chat-bubble-ai">
      <div class="chat-bubble-sender">Dr. AyurGenX AI</div>
      <div class="chat-bubble-content"></div>
    </div>
  `;
  messagesArea.appendChild(msg);

  const contentEl = msg.querySelector('.chat-bubble-content')!;

  if (animate) {
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
      <div class="chat-bubble-sender user-sender">You</div>
      <div class="chat-bubble-content">${escapeHTML(text)}</div>
    </div>
    <div class="chat-avatar chat-avatar-user">
      <span>👤</span>
    </div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
}

function addSystemMessage(text: string, tone: 'info' | 'safety' = 'info') {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-system-info';
  msg.innerHTML = `
    <div class="chat-system-bubble${tone === 'safety' ? ' chat-safety-bubble' : ''}">
      <span class="material-icons" style="font-size: 16px;">${tone === 'safety' ? 'health_and_safety' : 'info'}</span>
      <span>${formatMessageText(text)}</span>
    </div>
  `;
  messagesArea.appendChild(msg);
  scrollToBottom();
}

/**
 * A fixed message, written in code, for any critical statement (not eating,
 * not sleeping, fainting, self-harm) — shown right away, whatever the LLM says.
 */
function showSafetyMessages(userText: string) {
  for (const flag of detectSafetyFlags(userText)) {
    if (flag.severity !== 'critical' || shownSafetyFlags.has(flag.id)) continue;
    shownSafetyFlags.add(flag.id);
    if (flag.topic === 'self_harm') {
      addSystemMessage(`💛 Thank you for telling me. You don't have to deal with this alone. ${CRISIS_SUPPORT}`, 'safety');
    } else {
      addSystemMessage(
        `⚠️ **${flag.label}** is a health concern, not just a skin one. If that's accurate, please talk to a doctor soon. Skincare can't fix it.`,
        'safety'
      );
    }
  }
}

function addTypingIndicator(): HTMLElement {
  const msg = document.createElement('div');
  msg.className = 'chat-message chat-message-ai';
  msg.id = 'typing-indicator';
  msg.innerHTML = `
    <div class="chat-avatar chat-avatar-ai">
      <span>🩺</span>
      <span class="avatar-online-dot"></span>
    </div>
    <div class="chat-bubble chat-bubble-ai chat-typing-bubble">
      <div class="chat-bubble-sender">Dr. AyurGenX AI is thinking...</div>
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
  // Ensure optionsContainer is always placed at the bottom of messagesArea
  messagesArea.appendChild(optionsContainer);
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

  requestAnimationFrame(() => {
    optionsContainer.querySelectorAll('.chat-option-card').forEach((card, i) => {
      setTimeout(() => {
        (card as HTMLElement).classList.add('visible');
        scrollToBottom();
      }, i * 60);
    });
    scrollToBottom();
  });
}

function clearOptionCards() {
  optionsContainer.style.display = 'none';
  optionsContainer.innerHTML = '';
}

async function selectOption(opt: OptionCard) {
  clearOptionCards();
  addUserMessage(`${opt.emoji} ${opt.label}`);
  // The readable label is the user's answer; only the report request is sent as a code.
  await sendToLLM(opt.value === 'generate_report' ? opt.value : opt.label);
}

// ── Voice Banner Overlay Helpers ─────────────────────────────────────────────

/** The centre overlay while the microphone is recording: the only time it says "Listening". */
function showRecordingOverlay() {
  setOverlay({ busy: false, icon: 'mic', title: 'Listening...', hint: 'Speak your answer clearly. Tap to complete.' });
}

/** The centre overlay while the app works (transcribing, preparing the report): no microphone prompt. */
function showBusyOverlay(icon: string, title: string, hint: string) {
  setOverlay({ busy: true, icon, title, hint });
}

function setOverlay(o: { busy: boolean; icon: string; title: string; hint: string }) {
  const banner = document.getElementById('voice-recording-banner');
  if (!banner) return;
  banner.classList.toggle('is-busy', o.busy);
  const setText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('voice-banner-icon', o.icon);
  setText('voice-banner-label', o.title);
  setText('voice-banner-hint', o.hint);
  const micButton = document.getElementById('voice-banner-mic-btn') as HTMLButtonElement | null;
  if (micButton) {
    micButton.disabled = o.busy;
    micButton.setAttribute('aria-label', o.busy ? o.title : 'Stop recording');
  }
  banner.style.display = 'flex';
}

function hideVoiceBanner() {
  const banner = document.getElementById('voice-recording-banner');
  if (banner) banner.style.display = 'none';
}

// ── Speech Recording & Groq Whisper AI ───────────────────────────────────────

function setupSpeechRecognition() {
  if (!micBtn) return;
  micBtn.setAttribute('title', 'Voice Input (Click to speak)');
  micBtn.addEventListener('click', toggleVoiceInput);

  const bannerCard = document.getElementById('voice-banner-card');
  const stopBtn = document.getElementById('voice-banner-stop-btn');

  if (bannerCard) {
    bannerCard.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isRecording) {
        stopRecordingAndTranscribe();
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isRecording) {
        stopRecordingAndTranscribe();
      }
    });
  }
}

async function toggleVoiceInput() {
  if (isWaitingForResponse) return;

  if (isRecording) {
    stopRecordingAndTranscribe();
  } else {
    await startVoiceRecording();
  }
}

async function startVoiceRecording() {
  if (isRecording) return;

  // Primary method: Direct Local Audio Capture + Groq Whisper AI
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      audioChunks = [];

      const mimeType =
        ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) =>
          MediaRecorder.isTypeSupported(type)
        ) || '';

      mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (mediaStream) {
          mediaStream.getTracks().forEach((track) => track.stop());
          mediaStream = null;
        }

        if (audioChunks.length === 0) {
          resetMicButton();
          return;
        }

        const audioBlob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
        audioChunks = [];

        // UI Transcribing state inside banner
        showBusyOverlay('graphic_eq', 'Transcribing your answer...', 'Turning your speech into text.');

        if (micBtn) {
          micBtn.classList.remove('listening');
          micBtn.classList.add('transcribing');
          micBtn.setAttribute('title', 'Transcribing...');
        }
        if (chatInput) {
          chatInput.placeholder = 'Transcribing...';
        }

        try {
          let transcribedText = '';

          // 1. Try lightning-fast Groq Whisper API (< 0.2s speed)
          if (groqService && groqService.isConfigured()) {
            try {
              transcribedText = await groqService.transcribeAudio(audioBlob);
            } catch (groqErr) {
              console.warn('Groq Whisper API error, using local fallback:', groqErr);
            }
          }

          // 2. Fallback to local client-side model if Groq is unavailable
          if (!transcribedText || !transcribedText.trim()) {
            transcribedText = await transcribeAudioClientSide(audioBlob);
          }

          let cleanText = (transcribedText || '').trim();
          // Filter out Whisper silent hallucinations (e.g. '.', '..', '...', 'Thank you.', etc.)
          if (
            /^[\s.\-?!,;:]*$/.test(cleanText) ||
            cleanText.toLowerCase() === 'thank you' ||
            cleanText.toLowerCase() === 'thanks for watching'
          ) {
            cleanText = '';
          }

          if (cleanText) {
            chatInput.value = cleanText;
            chatInput.focus();
          } else {
            addSystemMessage('🎙️ Low audio or no clear speech detected. Please speak louder into your mic.');
          }
        } catch (err: any) {
          console.error('Transcription error:', err);
          addSystemMessage(`🎙️ Transcription error: ${err.message || 'Failed to process audio'}`);
        } finally {
          resetMicButton();
        }
      };

      // Start recording with 100ms timeslice to ensure continuous data accumulation
      mediaRecorder.start(100);
      isRecording = true;

      // Show Voice Recording Center Banner Overlay
      showRecordingOverlay();

      if (micBtn) {
        micBtn.classList.add('listening');
        micBtn.setAttribute('title', 'Recording... Click mic again when finished speaking');
      }
      if (chatInput) {
        chatInput.placeholder = 'Listening...';
      }
      return;
    } catch (err: any) {
      console.warn('getUserMedia microphone access error:', err);
      hideVoiceBanner();
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        addSystemMessage(
          '🎙️ Microphone permission was denied. Please allow microphone access in your browser settings.'
        );
        return;
      }
    }
  }

  // Secondary fallback: Web Speech API
  startWebSpeechFallback();
}

function stopRecordingAndTranscribe() {
  if (isRecording) {
    showBusyOverlay('graphic_eq', 'Transcribing your answer...', 'Turning your speech into text.');
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    mediaRecorder.stop();
  } else if (recognition) {
    stopWebSpeech();
  }
}

function resetMicButton() {
  isRecording = false;
  hideVoiceBanner();
  if (micBtn) {
    micBtn.classList.remove('listening', 'transcribing');
    micBtn.setAttribute('title', 'Voice Input (Click to speak)');
  }
  if (chatInput) {
    chatInput.placeholder = 'Type your answer...';
  }
}

// ── Web Speech API Fallback ──────────────────────────────────────────────────

function startWebSpeechFallback() {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    addSystemMessage('🎙️ Audio recording is not supported in this browser.');
    return;
  }

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isRecording = true;
      if (micBtn) micBtn.classList.add('listening');
      if (chatInput) chatInput.placeholder = 'Listening... Speak your answer now...';
    };

    recognition.onresult = (event: any) => {
      let currentTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        currentTranscript += event.results[i][0].transcript;
      }
      if (currentTranscript.trim()) {
        chatInput.value = currentTranscript;
      }
    };

    recognition.onerror = (event: any) => {
      console.warn('Web Speech error:', event.error);
      stopWebSpeech();
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        addSystemMessage(`🎙️ Microphone error (${event.error}). Please check permissions.`);
      }
    };

    recognition.onend = () => {
      stopWebSpeech();
    };

    recognition.start();
  } catch (err) {
    console.error('Failed Web Speech fallback:', err);
  }
}

function stopWebSpeech() {
  isRecording = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {}
  }
  resetMicButton();
}

// ── Input Handling ───────────────────────────────────────────────────────────

async function handleSend() {
  if (isRecording) {
    stopRecordingAndTranscribe();
  }
  const text = chatInput.value.trim();
  if (!text || isWaitingForResponse) return;

  chatInput.value = '';
  addUserMessage(text);
  await sendToLLM(text);
}

function disableInput() {
  chatInput.disabled = true;
  sendBtn.classList.add('disabled');
  if (micBtn) micBtn.classList.add('disabled');
  if (isRecording) stopRecordingAndTranscribe();
}

function enableInput() {
  chatInput.disabled = false;
  sendBtn.classList.remove('disabled');
  if (micBtn) micBtn.classList.remove('disabled');
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
    reportOffered = !!response.options?.some((o) => o.value === 'generate_report');
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
  showSafetyMessages(userInput);

  const isExplicitReportRequest = isReportRequest(userInput, reportOffered);

  if (isExplicitReportRequest) {
    showBusyOverlay(
      'auto_awesome',
      'Preparing your health report...',
      'Reading your answers and scan results. This takes a few seconds.'
    );
  }
  addTypingIndicator();

  try {
    // Anything typed with the request ("generate my report, also...") still counts as an answer.
    const response = isExplicitReportRequest
      ? await groqService.generateReport(undefined, userInput)
      : await groqService.chat(userInput);

    removeTypingIndicator();
    hideVoiceBanner();
    questionCount++;

    if (response.isReport) {
      // Hide chat UI elements so report renders from the top
      messagesArea.style.display = 'none';
      optionsContainer.style.display = 'none';
      inputBar.style.display = 'none';
      reportContainer.style.display = 'block';
      renderReport(response.message, skinMetrics!, reportContainer, response.assessment);
      if (response.assessment) {
        void saveConsultationToHistory(skinMetrics!, {
          completedAt: Date.now(),
          assessment: response.assessment,
          report: response.message,
        });
      }

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
      const msgText =
        (response.message || '').trim() ||
        "I've collected your scan details and lifestyle answers. Ready to see your comprehensive health report?";
      addAIMessage(msgText);

      // The model's own options; otherwise the report buttons, but only when the
      // message offers the report (a follow-up question gets a typed answer instead).
      const options = response.options?.length
        ? response.options
        : offersReport(msgText)
          ? REPORT_OPTIONS
          : [];
      reportOffered = options.some((o) => o.value === 'generate_report');
      updateQuestionCounter();
      if (options.length > 0) {
        setTimeout(() => renderOptionCards(options), Math.min(msgText.length * 15, 1200));
      }
    }
  } catch (err: any) {
    removeTypingIndicator();
    hideVoiceBanner();
    addSystemMessage(`❌ Error: ${err.message}`);
  } finally {
    isWaitingForResponse = false;
    enableInput();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function updateQuestionCounter() {
  if (questionCounter) {
    questionCounter.textContent = questionCounterText(questionCount, reportOffered);
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
  if (!text) return '';
  let cleaned = text.trim();

  // Guard against any raw JSON remnants
  if (cleaned.startsWith('{') && cleaned.includes('"message"')) {
    const match = cleaned.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match && match[1]) {
      try {
        cleaned = JSON.parse(`"${match[1]}"`);
      } catch {
        cleaned = match[1];
      }
    }
  }

  return cleaned
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function escapeHTML(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
