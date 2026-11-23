/* Migrant Homelessness Tracker
 * Reads data/data.json (built by pipeline/update_data.py) and renders every view
 * client-side. No build step: plain JS + d3.
 */
"use strict";

// ---------------------------------------------------------------- settings
const CONFIG = {
  author: "Leon Elliott",
  authorUrl: "",   // optional: a link for your name, e.g. a personal site or LinkedIn
  footerLine: "Built from official statistics. Figures update automatically when new data is published.",
};

const REGION_ORDER = ["E12000001", "E12000002", "E12000003", "E12000004", "E12000005",
  "E12000006", "E12000007", "E12000008", "E12000009"];
const ENGLAND = "E92000001";
const REST = "REST";
const LONDON = "E12000007";

const MEASURES = {
  total: { label: "Asylum leaver prevention + relief duties", short: "Asylum leaver duties", color: "var(--accent)" },
  prevention: { label: "Asylum leaver prevention duties", short: "Asylum leaver prevention", color: "var(--prevention)" },
  relief: { label: "Asylum leaver relief duties", short: "Asylum leaver relief", color: "var(--relief)" },
  rate: { label: "Homelessness duties per 100 people in asylum support", short: "Homelessness duties per 100 people in asylum support", color: "var(--accent)" },
};
const MEASURE_BUTTONS = [["total", "Prevention + Relief Duties"], ["prevention", "Prevention Duties"], ["relief", "Relief Duties"], ["rate", "Duties per 100 people in asylum support"]];

// ---------------------------------------------------------------- state
let D = null;          // the data
let Q = [];            // quarters (homelessness)
let LAS = [];          // current local authorities [{code,name,region}]
const $view = document.getElementById("view");
const $tip = document.getElementById("tooltip");

// ---------------------------------------------------------------- formatting
const fmtInt = d3.format(",");
const fmt = (v) => (v == null || Number.isNaN(v) ? "–" : fmtInt(Math.round(v)));
const fmtPct = (v, digits = 1) => (v == null || !isFinite(v) ? "–" : (v * 100).toFixed(digits) + "%");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const qShort = (q) => { const [y, n] = q.split("-Q"); return `Q${n} ${y}`; };
const qLong = (q) => { const [y, n] = q.split("-Q"); return `${["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][n - 1]} ${y}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mShort = (m) => { const [y, mm] = m.split("-"); return `${MONTHS[+mm - 1]} ${y}`; };
const mLong = (m) => { const [y, mm] = m.split("-"); return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+mm - 1]} ${y}`; };
const areaName = (c) => D.areas[c]?.name ?? c;
const regionName = (c) => D.areas[c]?.name ?? "";
const prevQ = (q, n = 1) => { let [y, k] = q.split("-Q").map(Number); k -= n; while (k < 1) { k += 4; y -= 1; } return `${y}-Q${k}`; };

function deltaSpan(cur, prev, { pct = true, abs = true, f = fmt } = {}) {
  if (cur == null || prev == null) return `<span class="flat">–</span>`;
  const d = cur - prev;
  const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "■";
  const parts = [];
  if (abs) parts.push((d > 0 ? "+" : d < 0 ? "−" : "±") + f(Math.abs(d)));
  if (pct && prev > 0) parts.push(((d / prev) * 100 > 0 ? "+" : (d / prev) * 100 < 0 ? "−" : "") + Math.abs(Math.round((d / prev) * 100)) + "%");
  const txt = abs && pct && parts.length === 2 ? `${parts[0]} (${parts[1]})` : parts.join(" ");
  return `<span class="${cls}" aria-label="${d > 0 ? "increase" : d < 0 ? "decrease" : "no change"}">${arrow} ${txt}</span>`;
}

// ---------------------------------------------------------------- data access
const H = () => D.homelessness;
const qi = (q) => Q.indexOf(q);
function hv(measure, code, q) {
  const s = H()[measure]?.[code];
  if (!s) return null;
  const i = qi(q);
  return i < 0 ? null : s[i];
}
// Sum of the last n quarters. Returns null if any quarter is missing, so a council
// that didn't submit for a quarter is never shown with an understated annual total.
const sumLast = (measure, code, q, n = 4) => {
  let t = 0;
  for (let k = 0; k < n; k++) { const v = hv(measure, code, prevQ(q, k)); if (v == null) return null; t += v; }
  return t;
};
const missingIn = (code, q, n = 4) => {
  const out = [];
  for (let k = n - 1; k >= 0; k--) { const pq = prevQ(q, k); if (hv("total", code, pq) == null && flagOf("total", code, pq)) out.push(pq); }
  return out;
};
const shareAll = (code, q) => {
  const t = hv("total", code, q), a = hv("total_all", code, q);
  return t != null && a ? t / a : null;
};
/** MHCLG marker for a missing value: "x" = missing data (the council did not submit,
 *  or its data had quality issues), "c" = suppressed to protect households, else null. */
const flagOf = (measure, code, q) => {
  const i = qi(q), F = (k) => H()[k]?.[code]?.[i] || null;
  if (measure === "prevention") return F("flags_prevention");
  if (measure === "relief") return F("flags_relief");
  return F("flags_prevention") || F("flags_relief") || F("flags_combined");
};
const FLAG_TEXT = { x: "missing: not submitted by the council", c: "suppressed by MHCLG" };
const FLAG_SHORT = { x: "not submitted", c: "suppressed" };
const splitQuarters = () => Q.slice(Q.indexOf(H().split_from));
const latestQ = () => Q[Q.length - 1];

function rsLatest(code) {
  const R = D.rough_sleeping, s = R.asylum[code];
  if (!s) return { value: null, month: null };
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return { value: s[i], month: R.months[i], prev: s[i - 1] };
  return { value: null, month: null };
}
function supportLatest(code) {
  const S = D.asylum_support, s = S.people[code];
  if (!s) return { value: null };
  const i = s.length - 1;
  return { value: s[i], quarter: S.quarters[i], prev: s[i - 4] };
}

// ---- Rates: households owed a duty per 100 people in asylum support.
// Denominator = people in asylum support in the area at the START of the quarter (end of
// the previous quarter), as that is the group who could be leaving support during it.
// Not shown where fewer than RATE_MIN_BASE people were in support: tiny bases give wild rates.
const RATE_MIN_BASE = 50;
function supportAt(code, q) {
  const S = D.asylum_support, i = S.quarters.indexOf(q);
  return i < 0 ? null : (S.people[code]?.[i] ?? 0);
}
function rateBase(code, q) { return supportAt(code, prevQ(q)); }
function rate(code, q, measure = "total") {
  const v = hv(measure, code, q), base = rateBase(code, q);
  if (v == null || base == null || base < RATE_MIN_BASE) return null;
  return (v / base) * 100;
}
// Year ending q: duties summed over the four quarters, divided by the average of the four
// start-of-quarter asylum support populations, x 100. Null if any quarter is missing or the
// average base is below RATE_MIN_BASE.
const avgBaseYear = (code, q) => {
  const b = [0, 1, 2, 3].map((k) => rateBase(code, prevQ(q, k)));
  return b.some((x) => x == null) ? null : d3.mean(b);
};
function rateYear(code, q) {
  const n = sumLast("total", code, q), base = avgBaseYear(code, q);
  if (n == null || base == null || base < RATE_MIN_BASE) return null;
  return (n / base) * 100;
}
// Prevention share: the % of duties that were prevention (help before homelessness) rather
// than relief (help once already homeless). Not shown for councils with fewer than
// PREV_MIN_BASE duties in the period, where one or two cases swing the percentage.
const PREV_MIN_BASE = 10;
function prevShare(code, q, year = false, all = false) {
  const [pm, rm] = all ? ["prevention_all", "relief_all"] : ["prevention", "relief"];
  const p = year ? sumLast(pm, code, q) : hv(pm, code, q), r = year ? sumLast(rm, code, q) : hv(rm, code, q);
  if (p == null || r == null || p + r === 0) return null;
  if (!all && D.areas[code]?.type === "la" && p + r < PREV_MIN_BASE) return null;
  return p / (p + r);
}
// Relief share: the % of asylum leaver duties that were relief (the household was already
// homeless) rather than prevention. The figure shown throughout the dashboard.
function reliefShare(code, q, year = false) {
  const v = prevShare(code, q, year);
  return v == null ? null : 1 - v;
}
// Share of ALL prevention (or relief) duties, for any reason, that were households leaving
// Home Office asylum accommodation. kind = "prevention" | "relief".
function shareOf(kind, code, q, year = false) {
  const ho = year ? sumLast(kind, code, q) : hv(kind, code, q);
  const all = year ? sumLast(kind + "_all", code, q) : hv(kind + "_all", code, q);
  return ho != null && all ? ho / all : null;
}
const yearLabel = (q) => { const [y, n] = q.split("-Q"); return `year ending ${["March", "June", "September", "December"][n - 1]} ${y}`; };
const yearShort = (q) => { const [y, n] = q.split("-Q"); return `${["Mar", "Jun", "Sep", "Dec"][n - 1]} ${y}`; };
const fmtRate = (v) => (v == null ? "–" : v < 10 ? v.toFixed(1) : Math.round(v).toString());

function rankLAs(measure, q, region = null) {
  return LAS.filter((a) => !region || a.region === region)
    .map((a) => ({ ...a, value: measure === "last4" ? sumLast("total", a.code, q) : measure === "rate" ? rate(a.code, q) : measure === "rate4" ? rateYear(a.code, q) : hv(measure, a.code, q) }))
    .filter((a) => a.value != null)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- tooltip
function showTip(html, ev) {
  $tip.innerHTML = html;
  $tip.hidden = false;
  const pad = 14, w = $tip.offsetWidth, h = $tip.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  $tip.style.left = Math.max(8, x) + "px";
  $tip.style.top = Math.max(8, y) + "px";
}
const hideTip = () => { $tip.hidden = true; };
const tipRow = (color, label, value) =>
  `<div class="t-row"><span>${color ? `<i class="key" style="background:${color}"></i>` : ""}${esc(label)}</span><b>${value}</b></div>`;

// ---------------------------------------------------------------- charts
function barPath(x, y, w, h, r = 4) {
  if (!(h > 0) || !(w > 0)) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function tickFmt(max) { return max >= 10000 ? d3.format("~s") : d3.format(","); }

/** Grouped column chart. series: [{name, color, values}] */
function columnChart(el, { labels, tipLabels, series, height = 280, yFormat = fmt, labelLast = true, onClick = null, valueSuffix = "" }) {
  el.innerHTML = "";
  const width = el.clientWidth || 600;
  const m = { t: 18, r: 6, b: 26, l: 40 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const max = d3.max(series.flatMap((s) => s.values.map((v) => v ?? 0))) || 1;
  const y = d3.scaleLinear().domain([0, max]).nice(5).range([ih, 0]);
  const x0 = d3.scaleBand().domain(labels.map((_, i) => i)).range([0, iw]).paddingInner(series.length > 1 ? 0.28 : 0.22).paddingOuter(0.1);
  const x1 = d3.scaleBand().domain(series.map((_, i) => i)).range([0, x0.bandwidth()]).paddingInner(series.length > 1 ? 0.06 : 0);
  const bw = Math.min(24, x1.bandwidth());
  const off = (x1.bandwidth() - bw) / 2;
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("height", height)
    .attr("role", "img").attr("aria-label", series.map((s) => s.name).join(", "));
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const tf = tickFmt(y.domain()[1]);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSize(-iw).tickFormat((v) => tf(v)))
    .call((a) => a.selectAll("text").attr("x", -6));
  g.append("line").attr("class", "baseline").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih);
  // x labels, thinned to fit
  const approx = 52;
  const every = Math.max(1, Math.ceil((labels.length * approx) / iw));
  g.append("g").selectAll("text").data(labels).join("text")
    .attr("x", (_, i) => x0(i) + x0.bandwidth() / 2).attr("y", ih + 17).attr("text-anchor", "middle")
    .text((d, i) => ((labels.length - 1 - i) % every === 0 ? d : ""));
  const hover = g.append("rect").attr("class", "hover-band").attr("y", 0).attr("height", ih).attr("width", x0.step()).style("display", "none");
  series.forEach((s, si) => {
    g.append("g").selectAll("path").data(s.values).join("path")
      .attr("d", (v, i) => (v == null ? "" : barPath(x0(i) + x1(si) + off, y(v), bw, ih - y(v))))
      .attr("fill", s.color);
  });
  // Mark quarters with no figure because of missing data, so a gap is never read as zero
  labels.forEach((_, i) => {
    const f = series.map((s) => (s.values[i] == null ? s.flags?.[i] : null));
    if (series.every((s, k) => s.values[i] == null && f[k])) {
      g.append("text").attr("class", "val").attr("x", x0(i) + x0.bandwidth() / 2).attr("y", ih - 6)
        .attr("text-anchor", "middle").style("font-size", "10px").style("fill", "var(--muted)").text("n/a");
    }
  });
  if (labelLast) {
    // Label the latest value. Grouped columns are too narrow for labels to sit side by
    // side, so for those the legend + tooltip carry the values instead.
    const i = labels.length - 1;
    const v = series[0].values[i];
    if (series.length === 1 && v != null) {
      g.append("text").attr("class", "val").attr("x", x0(i) + x0.bandwidth() / 2).attr("y", y(v) - 5)
        .attr("text-anchor", "middle").text(yFormat(v) + valueSuffix);
    }
  }
  g.append("g").selectAll("rect").data(labels).join("rect").attr("class", "hit")
    .attr("x", (_, i) => x0(i) - (x0.step() - x0.bandwidth()) / 2).attr("width", x0.step()).attr("y", 0).attr("height", ih)
    .on("mousemove", (ev, _d) => {
      const i = labels.indexOf(_d);
      hover.attr("x", x0(i) - (x0.step() - x0.bandwidth()) / 2).style("display", null);
      showTip(`<div class="t-title">${esc(tipLabels?.[i] ?? labels[i])}</div>` +
        series.map((s) => tipRow(s.color, s.name, s.values[i] == null ? (FLAG_SHORT[s.flags?.[i]] ?? "–") : yFormat(s.values[i]) + valueSuffix)).join("") +
        (series.length > 1 && series.every((s) => s.values[i] != null) ? tipRow(null, "Total", yFormat(d3.sum(series, (s) => s.values[i]))) : ""), ev);
    })
    .on("mouseleave", () => { hover.style("display", "none"); hideTip(); })
    .on("click", (ev, _d) => onClick && onClick(labels.indexOf(_d)));
}

/** Multi-line chart with crosshair. series: [{name, color, values}] */
function lineChart(el, { labels, tipLabels, series, height = 240, yFormat = fmt, yMax = null, yTickFormat = null }) {
  el.innerHTML = "";
  const width = el.clientWidth || 600;
  const m = { t: 14, r: 46, b: 26, l: 44 };
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const max = yMax ?? (d3.max(series.flatMap((s) => s.values.map((v) => v ?? 0))) || 1);
  const y = d3.scaleLinear().domain([0, max]).nice(5).range([ih, 0]);
  const x = d3.scalePoint().domain(labels.map((_, i) => i)).range([0, iw]);
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("height", height).attr("role", "img")
    .attr("aria-label", series.map((s) => s.name).join(", "));
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const tf = yTickFormat || tickFmt(y.domain()[1]);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickSize(-iw).tickFormat((v) => tf(v)))
    .call((a) => a.selectAll("text").attr("x", -6));
  g.append("line").attr("class", "baseline").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih);
  const every = Math.max(1, Math.ceil((labels.length * 56) / iw));
  g.append("g").selectAll("text").data(labels).join("text")
    .attr("x", (_, i) => x(i)).attr("y", ih + 17).attr("text-anchor", "middle")
    .text((d, i) => ((labels.length - 1 - i) % every === 0 ? d : ""));
  const line = d3.line().defined((v) => v != null).x((_, i) => x(i)).y((v) => y(v)).curve(d3.curveMonotoneX);
  series.forEach((s) => {
    g.append("path").attr("d", line(s.values)).attr("fill", "none").attr("stroke", s.color).attr("stroke-width", 2)
      .attr("stroke-linejoin", "round").attr("stroke-linecap", "round");
    let li = s.values.length - 1;
    while (li >= 0 && s.values[li] == null) li--;
    if (li >= 0) {
      g.append("circle").attr("cx", x(li)).attr("cy", y(s.values[li])).attr("r", 4).attr("fill", s.color)
        .attr("stroke", "var(--surface)").attr("stroke-width", 2);
      g.append("text").attr("class", "val").attr("x", x(li) + 8).attr("y", y(s.values[li]) + 4).text(yFormat(s.values[li]));
    }
  });
  const cross = g.append("line").attr("y1", 0).attr("y2", ih).attr("stroke", "var(--axis)").attr("opacity", 0);
  const dots = series.map((s) => g.append("circle").attr("r", 4).attr("fill", s.color).attr("stroke", "var(--surface)").attr("stroke-width", 2).attr("opacity", 0));
  g.append("rect").attr("class", "hit").attr("x", -10).attr("width", iw + 20).attr("height", ih)
    .on("mousemove", (ev) => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(mx / (x.step() || 1))));
      cross.attr("x1", x(i)).attr("x2", x(i)).attr("opacity", 1);
      series.forEach((s, k) => dots[k].attr("cx", x(i)).attr("cy", y(s.values[i] ?? 0)).attr("opacity", s.values[i] == null ? 0 : 1));
      showTip(`<div class="t-title">${esc(tipLabels?.[i] ?? labels[i])}</div>` +
        series.map((s) => tipRow(s.color, s.name, s.values[i] == null ? "–" : yFormat(s.values[i]))).join(""), ev);
    })
    .on("mouseleave", () => { cross.attr("opacity", 0); dots.forEach((d) => d.attr("opacity", 0)); hideTip(); });
}

function sparkline(values, { w = 120, h = 30, color = "var(--accent)" } = {}) {
  const vals = values.map((v) => v ?? null);
  const max = d3.max(vals) || 1;
  const x = d3.scaleLinear().domain([0, vals.length - 1]).range([2, w - 4]);
  const y = d3.scaleLinear().domain([0, max]).range([h - 3, 3]);
  const line = d3.line().defined((v) => v != null).x((_, i) => x(i)).y((v) => y(v)).curve(d3.curveMonotoneX);
  let li = vals.length - 1;
  while (li > 0 && vals[li] == null) li--;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:block;overflow:visible">
    <path d="${line(vals)}" fill="none" stroke="var(--context)" stroke-width="1.5"/>
    ${vals[li] != null ? `<circle cx="${x(li)}" cy="${y(vals[li])}" r="3" fill="${color}"/>` : ""}</svg>`;
}

const legend = (items) => `<div class="legend">${items.map(([c, l]) => `<span><i class="key" style="background:${c}"></i>${esc(l)}</span>`).join("")}</div>`;

// ---------------------------------------------------------------- shared controls
function areaOptions(selected) {
  const opts = [[ENGLAND, "England"], [LONDON + "|", ""], [REST, "Rest of England"]];
  let html = `<option value="${ENGLAND}" ${selected === ENGLAND ? "selected" : ""}>England</option>`;
  html += `<option value="${REST}" ${selected === REST ? "selected" : ""}>Rest of England (excluding London)</option>`;
  html += `<optgroup label="Regions">${REGION_ORDER.map((c) => `<option value="${c}" ${selected === c ? "selected" : ""}>${esc(regionName(c))}</option>`).join("")}</optgroup>`;
  html += `<optgroup label="Local authorities">${LAS.map((a) => `<option value="${a.code}" ${selected === a.code ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</optgroup>`;
  void opts;
  return html;
}
function quarterOptions(list, selected) {
  return list.slice().reverse().map((q) => `<option value="${q}" ${q === selected ? "selected" : ""}>${qLong(q)}</option>`).join("");
}
function seg(name, options, selected) {
  return `<div class="seg" role="group" data-seg="${name}">${options.map(([v, l]) =>
    `<button type="button" data-value="${v}" aria-pressed="${v === selected}">${esc(l)}</button>`).join("")}</div>`;
}
function onSeg(root, name, fn) {
  root.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => fn(b.dataset.value)));
}

// ---------------------------------------------------------------- routing
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query] = h.split("?");
  const parts = (path || "overview").split("/");
  return { view: parts[0] || "overview", arg: parts[1] ? decodeURIComponent(parts[1]) : null, params: new URLSearchParams(query || "") };
}
function setParams(updates) {
  const r = parseRoute();
  for (const [k, v] of Object.entries(updates)) (v == null ? r.params.delete(k) : r.params.set(k, v));
  const qs = r.params.toString();
  const newHash = `#/${r.view}${r.arg ? "/" + encodeURIComponent(r.arg) : ""}${qs ? "?" + qs : ""}`;
  history.replaceState(null, "", newHash);
  render();
}
const VIEWS = {};
let lastWidth = 0;
function render() {
  const r = parseRoute();
  const fn = VIEWS[r.view] || VIEWS.overview;
  document.querySelectorAll(".tabs a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.view === r.view) || a.dataset.view !== r.view || a.setAttribute("aria-current", "page"));
  hideTip();
  fn(r);
  lastWidth = $view.clientWidth;
}

// ================================================================ VIEWS

// ---------------------------------------------------------------- Overview
VIEWS.overview = ({ params }) => {
  const area = params.get("area") || ENGLAND;
  const range = params.get("range") || "3y";
  const topBy = params.get("top") === "rate" ? "rate" : "total";
  const period = params.get("period") === "year" ? "year" : "quarter";
  const Y = period === "year";
  const q = latestQ(), pq = prevQ(q), yq = prevQ(q, 4);
  // Period-aware values: the latest quarter, or the four quarters to the latest quarter
  const V = (m, code, at = q) => (Y ? sumLast(m, code, at) : hv(m, code, at));
  const label = Y ? yearLabel(q) : qLong(q);
  const cmpAt = Y ? yq : pq;                                   // main comparison
  const cmpText = Y ? `vs ${yearLabel(yq)}` : "vs previous quarter";
  const tot = V("total", ENGLAND), pre = V("prevention", ENGLAND), rel = V("relief", ENGLAND);
  const totAll = V("total_all", ENGLAND), relAll = V("relief_all", ENGLAND);
  const relShare = tot ? rel / tot : null;
  const rateNow = Y ? rateYear(ENGLAND, q) : rate(ENGLAND, q), rateCmp = Y ? rateYear(ENGLAND, yq) : rate(ENGLAND, pq);
  const sup = supportLatest(ENGLAND);
  // Rough sleeping: latest month, or the monthly average over the last 12 months
  const R0 = D.rough_sleeping, rsE = R0.asylum[ENGLAND] || [], lastM = R0.months.at(-1);
  const rsAvg = (end) => { const v = rsE.slice(Math.max(0, end - 12), end).filter((x) => x != null); return v.length === 12 ? d3.mean(v) : null; };
  const rs = rsLatest(ENGLAND);
  const rsVal = Y ? rsAvg(rsE.length) : rs.value, rsCmp = Y ? rsAvg(rsE.length - 12) : rs.prev;
  // Grants: latest quarter, or the latest four quarters
  const G = D.grants, gi = G.quarters.length - 1;
  const gSum = (end) => (end >= 3 ? d3.sum(G.grants.slice(end - 3, end + 1)) : null);
  const gVal = Y ? gSum(gi) : G.grants[gi], gCmp = Y ? gSum(gi - 4) : G.grants[gi - 1];
  const top = rankLAs(Y ? "last4" : "total", q).slice(0, 5);
  const dirWord = (a, b) => (a == null || b == null || !b ? "" : a > b ? `up ${Math.round(((a - b) / b) * 100)}%` : a < b ? `down ${Math.round(((b - a) / b) * 100)}%` : "unchanged");

  $view.innerHTML = `
  <div class="controls" style="justify-content:space-between;align-items:center">
    <div class="control">Show figures for${seg("period", [["quarter", `Latest quarter (${qLong(q)})`], ["year", `Year ending ${yearShort(q)}`]], period)}</div>
  </div>
  <div class="headline">
    <div class="headline-grid">
      <div>
        <div class="hero-label">Households owed a homelessness duty after being required to leave Home Office asylum accommodation, England, ${label}</div>
        <div class="hero">${fmt(tot)}</div>
        ${Y ? `<div class="delta">${deltaSpan(tot, V("total", ENGLAND, yq))} vs ${yearLabel(yq)}</div>`
            : `<div class="delta">${deltaSpan(tot, hv("total", ENGLAND, pq))} vs previous quarter</div>
               <div class="delta">${deltaSpan(tot, hv("total", ENGLAND, yq))} vs ${qLong(yq)}</div>`}
      </div>
      <div class="tiles">
        ${tile("Asylum leaver prevention duties", fmt(pre), `${deltaSpan(pre, V("prevention", ENGLAND, cmpAt))} ${cmpText}`, "var(--prevention)")}
        ${tile("Asylum leaver relief duties", fmt(rel), `${deltaSpan(rel, V("relief", ENGLAND, cmpAt))} ${cmpText}`, "var(--relief)")}
        ${tile("Relief share", fmtPct(reliefShare(ENGLAND, q, Y), 0), `of asylum leaver duties were relief: the household was already homeless when it got help`, "var(--relief)")}
        ${tile("Asylum leavers as % of all prevention duties", fmtPct(shareOf("prevention", ENGLAND, q, Y)), `of the ${fmt(V("prevention_all", ENGLAND))} households owed a prevention duty in England were leaving asylum accommodation`, "var(--prevention)")}
        ${tile("Asylum leavers as % of all relief duties", fmtPct(shareOf("relief", ENGLAND, q, Y)), `of the ${fmt(V("relief_all", ENGLAND))} households owed a relief duty in England were leaving asylum accommodation`, "var(--relief)")}
        ${tile("Homelessness duties per 100 people in asylum support", fmtRate(rateNow),
          Y ? `households owed a duty in the year per 100 people in support (average of the four quarters) · ${fmtRate(rateCmp)} the year before`
            : `households owed a duty per 100 people in support at the start of the quarter · ${fmtRate(rateCmp)} last quarter`)}
        ${tile("Sleeping rough after leaving asylum support", Y ? fmt(rsVal) : fmt(rsVal),
          Y ? `average per month, 12 months to ${mLong(lastM)} · ${deltaSpan(rsVal, rsCmp, { abs: false })} on the 12 months before`
            : `${rs.month ? mLong(rs.month) : ""} · ${deltaSpan(rs.value, rs.prev, { pct: false })} vs previous month`, "var(--rough)")}
        ${tile("People in asylum support (England)", fmt(sup.value), `at end of ${sup.quarter ? qLong(sup.quarter) : ""} · ${deltaSpan(sup.value, sup.prev, { abs: false })} on a year earlier`, "var(--support)")}
        ${tile("Grants of protection (UK)", fmt(gVal), `${Y ? yearLabel(G.quarters[gi]) : qLong(G.quarters[gi])}, main applicants · ${deltaSpan(gVal, gCmp, { abs: false })} ${Y ? "on the year before" : "vs last quarter"}`)}
      </div>
    </div>
  </div>
  <div class="card summary-card">
    <h3>Summary</h3>
    <p class="summary">In the ${Y ? yearLabel(q) : `quarter ${qLong(q)}`}, councils in England owed a homelessness duty to <b>${fmt(tot)}</b> households because they had to leave Home Office asylum accommodation: ${fmt(pre)} prevention duties and ${fmt(rel)} relief duties.
    ${Y ? `That is ${dirWord(tot, V("total", ENGLAND, yq)) || "–"} on the previous 12 months.`
        : `That is ${dirWord(tot, hv("total", ENGLAND, pq)) || "–"} on the previous quarter and ${dirWord(tot, hv("total", ENGLAND, yq)) || "–"} on the same quarter last year.`}
    <b>${fmtPct(relShare, 0)}</b> were already homeless when they were assessed (relief duty).
    The local authorities with the most were ${top.map((a) => `<a href="#/la/${a.code}">${esc(a.name)}</a> (${fmt(a.value)})`).join(", ")}.</p>
  </div>

  <div class="section">
    <div class="section-head">
      <div><h2>Trends</h2><p class="lede" style="margin:0">Choose an area to see its figures. National and regional figures are rounded to the nearest 10 by MHCLG.</p></div>
      <div class="controls" style="margin:0">
        <label class="control">Area<select id="area">${areaOptions(area)}</select></label>
        <div class="control">Period${seg("range", [["3y", "Last 3 years"], ["all", "All"]], range)}</div>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Households owed homelessness duties upon leaving Home Office accommodation</h3>
        <p class="sub">${esc(areaName(area))}, per quarter</p>${legend([["var(--prevention)", "Asylum leaver prevention duties"], ["var(--relief)", "Asylum leaver relief duties"]])}<div class="chart" id="c-duties"></div>
        <p class="embed-source">Source: MHCLG statutory homelessness statistics</p></div>
      <div class="card"><h3>Relief share</h3>
        <p class="sub">${esc(areaName(area))}, % of asylum leaver duties that were relief duties (already homeless) rather than prevention duties</p>
        <div class="chart" id="c-prevshare"></div>
        <p class="note">A lower relief share means councils are intervening earlier, before people lose their accommodation.</p></div>
      <div class="card"><h3>People sleeping rough after leaving asylum support</h3>
        <p class="sub">${esc(areaName(area))}, people seen sleeping rough during the month who had left asylum support in the previous 85 days</p><div class="chart" id="c-rough"></div>
        <p class="note">Estimates from councils' management information (Rough Sleeping Data Framework). Not comparable with the statutory homelessness figures.</p></div>
      <div class="card"><h3>Asylum leavers as a % of all prevention and relief duties</h3>
        <p class="sub">${esc(areaName(area))}, % of all households owed each duty (for any reason) who were leaving Home Office asylum accommodation</p>
        ${legend([["var(--prevention)", "Asylum leavers as % of all prevention duties"], ["var(--relief)", "Asylum leavers as % of all relief duties"]])}<div class="chart" id="c-share"></div></div>
      <div class="card"><h3>People in asylum support</h3>
        <p class="sub">${esc(areaName(area))}, people receiving Home Office asylum support at the end of each quarter (Section 95, 4 and 98). This is where future move-on need will arise.</p><div class="chart" id="c-support"></div></div>
      <div class="card"><h3>Homelessness duties per 100 people in asylum support</h3>
        <p class="sub">${esc(areaName(area))}, households owed a duty after leaving asylum accommodation per 100 people in asylum support in the area at the start of the quarter</p><div class="chart" id="c-rate"></div>
        <p class="note">People often leave support in one area and approach a council in another, so area rates are a guide, not an exact measure.</p></div>
      <div class="card"><h3>Grants of protection and homelessness duties</h3>
        <p class="sub">Grants of protection (UK, main applicants) compared with households owed a duty after leaving asylum accommodation (England), per quarter</p>
        ${legend([["var(--context)", "Grants of protection (UK)"], ["var(--accent)", "Duties owed (England)"]])}<div class="chart" id="c-grants"></div>
        <p class="note">Different populations: grants are UK-wide and count main applicants, duties are England-only and count households. Shown together to compare timing.</p></div>
    </div>
  </div>

  <div class="section">
    <div class="card"><div class="section-head" style="margin-bottom:4px"><div><h3>Where need is highest, ${label}</h3>
        <p class="sub" style="margin:0">${topBy === "rate" ? `Highest number of households owed a duty per 100 people in asylum support (areas with at least ${RATE_MIN_BASE} people in support)` : "Local authorities with the most households owed a duty (prevention + relief)"}${Y ? `. Change is against the ${yearLabel(yq)}; councils with a missing quarter are left out.` : ""}</p></div>
        ${seg("top", [["total", "Number"], ["rate", "Homelessness duties per 100 people in asylum support"]], topBy)}</div>
      <ol class="toplist" id="top10"></ol>
      <p class="note"><a href="#/rankings">See all local authorities →</a> · <a href="#/regions">Top 5 in each region →</a></p></div>
  </div>`;

  document.getElementById("area").addEventListener("change", (e) => setParams({ area: e.target.value === ENGLAND ? null : e.target.value }));
  onSeg($view, "range", (v) => setParams({ range: v === "3y" ? null : v }));

  const qs = range === "all" ? splitQuarters() : Q.slice(-12);
  columnChart(document.getElementById("c-duties"), {
    labels: qs.map(qShort), tipLabels: qs.map(qLong),
    series: [
      { name: "Asylum leaver prevention duties", color: "var(--prevention)", values: qs.map((x) => hv("prevention", area, x)), flags: qs.map((x) => flagOf("prevention", area, x)) },
      { name: "Asylum leaver relief duties", color: "var(--relief)", values: qs.map((x) => hv("relief", area, x)), flags: qs.map((x) => flagOf("relief", area, x)) },
    ],
    onClick: null,
  });
  lineChart(document.getElementById("c-prevshare"), {
    labels: qs.map(qShort), tipLabels: qs.map(qLong),
    series: [
      { name: "Relief share", color: "var(--relief)", values: qs.map((x) => reliefShare(area, x)) },
    ],
    yFormat: (v) => fmtPct(v, 0), yTickFormat: d3.format(".0%"), yMax: 1,
  });
  const R = D.rough_sleeping;
  const ms = range === "all" ? R.months : R.months.slice(-36);
  const rsv = R.asylum[area];
  if (rsv) {
    const off = R.months.length - ms.length;
    columnChart(document.getElementById("c-rough"), {
      labels: ms.map(mShort), tipLabels: ms.map(mLong),
      series: [{ name: "People sleeping rough", color: "var(--rough)", values: rsv.slice(off) }],
    });
  } else document.getElementById("c-rough").innerHTML = `<p class="empty">No rough sleeping data for this area.</p>`;

  const qsAll = range === "all" ? Q : Q.slice(-12);
  lineChart(document.getElementById("c-share"), {
    labels: qsAll.map(qShort), tipLabels: qsAll.map(qLong),
    series: [
      { name: "Asylum leavers as % of all prevention duties", color: "var(--prevention)", values: qsAll.map((x) => shareOf("prevention", area, x)) },
      { name: "Asylum leavers as % of all relief duties", color: "var(--relief)", values: qsAll.map((x) => shareOf("relief", area, x)) },
    ],
    yFormat: (v) => fmtPct(v), yTickFormat: d3.format(".0%"),
  });
  const S = D.asylum_support;
  const sq = range === "all" ? S.quarters : S.quarters.slice(-12);
  const sv = S.people[area];
  if (sv) {
    lineChart(document.getElementById("c-support"), {
      labels: sq.map(qShort), tipLabels: sq.map((x) => "End of " + qLong(x)),
      series: [{ name: "People in asylum support", color: "var(--support)", values: sv.slice(S.quarters.length - sq.length) }],
    });
  } else document.getElementById("c-support").innerHTML = `<p class="empty">No asylum support data for this area.</p>`;

  const gq = (range === "all" ? Q : Q.slice(-12)).filter((x) => G.quarters.includes(x));
  lineChart(document.getElementById("c-grants"), {
    labels: gq.map(qShort), tipLabels: gq.map(qLong),
    series: [
      { name: "Grants of protection (UK)", color: "var(--context)", values: gq.map((x) => G.grants[G.quarters.indexOf(x)]) },
      { name: "Duties owed (England)", color: "var(--accent)", values: gq.map((x) => hv("total", ENGLAND, x)) },
    ],
  });
  const rq = qsAll.filter((x) => S.quarters.includes(prevQ(x)));
  lineChart(document.getElementById("c-rate"), {
    labels: rq.map(qShort), tipLabels: rq.map(qLong),
    series: [{ name: "Per 100 people in asylum support", color: "var(--accent)", values: rq.map((x) => rate(area, x)) }],
    yFormat: fmtRate,
  });
  if (!rq.some((x) => rate(area, x) != null)) document.getElementById("c-rate").innerHTML = `<p class="empty">Too few people in asylum support here to calculate a rate.</p>`;
  onSeg($view, "top", (v) => setParams({ top: v === "total" ? null : v }));
  onSeg($view, "period", (v) => setParams({ period: v === "quarter" ? null : v }));
  const topMeasure = Y ? (topBy === "rate" ? "rate4" : "last4") : topBy;
  topList(document.getElementById("top10"), rankLAs(topMeasure, q).slice(0, 10), q, topMeasure, true);
};

function tile(label, value, delta, color) {
  return `<div class="tile"><div class="label">${color ? `<i class="key" style="background:${color}"></i>` : ""}${esc(label)}</div>
    <div class="value">${value}</div><div class="delta">${delta}</div></div>`;
}

function topList(el, items, q, measure, showRegion = false) {
  const max = d3.max(items, (d) => d.value) || 1;
  el.innerHTML = items.length ? items.map((a, i) => {
    if (measure === "rate" || measure === "rate4") {
      const n = measure === "rate" ? hv("total", a.code, q) : sumLast("total", a.code, q);
      const base = measure === "rate" ? rateBase(a.code, q) : Math.round(avgBaseYear(a.code, q));
      return `<li><span class="rank">${i + 1}</span><a href="#/la/${a.code}" title="${esc(a.name)}">${esc(a.name)}${showRegion ? ` <span class="muted" style="font-size:12px">${esc(regionName(a.region))}</span>` : ""}</a>
        <span class="num">${fmtRate(a.value)}<span class="chg delta" style="color:var(--ink-2)">${fmt(n)} of ${fmt(base)}</span></span>
        <span class="bar"><i style="width:${(a.value / max) * 100}%"></i></span></li>`;
    }
    // last4 (year ending) compares with the year before; quarterly measures with the previous quarter
    const prev = measure === "last4" ? sumLast("total", a.code, prevQ(q, 4)) : hv(measure, a.code, prevQ(q));
    return `<li><span class="rank">${i + 1}</span><a href="#/la/${a.code}" title="${esc(a.name)}">${esc(a.name)}${showRegion ? ` <span class="muted" style="font-size:12px">${esc(regionName(a.region))}</span>` : ""}</a>
      <span class="num">${fmt(a.value)}<span class="chg delta">${deltaSpan(a.value, prev, { pct: false })}</span></span>
      <span class="bar"><i style="width:${(a.value / max) * 100}%"></i></span></li>`;
  }).join("") : `<li class="muted">No data</li>`;
}

// ---------------------------------------------------------------- Regions
VIEWS.regions = ({ params }) => {
  const measure = params.get("m") || "total";
  const qList = measure === "total" ? Q : measure === "rate" ? Q.filter((x) => D.asylum_support.quarters.includes(prevQ(x))) : splitQuarters();
  const mv = (c, x) => (measure === "rate" ? rate(c, x) : hv(measure, c, x));
  const mf = measure === "rate" ? fmtRate : fmt;
  const md = (cur, prev, o = {}) => deltaSpan(cur, prev, measure === "rate" ? { pct: false, f: (v) => v.toFixed(1) } : o);
  let q = params.get("q");
  if (!qList.includes(q)) q = latestQ();
  const pq = prevQ(q), yq = prevQ(q, 4);
  const spanQ = Q.slice(Math.max(0, qi(q) - 11), qi(q) + 1);
  const rows = [ENGLAND, LONDON, REST, ...REGION_ORDER.filter((c) => c !== LONDON)];

  $view.innerHTML = `
    <h2>Regions</h2>
    <p class="lede">How each region compares, and the five local authorities with the highest numbers in each region. Choose a quarter, then a measure: the shaded columns and the top 5 lists change with the measure. Click a local authority to see its profile.</p>
    <div class="controls">
      <label class="control">Quarter<select id="q">${quarterOptions(qList, q)}</select></label>
    </div>
    <div class="table-wrap"><table class="region-table">
      <thead>
        <tr>
          <th class="l" rowspan="2">Area</th>
          <th class="grp dyn-head" colspan="4"><div class="grp-label">Choose a measure: these four columns change</div>${seg("m", MEASURE_BUTTONS, measure)}</th>
          <th class="grp static-head edge" colspan="${measure === "rate" ? 3 : 4}"><div class="grp-label">Other indicators, ${qShort(q)}</div><div class="grp-sub">Always shown: not affected by the measure buttons</div></th>
        </tr>
        <tr>
          <th class="dyn">${esc(MEASURES[measure].short)}, ${qShort(q)}</th><th class="dyn">vs previous quarter</th><th class="dyn">vs ${qShort(yq)}</th><th class="dyn l">Last 12 quarters</th>
          <th class="edge">Asylum leavers as % of all prevention duties</th><th>Asylum leavers as % of all relief duties</th><th>Relief share</th>${measure === "rate" ? "" : "<th>Homelessness duties per 100 people in asylum support</th>"}
        </tr>
      </thead>
      <tbody>${rows.map((c) => {
        const v = mv(c, q);
        const sep = c === REST ? ' style="border-bottom:2px solid var(--axis)"' : "";
        return `<tr${sep}><td class="l"><a href="#/overview?area=${c}">${c === ENGLAND ? "<b>England</b>" : esc(areaName(c))}</a></td>
          <td class="dyn"><b>${mf(v)}</b></td><td class="dyn delta">${md(v, mv(c, pq))}</td><td class="dyn delta">${md(v, mv(c, yq))}</td>
          <td class="dyn l">${sparkline(spanQ.map((x) => mv(c, x)), { color: MEASURES[measure].color })}</td>
          <td class="edge">${fmtPct(shareOf("prevention", c, q))}</td><td>${fmtPct(shareOf("relief", c, q))}</td><td>${fmtPct(reliefShare(c, q), 0)}</td>${measure === "rate" ? "" : `<td>${fmtRate(rate(c, q))}</td>`}</tr>`;
      }).join("")}</tbody></table></div>
    <p class="note">London and Rest of England are shown separately as well as within the regional list. Regional figures are rounded to the nearest 10; local authority figures are not rounded, so they may not add up to regional totals. "Asylum leavers as % of all prevention / relief duties" = of all households owed that duty in the area, for any reason, the percentage who were leaving Home Office asylum accommodation. "Relief share" = % of asylum leaver duties that were relief duties (already homeless) rather than prevention. "Homelessness duties per 100 people in asylum support" = households owed a duty after leaving asylum accommodation per 100 people in asylum support in the area at the start of the quarter.</p>

    <div class="section">
      <div class="section-head"><h2>Top 5 local authorities in each region, ${qLong(q)}</h2>
        <div class="control">Ranked by${seg("m", MEASURE_BUTTONS, measure)}</div></div>
      <p class="lede">${measure === "rate" ? `Households owed a duty after leaving asylum accommodation per 100 people in asylum support at the start of the quarter. The small numbers show households owed duties and people in support.` : `${esc(MEASURES[measure].label)} for households required to leave Home Office asylum accommodation. Change shown against the previous quarter.`}</p>
      <div class="region-grid">${REGION_ORDER.map((c) => {
        const v = mv(c, q);
        return `<div class="card region-card"><div class="rc-head"><h3><a href="#/overview?area=${c}" style="color:inherit">${esc(regionName(c))}</a></h3>
          <span class="rc-total">${mf(v)}</span></div>
          <div class="rc-meta delta">${md(v, mv(c, pq))} vs ${qShort(pq)}</div>
          ${sparkline(spanQ.map((x) => mv(c, x)), { w: 280, h: 36, color: MEASURES[measure].color })}
          <ol class="toplist" data-region="${c}"></ol>
          <p class="note"><a href="#/rankings?region=${c}">All local authorities in ${esc(regionName(c))} →</a></p></div>`;
      }).join("")}</div>
    </div>`;
  document.getElementById("q").addEventListener("change", (e) => setParams({ q: e.target.value === latestQ() ? null : e.target.value }));
  onSeg($view, "m", (v) => setParams({ m: v === "total" ? null : v }));
  $view.querySelectorAll("ol[data-region]").forEach((ol) => {
    const items = rankLAs(measure, q, ol.dataset.region).filter((a) => a.value > 0).slice(0, 5);
    topList(ol, items, q, measure);
    ol.querySelectorAll(".bar i").forEach((i) => (i.style.background = MEASURES[measure].color));
  });
};

// ---------------------------------------------------------------- Local authority profile
VIEWS.la = ({ arg, params }) => {
  let code = arg;
  if (!code || !D.areas[code] || D.areas[code].type !== "la") code = rankLAs("total", latestQ())[0]?.code;
  const a = D.areas[code];
  const q = latestQ(), pq = prevQ(q), yq = prevQ(q, 4);
  const all = rankLAs("total", q), inReg = rankLAs("total", q, a.region);
  const rank = all.findIndex((x) => x.code === code) + 1, rankR = inReg.findIndex((x) => x.code === code) + 1;
  const t = hv("total", code, q), p = hv("prevention", code, q), r = hv("relief", code, q);
  const rs = rsLatest(code), sup = supportLatest(code);
  const range = params.get("range") || "3y";
  const qs = range === "all" ? splitQuarters() : Q.slice(-12);
  const missing = splitQuarters().filter((x) => hv("total", code, x) == null && flagOf("total", code, x) === "x");
  const latestMissing = t == null && flagOf("total", code, q);
  const notSubmitted = `<span style="font-size:16px;font-weight:500;color:var(--ink-2)">Not submitted</span>`;
  const last12 = sumLast("total", code, q);

  $view.innerHTML = `
    <div class="controls no-embed"><div class="control">Find a local authority<div class="la-search" id="la-search"></div></div></div>
    <div class="profile-head">
      <div><span class="chip">${esc(regionName(a.region))}</span><h2>${esc(a.name)}</h2>
        ${a.current === false ? `<p class="note">This authority no longer exists; figures are shown for the periods it reported.</p>` : ""}
        ${missing.length ? `<p class="note">MHCLG has no data from ${esc(a.name)} for ${missing.map(qLong).join(", ")}. The council did not submit its return, or its data had quality problems. These quarters are shown as "n/a", not zero.</p>` : ""}</div>
      <div class="no-embed" style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="#/regions">Compare with region</a><a class="btn" href="#/map?focus=${code}">Show on map</a></div>
    </div>
    <div class="tiles">
      ${tile(`Households owed a duty, ${qShort(q)}`, latestMissing ? notSubmitted : fmt(t), latestMissing ? "No data from this council this quarter" : `${deltaSpan(t, hv("total", code, pq))} vs ${qShort(pq)}`)}
      ${tile("Asylum leaver prevention duties", latestMissing ? notSubmitted : fmt(p), latestMissing ? "" : `${deltaSpan(p, hv("prevention", code, pq), { pct: false })} vs last quarter`, "var(--prevention)")}
      ${tile("Asylum leaver relief duties", latestMissing ? notSubmitted : fmt(r), latestMissing ? "" : `${deltaSpan(r, hv("relief", code, pq), { pct: false })} vs last quarter`, "var(--relief)")}
      ${tile("Rank this quarter", rank ? `${rank} <span style="font-size:14px;font-weight:400;color:var(--ink-2)">of ${all.length}</span>` : "–", rankR ? `${ordinal(rankR)} of ${inReg.length} in ${esc(regionName(a.region))}` : "Not ranked: no data this quarter")}
      ${tile("Last 12 months", last12 == null ? notSubmitted.replace("Not submitted", "Incomplete") : fmt(last12),
        last12 == null ? `Missing data for ${missingIn(code, q).map(qShort).join(", ") || "a quarter"}` : `${deltaSpan(last12, sumLast("total", code, yq))} vs year before`)}
      ${tile("Relief share", fmtPct(reliefShare(code, q), 0),
        reliefShare(code, q) != null ? `of asylum leaver duties were relief (already homeless) · England: ${fmtPct(reliefShare(ENGLAND, q), 0)}`
          : latestMissing ? "No data this quarter" : `Not shown: fewer than ${PREV_MIN_BASE} duties this quarter${reliefShare(code, q, true) != null ? ` · year ending ${yearShort(q)}: ${fmtPct(reliefShare(code, q, true), 0)}` : ""}`, "var(--relief)")}
      ${tile("Asylum leavers as % of all prevention duties here", fmtPct(shareOf("prevention", code, q)), `of all households owed a prevention duty · England: ${fmtPct(shareOf("prevention", ENGLAND, q))}`, "var(--prevention)")}
      ${tile("Asylum leavers as % of all relief duties here", fmtPct(shareOf("relief", code, q)), `of all households owed a relief duty · England: ${fmtPct(shareOf("relief", ENGLAND, q))}`, "var(--relief)")}
      ${tile("Homelessness duties per 100 people in asylum support", fmtRate(rate(code, q)),
        rate(code, q) != null ? `${fmt(t)} households / ${fmt(rateBase(code, q))} people in support · England: ${fmtRate(rate(ENGLAND, q))}`
          : (rateBase(code, q) ?? 0) < RATE_MIN_BASE ? `Not calculated: fewer than ${RATE_MIN_BASE} people in support here` : "No data this quarter")}
      ${tile("Sleeping rough after leaving asylum support", fmt(rs.value), rs.month ? mLong(rs.month) : "No data", "var(--rough)")}
      ${tile("People in asylum support here", fmt(sup.value), sup.quarter ? `end of ${qLong(sup.quarter)} · ${deltaSpan(sup.value, sup.prev, { abs: false })} on a year earlier` : "None reported", "var(--support)")}
    </div>
    <div class="section"><div class="section-head"><h2>Trends</h2><div class="control no-embed">${seg("range", [["3y", "Last 3 years"], ["all", "All"]], range)}</div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Households owed a duty after leaving Home Office accommodation</h3><p class="sub">${esc(a.name)}, per quarter</p>
        ${legend([["var(--prevention)", "Asylum leaver prevention duties"], ["var(--relief)", "Asylum leaver relief duties"]])}<div class="chart" id="c-duties"></div>
        <p class="embed-source">Source: MHCLG statutory homelessness statistics</p></div>
      <div class="card"><h3>People sleeping rough after leaving asylum support</h3><p class="sub">${esc(a.name)}, per month</p><div class="chart" id="c-rough"></div></div>
      <div class="card"><h3>People in asylum support</h3><p class="sub">${esc(a.name)}, end of each quarter</p><div class="chart" id="c-support"></div>
        ${supportTypes(code)}</div>
      <div class="card"><h3>Figures by quarter</h3><div class="table-scroll" style="max-height:330px"><table id="la-table"></table></div></div>
    </div></div>`;

  laSearch(document.getElementById("la-search"), (c) => { location.hash = `#/la/${c}`; });
  onSeg($view, "range", (v) => setParams({ range: v === "3y" ? null : v }));
  columnChart(document.getElementById("c-duties"), {
    labels: qs.map(qShort), tipLabels: qs.map(qLong),
    series: [
      { name: "Asylum leaver prevention duties", color: "var(--prevention)", values: qs.map((x) => hv("prevention", code, x)), flags: qs.map((x) => flagOf("prevention", code, x)) },
      { name: "Asylum leaver relief duties", color: "var(--relief)", values: qs.map((x) => hv("relief", code, x)), flags: qs.map((x) => flagOf("relief", code, x)) },
    ],
  });
  const R = D.rough_sleeping, rsv = R.asylum[code];
  const ms = range === "all" ? R.months : R.months.slice(-36);
  if (rsv) columnChart(document.getElementById("c-rough"), { labels: ms.map(mShort), tipLabels: ms.map(mLong), series: [{ name: "People sleeping rough", color: "var(--rough)", values: rsv.slice(R.months.length - ms.length) }] });
  else document.getElementById("c-rough").innerHTML = `<p class="empty">No rough sleeping data for this area.</p>`;
  const S = D.asylum_support, sv = S.people[code];
  const sq = range === "all" ? S.quarters : S.quarters.slice(-12);
  if (sv) lineChart(document.getElementById("c-support"), { labels: sq.map(qShort), tipLabels: sq.map((x) => "End of " + qLong(x)), series: [{ name: "People in asylum support", color: "var(--support)", values: sv.slice(S.quarters.length - sq.length) }] });
  else document.getElementById("c-support").innerHTML = `<p class="empty">No one in asylum support was recorded in this area.</p>`;

  const tq = splitQuarters().slice().reverse();
  document.getElementById("la-table").innerHTML = `<thead><tr><th class="l">Quarter</th><th>Asylum leaver prevention</th><th>Asylum leaver relief</th><th>Asylum leaver total</th><th>Asylum leavers as % of all prevention</th><th>Asylum leavers as % of all relief</th><th>Relief share</th></tr></thead><tbody>${
    tq.map((x) => `<tr><td class="l">${qLong(x)}</td><td>${cell("prevention", code, x)}</td><td>${cell("relief", code, x)}</td><td><b>${cell("total", code, x)}</b></td><td>${fmtPct(shareOf("prevention", code, x))}</td><td>${fmtPct(shareOf("relief", code, x))}</td><td>${fmtPct(reliefShare(code, x), 0)}</td></tr>`).join("")}</tbody>
    <caption style="caption-side:bottom;text-align:left;padding:6px 10px;font-size:12px;color:var(--muted)">[x] = missing: not submitted by the council, or excluded by MHCLG for data quality.</caption>`;
};
const cell = (m, c, q) => {
  const v = hv(m, c, q), f = v == null ? flagOf(m, c, q) : null;
  return f ? `<span class="muted" title="${esc(FLAG_TEXT[f])}">[${f}]</span>` : fmt(v);
};
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
function supportTypes(code) {
  const t = D.asylum_support.latest_by_type[code];
  if (!t) return "";
  const tot = d3.sum(Object.values(t));
  return `<p class="note">By accommodation type, end of ${qLong(D.asylum_support.quarters.at(-1))}: ${Object.entries(t).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} ${fmt(v)} (${fmtPct(v / tot, 0)})`).join(" · ")}</p>`;
}

function laSearch(el, onPick) {
  el.innerHTML = `<input type="search" placeholder="Type a council name…" aria-label="Find a local authority" autocomplete="off"><div class="suggest" hidden></div>`;
  const input = el.querySelector("input"), box = el.querySelector(".suggest");
  let items = [], active = -1;
  const draw = () => {
    const s = input.value.trim().toLowerCase();
    items = (s ? LAS.filter((a) => a.name.toLowerCase().includes(s)) : []).slice(0, 12);
    box.hidden = !items.length;
    box.innerHTML = items.map((a, i) => `<button type="button" data-code="${a.code}" class="${i === active ? "active" : ""}">${esc(a.name)}<small>${esc(regionName(a.region))}</small></button>`).join("");
  };
  input.addEventListener("input", () => { active = -1; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && items.length) onPick(items[Math.max(0, active)].code);
    else if (e.key === "Escape") box.hidden = true;
  });
  box.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) onPick(b.dataset.code); });
  document.addEventListener("click", (e) => { if (!el.contains(e.target)) box.hidden = true; });
}

// ---------------------------------------------------------------- Map
let GEO = null;
// Map metrics. "periods" says which period types the metric supports.
const MAP_MEASURES = {
  total: { label: "Asylum leaver duties (prevention + relief)", periods: ["quarter", "year"] },
  prevention: { label: "Asylum leaver prevention duties", periods: ["quarter", "year"] },
  relief: { label: "Asylum leaver relief duties", periods: ["quarter", "year"] },
  rate: { label: "Homelessness duties per 100 people in asylum support", periods: ["quarter", "year"], continuous: true },
  prevshare: { label: "Relief share (% of asylum leaver duties that were relief)", periods: ["quarter", "year"], continuous: true, pct: true, breaks: [0.0001, 0.2, 0.4, 0.6, 0.8] },
  shareP: { label: "Asylum leavers as % of all prevention duties", periods: ["quarter", "year"], continuous: true, pct: true, breaks: [0.0001, 0.01, 0.02, 0.05, 0.1, 0.2] },
  shareR: { label: "Asylum leavers as % of all relief duties", periods: ["quarter", "year"], continuous: true, pct: true, breaks: [0.0001, 0.01, 0.02, 0.05, 0.1, 0.2] },
  rough: { label: "Sleeping rough after leaving asylum support (average per month)", periods: ["quarter", "year"], continuous: true },
  support: { label: "People in asylum support (at end of quarter)", periods: ["quarter"] },
};
// Months (YYYY-MM) covered by a quarter, or by the year ending that quarter
function monthsOf(q, year) {
  const [y, n] = q.split("-Q").map(Number);
  const out = [];
  for (let k = (year ? 11 : 2); k >= 0; k--) { const d = new Date(Date.UTC(y, n * 3 - 1 - k, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
function rsAverage(code, q, year) {
  const R = D.rough_sleeping, s = R.asylum[code];
  if (!s) return null;
  const vals = monthsOf(q, year).map((m) => { const i = R.months.indexOf(m); return i < 0 ? undefined : s[i]; });
  if (vals.some((v) => v === undefined)) return undefined;   // period not covered by the data
  const ok = vals.filter((v) => v != null);
  return ok.length === vals.length ? d3.mean(ok) : null;
}
const fmtDec = (v) => (v == null ? "–" : v < 10 ? (Math.round(v * 10) / 10).toString() : fmt(v));
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

function niceBreaks(values) {
  const pos = values.filter((v) => v > 0).sort(d3.ascending);
  if (!pos.length) return [1];
  const qs = [0.3, 0.5, 0.7, 0.85, 0.95].map((p) => d3.quantileSorted(pos, p));
  const nice = (v) => { if (v < 10) return Math.ceil(v); const m = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / (m / 2)) * (m / 2); };
  return [...new Set([1, ...qs.map(nice)])].sort(d3.ascending);
}

VIEWS.map = async ({ params }) => {
  // Backwards compatibility: the old "last 12 months" measure is now total + year ending
  let measure = params.get("m") === "last4" ? "total" : params.get("m");
  if (!MAP_MEASURES[measure]) measure = "total";
  const M = MAP_MEASURES[measure];
  let period = params.get("period") === "year" || params.get("m") === "last4" ? "year" : "quarter";
  if (!M.periods.includes(period)) period = "quarter";
  const Y = period === "year";
  // Quarters available for this metric and period
  const S = D.asylum_support;
  let qList = ["prevention", "relief", "prevshare", "shareP", "shareR"].includes(measure) ? splitQuarters()
    : measure === "rate" ? Q.filter((x) => S.quarters.includes(prevQ(x)))
    : measure === "support" ? S.quarters
    : measure === "rough" ? Q.concat(S.quarters).filter((x, i, a) => a.indexOf(x) === i).sort().filter((x) => rsAverage(ENGLAND, x, Y) !== undefined)
    : Q;
  if (Y && measure !== "rough") qList = qList.slice(3);   // a year ending needs four quarters
  let q = params.get("q"); if (!qList.includes(q)) q = qList.at(-1);
  const region = params.get("region") || "";
  const focus = params.get("focus");
  const valueOf = (code) => {
    if (measure === "rough") return rsAverage(code, q, Y) ?? null;
    if (measure === "support") return supportAt(code, q) ?? 0;
    if (measure === "rate") return Y ? rateYear(code, q) : rate(code, q);
    if (measure === "prevshare") return reliefShare(code, q, Y);
    if (measure === "shareP") return shareOf("prevention", code, q, Y);
    if (measure === "shareR") return shareOf("relief", code, q, Y);
    return Y ? sumLast(measure, code, q) : hv(measure, code, q);
  };
  const when = measure === "support" ? "end of " + qLong(q) : Y ? yearLabel(q) : qLong(q);
  const periodOptions = qList.slice().reverse().map((x) => `<option value="${x}" ${x === q ? "selected" : ""}>${Y ? "Year ending " + yearShort(x) : qLong(x)}</option>`).join("");
  const missingNote = measure === "rate" ? `the council did not submit${Y ? " for one or more quarters" : ""}, or fewer than ${RATE_MIN_BASE} people were in asylum support there`
    : measure === "prevshare" ? `the council did not submit, or had fewer than ${PREV_MIN_BASE} duties in the period`
    : measure === "rough" ? "no rough sleeping data for the area" : measure === "support" ? "none" : `the council did not submit${Y ? " for one or more of the four quarters" : ""}`;

  $view.innerHTML = `
    <h2>Map</h2>
    <p class="lede">Where people leaving asylum accommodation are presenting as homeless. Choose a metric, then the period. Hover over an area for its figures, click to open its profile.</p>
    <div class="controls">
      <label class="control">1. Metric<select id="m">${Object.entries(MAP_MEASURES).map(([k, v]) => `<option value="${k}" ${k === measure ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <div class="control">2. Period${M.periods.length > 1 ? seg("period", [["quarter", "Quarter"], ["year", "Year ending"]], period) : `<span style="padding:7px 0;color:var(--ink-2)">Quarter only (a count at one point in time)</span>`}</div>
      <label class="control">3. ${Y ? "Year ending" : "Quarter"}<select id="q">${periodOptions}</select></label>
      <label class="control">Zoom to region<select id="region"><option value="">All England</option>${REGION_ORDER.map((c) => `<option value="${c}" ${c === region ? "selected" : ""}>${esc(regionName(c))}</option>`).join("")}</select></label>
    </div>
    <div class="map-layout">
      <div class="card map"><div id="map" style="width:100%"></div>
        <div id="scale" class="scale"></div><p class="note">${esc(M.label)}, ${esc(when)}. Grey = none recorded. Hatched = no data (${missingNote}).${measure === "rate" && Y ? " Year rate = households owed a duty in the four quarters per 100 people in support (average of the four start-of-quarter figures)." : ""} Boundaries: ONS, December 2024.</p></div>
      <div class="card"><div id="map-info"><h3>${region ? esc(regionName(region)) : "England"}: highest, ${esc(when)}</h3><ol class="toplist" id="map-top"></ol></div></div>
    </div>`;
  document.getElementById("m").addEventListener("change", (e) => setParams({ m: e.target.value === "total" ? null : e.target.value }));
  onSeg($view, "period", (v) => setParams({ period: v === "quarter" ? null : v }));
  document.getElementById("q").addEventListener("change", (e) => setParams({ q: e.target.value === qList.at(-1) ? null : e.target.value }));
  document.getElementById("region").addEventListener("change", (e) => setParams({ region: e.target.value || null, focus: null }));

  const $map = document.getElementById("map");
  if (!GEO) {
    $map.innerHTML = `<p class="empty">Loading map…</p>`;
    try { GEO = await (await fetch("data/la_boundaries.geojson")).json(); }
    catch { $map.innerHTML = `<p class="empty">Map boundaries could not be loaded.</p>`; return; }
    if (parseRoute().view !== "map") return;
  }
  const values = new Map(GEO.features.map((f) => [f.properties.code, valueOf(f.properties.code)]));
  const isRate = !!M.continuous;
  const fmtV = measure === "rate" ? fmtRate : measure === "rough" ? fmtDec : M.pct ? (v) => fmtPct(v, 0) : fmt;
  // Rates are continuous: bands start at 0 and are labelled "a–b"; counts use whole-number bands.
  const breaks = M.breaks ? M.breaks : isRate ? [0.0001, ...niceBreaks([...values.values()].filter((v) => v != null)).slice(1)] : niceBreaks([...values.values()].filter((v) => v != null));
  // spread however many classes there are evenly across the ramp (light -> dark)
  const color = (v) => {
    if (v == null) return "url(#missing-hatch)";
    if (v <= 0) return "var(--zero)";
    const idx = Math.max(0, d3.bisectRight(breaks, v) - 1);
    return RAMP[breaks.length > 1 ? Math.round((idx * (RAMP.length - 1)) / (breaks.length - 1)) : RAMP.length - 1];
  };
  // legend
  const classes = breaks.map((b, i) => [b, breaks[i + 1] ? (isRate ? breaks[i + 1] : breaks[i + 1] - 1) : null]);
  const bandLabel = (lo, hi) => isRate ? (hi == null ? `${fmtV(lo)}+` : `${lo < 0.001 ? "0" : fmtV(lo)}–${fmtV(hi)}`)
    : hi == null ? fmt(lo) + "+" : lo === hi ? fmt(lo) : fmt(lo) + "–" + fmt(hi);
  const hatchCss = "repeating-linear-gradient(45deg, var(--axis) 0 1.5px, var(--surface) 1.5px 5px)";
  document.getElementById("scale").innerHTML = `<div><i style="background:var(--zero)"></i>0</div>` +
    classes.map(([lo, hi]) => `<div><i style="background:${color(lo)}"></i>${bandLabel(lo, hi)}</div>`).join("") +
    `<div style="margin-left:12px;flex:1.4"><i style="background:${hatchCss};border-radius:3px"></i>No data</div>`;

  const width = $map.clientWidth || 600;
  const height = Math.min(760, Math.max(420, width * 1.15));
  $map.innerHTML = "";
  const feats = GEO.features;
  const focusFeats = region ? feats.filter((f) => D.areas[f.properties.code]?.region === region) : feats;
  const proj = d3.geoMercator().fitExtent([[8, 8], [width - 8, height - 8]], { type: "FeatureCollection", features: focusFeats.length ? focusFeats : feats });
  const path = d3.geoPath(proj);
  const svg = d3.select($map).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("height", height).attr("role", "img").attr("aria-label", "Map of local authorities");
  svg.append("defs").html(`<pattern id="missing-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="5" height="5" fill="var(--surface)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--axis)" stroke-width="1.5"/></pattern>`);
  svg.append("g").selectAll("path").data(feats).join("path")
    .attr("class", (f) => "la" + (region && D.areas[f.properties.code]?.region !== region ? " dim" : "") + (f.properties.code === focus ? " sel" : ""))
    .attr("d", path).attr("fill", (f) => color(values.get(f.properties.code)))
    .on("mousemove", (ev, f) => {
      const c = f.properties.code, v = values.get(c);
      showTip(`<div class="t-title">${esc(areaName(c) || f.properties.name)}</div><div class="muted" style="margin-bottom:4px">${esc(regionName(D.areas[c]?.region))}</div>` +
        `<div class="muted" style="margin-bottom:4px">${esc(when)}</div>` +
        tipRow(null, M.label.replace(/ \(.*\)$/, ""), v == null ? (measure === "rate" && (Y ? sumLast("total", c, q) : hv("total", c, q)) != null ? `under ${RATE_MIN_BASE} in support` : measure === "rough" ? "no data" : "not submitted") : fmtV(v)) +
        (["total", "prevention", "relief", "rate", "prevshare", "shareP", "shareR"].includes(measure) ? tipRow("var(--prevention)", "Asylum leaver prevention", fmt(Y ? sumLast("prevention", c, q) : hv("prevention", c, q))) + tipRow("var(--relief)", "Asylum leaver relief", fmt(Y ? sumLast("relief", c, q) : hv("relief", c, q))) : "") +
        tipRow("var(--support)", "In asylum support", fmt(supportAt(c, measure === "support" ? q : S.quarters.at(-1)) ?? 0)), ev);
    })
    .on("mouseleave", hideTip)
    .on("click", (ev, f) => { if (D.areas[f.properties.code]) location.hash = `#/la/${f.properties.code}`; });
  svg.select("path.sel").raise();

  const ranked = LAS.filter((a) => !region || a.region === region).map((a) => ({ ...a, value: valueOf(a.code) }))
    .filter((a) => a.value > 0).sort((a, b) => b.value - a.value).slice(0, 15);
  const max = ranked[0]?.value || 1;
  document.getElementById("map-top").innerHTML = ranked.map((a, i) => `<li><span class="rank">${i + 1}</span><a href="#/la/${a.code}">${esc(a.name)}</a><span class="num">${fmtV(a.value)}</span><span class="bar"><i style="width:${(a.value / max) * 100}%"></i></span></li>`).join("") || `<li class="muted">None recorded</li>`;
};

// ---------------------------------------------------------------- Local authority tables (#/rankings)
VIEWS.rankings = ({ params }) => {
  let q = params.get("q"); if (!splitQuarters().includes(q)) q = latestQ();
  const region = params.get("region") || "";
  const sort = params.get("sort") || "total";
  const dir = params.get("dir") || "desc";
  const search = params.get("s") || "";
  const pq = prevQ(q);
  const lastMonth = D.rough_sleeping.months.at(-1);
  const cols = [
    ["name", "Local authority", "l"], ["region", "Region", "l"],
    ["total", `Asylum leaver duties ${qShort(q)}`], ["prevention", "Asylum leaver prevention"], ["relief", "Asylum leaver relief"],
    ["change", "Change vs prev. quarter"], ["last4", "Last 12 months"], ["shareP", "Asylum leavers as % of all prevention duties"], ["shareR", "Asylum leavers as % of all relief duties"], ["rate", "Homelessness duties per 100 people in asylum support"], ["prevshare", "Relief share"],
    ["rough", `Rough sleeping ${mShort(lastMonth)}`], ["support", "In asylum support"],
  ];
  let rows = LAS.filter((a) => (!region || a.region === region) && (!search || a.name.toLowerCase().includes(search.toLowerCase()))).map((a) => {
    const t = hv("total", a.code, q), tp = hv("total", a.code, pq);
    return {
      code: a.code, name: a.name, region: regionName(a.region), total: t,
      prevention: hv("prevention", a.code, q), relief: hv("relief", a.code, q),
      change: t != null && tp != null ? t - tp : null, last4: sumLast("total", a.code, q), shareP: shareOf("prevention", a.code, q), shareR: shareOf("relief", a.code, q), rate: rate(a.code, q), prevshare: reliefShare(a.code, q),
      rough: rsLatest(a.code).value, support: supportLatest(a.code).value ?? 0,
    };
  });
  const k = sort;
  rows.sort((a, b) => {
    const va = a[k], vb = b[k];
    if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return dir === "asc" ? c : -c;
  });

  $view.innerHTML = `
    <h2>Local authority tables</h2>
    <p class="lede">Every local authority in England. Sort by any column, filter by region, and download the table. The full datasets are on the <a href="#/about">About the data</a> page.</p>
    <div class="controls">
      <label class="control">Quarter<select id="q">${quarterOptions(splitQuarters(), q)}</select></label>
      <label class="control">Region<select id="region"><option value="">All England</option>${REGION_ORDER.map((c) => `<option value="${c}" ${c === region ? "selected" : ""}>${esc(regionName(c))}</option>`).join("")}</select></label>
      <label class="control">Search<input type="search" id="s" value="${esc(search)}" placeholder="Council name"></label>
      <button class="btn" id="dl">Download this table (CSV)</button>
    </div>
    <div class="table-wrap table-scroll"><table>
      <thead><tr>${cols.map(([key, label, cls]) => `<th class="sortable ${cls || ""}" data-key="${key}" ${key === sort ? `aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""} tabindex="0">${esc(label)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="l"><a href="#/la/${r.code}">${esc(r.name)}</a></td><td class="l">${esc(r.region)}</td>
        <td><b>${fmt(r.total)}</b></td><td>${cell("prevention", r.code, q)}</td><td>${cell("relief", r.code, q)}</td>
        <td class="delta">${r.change == null ? "–" : deltaSpan(r.total, r.total - r.change, { pct: false })}</td><td>${fmt(r.last4)}</td>
        <td>${fmtPct(r.shareP)}</td><td>${fmtPct(r.shareR)}</td><td>${fmtRate(r.rate)}</td><td>${fmtPct(r.prevshare, 0)}</td><td>${fmt(r.rough)}</td><td>${fmt(r.support)}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">${rows.length} local authorities. "[x]" = missing: the council did not submit data for this quarter, or MHCLG excluded it for data quality reasons. "Last 12 months" is left blank if any of the four quarters is missing. "Relief share" is left blank for councils with fewer than ${PREV_MIN_BASE} duties in the quarter. Rough sleeping figures are monthly estimates from the Rough Sleeping Data Framework. Asylum support is people receiving Home Office support at the end of ${qLong(D.asylum_support.quarters.at(-1))}.</p>    </div>`;

  document.getElementById("q").addEventListener("change", (e) => setParams({ q: e.target.value === latestQ() ? null : e.target.value }));
  document.getElementById("region").addEventListener("change", (e) => setParams({ region: e.target.value || null }));
  let tmr;
  document.getElementById("s").addEventListener("input", (e) => { clearTimeout(tmr); tmr = setTimeout(() => { setParams({ s: e.target.value || null }); const s = document.getElementById("s"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 300); });
  $view.querySelectorAll("th.sortable").forEach((th) => {
    const go = () => { const key = th.dataset.key; setParams({ sort: key, dir: key === sort && dir === "desc" ? "asc" : key === sort ? "desc" : (key === "name" || key === "region" ? "asc" : "desc") }); };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  document.getElementById("dl").addEventListener("click", () => {
    const head = ["area_code", "local_authority", "region", "quarter", "prevention_duties", "relief_duties", "total_duties", "change_vs_previous_quarter", "total_last_12_months", "share_of_all_prevention_duties", "share_of_all_relief_duties", "per_100_in_asylum_support", "relief_share", `rough_sleeping_${lastMonth}`, "people_in_asylum_support"];
    const lines = [head.join(",")].concat(rows.map((r) => [r.code, `"${r.name}"`, `"${r.region}"`, q, r.prevention ?? "", r.relief ?? "", r.total ?? "", r.change ?? "", r.last4 ?? "", r.shareP != null ? r.shareP.toFixed(4) : "", r.shareR != null ? r.shareR.toFixed(4) : "", r.rate != null ? r.rate.toFixed(2) : "", r.prevshare != null ? r.prevshare.toFixed(3) : "", r.rough ?? "", r.support ?? ""].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `migrant-homelessness-${q}${region ? "-" + regionName(region).replace(/\W+/g, "-").toLowerCase() : ""}.csv` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
};

// ---------------------------------------------------------------- About
VIEWS.about = () => {
  const s = D.meta.sources;
  // Live worked example: the council with the most households owed a duty in the latest quarter
  const lq = latestQ(), ex = rankLAs("total", lq).find((a) => rate(a.code, lq) != null);
  const exN = ex ? hv("total", ex.code, lq) : null, exBase = ex ? rateBase(ex.code, lq) : null;
  const engN = hv("total", ENGLAND, lq), engBase = rateBase(ENGLAND, lq);
  const exY = ex ? sumLast("total", ex.code, lq) : null, exYBase = ex ? avgBaseYear(ex.code, lq) : null;
  const embedBase = location.origin + location.pathname;
  $view.innerHTML = `<div class="prose">
    <h2>About the data</h2>
    <p class="lede">This tracker brings together official statistics about people who become homeless after leaving Home Office asylum accommodation, usually after being granted refugee status and given notice to leave. It follows GOV.UK's release calendar and updates itself on the day new data is published, with a weekly check for corrections.</p>

    <h3>What the measures mean</h3>
    <dl>
      <dt>Prevention duty</dt><dd>The council must help a household that is <i>threatened</i> with homelessness within 56 days. A high share of prevention duties means people are getting help before they lose their accommodation.</dd>
      <dt>Relief duty</dt><dd>The council must help a household that is <i>already</i> homeless to secure accommodation. A high share of relief duties means people are reaching the council only after they have become homeless.</dd>
      <dt>Households leaving Home Office accommodation</dt><dd>Households whose reason for loss, or threat of loss, of their last settled home was recorded as "Required to leave accommodation provided by Home Office as asylum support" (MHCLG tables A2P and A2R). Before April 2020 MHCLG published prevention and relief combined, so only the total is shown for those quarters.</dd>
      <dt>Asylum leavers as a % of all prevention / relief duties</dt><dd>Of all households owed a prevention duty (or a relief duty), for any reason, the percentage who were leaving Home Office asylum accommodation, in the same area and period. It shows how much of a council's homelessness workload comes from people leaving asylum support.</dd>
      <dt>Relief share</dt><dd>The percentage of asylum leaver duties that were relief duties rather than prevention duties: relief ÷ (prevention + relief). Relief duties are owed to households that are <i>already</i> homeless, so a higher relief share means fewer people got help before they lost their accommodation. A lower share suggests councils are intervening earlier, which is the aim of the Homelessness Reduction Act. For councils it is not shown where there were fewer than ${PREV_MIN_BASE} duties in the period, because one or two cases would swing the percentage a lot.</dd>
      <dt>Homelessness duties per 100 people in asylum support</dt><dd>Households owed a homelessness duty after leaving asylum accommodation, per 100 people in asylum support in the same area. <a href="#rate-explainer" onclick="document.getElementById('rate-explainer').scrollIntoView();return false;">How it is calculated and what it does and doesn't show</a>.</dd>
      <dt>Rough sleeping after leaving asylum support</dt><dd>People seen sleeping rough during the month who had left asylum support in the previous 85 days. These are estimates from councils' management information, collected through the Rough Sleeping Data Framework, and are not directly comparable with the statutory homelessness figures.</dd>
      <dt>People in asylum support</dt><dd>People receiving Home Office asylum support (Section 95, Section 4 and Section 98) on the last day of the quarter, by the local authority where they live. Areas with large numbers in support are where future move-on need is likely to arise.</dd>
      <dt>Grants of protection</dt><dd>Initial asylum decisions granting refugee status or humanitarian protection to main applicants (UK-wide). Shown to compare timing with homelessness duties.</dd>
    </dl>

    <h3 id="rate-explainer">How homelessness duties per 100 people in asylum support are calculated</h3>
    <p>The rate is the number of households owed a homelessness duty after leaving Home Office asylum accommodation in a quarter, divided by the number of people in asylum support in the same council area at the start of that quarter, multiplied by 100.</p>
    ${ex ? `<div class="card" style="margin:10px 0">
      <p style="margin:0 0 6px"><b>Worked example: ${esc(ex.name)}, ${qLong(lq)}</b></p>
      <ul style="margin:0;padding-left:20px">
        <li><b>${fmt(exN)}</b> households were owed a prevention or relief duty after being required to leave Home Office asylum accommodation in ${qLong(lq)} (MHCLG tables A2P and A2R).</li>
        <li><b>${fmt(exBase)}</b> people were living in ${esc(ex.name)} on Home Office asylum support at the end of ${qLong(prevQ(lq))}, the start of the quarter (Home Office table Asy_D11).</li>
        <li>${fmt(exN)} ÷ ${fmt(exBase)} × 100 = <b>${fmtRate(rate(ex.code, lq))}</b> households per 100 people in support.</li>
      </ul>
      <p class="note" style="margin-top:8px">For England as a whole: ${fmt(engN)} ÷ ${fmt(engBase)} × 100 = ${fmtRate(rate(ENGLAND, lq))}.</p>
    </div>` : ""}
    <p><b>Why the start of the quarter?</b> The people who leave asylum support during a quarter come from those who were in support at the start of it.</p>
    <p><b>Year-ending rates</b> add up the four quarters' duties and divide by the average of the four start-of-quarter support figures. Because they count a whole year of duties, they are roughly four times the quarterly rates, so don't compare a year-ending rate with a quarterly one.${ex && exY != null && exYBase != null ? ` For ${esc(ex.name)} in the ${yearLabel(lq)}: ${fmt(exY)} ÷ ${fmt(Math.round(exYBase))} × 100 = ${fmtRate(rateYear(ex.code, lq))}.` : ""}</p>

    <h3>What the rate shows</h3>
    <p>It adjusts for how many people in asylum support live in each area. Raw counts mostly follow where asylum accommodation is concentrated, so the largest dispersal areas always come top. The rate shows where homelessness is high <i>relative to</i> that population. A high rate suggests that a larger share of people moving on from support in that area end up needing homelessness help. That could point to weak move-on support, a tight housing market, or people arriving from other areas.</p>

    <h3>What the rate doesn't show</h3>
    <ul>
      <li><b>It isn't the percentage of people who become homeless.</b> The top of the calculation counts <i>households</i>; the bottom counts <i>people</i>. A family of four in support who are owed one duty count once on top and four times underneath.</li>
      <li><b>It uses everyone in support, not just people leaving.</b> Most people in support are not leaving in any given quarter. The Home Office does not publish how many people leave support in each council area, so the number in support is the closest measure available.</li>
      <li><b>People move between areas.</b> Someone can leave support in one council area and approach a different council for help, especially in and around London. That pushes rates up in areas people move to and down in areas they leave.</li>
      <li><b>Small areas are unstable.</b> No rate is shown where fewer than ${RATE_MIN_BASE} people were in support, and even above that a few cases can swing a rate a lot from one quarter to the next.</li>
    </ul>
    <p>Treat it as a rough comparison alongside the raw numbers, not a precise measure.</p>

    <h3>Things to bear in mind</h3>
    <ul>
      <li>MHCLG rounds national and regional figures to the nearest 10. Local authority figures are not rounded, so they will not add up exactly to the regional figures.</li>
      <li>Some councils have quarters marked "[x]" (missing data). MHCLG uses this when a council did not submit its H-CLIC return, or submitted data with quality problems. These are shown as gaps marked "n/a", never as zeros, and annual totals are left blank where a quarter is missing. MHCLG uses "[c]" for figures suppressed to protect households from being identified.</li>
      <li>National and regional totals include MHCLG's estimates for councils with missing data, so they are complete even when a council's own figure is missing.</li>
      <li>MHCLG revises earlier quarters. The tracker always uses the latest version of each quarter's tables, so figures can change slightly after publication.</li>
      <li>The statistics count <i>households</i> owed a duty, not people, and only those who approached a council in England.</li>
      <li>Rough sleeping data are management information, not official statistics, and coverage varies between councils.</li>
    </ul>

    <h3>Sources currently in use</h3>
    <ul>
      <li><a href="${esc(s.homelessness.page)}">${esc(s.homelessness.name)}</a>: latest file "${esc(s.homelessness.latest_file.title)}" (<a href="${esc(s.homelessness.latest_file.url)}">download</a>).</li>
      <li><a href="${esc(s.rough_sleeping.page)}">${esc(s.rough_sleeping.title)}</a>: monthly figures to ${mLong(s.rough_sleeping.latest_month)}.</li>
      <li><a href="${esc(s.asylum_support.page)}">${esc(s.asylum_support.name)}</a>: ${esc(s.asylum_support.title)}.</li>
      <li><a href="${esc(s.grants.page)}">${esc(s.grants.name)}</a>: ${esc(s.grants.title)}.</li>
    </ul>
    <p>Data last checked: ${new Date(D.meta.generated).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" })}.</p>

    <h3 id="downloads">Download the full datasets</h3>
    <p>Long-format CSV files covering every area and period, updated with each release.</p>
    <ul>
      <li><a href="data/homelessness_duties_asylum_support_leavers.csv" download>Homelessness duties owed to households leaving asylum accommodation, by area and quarter (CSV)</a></li>
      <li><a href="data/rough_sleeping_asylum_support_leavers.csv" download>Rough sleeping after leaving asylum support, by area and month (CSV)</a></li>
      <li><a href="data/people_in_asylum_support_by_area.csv" download>People in asylum support, by area and quarter (CSV)</a></li>
      <li><a href="data/data.json">Everything as one JSON file</a> (used by this site)</li>
    </ul>

    <h3>Embedding charts on your website</h3>
    <p>Any page can be embedded without the header and navigation by adding <code>?embed=1</code> to the address. For example, the overview for the North West:</p>
    <pre style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px;font-size:12.5px">&lt;iframe src="${esc(embedBase)}?embed=1#/overview?area=E12000002" width="100%" height="900" style="border:0" title="Migrant homelessness tracker"&gt;&lt;/iframe&gt;</pre>
    <p>Local authority profiles work the same way, for example <code>?embed=1#/la/E08000025</code> for Birmingham.</p>
  </div>`;
};

// ================================================================ boot
async function boot() {
  if (new URLSearchParams(location.search).get("embed")) document.body.classList.add("embed");
  const who = CONFIG.authorUrl ? `<a href="${esc(CONFIG.authorUrl)}">${esc(CONFIG.author)}</a>` : esc(CONFIG.author);
  document.getElementById("footer-org").innerHTML = `Created by ${who} · ${esc(CONFIG.footerLine)}`;
  try {
    D = await (await fetch("data/data.json", { cache: "no-cache" })).json();
  } catch (e) {
    document.getElementById("loading").textContent = "Sorry, the data could not be loaded. Please try again later.";
    return;
  }
  Q = D.homelessness.quarters;
  LAS = Object.entries(D.areas).filter(([, a]) => a.type === "la" && a.current)
    .map(([code, a]) => ({ code, name: a.name, region: a.region })).sort((a, b) => a.name.localeCompare(b.name));
  const m = D.meta;
  document.getElementById("updated").innerHTML =
    `Homelessness data to <b>${qLong(m.latest_quarter)}</b> · Rough sleeping to <b>${mLong(m.sources.rough_sleeping.latest_month)}</b><br><span id="next-release"></span>`;
  // Next scheduled release, from GOV.UK's release calendar (written by pipeline/release_check.py)
  fetch("data/releases.json", { cache: "no-cache" }).then((r) => r.json()).then(({ upcoming }) => {
    const today = new Date().toISOString().slice(0, 10);
    const next = (upcoming || []).find((a) => a.date >= today);
    if (!next) return;
    const d = new Date(next.date + "T12:00:00");
    const when = next.month_only ? d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) + " (provisional)"
      : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const sameDay = upcoming.filter((a) => a.date === next.date && a.month_only === next.month_only).map((a) => a.series.replace(/^(MHCLG|Home Office) /, ""));
    document.getElementById("next-release").innerHTML = `Next update: <a href="${esc(next.url)}">${esc(when)}</a> · ${esc(sameDay.join(" and "))}`;
  }).catch(() => {});
  document.getElementById("loading").remove();
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (Math.abs($view.clientWidth - lastWidth) > 30) render(); }, 200); });
  render();
}
boot();
