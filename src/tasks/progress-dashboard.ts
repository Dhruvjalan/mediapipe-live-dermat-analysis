/**
 * Progress dashboard (#/dashboard) — the user's health history: the latest
 * score and how it has moved, what changed since the last scan, habits across
 * consultations, and every past session with its report. Everything is read
 * from this device (history-store.ts).
 */

import { GUEST, type HistoryEntry, type HistoryStore } from '../services/health-history';
import {
  changesSinceLastScan,
  habitTimeline,
  latestScoreChange,
  scoreTrend,
  type HabitCell,
  type ReadingChange,
} from '../services/history-insights';
import { currentUserKey, openHistoryStore } from '../services/history-store';
import { renderReport } from '../services/report-generator';
import { healthLevel, type ReadingLevel, type SkinMetrics } from '../services/skin-interpretation';
import { renderScoreChart, scoreBandKey } from '../ui/score-chart';

// @ts-ignore
import template from '../templates/dashboard.html?raw';

// ── Small DOM helpers (all text goes in as text, never as HTML) ──────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child) node.append(child);
  return node;
}

const icon = (name: string) => {
  const node = el('span', 'material-icons', name);
  node.setAttribute('aria-hidden', 'true');
  return node;
};

const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortDayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const LEVELS: Record<ReadingLevel, { label: string; icon: string }> = {
  good: { label: 'Good', icon: 'check_circle' },
  fair: { label: 'Fair', icon: 'info' },
  concern: { label: 'Needs care', icon: 'error' },
};

function levelChip(score: number): HTMLElement {
  if (!Number.isFinite(score)) return el('span', 'level-chip', 'Not measured');
  const level = healthLevel(score);
  return el('span', `level-chip level-${level}`, icon(LEVELS[level].icon), LEVELS[level].label);
}

/** Readings shown the same way as in the scan table. */
function formatReading(key: keyof SkinMetrics, value: number): string {
  switch (key) {
    case 'acne':
    case 'pores':
    case 'oiliness':
      return `${value.toFixed(1)}%`;
    case 'darkCircles':
      return `${Math.round(value)}%`;
    case 'erythema':
      return value.toFixed(1);
    case 'yellowness':
      return `${value.toFixed(1)}°`;
    case 'fatigue':
      return value.toFixed(2);
    default:
      return String(Math.round(value));
  }
}

const score = (m: SkinMetrics) => (Number.isFinite(m.health) ? String(Math.round(m.health)) : '--');

// ── Page state ───────────────────────────────────────────────────────────────

let generation = 0;
let stopChart: (() => void) | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

type Ui = ReturnType<typeof grab>;

function grab(root: HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  return {
    userName: $('progress-user-name'),
    notice: $('progress-notice'),
    toast: $('progress-toast'),
    empty: $('progress-empty'),
    content: $('progress-content'),
    heroScore: $('hero-score'),
    heroLevel: $('hero-level'),
    heroDelta: $('hero-delta'),
    heroDate: $('hero-date'),
    chart: $('score-chart'),
    chartFootnote: $('chart-footnote'),
    changesSubtitle: $('changes-subtitle'),
    changesList: $('changes-list'),
    habitsTable: $('habits-table'),
    sessionList: $('session-list'),
    clearButton: $<HTMLButtonElement>('clear-history-btn'),
    sessionsTitle: $('sessions-title'),
    emptyTitle: $('empty-title'),
    reportDialog: $<HTMLDialogElement>('report-dialog'),
    reportBody: $('report-dialog-body'),
    reportClose: $<HTMLButtonElement>('report-dialog-close'),
    confirmDialog: $<HTMLDialogElement>('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmOk: $<HTMLButtonElement>('confirm-ok'),
    confirmCancel: $<HTMLButtonElement>('confirm-cancel'),
  };
}

// ── Setup / cleanup ──────────────────────────────────────────────────────────

export async function setupProgressDashboard(container: HTMLElement): Promise<void> {
  const mine = ++generation;
  container.innerHTML = template;
  const ui = grab(container);
  const userKey = currentUserKey();
  ui.userName.textContent = userKey === GUEST ? 'Guest' : userKey;

  const store = await openHistoryStore();
  if (mine !== generation) return; // the user has already moved on to another page
  if (!store) {
    ui.notice.textContent =
      "Your history can't be saved in this browser. It may be a private window, or this site may be blocked from storing data. Scans and reports still work; they just aren't kept here.";
    ui.notice.hidden = false;
    return;
  }

  const refresh = async () => {
    const entries = await store.list(userKey);
    if (mine === generation) render(ui, entries);
  };
  wireDialogs(ui);
  wireSessionActions(ui, store, userKey, refresh);
  try {
    await refresh();
  } catch (err) {
    console.warn('Could not load the health history:', err);
    if (mine !== generation) return;
    ui.notice.textContent = "Your history couldn't be loaded just now. Please reload the page to try again.";
    ui.notice.hidden = false;
  }
}

export function cleanupProgressDashboard(): void {
  generation++;
  stopChart?.();
  stopChart = null;
  clearTimeout(toastTimer);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render(ui: Ui, entries: HistoryEntry[]) {
  stopChart?.();
  stopChart = null;
  ui.empty.hidden = entries.length > 0;
  ui.content.hidden = entries.length === 0;
  if (!entries.length) return;
  renderOverview(ui, entries);
  renderChanges(ui, entries);
  renderHabits(ui, entries);
  renderSessions(ui, entries);
}

function renderOverview(ui: Ui, entries: HistoryEntry[]) {
  const latest = entries[0];
  const trend = scoreTrend(entries);
  ui.heroScore.textContent = score(latest.metrics);
  ui.heroLevel.replaceChildren(levelChip(latest.metrics.health));
  ui.heroDate.textContent = `Last scan: ${dayFormat.format(latest.createdAt)}, ${timeFormat.format(latest.createdAt)}`;

  const change = latestScoreChange(trend.points);
  if (!change) {
    ui.heroDelta.replaceChildren(el('span', 'delta delta-same', 'Scan again to see your trend'));
  } else {
    const signed = `${change.delta > 0 ? '+' : change.delta < 0 ? '−' : '±'}${Math.abs(change.delta)}`;
    const text =
      change.change === 'same' ? `About the same (${signed}) since your last scan` : `${signed} since your last scan`;
    const symbol = { better: 'arrow_upward', worse: 'arrow_downward', same: 'remove' }[change.change];
    ui.heroDelta.replaceChildren(el('span', `delta delta-${change.change}`, icon(symbol), text));
  }

  if (trend.points.length) stopChart = renderScoreChart(ui.chart, trend.points);
  else ui.chart.replaceChildren();
  ui.chart.parentElement?.querySelector('.score-key')?.remove();
  ui.chart.insertAdjacentElement('afterend', scoreBandKey());

  const older = trend.olderVersion;
  ui.chartFootnote.hidden = older === 0;
  ui.chartFootnote.textContent = older
    ? `${older} earlier scan${older === 1 ? '' : 's'} used an older version of the scan and ${older === 1 ? "isn't" : "aren't"} shown, since ${older === 1 ? 'it was' : 'they were'} measured differently.`
    : '';
}

const CHANGE_LOOK = {
  better: { icon: 'check_circle', word: 'Better' },
  worse: { icon: 'error', word: 'Worse' },
  same: { icon: 'remove', word: 'Same' },
} as const;

function changeRow(c: ReadingChange): HTMLElement {
  const look = CHANGE_LOOK[c.change];
  return el(
    'li',
    `change-row change-${c.change}`,
    el('span', 'change-label', c.label),
    el('span', 'change-values', `${formatReading(c.key, c.before)} → ${formatReading(c.key, c.after)}`),
    el('span', 'change-status', icon(look.icon), look.word)
  );
}

function renderChanges(ui: Ui, entries: HistoryEntry[]) {
  const comparison = changesSinceLastScan(entries);
  if (!comparison) {
    ui.changesSubtitle.textContent = "After your next scan, you'll see here what has changed.";
    ui.changesList.replaceChildren();
    return;
  }
  const { previous, latest, changes } = comparison;
  ui.changesSubtitle.textContent = `${dayFormat.format(previous.createdAt)} → ${dayFormat.format(latest.createdAt)}`;
  const moved = changes
    .filter((c) => c.change !== 'same')
    .sort((a, b) => (a.change === b.change ? 0 : a.change === 'worse' ? -1 : 1));
  const same = changes.filter((c) => c.change === 'same');

  const parts: HTMLElement[] = [];
  if (comparison.poorConditions) {
    parts.push(
      el(
        'p',
        'progress-caveat',
        icon('wb_cloudy'),
        'One of these scans was taken in poor light or focus, so some differences may come from the conditions rather than your skin.'
      )
    );
  }
  if (moved.length) parts.push(el('ul', 'change-list', ...moved.map(changeRow)));
  else parts.push(el('p', 'progress-muted', 'Nothing has changed meaningfully since your last scan.'));
  if (same.length) {
    const details = el(
      'details',
      'change-same',
      el('summary', '', `About the same: ${same.length} reading${same.length === 1 ? '' : 's'}`),
      el('ul', 'change-list', ...same.map(changeRow))
    );
    parts.push(details);
  }
  ui.changesList.replaceChildren(...parts);
}

const SEVERITY_LOOK = {
  critical: { icon: 'error', word: 'Critical' },
  high: { icon: 'warning', word: 'High' },
  moderate: { icon: 'info', word: 'Moderate' },
} as const;

function habitChip(cell: HabitCell): HTMLElement {
  if (cell.status === 'unknown') return el('span', 'habit-unknown', cell.label);
  if (cell.status === 'fine') return el('span', 'habit-chip habit-fine', icon('check_circle'), cell.label);
  const look = SEVERITY_LOOK[cell.severity ?? 'moderate'];
  return el(
    'span',
    `habit-chip habit-${cell.severity}`,
    icon(look.icon),
    el('span', 'progress-sr-only', `${look.word}: `),
    cell.label
  );
}

function renderHabits(ui: Ui, entries: HistoryEntry[]) {
  const timeline = habitTimeline(entries);
  if (!timeline) {
    ui.habitsTable.replaceChildren(
      el(
        'p',
        'progress-muted',
        'Finish a consultation after your scan, and your sleep, water, meals and stress will be tracked here.'
      )
    );
    return;
  }
  const head = el(
    'tr',
    '',
    el('th', '', 'Habit'),
    ...timeline.sessions.map((s) => el('th', '', shortDayFormat.format(s.at)))
  );
  head.querySelectorAll('th').forEach((th) => th.setAttribute('scope', 'col'));
  const rows = timeline.rows.map((row) => {
    const label = el('th', '', row.label);
    label.setAttribute('scope', 'row');
    const tr = el('tr', '', label, ...row.cells.map((cell) => el('td', '', habitChip(cell))));
    tr.dataset.topic = row.topic;
    return tr;
  });
  const table = el(
    'table',
    'habit-table',
    el('caption', 'progress-sr-only', 'Your habits at each consultation, oldest first'),
    el('thead', '', head),
    el('tbody', '', ...rows)
  );
  const wrap = el('div', 'habit-table-wrap', table);
  // A table wider than a phone scrolls sideways; make that scroll area reachable by keyboard.
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Habits over time (scrolls sideways)');
  ui.habitsTable.replaceChildren(wrap);
}

const VERDICT_CLASS = { good: 'good', fair: 'fair', attention: 'attention', urgent: 'urgent' } as const;

function renderSessions(ui: Ui, entries: HistoryEntry[]) {
  const comparableVersion = entries[0].metrics.version ?? 1;
  ui.sessionList.replaceChildren(
    ...entries.map((entry) => {
      const when = `${dayFormat.format(entry.createdAt)}, ${timeFormat.format(entry.createdAt)}`;
      const detail = el('div', 'session-detail');
      const verdict = entry.consultation?.assessment.verdict;
      detail.append(
        verdict
          ? el('span', `verdict-chip verdict-${VERDICT_CLASS[verdict.level]}`, verdict.label)
          : el('span', 'session-scan-only', 'Scan only, no consultation')
      );
      if (entry.metrics.heartRate > 0) {
        detail.append(el('span', 'session-pulse', icon('favorite'), `${Math.round(entry.metrics.heartRate)} BPM`));
      }
      if ((entry.metrics.version ?? 1) !== comparableVersion) {
        detail.append(el('span', 'session-older', 'Older scan version'));
      }

      const actions = el('div', 'session-actions');
      if (entry.consultation) {
        const view = el('button', 'progress-btn', icon('description'), 'View report');
        view.type = 'button';
        view.dataset.action = 'view';
        view.dataset.id = entry.id;
        actions.append(view);
      }
      const remove = el('button', 'progress-icon-btn', icon('delete'));
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.dataset.id = entry.id;
      remove.setAttribute('aria-label', `Delete the session of ${when}`);
      remove.title = 'Delete this session';
      actions.append(remove);

      const item = el(
        'li',
        'session-item',
        el(
          'div',
          'session-when',
          el('span', 'session-date', dayFormat.format(entry.createdAt)),
          el('span', 'session-time', timeFormat.format(entry.createdAt))
        ),
        el('div', 'session-score', el('span', 'session-score-value', score(entry.metrics)), levelChip(entry.metrics.health)),
        detail,
        actions
      );
      item.dataset.id = entry.id;
      return item;
    })
  );
}

// ── Actions ──────────────────────────────────────────────────────────────────

function showToast(ui: Ui, message: string) {
  ui.toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.textContent = ''), 5000);
}

/** After a delete the pressed button is gone: put focus on the list's heading (or the empty state's). */
function refocusAfterDelete(ui: Ui) {
  (ui.content.hidden ? ui.emptyTitle : ui.sessionsTitle).focus();
}

function wireDialogs(ui: Ui) {
  ui.reportClose.addEventListener('click', () => ui.reportDialog.close());
  // A click on the dimmed backdrop (the dialog element itself, outside its content) closes it.
  ui.reportDialog.addEventListener('click', (event) => {
    if (event.target === ui.reportDialog) ui.reportDialog.close();
  });
  ui.confirmOk.addEventListener('click', () => ui.confirmDialog.close('ok'));
  ui.confirmCancel.addEventListener('click', () => ui.confirmDialog.close('cancel'));
}

/** Asks before anything is deleted; the safe choice has the focus. */
function confirmDelete(ui: Ui, title: string, text: string, action: string): Promise<boolean> {
  ui.confirmTitle.textContent = title;
  ui.confirmText.textContent = text;
  ui.confirmOk.textContent = action;
  ui.confirmDialog.returnValue = '';
  return new Promise((resolve) => {
    ui.confirmDialog.addEventListener('close', () => resolve(ui.confirmDialog.returnValue === 'ok'), { once: true });
    ui.confirmDialog.showModal();
    ui.confirmCancel.focus();
  });
}

function openReport(ui: Ui, entry: HistoryEntry, opener: HTMLElement) {
  const consultation = entry.consultation;
  if (!consultation) return;
  renderReport(consultation.report, entry.metrics, ui.reportBody, consultation.assessment, {
    writtenAt: new Date(consultation.completedAt),
    fromHistory: true,
  });
  ui.reportDialog.addEventListener('close', () => opener.focus(), { once: true });
  ui.reportDialog.showModal();
  ui.reportBody.scrollTop = 0;
  ui.reportClose.focus();
}

/** Runs a storage action; if the browser's storage fails, the user is told rather than nothing happening. */
async function attempt(ui: Ui, failure: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (err) {
    console.warn(failure, err);
    showToast(ui, `${failure} Please try again.`);
  }
}

function wireSessionActions(ui: Ui, store: HistoryStore, userKey: string, refresh: () => Promise<void>) {
  ui.sessionList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const id = button?.dataset.id;
    if (!button || !id) return;
    const viewing = button.dataset.action === 'view';
    void attempt(ui, viewing ? "That report couldn't be opened." : "That session couldn't be deleted.", async () => {
      const entry = await store.get(id);
      if (!entry) return refresh();
      if (viewing) return openReport(ui, entry, button);

      const when = `${dayFormat.format(entry.createdAt)}, ${timeFormat.format(entry.createdAt)}`;
      const confirmed = await confirmDelete(
        ui,
        'Delete this session?',
        `The scan from ${when}${entry.consultation ? ' and its report' : ''} will be removed from this device. This can't be undone.`,
        'Delete session'
      );
      if (!confirmed) return;
      await store.remove(id);
      await refresh();
      showToast(ui, 'Session deleted.');
      refocusAfterDelete(ui);
    });
  });

  ui.clearButton.addEventListener('click', () => {
    void attempt(ui, "Your history couldn't be cleared.", async () => {
      const confirmed = await confirmDelete(
        ui,
        'Clear all history?',
        `Every scan and report saved for ${userKey === GUEST ? 'this guest profile' : userKey} on this device will be removed. This can't be undone.`,
        'Clear all history'
      );
      if (!confirmed) return;
      await store.clear(userKey);
      await refresh();
      showToast(ui, 'Your history has been cleared.');
      refocusAfterDelete(ui);
    });
  });
}
