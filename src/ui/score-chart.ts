/**
 * Score chart — the skin health score at each scan, as a single line. A 2px
 * line with ringed 8px points, hairline grid, only the latest value labelled,
 * and a readout that follows the pointer or the arrow keys. The page's
 * sessions list is its table view, so no value is only reachable by hovering.
 */

import type { TrendPoint } from '../services/history-insights';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 220; // plot plus the date labels underneath
const MARGIN = { top: 12, right: 40, bottom: 30, left: 34 };
const TICKS = [0, 20, 40, 60, 80, 100];
/** Score bands, matching healthLevel(): good from 80, needs care below 60. */
const BANDS = [
  { from: 80, to: 100, className: 'score-band-good', label: 'Good (80 and up)' },
  { from: 0, to: 60, className: 'score-band-care', label: 'Needs care (below 60)' },
];
/** Room each date label needs, so they never overlap. */
const DATE_LABEL_WIDTH = 64;

const axisDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  parent.appendChild(node);
  return node;
}

/**
 * Which scans get a date under the axis: the first and the latest, and as many
 * evenly spaced ones between as fit without two labels overlapping. The latest
 * scan's date always shows.
 */
export function labelledIndices(count: number, plotWidth: number): number[] {
  if (count <= 1) return [0];
  const step = plotWidth / (count - 1);
  const labels = Math.max(2, Math.min(count, Math.floor(plotWidth / DATE_LABEL_WIDTH) + 1));
  const kept: number[] = [];
  for (let k = 0; k < labels; k++) {
    const index = Math.round((k * (count - 1)) / (labels - 1));
    if (kept.length && (index - kept[kept.length - 1]) * step < DATE_LABEL_WIDTH) {
      if (index === count - 1) kept[kept.length - 1] = index; // keep the latest rather than its neighbour
      continue;
    }
    kept.push(index);
  }
  return kept;
}

/** Draws the chart into `container` (redrawing when it is resized); returns a function that stops it. */
export function renderScoreChart(container: HTMLElement, points: TrendPoint[]): () => void {
  let active = -1;

  const tooltip = document.createElement('div');
  tooltip.className = 'score-tooltip';
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.hidden = true;
  const announcer = document.createElement('p');
  announcer.className = 'progress-sr-only';
  announcer.setAttribute('aria-live', 'polite');

  container.tabIndex = 0;
  container.setAttribute('role', 'group');
  container.setAttribute(
    'aria-label',
    points.length > 1
      ? `Skin health score at ${points.length} scans, from ${Math.round(points[0].score)} on ${fullDate.format(points[0].at)} to ${Math.round(points[points.length - 1].score)} on ${fullDate.format(points[points.length - 1].at)}. Use the arrow keys to go through the scans.`
      : `Skin health score: one scan so far.`
  );

  let geometry: { x: (i: number) => number; y: (score: number) => number; width: number } | null = null;
  let crosshair: SVGLineElement | null = null;
  let dots: SVGCircleElement[] = [];

  function draw() {
    const width = Math.max(260, Math.round(container.clientWidth));
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const x = (i: number) =>
      points.length === 1 ? MARGIN.left + plotWidth / 2 : MARGIN.left + (i * plotWidth) / (points.length - 1);
    const y = (score: number) => MARGIN.top + ((100 - Math.min(100, Math.max(0, score))) / 100) * plotHeight;
    geometry = { x, y, width };

    const root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(HEIGHT));
    root.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    root.setAttribute('aria-hidden', 'true'); // the group label and the readout describe it

    for (const band of BANDS) {
      svg('rect', { x: MARGIN.left, y: y(band.to), width: plotWidth, height: y(band.from) - y(band.to), class: band.className }, root);
    }
    for (const tick of TICKS) {
      svg('line', { x1: MARGIN.left, x2: MARGIN.left + plotWidth, y1: y(tick), y2: y(tick), class: 'score-grid' }, root);
      svg('text', { x: MARGIN.left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'score-tick' }, root).textContent =
        String(tick);
    }
    for (const i of labelledIndices(points.length, plotWidth)) {
      const anchor = points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      svg('text', { x: x(i), y: HEIGHT - 8, 'text-anchor': anchor, class: 'score-tick' }, root).textContent =
        axisDate.format(points[i].at);
    }

    crosshair = svg('line', { y1: MARGIN.top, y2: MARGIN.top + plotHeight, class: 'score-crosshair', visibility: 'hidden' }, root);
    if (points.length > 1) {
      const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
      svg('path', { d: path, class: 'score-line' }, root);
    }
    dots = points.map((p, i) => svg('circle', { cx: x(i), cy: y(p.score), r: 4, class: 'score-point' }, root));
    const last = points[points.length - 1];
    svg('text', { x: x(points.length - 1) + 9, y: y(last.score) + 4, class: 'score-end-label' }, root).textContent =
      String(Math.round(last.score));

    // Hover (or tap) anywhere over the plot: the nearest scan is picked, no need to hit the 8px point.
    const hit = svg('rect', { x: MARGIN.left - 12, y: 0, width: plotWidth + 24, height: HEIGHT, class: 'score-hit' }, root);
    const pick = (event: PointerEvent) => show(nearest(event.clientX - root.getBoundingClientRect().left), false);
    hit.addEventListener('pointermove', pick);
    hit.addEventListener('pointerdown', pick);
    hit.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') hide(); // a tap's readout stays until the next tap
    });

    container.replaceChildren(root, tooltip, announcer);
    if (active >= 0) show(active, false);
  }

  function nearest(px: number): number {
    if (!geometry || points.length === 1) return 0;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(geometry.x(i) - px) < Math.abs(geometry.x(best) - px)) best = i;
    }
    return best;
  }

  function show(index: number, announce: boolean) {
    if (!geometry || !crosshair) return;
    active = index;
    const point = points[index];
    const px = geometry.x(index);
    crosshair.setAttribute('x1', String(px));
    crosshair.setAttribute('x2', String(px));
    crosshair.setAttribute('visibility', 'visible');
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));

    const value = document.createElement('strong');
    value.textContent = String(Math.round(point.score));
    const when = document.createElement('span');
    when.textContent = fullDate.format(point.at);
    tooltip.replaceChildren(value, when);
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.min(geometry.width - half, Math.max(half, px))}px`;
    tooltip.style.top = `${geometry.y(point.score)}px`;
    if (announce) announcer.textContent = `${when.textContent}: score ${value.textContent}`;
  }

  function hide() {
    active = -1;
    tooltip.hidden = true;
    crosshair?.setAttribute('visibility', 'hidden');
    dots.forEach((dot) => dot.classList.remove('is-active'));
  }

  const onKey = (event: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowLeft: Math.max(0, (active < 0 ? points.length : active) - 1),
      ArrowRight: Math.min(points.length - 1, active + 1),
      Home: 0,
      End: points.length - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    show(keys[event.key], true);
  };
  const onFocus = () => show(points.length - 1, true);
  container.addEventListener('keydown', onKey);
  container.addEventListener('focus', onFocus);
  container.addEventListener('blur', hide);

  draw();
  let lastWidth = container.clientWidth;
  const resize = new ResizeObserver(() => {
    if (container.clientWidth === lastWidth) return;
    lastWidth = container.clientWidth;
    draw();
  });
  resize.observe(container);

  return () => {
    resize.disconnect();
    container.removeEventListener('keydown', onKey);
    container.removeEventListener('focus', onFocus);
    container.removeEventListener('blur', hide);
  };
}

/** The key for the chart's score bands (status colours always come with words). */
export function scoreBandKey(): HTMLElement {
  const key = document.createElement('p');
  key.className = 'score-key';
  for (const band of BANDS) {
    const item = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = `score-key-swatch ${band.className}`;
    item.append(swatch, band.label);
    key.appendChild(item);
  }
  return key;
}
