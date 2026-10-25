/**
 * Report Generator — Renders the LLM-generated health report into
 * a warm, personal health letter with organic card-based layout.
 * The verdict, the summary tags and the safety notice come from the app's own
 * assessment, so they stay honest whatever the LLM writes.
 */

import type { ReportAssessment } from './groq-service';
import { interpretSkin, type SkinMetrics } from './skin-interpretation';

// ── Summary Tags & Safety Notice ─────────────────────────────────────────────

export interface ReportTag {
  text: string;
  mood: 'positive' | 'neutral' | 'attention';
}

/** Healthy findings worth showing even when nothing is wrong with them. */
const KEY_METRICS: (keyof SkinMetrics)[] = ['hydration', 'glow', 'texture'];
const LEVEL_ORDER = { concern: 0, fair: 1, good: 2 } as const;
const LEVEL_MOOD = { concern: 'attention', fair: 'neutral', good: 'positive' } as const;

/** Lifestyle risks first, then skin findings from most to least concerning. */
export function buildReportTags(m: SkinMetrics, assessment?: ReportAssessment): ReportTag[] {
  const risks = assessment?.lifestyle.risks ?? [];
  const lifestyle = risks.map(
    (r): ReportTag => ({ text: r.label, mood: r.severity === 'moderate' ? 'neutral' : 'attention' })
  );
  // A green "skin looks moisturised" next to "very low water intake" reads as a contradiction.
  const drinksTooLittle = risks.some((r) => r.topic === 'water');
  const skin = interpretSkin(m)
    .filter((r) => r.level !== 'good' || (KEY_METRICS.includes(r.key) && !(drinksTooLittle && r.key === 'hydration')))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .map((r): ReportTag => ({ text: r.tag, mood: LEVEL_MOOD[r.level] }));
  return [...lifestyle, ...skin];
}

export interface SafetyNotice {
  /** Labels of the risks that need a doctor. */
  items: string[];
  /** The user mentioned self-harm: show crisis support. */
  crisis: boolean;
}

/** A fixed, code-written notice for anything that needs a doctor. */
export function safetyNotice(assessment?: ReportAssessment): SafetyNotice | null {
  const urgent = assessment?.lifestyle.risks.filter((r) => r.seeDoctor) ?? [];
  if (!urgent.length) return null;
  return { items: urgent.map((r) => r.label), crisis: urgent.some((r) => r.topic === 'self_harm') };
}

export const CRISIS_SUPPORT =
  'If you are having thoughts of harming yourself, please reach out right now: in India, call Tele-MANAS on 14416 (free, 24×7) or the emergency number 112. Elsewhere, call your local emergency number or a crisis line.';

function safetyNoticeHTML(notice: SafetyNotice | null): string {
  if (!notice) return '';
  return `
    <div class="report-safety-notice" role="alert">
      <strong>Please speak with a doctor soon</strong>
      <p>Some of what you shared is a health concern beyond your skin (${notice.items.join(', ').toLowerCase()}). Skincare can't fix this, but a doctor can help.</p>
      ${notice.crisis ? `<p class="report-safety-crisis">${CRISIS_SUPPORT}</p>` : ''}
    </div>`;
}

function verdictHTML(assessment?: ReportAssessment): string {
  if (!assessment) return '';
  return `<div class="report-verdict report-verdict-${assessment.verdict.level}">Overall: ${assessment.verdict.label}</div>`;
}

// ── Markdown → HTML (lightweight) ────────────────────────────────────────────

const escapeHTML = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The model's text is escaped first, so only the markdown below becomes HTML (reports are saved and reopened). */
function markdownToHTML(md: string): string {
  let html = escapeHTML(md)
    // Headers — render as styled section titles (no border-bottom)
    .replace(/^### (.+)$/gm, '<h4 class="report-section-subtitle">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="report-section-title">$1</h3>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Unordered lists
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    // Line breaks → paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap consecutive <li> tags in <ul>
  html = html.replace(/((<li>.+?<\/li>)(<br>)?)+/g, (match) => {
    return '<ul class="report-suggestions-list">' + match.replace(/<br>/g, '') + '</ul>';
  });

  return `<p>${html}</p>`;
}

const longDate = (date: Date) =>
  date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

// ── Download Helpers ─────────────────────────────────────────────────────────

function downloadHTMLReport(
  reportMarkdown: string,
  metrics: SkinMetrics,
  assessment: ReportAssessment | undefined,
  writtenAt: Date
): void {
  const tags = buildReportTags(metrics, assessment);
  const reportHTML = markdownToHTML(reportMarkdown);

  const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AyurGenX — Your Personal Health Report</title>
  <style>
    body { font-family: 'Google Sans', system-ui, -apple-system, sans-serif; margin: 0; padding: 40px; background: #f8fafc; color: #202124; line-height: 1.75; }
    .report-card { max-width: 720px; margin: 0 auto; background: white; border-radius: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 40px; }
    .hero { background: linear-gradient(135deg, #f0fdf8 0%, #ecfdf5 50%, #f0f9ff 100%); border-radius: 16px; padding: 28px 32px; margin-bottom: 24px; }
    .hero h1 { margin: 0 0 4px; font-size: 1.4rem; color: #065f46; font-weight: 700; }
    .hero p { margin: 0; color: #6b7280; font-size: 0.85rem; }
    .report-verdict { display: inline-block; margin-bottom: 14px; padding: 8px 18px; border-radius: 20px; font-weight: 700; font-size: 0.9rem; }
    .report-verdict-good { background: #dcfce7; color: #166534; }
    .report-verdict-fair { background: #fef9c3; color: #854d0e; }
    .report-verdict-attention { background: #ffedd5; color: #9a3412; }
    .report-verdict-urgent { background: #fee2e2; color: #991b1b; }
    .report-safety-notice { background: #fef2f2; border: 1px solid #fecaca; border-radius: 14px; padding: 16px 20px; margin-bottom: 24px; color: #7f1d1d; }
    .report-safety-notice p { margin: 6px 0 0; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
    .tag { padding: 6px 14px; border-radius: 20px; font-size: 0.78rem; font-weight: 500; }
    .tag-positive { background: #f0fdf4; color: #166534; }
    .tag-neutral { background: #fefce8; color: #854d0e; }
    .tag-attention { background: #fef2f2; color: #991b1b; }
    .content h3 { color: #1e3a5f; margin-top: 28px; font-size: 1.1rem; font-weight: 600; }
    .content p { line-height: 1.75; color: #374151; }
    .content ul { padding-left: 20px; }
    .content li { margin-bottom: 6px; line-height: 1.6; }
    .content strong { color: #1e3a5f; }
    .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #f3f4f6; text-align: center; color: #9ca3af; font-size: 0.78rem; }
    @media print { body { padding: 0; background: white; } .report-card { box-shadow: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="report-card">
    <div class="hero">
      <h1>Your Personal Health Report</h1>
      <p>Prepared by Dr. AyurGenX · ${longDate(writtenAt)}</p>
    </div>
    ${verdictHTML(assessment)}
    <div class="summary">
      ${tags.map((tag) => `<span class="tag tag-${tag.mood}">${tag.text}</span>`).join('')}
    </div>
    ${safetyNoticeHTML(safetyNotice(assessment))}
    <div class="content">
      ${reportHTML}
    </div>
    <div class="footer">
      Prepared with care by Dr. AyurGenX · Skin Analysis + Lifestyle Consultation<br>
      Skin readings are camera estimates, not a diagnosis. For medical concerns, please consult a healthcare professional.
    </div>
  </div>
</body>
</html>`;

  const blob = new Blob([fullHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AyurGenX_Health_Report_${writtenAt.toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Main Render Function ─────────────────────────────────────────────────────

export interface ReportViewOptions {
  /** When the report was written (default: now). */
  writtenAt?: Date;
  /** A saved report opened from the history page: no chat-only buttons (new consultation, print, progress). */
  fromHistory?: boolean;
}

export function renderReport(
  reportMarkdown: string,
  metrics: SkinMetrics,
  container: HTMLElement,
  assessment?: ReportAssessment,
  { writtenAt = new Date(), fromHistory = false }: ReportViewOptions = {}
): void {
  const tags = buildReportTags(metrics, assessment);
  const reportHTML = markdownToHTML(reportMarkdown);

  container.innerHTML = `
    <div class="health-report" id="health-report-document">
      <!-- Warm Greeting Header -->
      <div class="report-greeting-card">
        <div class="report-greeting-icon">🌿</div>
        <div class="report-greeting-text">
          <h1 class="report-greeting-title">Your Personal Health Report</h1>
          <p class="report-greeting-subtitle">Prepared by Dr. AyurGenX · Skin Analysis + Lifestyle Consultation</p>
          <p class="report-greeting-date">${longDate(writtenAt)}</p>
        </div>
      </div>

      <!-- Overall verdict (computed by the app, not the LLM) -->
      ${verdictHTML(assessment)}

      <!-- Descriptive Summary Tags -->
      <div class="report-summary-strip">
        ${tags
          .map(
            (tag) => `
          <span class="report-summary-tag report-tag-${tag.mood}">
            ${tag.text}
          </span>
        `
          )
          .join('')}
      </div>

      ${safetyNoticeHTML(safetyNotice(assessment))}

      <!-- Report Letter Content -->
      <div class="report-letter">
        ${reportHTML}
      </div>

      <!-- Practitioner Footer -->
      <div class="report-footer">
        <div class="report-footer-line"></div>
        <p class="report-footer-text">Prepared with care by <strong>Dr. AyurGenX</strong></p>
        <p class="report-footer-note">This report combines camera-based skin estimates with your personal lifestyle information. It is not a diagnosis; for medical concerns, please consult a healthcare professional.</p>
      </div>

      <!-- Actions -->
      <div class="report-actions">
        ${
          fromHistory
            ? ''
            : `<button class="report-action-btn report-action-pdf" id="report-download-pdf-btn">
          <span>📥</span> Save / Print as PDF
        </button>`
        }
        <button class="report-action-btn report-action-html" id="report-download-html-btn">
          <span>📄</span> Download Report
        </button>
        ${
          fromHistory
            ? ''
            : `<a class="report-action-btn report-action-progress" href="#/dashboard">
          <span>📈</span> My Progress
        </a>
        <button class="report-action-btn report-action-new" id="report-new-chat-btn">
          <span>💬</span> New Consultation
        </button>`
        }
      </div>
    </div>
  `;

  // Attach event handlers
  const pdfBtn = container.querySelector('#report-download-pdf-btn');
  if (pdfBtn) {
    pdfBtn.addEventListener('click', () => {
      window.print();
    });
  }

  const htmlBtn = container.querySelector('#report-download-html-btn');
  if (htmlBtn) {
    htmlBtn.addEventListener('click', () => {
      downloadHTMLReport(reportMarkdown, metrics, assessment, writtenAt);
    });
  }
}
