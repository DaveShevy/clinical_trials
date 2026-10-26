// The story page: "The skin conditions research forgot".
//
// Every number on the page is computed here, at runtime, from data/*.json.
// The only hand-written content is the page prose in story.html and the
// curated text in data/story.json (card one-liners and a few settings).
// Strings from data files reach the DOM only through textContent,
// createElement or createElementNS. Trial links are built only from IDs that
// match /^NCT\d{8}$/.

import { loadIndex, loadPrebuilt } from "./data.js";
import {
  interventionType,
  interventionTypes,
  isQuiet,
  monthsOverdue,
  parseDate,
  phaseGroup,
  sponsorGroup,
  startsByYear,
  statusGroup,
  summarize,
  yearOf,
} from "./analyze.js";

const NCT_RE = /^NCT\d{8}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SVGNS = "http://www.w3.org/2000/svg";
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const DEV_PHASES = new Set(["Early phase 1", "Phase 1", "Phase 1/2", "Phase 2", "Phase 2/3", "Phase 3"]);
const STATUS_TEXT = {
  RECRUITING: "Recruiting",
  NOT_YET_RECRUITING: "Not yet recruiting",
  ENROLLING_BY_INVITATION: "Enrolling by invitation",
  ACTIVE_NOT_RECRUITING: "Active, not recruiting",
  COMPLETED: "Completed",
  TERMINATED: "Stopped early (terminated)",
  WITHDRAWN: "Withdrawn before enrolling",
  SUSPENDED: "Suspended",
  UNKNOWN: "Status not known",
};
const STATUS_KEY = {
  Recruiting: "recruiting",
  "Active, not recruiting": "active",
  Completed: "completed",
  "Stopped early": "stopped",
  Unknown: "unknown",
};
const STORY_DEFAULTS = {
  focus: "keratosis-pilaris",
  focusShort: "KP",
  comparison: "rosacea",
  lightPattern: "\\blaser|\\bIPL\\b|intense pulsed light",
  graceMonths: 6,
  timelineStart: 2000,
  timelineNote: "",
  familiarMedicines: [],
  familiarLabel: "familiar medicines",
  quote: null,
  cards: [],
};

const nf = new Intl.NumberFormat("en-US");
// Own-key lookup, so "toString" and friends never match a label table.
const lookup = (table, key) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);
// Rows with fewer recruiting listings than this get no share in section 5.
const MIN_LISTINGS = 10;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ formatting

const fmt = (n) => nf.format(n);
const word = (n) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : fmt(n));
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

function pct(share) {
  if (share === null || share === undefined || !Number.isFinite(share)) return "n/a";
  const p = share * 100;
  if (p > 0 && p < 1) return "under 1%";
  return `${Math.round(p)}%`;
}

const FRACTIONS = [
  [1 / 10, "a tenth"], [1 / 8, "an eighth"], [1 / 6, "a sixth"], [1 / 5, "a fifth"], [1 / 4, "a quarter"],
  [1 / 3, "a third"], [2 / 5, "two-fifths"], [1 / 2, "half"], [3 / 5, "three-fifths"], [2 / 3, "two-thirds"],
  [3 / 4, "three-quarters"], [4 / 5, "four-fifths"], [9 / 10, "nine-tenths"],
];

/** "a third" for 0.34, or null when no simple fraction is within 2 points. */
function aboutFraction(share) {
  let best = null;
  for (const [v, w] of FRACTIONS) {
    const d = Math.abs(share - v);
    if (d <= 0.02 && (!best || d < best.d)) best = { d, w };
  }
  return best ? best.w : null;
}

/** "one in eight" for 0.13, or null when it would not be close. */
function oneIn(share) {
  if (!(share > 0) || share > 0.5) return null;
  const n = Math.round(1 / share);
  return Math.abs(1 / n - share) / share <= 0.1 ? `one in ${word(n)}` : null;
}

/** "Keratosis pilaris" -> "keratosis pilaris"; leaves "KP" and codes alone. */
function lc(s) {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function uc(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function listText(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function times(a, b) {
  const r = a / b;
  return r >= 10 ? fmt(Math.round(r)) : r.toFixed(1).replace(/\.0$/, "");
}

function longDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A listing date as people say it: "July 2026", "2026" or "15 October 2026". */
function listingDate(s, { day = false } = {}) {
  const d = parseDate(s);
  if (!d) return null;
  const t = s.trim();
  if (/^\d{4}$/.test(t)) return String(d.getUTCFullYear());
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(t)) return longDate(d);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function people(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Number.isInteger(n) ? fmt(n) : `about ${fmt(Math.round(n))}`;
}

// ------------------------------------------------------------ DOM helpers

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

/** Replace an element's content with text and nodes. Strings become text nodes. */
function fill(el, ...parts) {
  if (!el) return;
  el.replaceChildren(...parts.flat().filter((p) => p !== null && p !== undefined && p !== false));
  el.hidden = false;
  el.style.minHeight = "";
}

const num = (text) => h("strong", { class: "story-num" }, text);

function trialLink(id, text) {
  if (typeof id !== "string" || !NCT_RE.test(id)) return document.createTextNode(text ?? "");
  return h("a", { href: `https://clinicaltrials.gov/study/${id}` }, text ?? id);
}

function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.append(node);
  return node;
}

function svgText(parent, x, y, text, attrs = {}) {
  const t = svg("text", { x, y, ...attrs }, parent);
  t.textContent = text;
  return t;
}

function svgRoot(width, height, label) {
  return svg("svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": label,
    class: "story-svg",
  });
}

let measureCtx = null;
let measureFont = null;
function textWidth(text, size = 12, weight = 400) {
  if (measureCtx === null) {
    measureCtx = document.createElement("canvas").getContext("2d") || false;
    measureFont = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  }
  if (!measureCtx) return String(text).length * size * 0.6;
  measureCtx.font = `${weight} ${size}px ${measureFont}`;
  return measureCtx.measureText(String(text)).width;
}

/** Horizontal bar, square at the baseline, 4px rounded data end. */
function hbarPath(x0, y, w, hgt, r = 4) {
  if (!(w > 0)) return "";
  r = Math.min(r, w, hgt / 2);
  return `M${x0},${y}H${x0 + w - r}A${r},${r} 0 0 1 ${x0 + w},${y + r}V${y + hgt - r}A${r},${r} 0 0 1 ${x0 + w - r},${y + hgt}H${x0}Z`;
}

/** Vertical bar, square at the baseline, rounded top. */
function vbarPath(x, base, w, hgt, r) {
  if (!(hgt > 0) || !(w > 0)) return "";
  r = Math.min(r, w / 2, hgt);
  const top = base - hgt;
  return `M${x},${base}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${base}Z`;
}

/**
 * Render `draw(width)` into `container` now and again whenever its width
 * changes. Mounting again on the same container swaps in the new draw
 * function (a loading placeholder, then the real chart) without adding a
 * second observer.
 */
const mounts = new WeakMap();
function mount(container, draw) {
  if (!container) return;
  let m = mounts.get(container);
  if (!m) {
    m = { draw, last: -1, frame: 0 };
    mounts.set(container, m);
    const schedule = () => {
      if (!m.frame) {
        m.frame = requestAnimationFrame(() => {
          m.frame = 0;
          renderMounted(container, m);
        });
      }
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(container);
    else window.addEventListener("resize", schedule);
  }
  m.draw = draw;
  m.last = -1;
  renderMounted(container, m);
}

function renderMounted(container, m) {
  const w = Math.floor(container.clientWidth);
  if (w <= 0 || w === m.last) return;
  m.last = w;
  container.replaceChildren(m.draw(w));
}

/** A collapsed table of the chart's numbers. */
function numbersTable(container, caption, head, rows) {
  if (!container) return;
  const table = h(
    "table",
    { class: "table table-compact" },
    h("caption", { class: "visually-hidden" }, caption),
    h("thead", {}, h("tr", {}, head.map((c, i) => h("th", { scope: "col", class: i ? "num" : null }, c)))),
    h(
      "tbody",
      {},
      rows.map((r) =>
        h(
          "tr",
          {},
          r.map((c, i) => (i === 0 ? h("th", { scope: "row" }, c) : h("td", { class: "num" }, c))),
        ),
      ),
    ),
  );
  container.replaceChildren(h("details", { class: "table-view" }, h("summary", {}, "Show the numbers"), scrollBox(table, caption)));
}

/** A sideways-scrolling box that keyboard users can focus and scroll. */
function scrollBox(table, label) {
  return h("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": label }, table);
}

function legend(container, items) {
  if (!container) return;
  container.replaceChildren(
    h(
      "ul",
      { class: "legend story-legend" },
      items.map((it) =>
        h(
          "li",
          { class: "legend-item" },
          h("span", { class: `swatch tone-${it.tone}${it.extra ? ` ${it.extra}` : ""}`, "aria-hidden": "true" }),
          it.label,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------ charts

/**
 * Horizontal bars with direct labels. rows: [{label, value, valueText, tone, noBar?}].
 * Labels sit left of the bars when there is room, above them when narrow.
 * The focus condition's row gets a faint highlight band, unless it has no
 * bar (noBar: a row with too little data for a value, shown as text only).
 */
function hbarChart(rows, { width, max, label, track = false }) {
  const wide = width >= 520;
  const fs = 13;
  const labelW = wide
    ? Math.min(Math.ceil(Math.max(...rows.map((r) => textWidth(r.label, fs, r.tone === "focus" ? 650 : 400)))) + 16, Math.round(width * 0.42))
    : 0;
  // Text-only rows write across the bar area, so they do not narrow the bars.
  const valueW = Math.ceil(Math.max(0, ...rows.filter((r) => !r.noBar).map((r) => textWidth(r.valueText, 12, 600)))) + 10;
  const barH = wide ? 18 : 16;
  const rowH = wide ? 34 : 52;
  const top = 2;
  const x0 = labelW;
  const span = Math.max(40, width - labelW - valueW);
  const height = top + rows.length * rowH;
  const root = svgRoot(width, height, label);
  const domain = max > 0 ? max : 1;

  rows.forEach((r, i) => {
    const rowTop = top + i * rowH;
    const y = wide ? rowTop + (rowH - barH) / 2 : rowTop + 22;
    const g = svg("g", { class: `story-row tone-${r.tone}` }, root);
    if (r.tone === "focus" && !r.noBar) {
      svg("rect", { x: -6, y: rowTop + (wide ? 1 : 0), width: width + 12, height: rowH - (wide ? 2 : 4), rx: 6, class: "story-band" }, g);
    }
    if (wide) {
      svgText(g, 0, y + barH / 2, r.label, { class: "story-label", "dominant-baseline": "central" });
    } else {
      svgText(g, 0, rowTop + 15, r.label, { class: "story-label" });
    }
    if (r.noBar) {
      svgText(g, x0 + 6, y + barH / 2, r.valueText, { class: "story-value story-value--note", "dominant-baseline": "central" });
      return;
    }
    if (track) svg("rect", { x: x0, y, width: span, height: barH, rx: 4, class: "story-track" }, g);
    const w = (Math.max(0, r.value) / domain) * span;
    const drawn = r.value > 0 ? Math.max(w, 1) : 0;
    if (drawn > 0) svg("path", { d: hbarPath(x0, y, drawn, barH), class: "story-bar" }, g);
    if (!wide) svg("line", { x1: x0 + 0.5, x2: x0 + 0.5, y1: y - 3, y2: y + barH + 3, class: "story-axis" }, g);
    svgText(g, x0 + drawn + 6, y + barH / 2, r.valueText, { class: "story-value", "dominant-baseline": "central" });
  });
  if (wide) svg("line", { x1: x0 + 0.5, x2: x0 + 0.5, y1: top, y2: height, class: "story-axis" }, root);
  return root;
}

/**
 * For each category, one bar per series, as shares on a 0..100% track.
 * cats: [{label, values: [{count, share, total}]}]; series: [{short, tone}].
 */
function pairedChart(cats, series, { width, label }) {
  const wide = width >= 560;
  const catW = wide ? Math.min(Math.ceil(Math.max(...cats.map((c) => textWidth(c.label, 13, 650)))) + 20, Math.round(width * 0.36)) : 0;
  const nameW = Math.ceil(Math.max(...series.map((s) => textWidth(s.short, 12, 650)))) + 10;
  const valueText = (v) => `${pct(v.share)} (${fmt(v.count)} of ${fmt(v.total)})`;
  const valueW = Math.ceil(Math.max(...cats.flatMap((c) => c.values.map((v) => textWidth(valueText(v), 12, 600))))) + 10;
  const barH = 14;
  const gap = 6;
  const groupH = series.length * barH + (series.length - 1) * gap;
  const head = wide ? 0 : 24;
  const rowH = head + groupH + (wide ? 24 : 22);
  const x0 = catW + nameW;
  const span = Math.max(40, width - x0 - valueW);
  const height = cats.length * rowH - (wide ? 24 : 22) + 4;
  const root = svgRoot(width, height, label);

  cats.forEach((c, i) => {
    const rowTop = i * rowH;
    const g = svg("g", { class: "story-row" }, root);
    if (wide) svgText(g, 0, rowTop + groupH / 2, c.label, { class: "story-label story-label--cat", "dominant-baseline": "central" });
    else svgText(g, 0, rowTop + 15, c.label, { class: "story-label story-label--cat" });
    series.forEach((s, j) => {
      const v = c.values[j];
      const y = rowTop + head + j * (barH + gap);
      const sg = svg("g", { class: `tone-${s.tone}` }, g);
      svgText(sg, catW, y + barH / 2, s.short, { class: "story-label story-label--series", "dominant-baseline": "central" });
      svg("rect", { x: x0, y, width: span, height: barH, rx: 4, class: "story-track" }, sg);
      const w = v.share > 0 ? Math.max(1, v.share * span) : 0;
      if (w > 0) svg("path", { d: hbarPath(x0, y, w, barH, 4), class: "story-bar" }, sg);
      svgText(sg, x0 + span + 8, y + barH / 2, valueText(v), { class: "story-value", "dominant-baseline": "central" });
    });
  });
  return root;
}

/** The smallest "nice" number (1, 2, 2.5 or 5 times a power of ten) at or above v. */
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Panel geometry shared by the real chart and its loading placeholder. */
function multiplesLayout(width) {
  const narrow = width < 520;
  const gapX = narrow ? 16 : 24;
  const cols = width >= 860 ? 3 : width >= 280 ? 2 : 1;
  const panelW = Math.floor((width - gapX * (cols - 1)) / cols);
  const mt = 8;
  const mb = 20;
  const ph = narrow ? 64 : 96;
  return { narrow, gapX, cols, panelW, mt, mb, ph, height: mt + ph + mb };
}

function multiplesGrid(layout) {
  const grid = h("div", { class: "story-multiples__grid" });
  grid.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
  grid.style.columnGap = `${layout.gapX}px`;
  return grid;
}

/**
 * The section 2 grid before the data arrives: the same panels, titles and
 * heights as the real chart, so nothing below moves when it is drawn.
 */
function multiplesPlaceholder(panels, { width }) {
  const L = multiplesLayout(width);
  const grid = multiplesGrid(L);
  for (const p of panels) {
    const root = svgRoot(L.panelW, L.height, `${p.label}: loading`);
    root.setAttribute("aria-hidden", "true");
    svg("line", { x1: 0, x2: L.panelW, y1: L.mt + L.ph + 0.5, y2: L.mt + L.ph + 0.5, class: "story-axis" }, root);
    grid.append(
      h(
        "div",
        { class: `story-panel is-loading tone-${p.tone}` },
        h("p", { class: "story-panel__title" }, h("span", { class: "swatch", "aria-hidden": "true" }), p.label),
        h("p", { class: "story-panel__meta" }, "Loading…"),
        root,
      ),
    );
  }
  return h("div", { class: "story-multiples__inner" }, grid);
}

/**
 * Small multiples of trials started per year. panels: [{label, tone, counts:
 * Map(year -> n), total}]. All panels share the years and one vertical scale,
 * so their heights compare directly. A year with any trials gets a bar at
 * least MIN_BAR px tall, and a panel whose bars are too short to read says
 * its busiest year in words, right above them.
 */
const MIN_BAR = 2;
// Closes a tapped-open tooltip when the reader taps anywhere else. One
// listener for the page, so redrawing a chart never adds another.
let closePinnedTip = null;
document.addEventListener("pointerdown", (e) => {
  if (closePinnedTip) closePinnedTip(e.target);
});
function multiples(panels, { width, start, end, partialYear, todayText }) {
  const L = multiplesLayout(width);
  const { narrow, panelW, mt, ph, height } = L;
  const years = [];
  for (let y = start; y <= end; y += 1) years.push(y);
  const shownOf = (p) => years.map((y) => p.counts.get(y) ?? 0);
  const yMax = niceCeil(Math.max(1, ...panels.flatMap(shownOf)));

  const wrap = multiplesGrid(L);
  const tip = h("div", { class: "story-tip", "aria-hidden": "true", hidden: true });
  const outer = h("div", { class: "story-multiples__inner" }, wrap, tip);

  let pinned = null;
  const showTip = (target, panel, year, n) => {
    tip.replaceChildren(
      h("strong", {}, `${fmt(n)} ${plural(n, "trial")}`),
      ` started in ${year}${year === partialYear ? ` (to ${todayText})` : ""}`,
      h("span", { class: "story-tip__sub" }, panel.label),
    );
    tip.hidden = false;
    const box = outer.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = r.left + r.width / 2 - box.left - tw / 2;
    left = Math.max(0, Math.min(left, box.width - tw));
    tip.style.left = `${left}px`;
    tip.style.top = `${r.top - box.top - tip.offsetHeight - 6}px`;
  };
  const hideTip = () => {
    tip.hidden = true;
    if (pinned) pinned.classList.remove("is-hover");
    pinned = null;
  };
  // A tap (touch or pen) pins the tip until the next tap elsewhere; a mouse
  // shows it on hover only.
  const pin = (hit) => {
    pinned = hit;
    hit.classList.add("is-hover");
    closePinnedTip = (target) => {
      if (!outer.contains(target)) hideTip();
    };
  };

  const ml = Math.ceil(textWidth(fmt(yMax), 11)) + 7;
  const mr = 2;
  const plotW = panelW - ml - mr;
  const band = plotW / years.length;
  const barW = band >= 6 ? band - 2 : Math.max(1, band - 1);
  const base = mt + ph;
  const barH = (n) => (n > 0 ? Math.max(MIN_BAR, (n / yMax) * ph) : 0);

  for (const p of panels) {
    const shown = shownOf(p);
    const peak = Math.max(0, ...shown);
    const peakYears = years.filter((y, i) => shown[i] === peak && peak > 0);
    const totalShown = shown.reduce((a, b) => a + b, 0);

    const peakYearsText = peakYears.length <= 2 ? peakYears.join(" and ") : `${word(peakYears.length)} years`;
    const peakText = peak > 0 ? `busiest year ${fmt(peak)} (${peakYearsText})` : "none started in these years";
    const meta = narrow
      ? `${fmt(p.total)} ${plural(p.total, "trial")} · peak ${fmt(peak)}`
      : `${fmt(p.total)} ${plural(p.total, "trial")} in all · ${peakText}`;
    const root = svgRoot(
      panelW,
      height,
      `${p.label}: ${fmt(totalShown)} ${plural(totalShown, "trial")} started from ${start} to ${end}; ${peakText}. Scale 0 to ${fmt(yMax)} trials a year, shared by all panels.`,
    );
    root.classList.add(`tone-${p.tone}`);
    // Baseline and the shared top line.
    svg("line", { x1: ml, x2: panelW - mr, y1: base + 0.5, y2: base + 0.5, class: "story-axis" }, root);
    svg("line", { x1: ml, x2: panelW - mr, y1: mt + 0.5, y2: mt + 0.5, class: "story-grid" }, root);
    svgText(root, ml - 5, base, "0", { class: "story-tick", "text-anchor": "end", "dominant-baseline": "central" });
    svgText(root, ml - 5, mt, fmt(yMax), { class: "story-tick", "text-anchor": "end", "dominant-baseline": "central" });
    // Decade ticks.
    for (const y of years) {
      if (y % 10 !== 0) continue;
      const x = ml + (y - start) * band + band / 2;
      svg("line", { x1: x, x2: x, y1: base, y2: base + 4, class: "story-axis" }, root);
      svgText(root, x, base + 15, String(y), { class: "story-tick", "text-anchor": y === start ? "start" : "middle" });
    }
    years.forEach((y, i) => {
      const n = shown[i];
      const x = ml + i * band + (band - barW) / 2;
      if (n > 0) {
        svg("path", { d: vbarPath(x, base, barW, barH(n), Math.min(2, barW / 2)), class: `story-bar${y === partialYear ? " is-partial" : ""}` }, root);
      }
      const hit = svg("rect", { x: ml + i * band, y: mt, width: band, height: ph, class: "story-hit" }, root);
      hit.addEventListener("pointerenter", (e) => {
        if (e.pointerType !== "mouse") return;
        hit.classList.add("is-hover");
        showTip(hit, p, y, n);
      });
      hit.addEventListener("pointerleave", (e) => {
        if (e.pointerType !== "mouse") return;
        hit.classList.remove("is-hover");
        if (!pinned) hideTip();
      });
      hit.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return;
        if (pinned === hit) {
          hideTip();
          return;
        }
        hideTip();
        pin(hit);
        showTip(hit, p, y, n);
      });
    });
    // Short bars get their busiest year in words, just above them.
    const peakH = barH(peak);
    if (peak > 0 && peakH < ph * 0.4) {
      const long = `never more than ${fmt(peak)} a year`;
      const note = textWidth(long, 11, 600) <= plotW - 6 ? long : `at most ${fmt(peak)} a year`;
      svgText(root, ml + 4, base - peakH - 6, note, { class: "story-note" });
    }

    wrap.append(
      h(
        "div",
        { class: `story-panel tone-${p.tone}` },
        h("p", { class: "story-panel__title" }, h("span", { class: "swatch", "aria-hidden": "true" }), p.label),
        h("p", { class: "story-panel__meta" }, meta),
        root,
      ),
    );
  }
  outer.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") hideTip();
  });
  return outer;
}

// ------------------------------------------------------------ loading

async function loadStory() {
  try {
    const res = await fetch("data/story.json");
    if (!res.ok) throw new Error(`error ${res.status}`);
    const raw = await res.json();
    return { ...STORY_DEFAULTS, ...sanitizeStory(raw), loaded: true };
  } catch (err) {
    return { ...STORY_DEFAULTS, loaded: false, error: err };
  }
}

function sanitizeStory(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of ["focus", "comparison"]) if (typeof raw[k] === "string" && SLUG_RE.test(raw[k])) out[k] = raw[k];
  for (const k of ["focusShort", "lightPattern", "timelineNote", "familiarLabel"]) if (typeof raw[k] === "string") out[k] = raw[k];
  if (Number.isInteger(raw.graceMonths) && raw.graceMonths >= 0 && raw.graceMonths <= 60) out.graceMonths = raw.graceMonths;
  if (Number.isInteger(raw.timelineStart) && raw.timelineStart > 1900 && raw.timelineStart < 2100) out.timelineStart = raw.timelineStart;
  if (Array.isArray(raw.familiarMedicines)) out.familiarMedicines = raw.familiarMedicines.filter((m) => typeof m === "string" && m.trim());
  if (raw.quote && typeof raw.quote.id === "string" && typeof raw.quote.text === "string") out.quote = raw.quote;
  if (Array.isArray(raw.cards)) {
    out.cards = raw.cards
      .filter((c) => c && typeof c.id === "string")
      .map((c) => ({
        id: c.id.trim(),
        condition: typeof c.condition === "string" && SLUG_RE.test(c.condition) ? c.condition : null,
        name: typeof c.name === "string" ? c.name : c.id,
        oneLiner: typeof c.oneLiner === "string" ? c.oneLiner : "",
      }));
  }
  return out;
}

/** The data date as a UTC day; falls back to today if the index has none. */
function dataDay(iso) {
  const d = typeof iso === "string" ? parseDate(iso.slice(0, 10)) : null;
  if (d) return d;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ------------------------------------------------------------ sections

function renderIntro(ctx) {
  const { conds, focus, today } = ctx;
  // The numbers themselves are in section 1's headline, right below.
  const others = conds.filter((c) => c !== focus);
  const fewest = others.length > 0 && others.every((c) => c.count > focus.count);
  const byFar = fewest && others.every((c) => c.count >= focus.count * 3);
  fill(
    $("story-dek"),
    `Keratosis pilaris, the rough little bumps many people have on their upper arms, is very common. `,
    fewest
      ? `Yet of the ${word(conds.length)} skin conditions in this story, it has ${byFar ? "by far " : ""}the fewest studies registered on ClinicalTrials.gov. `
      : "",
    fewest
      ? `This story looks at that gap, at what does get tested, and at some newer ideas being studied.`
      : `This story looks at how often it has been studied, at what gets tested, and at some newer ideas being studied.`,
  );
  fill($("story-byline"), "Data from ", h("a", { href: "https://clinicaltrials.gov/" }, "ClinicalTrials.gov"), `, fetched ${longDate(today)}. Every number is computed in your browser.`);
  fill($("footer-fetched"), `The data on this page was fetched on ${longDate(today)}.`);
  fill($("method-fetched"), `Every number on this page is computed in your browser from the data files below, fetched from ClinicalTrials.gov on ${longDate(today)}.`);
}

function tone(ctx, slug) {
  return slug === ctx.focus.slug ? "focus" : slug === ctx.comparison?.slug ? "compare" : "other";
}

function renderCount(ctx) {
  const { conds, focus, top } = ctx;
  const f = focus.count;
  if (top === focus) {
    fill($("count-headline"), `${uc(focus.label)} has ${fmt(f)} registered ${plural(f, "trial")}, the most of the conditions in this story.`);
  } else if (f === 0) {
    fill($("count-headline"), `${uc(focus.label)} has no registered trials. ${uc(top.label)} has `, num(fmt(top.count)), ".");
  } else {
    fill(
      $("count-headline"),
      `${uc(focus.label)} has `,
      num(fmt(f)),
      ` registered ${plural(f, "trial")}. ${uc(top.label)} has `,
      num(fmt(top.count)),
      `: about ${times(top.count, f)} for every one.`,
    );
  }

  const others = conds.filter((c) => c !== focus).sort((a, b) => a.count - b.count);
  const parts = [];
  const next = others[0];
  if (next && f > 0 && next.count > f) {
    parts.push(`The next smallest in this story, ${lc(next.label)}, has ${fmt(next.count)}, about ${times(next.count, f)} times as many. `);
  }
  if (parts.length) fill($("count-compare"), ...parts);

  const rows = [...conds]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((c) => ({ label: c.label, value: c.count, valueText: fmt(c.count), tone: tone(ctx, c.slug) }));
  const aria = `Bar chart of registered trials per condition: ${rows.map((r) => `${r.label} ${r.valueText}`).join(", ")}.`;
  mount($("count-chart"), (width) => hbarChart(rows, { width, max: rows[0]?.value ?? 1, label: aria }));
  const smallest = rows[rows.length - 1];
  const compare = ctx.comparison;
  fill(
    $("count-caption"),
    `Trials registered on ClinicalTrials.gov that list each condition, as of ${longDate(ctx.today)}.`,
    smallest && smallest.tone === "focus" && rows.length > 1
      ? ` ${uc(focus.label)}, in orange, is the bar at the bottom${rows[0].value > 0 && smallest.value / rows[0].value < 0.02 ? ", so short it is barely visible" : ""}.`
      : ` ${uc(focus.label)} is in orange.`,
    compare ? ` ${uc(compare.label)}, in blue, is the comparison used in section 3.` : "",
  );
  numbersTable($("count-table"), "Registered trials per condition", ["Condition", "Trials"], rows.map((r) => [r.label, r.valueText]));
}

function renderQuote(ctx, focusData) {
  const q = ctx.story.quote;
  if (!q || !NCT_RE.test(q.id)) return;
  const rec = focusData?.records.find((r) => r.id === q.id);
  // Only quote the listing if it still says exactly this.
  if (!rec || typeof rec.summary !== "string" || !rec.summary.includes(q.text)) return;
  fill(
    $("count-quote"),
    `How common is it? The researchers behind one of these trials write in their listing that ${ctx.story.focusShort} “${q.text}” (`,
    trialLink(rec.id, rec.id),
    ").",
  );
}

function renderTime(ctx, datasets) {
  const { story, today, focus } = ctx;
  const end = today.getUTCFullYear();
  const start = Math.min(story.timelineStart, end);
  const order = orderedSlugs(ctx, datasets);
  let before = 0;
  let after = 0;
  let undated = 0;
  const panels = order.map((slug) => {
    const d = datasets.get(slug);
    const sy = startsByYear(d.records);
    const counts = new Map();
    for (const row of sy.rows) counts.set(row.year, (counts.get(row.year) ?? 0) + row.count);
    for (const [y, n] of counts) {
      if (y < start) before += n;
      else if (y > end) after += n;
    }
    undated += sy.undated;
    return { slug, label: d.label, tone: tone(ctx, slug), counts, total: d.records.length };
  });

  const peakOf = (p) => {
    let peak = 0;
    let years = [];
    for (let y = start; y <= end; y += 1) {
      const n = p.counts.get(y) ?? 0;
      if (n > peak) {
        peak = n;
        years = [y];
      } else if (n === peak && n > 0) years.push(y);
    }
    return { peak, years };
  };
  const yearsText = (ys) => (ys.length <= 2 ? `in ${ys.join(" and ")}` : `in ${word(ys.length)} different years`);

  const fp = panels.find((p) => p.slug === focus.slug);
  const best = panels.map((p) => ({ p, ...peakOf(p) })).sort((a, b) => b.peak - a.peak)[0];
  if (fp) {
    const fPeak = peakOf(fp);
    const headline = [`In its busiest year, ${lc(fp.label)} had `, num(word(fPeak.peak)), ` new ${plural(fPeak.peak, "trial")} start.`];
    if (best && best.p !== fp) headline.push(` ${uc(best.p.label)} peaked at `, num(fmt(best.peak)), ` ${yearsText(best.years)}.`);
    fill($("time-headline"), ...headline);

    // Complete years only: the current year is not over.
    const fYears = [...fp.counts.keys()].filter((y) => y >= start && y < end).sort((a, b) => a - b);
    const body = [];
    if (fYears.length) {
      const first = fYears[0];
      const span = end - first;
      let empty = 0;
      for (let y = first; y < end; y += 1) if (!fp.counts.get(y)) empty += 1;
      if (span > 1) body.push(`Between ${first} and ${end - 1}, ${word(empty)} of those ${word(span)} years saw no new ${story.focusShort} trial start at all. `);
    }
    const recentFrom = end - 5;
    const recent = [...fp.counts].filter(([y]) => y >= recentFrom).reduce((a, [, n]) => a + n, 0);
    if (fp.total > 0) body.push(`${uc(word(recent))} of the ${word(fp.total)} ${story.focusShort} trials started in ${recentFrom} or later.`);
    if (body.length) fill($("time-body"), ...body);
  }

  if (story.timelineNote) fill($("time-start-note"), story.timelineNote);
  const partialYear = end;
  const todayText = longDate(today);
  legend($("time-legend"), [
    { tone: "neutral", label: "Trials started that year" },
    { tone: "neutral", extra: "is-partial", label: `${end} so far (the year is not over)` },
  ]);
  mount($("time-chart"), (width) => multiples(panels, { width, start, end, partialYear, todayText }));

  let peakAll = 0;
  for (const p of panels) for (let y = start; y <= end; y += 1) peakAll = Math.max(peakAll, p.counts.get(y) ?? 0);
  const notShown = [];
  if (before) notShown.push(`${fmt(before)} ${plural(before, "trial")} that started before ${start}`);
  if (after) notShown.push(`${fmt(after)} with planned start dates after ${end}`);
  if (undated) notShown.push(`${fmt(undated)} with no start date`);
  fill($("time-caption"), timeCaption({ start, end, todayText, yMax: niceCeil(Math.max(1, peakAll)), notShown }));

  const years = [];
  for (let y = start; y <= end; y += 1) years.push(y);
  numbersTable(
    $("time-table"),
    "Trials started per year, by condition",
    ["Year", ...panels.map((p) => p.label)],
    years.map((y) => [String(y), ...panels.map((p) => fmt(p.counts.get(y) ?? 0))]),
  );
}

function timeCaption({ start, end, todayText, yMax = null, notShown = [] }) {
  return [
    `Trials started per year, ${start} to ${end}, by condition, on one shared scale${yMax ? ` from 0 to ${fmt(yMax)} trials a year` : ""}. `,
    `A year with any trials gets a bar at least ${MIN_BAR} pixels tall, so even one trial shows. `,
    notShown.length ? `Not shown, adding up all the panels: ${listText(notShown)}. ` : "",
    `${end} runs to ${todayText}. Point at or tap a bar for its number, or open the table below.`,
  ].join("");
}

/** A collapsed "Show the numbers" that has no numbers yet, the same height as the real one. */
function numbersPending(container) {
  if (!container) return;
  container.replaceChildren(h("details", { class: "table-view" }, h("summary", {}, "Show the numbers"), h("p", { class: "story-pending" }, "Loading…")));
}

/** Section 2 before the data arrives: the same panels, empty, so the page does not jump. */
function renderTimePlaceholder(ctx) {
  const { story, today } = ctx;
  const end = today.getUTCFullYear();
  const start = Math.min(story.timelineStart, end);
  const panels = orderedConds(ctx).map((c) => ({ label: c.label, tone: tone(ctx, c.slug) }));
  pending($("time-headline"), "Counting the trials started each year…", [4, 2]);
  pending($("time-body"), "Loading…", [3, 2]);
  const cap = $("time-caption");
  fill(cap, timeCaption({ start, end, todayText: longDate(today) }));
  if (cap) cap.style.minHeight = `${window.innerWidth < 600 ? 11 : 4}lh`;
  numbersPending($("time-table"));
  legend($("time-legend"), [
    { tone: "neutral", label: "Trials started that year" },
    { tone: "neutral", extra: "is-partial", label: `${end} so far (the year is not over)` },
  ]);
  if (story.timelineNote) fill($("time-start-note"), story.timelineNote);
  mount($("time-chart"), (width) => multiplesPlaceholder(panels, { width }));
}

/** Section 5 before the data arrives: one text row per condition, the chart's final height. */
function renderQuietPlaceholder(ctx) {
  const rows = orderedConds(ctx).map((c) => ({ label: c.label, value: 0, valueText: "Loading…", tone: tone(ctx, c.slug), noBar: true }));
  pending($("quiet-headline"), "Checking which recruiting listings have not been updated…", [6, 4]);
  pending($("quiet-body"), "Loading…", [3, 2]);
  pending($("quiet-focus"), "Loading…", [5, 2]);
  fill($("quiet-caption"), quietCaption(ctx.story.graceMonths, ctx.today));
  numbersPending($("quiet-table"));
  mount($("quiet-chart"), (width) => {
    const chart = hbarChart(rows, { width, max: 1, label: "Loading" });
    chart.setAttribute("aria-hidden", "true");
    return chart;
  });
}

/** Focus, comparison, then the rest by number of trials: the order the charts use. */
function orderedConds(ctx) {
  const rest = ctx.conds.filter((c) => c !== ctx.focus && c !== ctx.comparison).sort((a, b) => b.count - a.count);
  return [ctx.focus, ctx.comparison, ...rest].filter(Boolean);
}

/**
 * A muted "loading" line in a text slot. `lines` reserves about as many
 * lines as the finished text usually takes (narrow screen, wide screen), so
 * the page below does not jump much when it arrives.
 */
function pending(el, text, lines = null) {
  if (!el) return;
  fill(el, h("span", { class: "story-pending" }, text));
  if (lines) el.style.minHeight = `${window.innerWidth < 600 ? lines[0] : lines[1]}lh`;
}

function orderedSlugs(ctx, datasets) {
  const rest = [...datasets.keys()]
    .filter((s) => s !== ctx.focus.slug && s !== ctx.comparison?.slug)
    .sort((a, b) => datasets.get(b).records.length - datasets.get(a).records.length);
  return [ctx.focus.slug, ctx.comparison?.slug, ...rest].filter((s) => s && datasets.has(s));
}

function renderTested(ctx, fData, cData) {
  const { story } = ctx;
  const short = story.focusShort;
  const fR = fData.records;
  const cR = cData.records;
  const fN = fR.length;
  const cN = cR.length;
  const cLabel = lc(cData.label);
  const fT = interventionTypes(fR);
  const cT = interventionTypes(cR);
  const countOf = (rows, type) => rows.find((t) => t.type === type)?.count ?? 0;

  let lightRe;
  try {
    lightRe = new RegExp(story.lightPattern, "i");
  } catch {
    lightRe = /laser/i;
  }
  const lightN = fR.filter((r) => (r.interventions ?? []).some((i) => lightRe.test(i?.name ?? ""))).length;
  const cDrug = countOf(cT, "DRUG");
  const headline = [];
  if (lightN > 0) {
    headline.push(num(uc(word(lightN))), ` of the ${word(fN)} ${short} trials test a laser or light-based device. `);
  } else if (fT[0]) {
    headline.push(num(uc(word(fT[0].count))), ` of the ${word(fN)} ${short} trials test a ${lc(fT[0].label)}. `);
  }
  headline.push(`In ${cLabel}, `, num(fmt(cDrug)), ` of the ${fmt(cN)} trials test a drug.`);
  fill($("tested-headline"), ...headline);

  const devCount = (rs) => rs.filter((r) => DEV_PHASES.has(phaseGroup(r))).length;
  const fDev = devCount(fR);
  const cDev = devCount(cR);
  const fP4 = fR.filter((r) => phaseGroup(r) === "Phase 4").length;
  const phases = [
    `${uc(cLabel)} has ${fmt(cDev)} ${plural(cDev, "trial")} in the drug-development phases, from early phase 1 to phase 3, which a new medicine normally passes through before it can be approved. ${uc(lc(fData.label))} has ${fDev === 0 ? "none" : word(fDev)}.`,
  ];
  if (fDev === 0 && fP4 > 0) {
    phases.push(` Its only trials with a phase are ${word(fP4)} phase 4 ${plural(fP4, "study", "studies")}, which look at products already on the market.`);
  }
  fill($("tested-phases"), ...phases);

  const ind = (rs) => rs.filter((r) => sponsorGroup(r.sponsorClass) === "Industry").length;
  const fInd = ind(fR);
  const cInd = ind(cR);
  const fMed = summarize(fR, ctx.today).medianEnrollment;
  const cMed = summarize(cR, ctx.today).medianEnrollment;
  const fAcad = fR.filter((r) => sponsorGroup(r.sponsorClass) === "Universities, hospitals & other").length;
  const sponsors = [
    `Companies are the lead sponsor of ${word(fInd)} of the ${word(fN)} ${short} trials, against ${fmt(cInd)} of the ${fmt(cN)} ${cLabel} trials (${pct(cN ? cInd / cN : null)}).`,
  ];
  if (fAcad > fN / 2) sponsors.push(` ${uc(word(fAcad))} of the ${short} trials are led by universities, hospitals and other organisations.`);
  if (fMed !== null && cMed !== null) {
    sponsors.push(` The typical (median) ${short} trial lists ${people(fMed)} participants; the typical ${cLabel} trial lists ${people(cMed)}.`);
  }
  fill($("tested-sponsors"), ...sponsors);

  // Chart: share of each condition's trials per intervention type.
  const types = new Map();
  for (const t of [...fT, ...cT]) types.set(t.type, t.label);
  const all = [...types]
    .map(([type, label]) => {
      const fc = countOf(fT, type);
      const cc = countOf(cT, type);
      return {
        type,
        label,
        values: [
          { count: fc, total: fN, share: fN ? fc / fN : 0 },
          { count: cc, total: cN, share: cN ? cc / cN : 0 },
        ],
      };
    })
    .sort((a, b) => (a.type === "OTHER") - (b.type === "OTHER") || b.values[0].share + b.values[1].share - (a.values[0].share + a.values[1].share));
  // Types under 5% for both conditions share one row, counted as trials that
  // test at least one of them; the table still lists every type.
  const big = all.filter((c) => c.type === "OTHER" || c.values.some((v) => v.share >= 0.05));
  const small = all.filter((c) => !big.includes(c));
  let cats = all;
  let folded = null;
  if (small.length >= 2) {
    const smallTypes = new Set(small.map((c) => c.type));
    const typesOf = (r) => (r.interventions ?? []).map((i) => interventionType(i?.type));
    const anyOf = (rs) => rs.filter((r) => typesOf(r).some((t) => smallTypes.has(t))).length;
    const fc = anyOf(fR);
    const cc = anyOf(cR);
    folded = { label: `${uc(word(small.length))} smaller types`, names: small.map((c) => lc(c.label)) };
    cats = [
      ...big,
      {
        type: "SMALL",
        label: folded.label,
        values: [
          { count: fc, total: fN, share: fN ? fc / fN : 0 },
          { count: cc, total: cN, share: cN ? cc / cN : 0 },
        ],
      },
    ];
  }
  const series = [
    { short, tone: "focus" },
    { short: uc(cLabel), tone: "compare" },
  ];
  legend($("tested-legend"), [
    { tone: "focus", label: `${fData.label} (${short}), ${fmt(fN)} ${plural(fN, "trial")}` },
    { tone: "compare", label: `${cData.label}, ${fmt(cN)} ${plural(cN, "trial")}` },
  ]);
  const aria = `Paired bar chart of the share of trials testing each type of intervention. ${cats
    .map((c) => `${c.label}: ${short} ${pct(c.values[0].share)}, ${cLabel} ${pct(c.values[1].share)}`)
    .join("; ")}.`;
  mount($("tested-chart"), (width) => pairedChart(cats, series, { width, label: aria }));
  const caption = [
    `Share of each condition’s trials that test each type of intervention, as the listings label them. A trial can test more than one type, so a condition’s shares can add up to more than 100%.`,
  ];
  if (folded) caption.push(` “${folded.label}” counts trials that test at least one of: ${listText(folded.names)}.`);
  if (fN > 0 && fN < 30) caption.push(` With only ${word(fN)} ${short} trials, each one moves the ${short} share by about ${Math.round(100 / fN)} percentage points.`);
  fill($("tested-caption"), ...caption);
  numbersTable(
    $("tested-table"),
    "Trials per intervention type",
    ["Intervention type", `${short} trials`, `${short} share`, `${uc(cLabel)} trials`, `${uc(cLabel)} share`],
    all.map((c) => [c.label, fmt(c.values[0].count), pct(c.values[0].share), fmt(c.values[1].count), pct(c.values[1].share)]),
  );
}

function renderNew(ctx, datasets) {
  const { story, today } = ctx;
  const cData = ctx.comparison ? datasets.get(ctx.comparison.slug) : null;
  const container = $("new-cards");

  // The finding: how many rosacea trials test a familiar medicine, from a
  // curated list of medicines already prescribed for it.
  let familiar = null;
  if (cData && story.familiarMedicines.length) {
    const meds = story.familiarMedicines.map((m) => {
      const needle = m.toLowerCase();
      const ids = new Set(cData.records.filter((r) => (r.interventions ?? []).some((i) => (i?.name ?? "").toLowerCase().includes(needle))).map((r) => r.id));
      return { name: m, ids };
    });
    const union = new Set(meds.flatMap((m) => [...m.ids]));
    const top = meds.filter((m) => m.ids.size > 0).sort((a, b) => b.ids.size - a.ids.size).slice(0, 3);
    if (union.size > 0 && top.length) familiar = { cLabel: lc(cData.label), n: cData.records.length, union, top };
  }
  if (familiar) {
    const { cLabel, n, union, top } = familiar;
    const share = n ? union.size / n : 0;
    const frac = aboutFraction(share);
    fill(
      $("new-headline"),
      `${frac ? `About ${frac}` : pct(share)} of ${cLabel} trials (`,
      num(`${fmt(union.size)} of ${fmt(n)}`),
      `) test ${story.familiarLabel}; a few recent ones try something different.`,
    );
    const examples = top.map((m, i) => `${m.name} (${fmt(m.ids.size)}${i === 0 ? ` ${plural(m.ids.size, "trial")}` : ""})`);
    familiar.body = `That counts trials testing at least one of ${word(story.familiarMedicines.length)} ${story.familiarLabel}; the most common are ${listText(examples)}.`;
  }

  if (!story.loaded) {
    fill(container, h("p", { class: "notice notice-error story-col" }, "The curated list of trials for this section could not be loaded. Reload the page to try again."));
    if (!familiar) fill($("new-headline"), "The curated trials could not be loaded.");
    if (familiar) fill($("new-body"), familiar.body);
    return true;
  }
  const cards = story.cards;
  if (!cards.length) {
    fill(container, h("p", {}, "No trials are listed for this section yet."));
    if (familiar) fill($("new-body"), familiar.body);
    else fill($("new-headline"), "No trials are listed for this section yet.");
    return true;
  }

  const find = (card) => {
    const first = card.condition ? datasets.get(card.condition) : null;
    const hit = first?.records.find((r) => r.id === card.id);
    if (hit) return hit;
    for (const d of datasets.values()) {
      const r = d.records.find((x) => x.id === card.id);
      if (r) return r;
    }
    return null;
  };

  const found = cards.map((c) => ({ card: c, record: find(c) }));
  const nFound = found.filter((f) => f.record).length;
  const nRec = found.filter((f) => f.record && statusGroup(f.record.status) === "Recruiting").length;
  const status = [];
  if (nRec === cards.length) status.push(`All ${word(cards.length)} trials below are recruiting, according to their listings.`);
  else status.push(`${uc(word(nRec))} of the ${word(cards.length)} trials below ${nRec === 1 ? "is" : "are"} recruiting, according to their listings.`);
  if (nFound < cards.length) status.push(` ${uc(word(cards.length - nFound))} ${cards.length - nFound === 1 ? "is" : "are"} missing from the current data.`);
  if (familiar) {
    fill($("new-body"), familiar.body, " ", ...status);
  } else {
    fill($("new-headline"), ...status);
  }

  const labelOf = (slug) => ctx.conds.find((c) => c.slug === slug)?.label ?? null;
  const nodes = found.map((f) => card(f.card, f.record, story, today, labelOf(f.card.condition), tone(ctx, f.card.condition)));

  // A closing tile: how many recruiting trials these cards are drawn from.
  const slugs = [...new Set(cards.map((c) => c.condition).filter((s) => s && datasets.has(s)))];
  if (slugs.length) {
    const recruiting = new Set();
    for (const slug of slugs) for (const r of datasets.get(slug).records) if (statusGroup(r.status) === "Recruiting") recruiting.add(r.id);
    const shown = found.filter((f) => f.record && recruiting.has(f.record.id)).length;
    const names = slugs.map((s) => lc(labelOf(s)));
    nodes.push(
      h(
        "aside",
        { class: "story-card story-card--more", "aria-label": "More recruiting trials" },
        h("h3", { class: "story-card__name" }, "Every recruiting trial"),
        h(
          "p",
          { class: "story-card__text" },
          `These cards show ${word(shown)} of the ${fmt(recruiting.size)} ${listText(names)} trials that say they are recruiting. The explorer lists all of them and maps the sites their listings give.`,
        ),
        h(
          "ul",
          { class: "story-card__more" },
          slugs.map((s) => h("li", {}, h("a", { href: `index.html?${new URLSearchParams({ q: labelOf(s) })}` }, `${labelOf(s)} in the explorer`))),
        ),
      ),
    );
  }
  fill(container, h("div", { class: "story-cards__grid" }, nodes));
  return nFound === cards.length;
}

function card(c, r, story, today, conditionLabel, toneName) {
  const validId = NCT_RE.test(c.id);
  const link = validId
    ? h("a", { class: "story-card__link", href: `https://clinicaltrials.gov/study/${c.id}` }, `Read ${c.id} on ClinicalTrials.gov`, h("span", { class: "visually-hidden" }, ` (${c.name})`))
    : null;
  if (!r) {
    return h(
      "article",
      { class: `story-card is-missing tone-${toneName}` },
      conditionLabel ? h("p", { class: "story-card__cond" }, h("span", { class: "swatch", "aria-hidden": "true" }), conditionLabel) : null,
      h("h3", { class: "story-card__name" }, c.name),
      c.oneLiner ? h("p", { class: "story-card__text" }, c.oneLiner) : null,
      h(
        "p",
        { class: "story-card__missing", role: "note" },
        validId
          ? `This trial (${c.id}) is not in the current data, so its status, phase and sponsor cannot be shown. It may have been withdrawn, merged or re-labelled since this story was written.`
          : `The trial ID for this card is not valid, so it cannot be looked up.`,
      ),
      link ? h("p", {}, link) : null,
    );
  }

  const group = statusGroup(r.status);
  const statusText = lookup(STATUS_TEXT, r.status) ?? (r.status ? uc(String(r.status).toLowerCase().replace(/_/g, " ")) : "Status not given");
  const phase = r.type === "OBSERVATIONAL" ? "Observational study" : phaseGroup(r) === "Not phased" ? "Phase not applicable" : phaseGroup(r);
  const startD = parseDate(r.start);
  const facts = [
    ["Sponsor", r.sponsor || "Not given"],
    [startD && startD > today ? "Planned start" : "Started", listingDate(r.start) ?? "Not given"],
    ["Participants", typeof r.enrollment === "number" ? fmt(r.enrollment) : "Not given"],
    [
      "Primary completion",
      r.primaryCompletion
        ? `${listingDate(r.primaryCompletion)}${r.primaryCompletionType === "ESTIMATED" ? " (planned)" : r.primaryCompletionType === "ACTUAL" ? " (actual)" : ""}`
        : "Not given",
    ],
  ];
  const quiet = isQuiet(r, today, story.graceMonths);
  const updated = listingDate(r.lastUpdate, { day: true });
  return h(
    "article",
    { class: `story-card tone-${toneName}` },
    conditionLabel ? h("p", { class: "story-card__cond" }, h("span", { class: "swatch", "aria-hidden": "true" }), conditionLabel) : null,
    h(
      "p",
      { class: "story-card__tags" },
      h("span", { class: `pill story-pill status-${lookup(STATUS_KEY, group) ?? "unknown"}` }, statusText),
      h("span", { class: "story-phase" }, phase),
    ),
    h("h3", { class: "story-card__name" }, c.name),
    c.oneLiner ? h("p", { class: "story-card__text" }, c.oneLiner) : null,
    h(
      "dl",
      { class: "story-card__facts" },
      facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))),
    ),
    quiet
      ? h(
          "p",
          { class: "story-card__quiet", role: "note" },
          `Listing not updated: it still says it is recruiting, ${fmt(monthsOverdue(r, today))} months after its planned primary completion.`,
        )
      : null,
    r.title ? h("p", { class: "story-card__title" }, "Listed as: ", h("q", {}, r.title)) : null,
    h("p", { class: "story-card__foot" }, link, updated ? h("span", { class: "story-card__updated" }, `Listing updated ${updated}`) : null),
  );
}

function renderQuiet(ctx, datasets) {
  const { story, today, focus } = ctx;
  const grace = story.graceMonths;
  for (const el of document.querySelectorAll(".story-grace")) el.textContent = word(grace);
  const recAll = new Set();
  const quietAll = new Set();
  const rows = orderedSlugs(ctx, datasets).map((slug) => {
    const d = datasets.get(slug);
    const rec = d.records.filter((r) => statusGroup(r.status) === "Recruiting");
    const q = rec.filter((r) => isQuiet(r, today, grace));
    for (const r of rec) recAll.add(r.id);
    for (const r of q) quietAll.add(r.id);
    return { slug, label: d.label, rec, q, share: rec.length ? q.length / rec.length : null, tone: tone(ctx, slug) };
  });

  const n = datasets.size;
  fill(
    $("quiet-headline"),
    `Across the ${word(n)} conditions, `,
    num(fmt(quietAll.size)),
    ` of the ${fmt(recAll.size)} listings that say they are recruiting (${pct(recAll.size ? quietAll.size / recAll.size : null)}${oneIn(recAll.size ? quietAll.size / recAll.size : 0) ? `, about ${oneIn(quietAll.size / recAll.size)}` : ""}) are more than ${word(grace)} months past their planned primary completion date.`,
  );

  const solid = rows.filter((r) => r.rec.length >= MIN_LISTINGS).sort((a, b) => a.share - b.share);
  if (solid.length >= 2) {
    const lo = solid[0];
    const hi = solid[solid.length - 1];
    fill(
      $("quiet-body"),
      `Among conditions with at least ${word(MIN_LISTINGS)} recruiting listings, the share runs from ${pct(lo.share)} for ${lc(lo.label)} (${fmt(lo.q.length)} of ${fmt(lo.rec.length)}) to ${pct(hi.share)} for ${lc(hi.label)} (${fmt(hi.q.length)} of ${fmt(hi.rec.length)}).`,
    );
  }

  const fRow = rows.find((r) => r.slug === focus.slug);
  if (fRow) {
    const fl = uc(lc(fRow.label));
    const cardIds = new Set(story.cards.map((c) => c.id));
    if (fRow.rec.length === 0) {
      fill($("quiet-focus"), `${fl} has no listings that say they are recruiting.`);
    } else if (fRow.rec.length === 1) {
      const r = fRow.rec[0];
      const mo = monthsOverdue(r, today);
      const when = listingDate(r.primaryCompletion);
      const parts = [`${fl} has just one listing that says it is recruiting (`, trialLink(r.id, r.id), cardIds.has(r.id) ? ", one of the trials above). " : "). "];
      if (mo === null) parts.push("It gives no planned primary completion date.");
      else if (isQuiet(r, today, grace)) parts.push(`Its planned primary completion was ${when}, ${fmt(mo)} ${plural(mo, "month")} ago, so it counts as not updated.`);
      else if (mo < 0 || parseDate(r.primaryCompletion, { end: true }) > today) parts.push(`Its planned primary completion is ${when}, so it is not overdue.`);
      else parts.push(`Its planned primary completion was ${when}, within the ${word(grace)}-month allowance.`);
      fill($("quiet-focus"), ...parts);
    } else {
      fill($("quiet-focus"), `${fl} has ${word(fRow.rec.length)} listings that say they are recruiting; ${word(fRow.q.length)} of them ${fRow.q.length === 1 ? "is" : "are"} not updated.`);
    }
  }

  // Too few listings for a share: those rows say so in words, below the bars.
  const few = (r) => r.rec.length < MIN_LISTINGS;
  const chartRows = rows
    .slice()
    .sort((a, b) => few(a) - few(b) || (few(a) ? b.rec.length - a.rec.length : b.share - a.share || b.rec.length - a.rec.length))
    .map((r) => ({
      label: r.label,
      value: few(r) ? 0 : r.share,
      valueText: few(r)
        ? r.rec.length
          ? `${fmt(r.rec.length)} recruiting ${plural(r.rec.length, "listing")}: too few for a share`
          : "no recruiting listings"
        : `${pct(r.share)} · ${fmt(r.q.length)} of ${fmt(r.rec.length)}`,
      tone: r.tone,
      noBar: few(r),
    }));
  const nFew = chartRows.filter((r) => r.noBar).length;
  const aria = `Bar chart of the share of recruiting listings that are not updated: ${chartRows.map((r) => `${r.label} ${r.valueText}`).join(", ")}.`;
  mount($("quiet-chart"), (width) => hbarChart(chartRows, { width, max: 1, label: aria, track: true }));
  fill($("quiet-caption"), quietCaption(grace, today, nFew));
  numbersTable(
    $("quiet-table"),
    "Recruiting listings that are not updated, per condition",
    ["Condition", "Say they are recruiting", "Not updated", "Share"],
    rows.map((r) => [r.label, fmt(r.rec.length), fmt(r.q.length), r.rec.length ? pct(r.share) : "n/a"]),
  );
}

function quietCaption(grace, today, nFew = 0) {
  return [
    `Share of listings that say they are recruiting but are more than ${word(grace)} months past their planned primary completion date, as of ${longDate(today)}. Bars run from 0 to 100%.`,
    nFew ? ` ${nFew === 1 ? "A condition" : "Conditions"} with fewer than ${word(MIN_LISTINGS)} recruiting listings ${nFew === 1 ? "gets" : "get"} no bar, because a share of so few would mean little; the table below still counts ${nFew === 1 ? "it" : "them"}.` : "",
    ` Trials that name several of these conditions count under each; the total above counts each once.`,
  ].join("");
}

function renderExplore(ctx) {
  const chips = ctx.conds.map((c) =>
    h("li", {}, h("a", { class: "chip", href: `index.html?${new URLSearchParams({ q: c.label })}` }, c.label)),
  );
  fill($("explore-chips"), ...chips);
}

function renderMethod(ctx, datasets) {
  const rows = ctx.conds.map((c) => {
    const d = datasets.get(c.slug);
    return [c.label, d?.query ?? "not loaded", d ? fmt(d.records.length) : fmt(c.count), c.slug];
  });
  const container = $("method-table");
  if (!container) return;
  const table = h(
    "table",
    { class: "table table-compact story-method__table" },
    h("caption", { class: "visually-hidden" }, "Search term and data file for each condition"),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Condition"), h("th", { scope: "col" }, "Search term"), h("th", { scope: "col", class: "num" }, "Trials"), h("th", { scope: "col" }, "Data"))),
    h(
      "tbody",
      {},
      rows.map(([label, query, count, slug]) =>
        h(
          "tr",
          {},
          h("th", { scope: "row" }, label),
          h("td", {}, h("code", {}, query)),
          h("td", { class: "num" }, count),
          h("td", {}, SLUG_RE.test(slug) ? h("a", { href: `data/${slug}.json` }, "JSON", h("span", { class: "visually-hidden" }, ` data for ${label}`)) : ""),
        ),
      ),
    ),
  );
  container.replaceChildren(scrollBox(table, "Search term and data file for each condition"));
}

// ------------------------------------------------------------ main

function setStatus(text, { error = false } = {}) {
  const el = $("story-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", error);
  el.hidden = !text;
}

async function main() {
  const [story, index] = await Promise.all([loadStory(), loadIndex().catch((err) => ({ error: err }))]);
  if (index.error) {
    setStatus(`${index.error.message} The story needs this data to show its numbers.`, { error: true });
    return;
  }
  const conds = index.conditions.filter((c) => c && typeof c.slug === "string" && SLUG_RE.test(c.slug) && typeof c.label === "string" && Number.isFinite(c.count));
  const focus = conds.find((c) => c.slug === story.focus);
  if (!focus) {
    setStatus("The condition this story is about is missing from the data, so the story cannot be shown.", { error: true });
    return;
  }
  const comparison = conds.find((c) => c.slug === story.comparison && c.slug !== focus.slug) ?? null;
  const top = [...conds].sort((a, b) => b.count - a.count)[0];
  const ctx = { story, index, conds, focus, comparison, top, today: dataDay(index.fetched) };

  renderIntro(ctx);
  renderCount(ctx);
  renderExplore(ctx);
  renderMethod(ctx, new Map());
  // Hold the space of the charts that wait for the big data files.
  renderTimePlaceholder(ctx);
  renderQuietPlaceholder(ctx);
  pending($("new-headline"), "Loading the trials…");

  setStatus(`Loading the trial data for ${word(conds.length)} conditions…`);
  const datasets = new Map();
  const failures = [];
  let settled = 0;
  const loads = conds.map((c) =>
    loadPrebuilt(c.slug)
      .then((d) => {
        datasets.set(c.slug, { ...d, label: c.label });
      })
      .catch((err) => {
        failures.push({ cond: c, err });
      })
      .finally(() => {
        settled += 1;
        if (settled < conds.length) setStatus(`Loading the trial data: ${word(settled)} of ${word(conds.length)} conditions loaded…`);
      }),
  );

  // Sections about the two main conditions can draw as soon as both arrive.
  const pair = [focus.slug, comparison?.slug].filter(Boolean);
  await Promise.all(loads.filter((_, i) => pair.includes(conds[i].slug)));
  const fData = datasets.get(focus.slug);
  const cData = comparison ? datasets.get(comparison.slug) : null;
  if (fData) renderQuote(ctx, fData);
  if (fData && cData) renderTested(ctx, fData, cData);
  // The cards come from these two conditions, so they can draw now too;
  // if any is missing, they draw again once every file is in.
  const early = new Map(pair.filter((slug) => datasets.has(slug)).map((slug) => [slug, datasets.get(slug)]));
  const cardsDone = renderNew(ctx, early);

  await Promise.all(loads);
  // Keep the index order so charts and tables are stable.
  const ordered = new Map(conds.filter((c) => datasets.has(c.slug)).map((c) => [c.slug, datasets.get(c.slug)]));
  if (ordered.has(focus.slug)) {
    renderTime(ctx, ordered);
    renderQuiet(ctx, ordered);
  } else {
    for (const id of ["time-headline", "quiet-headline"]) fill($(id), "The data for this section could not be loaded.");
    for (const id of ["time-chart", "quiet-chart"]) mount($(id), () => document.createTextNode(""));
  }
  if (!cardsDone) renderNew(ctx, ordered);
  renderMethod(ctx, ordered);

  if (failures.length) {
    setStatus(
      `The data for ${listText(failures.map((f) => lc(f.cond.label)))} could not be loaded, so the charts below leave ${failures.length === 1 ? "it" : "them"} out. ${failures[0].err.message}`,
      { error: true },
    );
  } else {
    setStatus("");
  }
}

main().catch((err) => {
  setStatus(`Something went wrong while building this page: ${err?.message ?? err}`, { error: true });
});
