/**
 * Report Generator — Renders the LLM-generated health report into
 * beautiful card-based HTML with scores, sections, and visual hierarchy.
 */

import type { SkinMetrics } from './groq-service';

// ── Metric Interpretation Helpers ────────────────────────────────────────────

interface MetricInterpretation {
  label: string;
  value: string;
  status: 'good' | 'warning' | 'critical';
  icon: string;
}

function interpretMetrics(m: SkinMetrics): MetricInterpretation[] {
  const results: MetricInterpretation[] = [];

  const add = (label: string, value: string, status: 'good' | 'warning' | 'critical', icon: string) => {
    results.push({ label, value, status, icon });
  };

  // Health
  if (m.health >= 70) add('Overall Health', `${m.health.toFixed(0)}/100`, 'good', '❤️');
  else if (m.health >= 50) add('Overall Health', `${m.health.toFixed(0)}/100`, 'warning', '❤️');
  else add('Overall Health', `${m.health.toFixed(0)}/100`, 'critical', '❤️');

  // Hydration
  if (m.hydration >= 60) add('Hydration', `${m.hydration.toFixed(0)}/100`, 'good', '💧');
  else if (m.hydration >= 40) add('Hydration', `${m.hydration.toFixed(0)}/100`, 'warning', '💧');
  else add('Hydration', `${m.hydration.toFixed(0)}/100`, 'critical', '💧');

  // Glow
  if (m.glow >= 60) add('Glow', `${m.glow.toFixed(0)}/100`, 'good', '✨');
  else if (m.glow >= 40) add('Glow', `${m.glow.toFixed(0)}/100`, 'warning', '✨');
  else add('Glow', `${m.glow.toFixed(0)}/100`, 'critical', '✨');

  // Oiliness
  if (m.oiliness < 10) add('Oil Control', `${m.oiliness.toFixed(1)}%`, 'good', '🧴');
  else if (m.oiliness < 15) add('Oil Control', `${m.oiliness.toFixed(1)}%`, 'warning', '🧴');
  else add('Oil Control', `${m.oiliness.toFixed(1)}%`, 'critical', '🧴');

  // Texture
  if (m.texture >= 70) add('Texture', `${m.texture.toFixed(0)}/100`, 'good', '🪞');
  else if (m.texture >= 40) add('Texture', `${m.texture.toFixed(0)}/100`, 'warning', '🪞');
  else add('Texture', `${m.texture.toFixed(0)}/100`, 'critical', '🪞');

  // Elasticity
  if (m.elasticity >= 70) add('Elasticity', `${m.elasticity.toFixed(0)}/100`, 'good', '🧘');
  else if (m.elasticity >= 50) add('Elasticity', `${m.elasticity.toFixed(0)}/100`, 'warning', '🧘');
  else add('Elasticity', `${m.elasticity.toFixed(0)}/100`, 'critical', '🧘');

  return results;
}

// ── Score Ring SVG ───────────────────────────────────────────────────────────

function scoreRingSVG(score: number, size: number = 120): string {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 70 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444';

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="score-ring">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
              stroke="rgba(255,255,255,0.1)" stroke-width="10" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
              stroke="${color}" stroke-width="10"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
              stroke-linecap="round"
              transform="rotate(-90 ${size / 2} ${size / 2})"
              style="transition: stroke-dashoffset 1.5s ease-out;" />
      <text x="${size / 2}" y="${size / 2 - 6}" text-anchor="middle"
            fill="white" font-size="28" font-weight="700">${score.toFixed(0)}</text>
      <text x="${size / 2}" y="${size / 2 + 14}" text-anchor="middle"
            fill="rgba(255,255,255,0.7)" font-size="11" font-weight="500">out of 100</text>
    </svg>
  `;
}

// ── Markdown → HTML (lightweight) ────────────────────────────────────────────

function markdownToHTML(md: string): string {
  let html = md
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="report-h4">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="report-h3">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="report-h2">$1</h2>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Unordered lists
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr class="report-divider">')
    // Line breaks → paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap consecutive <li> tags in <ul>
  html = html.replace(/(<li>.+?<\/li>(?:<br>)?)+/g, (match) => {
    return '<ul class="report-list">' + match.replace(/<br>/g, '') + '</ul>';
  });

  return `<p>${html}</p>`;
}

// ── Download Helpers ─────────────────────────────────────────────────────────

function downloadHTMLReport(reportMarkdown: string, metrics: SkinMetrics): void {
  const interpreted = interpretMetrics(metrics);
  const reportHTML = markdownToHTML(reportMarkdown);

  const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AyurGenX Personal Health Report</title>
  <style>
    body { font-family: 'Google Sans', system-ui, -apple-system, sans-serif; margin: 0; padding: 40px; background: #f8fafc; color: #202124; line-height: 1.6; }
    .report-card { max-width: 800px; margin: 0 auto; background: white; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); padding: 32px; border: 1px solid #e2e8f0; }
    .hero { background: linear-gradient(135deg, #007f8b 0%, #00a3b4 100%); color: white; border-radius: 16px; padding: 28px; margin-bottom: 24px; text-align: center; }
    .hero h1 { margin: 0 0 8px; font-size: 1.8rem; }
    .hero p { margin: 0; opacity: 0.9; font-size: 0.9rem; }
    .metrics-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
    .chip { padding: 8px 14px; border-radius: 12px; font-size: 0.8rem; background: #f0fdf4; border: 1px solid #bbf7d0; font-weight: 600; }
    .content h2 { color: #007f8b; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; margin-top: 24px; font-size: 1.3rem; }
    .content h3 { font-size: 1.1rem; margin-top: 18px; }
    .content ul { padding-left: 20px; }
    .content li { margin-bottom: 6px; }
    @media print { body { padding: 0; background: white; } .report-card { box-shadow: none; border: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="report-card">
    <div class="hero">
      <h1>AyurGenX Personal Health Report</h1>
      <p>Skin Analysis + AI Lifestyle Consultation &bull; ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
    <div class="metrics-grid">
      ${interpreted.map((m) => `<div class="chip">${m.icon} ${m.label}: ${m.value}</div>`).join('')}
    </div>
    <div class="content">
      ${reportHTML}
    </div>
  </div>
</body>
</html>`;

  const blob = new Blob([fullHTML], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AyurGenX_Health_Report_${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Main Render Function ─────────────────────────────────────────────────────

export function renderReport(reportMarkdown: string, metrics: SkinMetrics, container: HTMLElement): void {
  const interpreted = interpretMetrics(metrics);
  const reportHTML = markdownToHTML(reportMarkdown);

  container.innerHTML = `
    <div class="health-report" id="health-report-document">
      <!-- Hero Score Section -->
      <div class="report-hero">
        <div class="report-hero-content">
          <div class="report-hero-score">
            ${scoreRingSVG(metrics.health, 140)}
          </div>
          <div class="report-hero-text">
            <h1 class="report-title">Your Health Report</h1>
            <p class="report-subtitle">Powered by AyurGenX Skin Analysis + AI Consultation</p>
            <div class="report-date">${new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}</div>
          </div>
        </div>
      </div>

      <!-- Quick Metrics Strip -->
      <div class="report-metrics-strip">
        ${interpreted
          .map(
            (m) => `
          <div class="report-metric-chip report-metric-${m.status}">
            <span class="report-metric-icon">${m.icon}</span>
            <div class="report-metric-info">
              <span class="report-metric-label">${m.label}</span>
              <span class="report-metric-value">${m.value}</span>
            </div>
          </div>
        `
          )
          .join('')}
      </div>

      <!-- Report Content -->
      <div class="report-content">
        ${reportHTML}
      </div>

      <!-- Actions -->
      <div class="report-actions">
        <button class="report-action-btn report-action-pdf" id="report-download-pdf-btn">
          <span>📥</span> Save / Print as PDF
        </button>
        <button class="report-action-btn report-action-html" id="report-download-html-btn">
          <span>📄</span> Download HTML File
        </button>
        <button class="report-action-btn report-action-new" id="report-new-chat-btn">
          <span>💬</span> New Consultation
        </button>
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
      downloadHTMLReport(reportMarkdown, metrics);
    });
  }
}
