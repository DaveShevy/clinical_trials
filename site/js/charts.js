// Chart builders for the explorer. Each chart export has the shape
// (data, {width, ...options}) => HTMLElement and draws with Observable Plot
// (the global `Plot`, loaded from vendor/ before the module scripts).
//
// Colours are CSS custom properties defined in css/style.css, so the same
// rendered chart is correct in light and dark mode. The three categorical
// palettes below are the only place category -> colour is decided; reuse
// them everywhere a phase, status or sponsor group is shown.
//
// Plot writes every string as SVG text, so names from the data are escaped.
// The few HTML pieces built here (legends) use textContent only.

import { PHASE_ORDER, STATUS_ORDER, SPONSOR_ORDER } from "./analyze.js";

/* global Plot, topojson */

// ------------------------------------------------------------------ palettes

// Eight phase groups are too many shades of one hue to tell apart in a
// stack, so charts colour four ordinal bands plus "Not phased". The tables
// and tooltips keep all eight groups. Combined phases count under the lower
// one: phase 1/2 under phase 1, phase 2/3 under phase 2.
export const PHASE_BANDS = Object.freeze(["Phase 1 or earlier", "Phase 2", "Phase 3", "Phase 4", "Not phased"]);
export const PHASE_BAND_OF = Object.freeze({
  "Early phase 1": "Phase 1 or earlier",
  "Phase 1": "Phase 1 or earlier",
  "Phase 1/2": "Phase 1 or earlier",
  "Phase 2": "Phase 2",
  "Phase 2/3": "Phase 2",
  "Phase 3": "Phase 3",
  "Phase 4": "Phase 4",
  "Not phased": "Not phased",
});

export const PHASE_COLORS = Object.freeze({
  "Phase 1 or earlier": "var(--c-phase-1)",
  "Phase 2": "var(--c-phase-2)",
  "Phase 3": "var(--c-phase-3)",
  "Phase 4": "var(--c-phase-4)",
  "Not phased": "var(--c-phase-np)",
});

export const STATUS_COLORS = Object.freeze({
  Recruiting: "var(--c-status-recruiting)",
  "Active, not recruiting": "var(--c-status-active)",
  Completed: "var(--c-status-completed)",
  "Stopped early": "var(--c-status-stopped)",
  Unknown: "var(--c-status-unknown)",
});

/** Text colour for a label drawn inside a status fill (AA contrast in both modes). */
export const STATUS_INK = Object.freeze({
  Recruiting: "var(--on-status-recruiting)",
  "Active, not recruiting": "var(--on-status-active)",
  Completed: "var(--on-status-completed)",
  "Stopped early": "var(--on-status-stopped)",
  Unknown: "var(--on-status-unknown)",
});

export const SPONSOR_COLORS = Object.freeze({
  Industry: "var(--c-sponsor-industry)",
  "Government & public bodies": "var(--c-sponsor-gov)",
  "Universities, hospitals & other": "var(--c-sponsor-other)",
});

export const SINGLE_COLOR = "var(--c-single)";
export const MAP_DOT_COLOR = "var(--c-map-dot)";

const GRID = "var(--grid)";
const AXIS = "var(--axis)";
const SURFACE = "var(--bg)";

// ------------------------------------------------------------------ format

const intFmt = new Intl.NumberFormat("en-US");

/** 1234 -> "1,234". */
export function formatCount(n) {
  return intFmt.format(n);
}

/** 0.4906 -> "49%"; tiny non-zero shares read "<1%" rather than "0%". */
export function formatShare(share) {
  if (share == null || !Number.isFinite(share)) return "–";
  if (share > 0 && share < 0.005) return "<1%";
  if (share < 1 && share > 0.995) return ">99%";
  return `${Math.round(share * 100)}%`;
}

function plural(n, one, many = `${one}s`) {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

// ------------------------------------------------------------------ small DOM helpers

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A legend as an HTML list. items: [{label, color, value?, shape?}].
 * shape "rect" (default, for bars), "dot" (for points) or "ring" (hollow points).
 */
export function legend(items, { stacked = false, label } = {}) {
  const ul = h("ul", stacked ? "legend legend-stacked" : "legend");
  if (label) ul.setAttribute("aria-label", label);
  for (const item of items) {
    const li = h("li", "legend-item");
    const sw = h("span", item.shape === "dot" ? "swatch swatch-dot" : item.shape === "ring" ? "swatch swatch-dot swatch-ring" : "swatch");
    sw.style.setProperty("--swatch", item.color);
    sw.setAttribute("aria-hidden", "true");
    li.append(sw);
    if (item.value != null) {
      const text = h("span");
      text.append(h("span", "legend-value", item.value), document.createTextNode(` ${item.label}`));
      li.append(text);
    } else {
      li.append(h("span", null, item.label));
    }
    ul.append(li);
  }
  return ul;
}

// Plot's SVG holds many small groups ("bar", "rule", tick labels); role="img"
// makes assistive technology read its aria-label summary instead.
function wrap(...children) {
  const div = h("div", "chart-body");
  for (const child of children.filter(Boolean)) {
    if (child instanceof SVGSVGElement && child.hasAttribute("aria-label")) child.setAttribute("role", "img");
    div.append(child);
  }
  return div;
}

function integerTicks(max, count) {
  if (!(max > 0)) return [0];
  const ticks = globalThis.d3.ticks(0, max, count).filter(Number.isInteger);
  return ticks.length ? ticks : [0, max];
}

// Bottom axis whose first and last labels are anchored inside the frame, so
// they never poke past the chart's edges (which would cause sideways scroll).
function edgeAwareAxisX(ticks, max, tickFormat) {
  const opts = { tickFormat, tickSize: 0, tickPadding: 8, label: null };
  const first = ticks.filter((t) => t === 0);
  const last = ticks.filter((t) => t === max && t !== 0);
  const middle = ticks.filter((t) => t !== 0 && t !== max);
  return [
    first.length ? Plot.axisX(first, { ...opts, textAnchor: "start" }) : null,
    middle.length ? Plot.axisX(middle, opts) : null,
    last.length ? Plot.axisX(last, { ...opts, textAnchor: "end" }) : null,
  ].filter(Boolean);
}

// Approximate rendered width of a label at 12px system sans, for layout.
function textWidth(s, px = 12) {
  return String(s).length * px * 0.56;
}

// ------------------------------------------------------------------ 2. trials started per year

/** First year the start-year axis needs to show (see startsChart). */
export const AXIS_FROM = 2000;

/**
 * The first year to draw. ClinicalTrials.gov opened in 2000; older trials
 * were registered later, a handful a year, and drawing them can leave half
 * the chart empty. Start at 2000 unless more than a tenth of the dated
 * trials started before it. rows: startsByYear().rows.
 */
export function startsAxisFrom(rows) {
  if (rows.length === 0) return null;
  const minYear = Math.min(...rows.map((r) => r.year));
  const maxYear = Math.max(...rows.map((r) => r.year));
  if (minYear >= AXIS_FROM || maxYear < AXIS_FROM) return minYear;
  const total = rows.reduce((s, r) => s + r.count, 0);
  const before = rows.filter((r) => r.year < AXIS_FROM).reduce((s, r) => s + r.count, 0);
  return before / total <= 0.1 ? AXIS_FROM : minYear;
}

/**
 * Stacked columns: trials started per year, by phase band (PHASE_BANDS).
 * data: {rows: [{year, phase, count}] from startsByYear, today: Date, from?: year}
 * Years before `from` are not drawn (the caller says so). The current year
 * (not over yet) and later years (planned starts) are drawn lighter.
 */
export function startsChart({ rows: phaseRows, today, from }, { width }) {
  const d3 = globalThis.d3;
  const fromYear = from ?? d3.min(phaseRows, (r) => r.year);
  const shownRows = phaseRows.filter((r) => r.year >= fromYear);
  // Collapse the eight phase groups into bands, keeping the detail for the tooltip.
  const bandMap = new Map();
  for (const r of shownRows) {
    const band = PHASE_BAND_OF[r.phase] ?? "Not phased";
    const key = `${r.year}|${band}`;
    const row = bandMap.get(key) ?? { year: r.year, band, count: 0, detail: [] };
    row.count += r.count;
    row.detail.push(r);
    bandMap.set(key, row);
  }
  const rows = [...bandMap.values()];
  const years = rows.map((r) => r.year);
  const minYear = d3.min(years);
  const maxYear = d3.max(years);
  const domain = d3.range(minYear, maxYear + 1);
  const totals = d3.rollup(rows, (v) => d3.sum(v, (d) => d.count), (d) => d.year);
  const maxTotal = d3.max(totals.values());
  const thisYear = today.getUTCFullYear();

  const narrow = width < 520;
  // Short charts for tiny counts, so two trials do not look like a lot.
  const height = Math.min(narrow ? 240 : 320, 140 + maxTotal * 40);
  const marginLeft = Math.max(28, textWidth(formatCount(maxTotal)) + 12);
  const marginRight = 16;
  const marginTop = 26;
  const marginBottom = 30;
  const plotW = width - marginLeft - marginRight;
  const step = plotW / domain.length;
  // At least a 2px gap between columns, and columns no wider than 28px.
  const padding = Math.min(0.85, Math.max(0.08, 2 / step, 1 - 28 / step));
  const tickEvery = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => s * step >= 44) ?? 100;
  const ticks = domain.filter((y) => y % tickEvery === 0);
  if (ticks.length === 0) ticks.push(minYear);
  const pxPerTrial = (height - marginTop - marginBottom) / maxTotal;
  // A thin surface-coloured gap between stacked segments where they are tall enough.
  const inset = pxPerTrial >= 5 ? 0.75 : 0;

  // Label the busiest year (each of them if up to three tie).
  const peakYears = domain.filter((y) => totals.get(y) === maxTotal);
  // Tied peaks too close together for two labels get one, on the latest.
  let labelled = peakYears.length <= 3 ? peakYears : peakYears.slice(-1);
  labelled = labelled.filter((y, i) => i === labelled.length - 1 || (labelled[i + 1] - y) * step >= 36);
  const peaks = labelled.map((year) => ({ year, total: maxTotal }));
  const anchorFor = (year) => {
    const i = domain.indexOf(year);
    return i < domain.length * 0.08 ? "start" : i > domain.length * 0.92 ? "end" : "middle";
  };
  const tipText = (d) => {
    const lines = [`${d.year}${d.year > thisYear ? " (planned)" : d.year === thisYear ? " (so far)" : ""}`, `${d.band}: ${plural(d.count, "trial")}`];
    if (d.detail.length > 1 || d.detail[0]?.phase !== d.band) {
      for (const r of d.detail) lines.push(`  ${r.phase}: ${formatCount(r.count)}`);
    }
    lines.push(`All phases: ${plural(totals.get(d.year), "trial")}`);
    return lines.join("\n");
  };

  const svg = Plot.plot({
    width,
    height,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    ariaLabel: `Column chart of trials started each year from ${minYear} to ${maxYear}, by phase. The most trials started in one year was ${formatCount(maxTotal)}, in ${peakYears.join(" and ")}.`,
    x: { type: "band", domain, padding },
    y: { domain: [0, maxTotal] },
    color: { domain: PHASE_BANDS, range: PHASE_BANDS.map((p) => PHASE_COLORS[p]) },
    marks: [
      Plot.gridY(integerTicks(maxTotal, narrow ? 4 : 5), { stroke: GRID, strokeOpacity: 1 }),
      Plot.axisX({ ticks, tickFormat: (d) => String(d), tickSize: 0, tickPadding: 8, label: null }),
      Plot.axisY({ ticks: integerTicks(maxTotal, narrow ? 4 : 5), tickFormat: (d) => formatCount(d), tickSize: 0, tickPadding: 6, label: null }),
      Plot.barY(rows, {
        x: "year",
        y: "count",
        fill: "band",
        order: PHASE_BANDS,
        insetTop: inset,
        insetBottom: inset,
        fillOpacity: (d) => (d.year >= thisYear ? 0.45 : 1),
        title: tipText,
        tip: { fill: "var(--tip-bg)" },
      }),
      Plot.ruleY([0], { stroke: AXIS }),
      ...["start", "middle", "end"].map((anchor) =>
        Plot.text(
          peaks.filter((d) => anchorFor(d.year) === anchor),
          {
            x: "year",
            y: "total",
            text: (d) => formatCount(d.total),
            dy: -6,
            lineAnchor: "bottom",
            textAnchor: anchor,
            fill: "var(--ink)",
            fontWeight: 650,
          },
        ),
      ),
    ],
  });
  return wrap(axisTitle("Trials started per year"), svg);
}

function axisTitle(text) {
  return h("p", "chart-axis-title", text);
}

/** Legend for the phase band colours (in stack order, bottom first). */
export function phaseLegend(bands = PHASE_BANDS) {
  return legend(bands.map((p) => ({ label: p, color: PHASE_COLORS[p] })), { label: "Phase" });
}

/** Legend for the status colours. */
export function statusLegend(statuses = STATUS_ORDER) {
  return legend(statuses.map((s) => ({ label: s, color: STATUS_COLORS[s] })), { label: "Status" });
}

/** Legend for the sponsor colours. */
export function sponsorLegend(groups = SPONSOR_ORDER) {
  return legend(groups.map((g) => ({ label: g, color: SPONSOR_COLORS[g] })), { label: "Lead sponsor type" });
}

// ------------------------------------------------------------------ labelled horizontal bars

// Rows of horizontal bars with the name above each bar and the value at its
// end: reads well at 360px and at full width, with no label truncation for
// typical names (long ones are cut with an ellipsis; the tooltip and table
// keep the full name).
function labelledBars(rows, { width, label, value, fill, valueText, title, ariaLabel, rowHeight = 40, barHeight = 14 }) {
  const maxValue = Math.max(1, ...rows.map(value));
  const maxValueText = Math.max(...rows.map((r) => textWidth(valueText(r))));
  const marginRight = Math.ceil(maxValueText + 10);
  const height = rows.length * rowHeight;
  const labelTop = rowHeight - barHeight - 4; // space above the bar for the name
  const centre = rowHeight / 2;
  const barCentre = labelTop + barHeight / 2;
  const lineWidth = Math.max(8, (width - 4) / 13); // ems available for the name (13px text)

  return Plot.plot({
    width,
    height,
    marginLeft: 0,
    marginRight,
    marginTop: 0,
    marginBottom: 0,
    ariaLabel,
    x: { domain: [0, maxValue], axis: null },
    y: { domain: rows.map(label), axis: null, padding: 0 },
    marks: [
      Plot.barX(rows, {
        x: value,
        y: label,
        fill,
        insetTop: labelTop,
        insetBottom: rowHeight - labelTop - barHeight,
        rx2: 3,
      }),
      Plot.text(rows, {
        x: 0,
        y: label,
        text: label,
        textAnchor: "start",
        lineAnchor: "bottom",
        dy: labelTop - 7 - centre,
        lineWidth,
        textOverflow: "ellipsis",
        fill: "var(--ink)",
        fontSize: 13,
      }),
      Plot.text(rows, {
        x: value,
        y: label,
        text: valueText,
        textAnchor: "start",
        dx: 6,
        dy: barCentre - centre,
        fill: "var(--ink-2)",
        fontWeight: 600,
      }),
      Plot.tip(rows, Plot.pointerY({ x: value, y: label, title, fill: "var(--tip-bg)", anchor: "bottom" })),
    ],
  });
}

// ------------------------------------------------------------------ 3. how far trials get

/** Rows with fewer trials than this get counts ("1 of 2") rather than shares, and a "few trials" mark. */
export const FEW_TRIALS = 10;

/**
 * One row per phase group (interventional trials), segments by status group.
 * data: [{phase, status, count}] from phaseByStatus.
 * mode "share" (default) draws 100% bars; "count" draws numbers of trials.
 */
export function phaseStatusChart(rows, { width, mode = "share" }) {
  const d3 = globalThis.d3;
  const phases = PHASE_ORDER.filter((p) => rows.some((r) => r.phase === p));
  const totals = d3.rollup(rows, (v) => d3.sum(v, (d) => d.count), (d) => d.phase);
  const maxTotal = d3.max(totals.values());
  const share = mode === "share";
  const rowHeight = 48;
  const barHeight = 18;
  const labelTop = rowHeight - barHeight - 6;
  const centre = rowHeight / 2;
  const marginBottom = 28;
  const marginRight = 12;
  const plotW = width - marginRight;
  const height = phases.length * rowHeight + marginBottom;

  // Direct labels on every segment wide enough for its text. In share mode a
  // row with few trials is labelled with counts ("1 of 2"), since a share of
  // two trials says little.
  const placed = [];
  for (const p of phases) {
    let x0 = 0;
    const t = totals.get(p);
    for (const s of STATUS_ORDER) {
      const r = rows.find((d) => d.phase === p && d.status === s);
      if (!r) continue;
      const frac = r.count / t;
      const w = share ? frac * plotW : (r.count / maxTotal) * plotW;
      const options = share
        ? t < FEW_TRIALS ? [`${formatCount(r.count)} of ${formatCount(t)}`, formatCount(r.count)] : [formatShare(frac)]
        : [formatCount(r.count)];
      const text = options.find((o) => w >= textWidth(o, 11.5) + 10);
      if (text) placed.push({ ...r, text, mid: share ? x0 + frac / 2 : x0 + r.count / 2 });
      x0 += share ? frac : r.count;
    }
  }
  const all = d3.sum(rows, (d) => d.count);
  const completed = d3.sum(rows.filter((d) => d.status === "Completed"), (d) => d.count);
  const stopped = d3.sum(rows.filter((d) => d.status === "Stopped early"), (d) => d.count);
  const xTicks = share ? [0, 0.25, 0.5, 0.75, 1] : integerTicks(maxTotal, width < 520 ? 4 : 6);
  const xMax = share ? 1 : maxTotal;

  const svg = Plot.plot({
    width,
    height,
    marginLeft: 1,
    marginRight,
    marginTop: 0,
    marginBottom,
    ariaLabel: `Bar chart of interventional trials in each phase, split by status${share ? ", as shares of each phase" : ""}. Of all ${plural(all, "interventional trial")}, ${formatShare(completed / all)} completed and ${formatShare(stopped / all)} stopped early.`,
    x: { domain: [0, xMax] },
    y: { domain: phases, axis: null, padding: 0 },
    color: { domain: STATUS_ORDER, range: STATUS_ORDER.map((s) => STATUS_COLORS[s]) },
    marks: [
      Plot.gridX(xTicks, { stroke: GRID, strokeOpacity: 1, insetTop: 0 }),
      ...edgeAwareAxisX(xTicks, xMax, share ? (d) => `${Math.round(d * 100)}%` : (d) => formatCount(d)),
      Plot.barX(
        rows,
        Plot.stackX({
          x: "count",
          y: "phase",
          fill: "status",
          order: STATUS_ORDER,
          offset: share ? "normalize" : null,
          insetTop: labelTop,
          insetBottom: rowHeight - labelTop - barHeight,
          insetLeft: 0.75,
          insetRight: 0.75,
          title: (d) => {
            const t = totals.get(d.phase);
            return `${d.phase} · ${d.status}\n${plural(d.count, "trial")} of ${formatCount(t)} (${formatShare(d.count / t)})`;
          },
          tip: { fill: "var(--tip-bg)" },
        }),
      ),
      Plot.text(placed, {
        x: "mid",
        y: "phase",
        text: "text",
        dy: labelTop + barHeight / 2 - centre,
        fill: (d) => STATUS_INK[d.status],
        fontSize: 11.5,
        fontWeight: 650,
        pointerEvents: "none",
      }),
      Plot.text(phases, {
        y: (d) => d,
        frameAnchor: "left",
        text: (p) => `${p}  ·  ${plural(totals.get(p), "trial")}${share && totals.get(p) < FEW_TRIALS ? "  ·  few trials" : ""}`,
        lineWidth: Math.max(10, (width - 4) / 13),
        textOverflow: "ellipsis",
        textAnchor: "start",
        lineAnchor: "bottom",
        dy: labelTop - 7 - centre,
        fill: "var(--ink)",
        fontSize: 13,
      }),
    ],
  });
  return wrap(svg);
}

// ------------------------------------------------------------------ 4. who pays

/** Top lead sponsors, coloured by sponsor group. data: topSponsors().rows */
export function sponsorsChart(rows, { width }) {
  return wrap(
    labelledBars(rows, {
      width,
      label: (d) => d.sponsor,
      value: (d) => d.count,
      fill: (d) => SPONSOR_COLORS[d.group],
      valueText: (d) => formatCount(d.count),
      title: (d) => `${d.sponsor}\n${d.group}\n${plural(d.count, "trial")} as lead sponsor`,
      ariaLabel: `Bar chart of the ${rows.length} lead sponsors with the most trials. ${rows[0]?.sponsor ?? ""} leads with ${plural(rows[0]?.count ?? 0, "trial")}.`,
    }),
  );
}

/** The sponsor mix as one 100% bar. data: sponsorMix() */
export function sponsorMixChart(mix, { width }) {
  const rows = mix.filter((d) => d.count > 0);
  const svg = Plot.plot({
    width,
    height: 22,
    margin: 0,
    ariaLabel: `Share of trials by lead sponsor type: ${mix.map((d) => `${d.group} ${formatShare(d.share)}`).join(", ")}.`,
    x: { domain: [0, 1], axis: null },
    y: { axis: null },
    color: { domain: SPONSOR_ORDER, range: SPONSOR_ORDER.map((g) => SPONSOR_COLORS[g]) },
    marks: [
      Plot.barX(
        rows,
        Plot.stackX({
          x: "share",
          fill: "group",
          order: SPONSOR_ORDER,
          insetLeft: 1,
          insetRight: 1,
          title: (d) => `${d.group}\n${plural(d.count, "trial")} (${formatShare(d.share)})`,
          tip: { fill: "var(--tip-bg)" },
        }),
      ),
    ],
  });
  const key = legend(
    mix.map((d) => ({
      label: `${d.group} (${plural(d.count, "trial")})`,
      value: formatShare(d.share),
      color: SPONSOR_COLORS[d.group],
    })),
    { stacked: width < 640, label: "Lead sponsor type" },
  );
  return wrap(svg, key);
}

// ------------------------------------------------------------------ 5. where you could take part

let worldCache = null;

/** Turn the world-atlas topology into land shapes (without Antarctica) and borders, once. */
export function prepareWorld(topology) {
  if (worldCache && worldCache.topology === topology) return worldCache;
  const countries = topojson.feature(topology, topology.objects.countries);
  const land = { type: "FeatureCollection", features: countries.features.filter((f) => f.id !== "010") };
  const borders = topojson.mesh(topology, topology.objects.countries, (a, b) => a !== b);
  worldCache = { topology, land, borders };
  return worldCache;
}

/** Dot radius for one trial and the largest dot, from the map's width (not the data). */
function dotScale(width) {
  const unitR = Math.max(1.5, Math.min(4, width / 250));
  const maxR = Math.max(6, Math.min(16, width / 45));
  return (n) => Math.min(maxR, unitR * Math.sqrt(n));
}

/**
 * World map (Equal Earth) of recruiting sites, dots sized by the number of
 * trials at each place. Filled dots: at least one trial there is recruiting
 * now; rings: only not yet recruiting, or enrolling by invitation.
 * data: {points, world} where world is the countries-110m topology.
 */
export function mapChart({ points, world }, { width }) {
  const { land, borders } = prepareWorld(world);
  // Dot area is proportional to trials on a scale that depends only on the
  // map's width (not rescaled to the busiest place), so maps of different
  // conditions compare honestly; big conditions do not become solid blobs on
  // a phone.
  const radius = dotScale(width);
  const shown = points.filter((p) => p.lat > -60);
  const open = shown.filter((p) => p.recruitingNow !== 0);
  const notYet = shown.filter((p) => p.recruitingNow === 0);
  const busiest = shown.reduce((a, p) => (!a || p.trials > a.trials ? p : a), null);
  const label = busiest && busiest.trials > 1 && busiest.city ? [busiest] : [];
  const title = (d) =>
    `${[d.city, d.country].filter(Boolean).join(", ") || "Unnamed place"}\n${plural(d.trials, "trial")} recruiting or about to` +
    (d.recruitingNow === 0 ? "\nNone recruiting yet: not yet recruiting or by invitation only" : d.recruitingNow < d.trials ? `\n${formatCount(d.recruitingNow)} recruiting now` : "");
  const svg = Plot.plot({
    width,
    projection: { type: "equal-earth", domain: land, inset: 2 },
    ariaLabel: `World map of ${plural(points.length, "place")} where trials say they are recruiting${busiest ? `; the busiest, ${[busiest.city, busiest.country].filter(Boolean).join(", ")}, has ${plural(busiest.trials, "trial")}` : ""}. Larger dots mean more trials.`,
    r: { type: "identity" },
    marks: [
      Plot.geo(land, { fill: "var(--c-map-land)" }),
      Plot.geo(borders, { stroke: "var(--c-map-border)", strokeWidth: 0.6 }),
      Plot.dot(notYet, {
        x: "lon",
        y: "lat",
        r: (d) => radius(d.trials),
        fill: "none",
        stroke: MAP_DOT_COLOR,
        strokeWidth: 1.25,
      }),
      Plot.dot(open, {
        x: "lon",
        y: "lat",
        r: (d) => radius(d.trials),
        fill: MAP_DOT_COLOR,
        fillOpacity: 0.8,
        stroke: SURFACE,
        strokeWidth: 0.75,
      }),
      Plot.text(label, {
        x: "lon",
        y: "lat",
        text: (d) => d.city,
        dy: label.length ? -radius(label[0].trials) - 7 : 0,
        fill: "var(--ink)",
        stroke: SURFACE,
        strokeWidth: 3,
        paintOrder: "stroke",
        fontWeight: 650,
        fontSize: 12,
      }),
      Plot.tip(shown, Plot.pointer({ x: "lon", y: "lat", title, fill: "var(--tip-bg)", maxRadius: 24 })),
    ],
  });
  const maxTrials = Math.max(1, ...points.map((p) => p.trials));
  return wrap(svg, sizeKey(maxTrials, radius));
}

// A key for dot sizes: one, a middle value and the largest number of trials.
function sizeKey(max, radius) {
  const mid = [2, 5, 10, 25, 50, 100, 250, 500].filter((v) => v <= max / 2).pop();
  const values = [1, mid, max > 1 ? max : null].filter(Boolean);
  const NS = "http://www.w3.org/2000/svg";
  const key = h("div", "size-key");
  key.append(h("span", "size-key-label", "Trials at a place"));
  for (const v of values) {
    const r = radius(v);
    const item = h("span", "size-key-item");
    const svg = document.createElementNS(NS, "svg");
    const size = Math.ceil(r * 2 + 2);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("aria-hidden", "true");
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", size / 2);
    c.setAttribute("cy", size / 2);
    c.setAttribute("r", r);
    c.setAttribute("fill", MAP_DOT_COLOR);
    c.setAttribute("fill-opacity", "0.8");
    svg.append(c);
    item.append(svg, h("span", null, formatCount(v)));
    key.append(item);
  }
  return key;
}

// ------------------------------------------------------------------ 6. what gets tested

/** Trials per intervention type. data: interventionTypes(); total: trials in the set. */
export function interventionTypesChart(rows, { width, total }) {
  return wrap(
    labelledBars(rows, {
      width,
      label: (d) => d.label,
      value: (d) => d.count,
      fill: SINGLE_COLOR,
      valueText: (d) => `${formatCount(d.count)} · ${formatShare(d.count / total)}`,
      title: (d) => `${d.label}\n${plural(d.count, "trial")} (${formatShare(d.count / total)} of ${formatCount(total)})`,
      ariaLabel: `Bar chart of trials by type of intervention. ${rows[0]?.label ?? ""} is the most common, in ${plural(rows[0]?.count ?? 0, "trial")}.`,
    }),
  );
}

/** Named interventions in the most trials. data: topInterventions().rows */
export function topInterventionsChart(rows, { width }) {
  return wrap(
    labelledBars(rows, {
      width,
      label: (d) => d.name,
      value: (d) => d.count,
      fill: SINGLE_COLOR,
      valueText: (d) => formatCount(d.count),
      title: (d) => `${d.name}\nNamed in ${plural(d.count, "trial")}${d.spellings > 1 ? `\nunder ${formatCount(d.spellings)} different names` : ""}`,
      ariaLabel: `Bar chart of the ${rows.length} named interventions in the most trials. ${rows[0]?.name ?? ""} is named in ${plural(rows[0]?.count ?? 0, "trial")}.`,
    }),
  );
}
