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
  total: { label: "Prevention + relief duties", short: "Total duties", color: "var(--accent)" },
  prevention: { label: "Prevention duties", short: "Prevention", color: "var(--prevention)" },
  relief: { label: "Relief duties", short: "Relief", color: "var(--relief)" },
  rate: { label: "Households owed a duty per 100 people in asylum support", short: "Per 100 in support", color: "var(--accent)" },
};

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
const fmtRate = (v) => (v == null ? "–" : v < 10 ? v.toFixed(1) : Math.round(v).toString());

function rankLAs(measure, q, region = null) {
  return LAS.filter((a) => !region || a.region === region)
    .map((a) => ({ ...a, value: measure === "last4" ? sumLast("total", a.code, q) : measure === "rate" ? rate(a.code, q) : hv(measure, a.code, q) }))
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
  const q = latestQ(), pq = prevQ(q), yq = prevQ(q, 4);
  const tot = hv("total", ENGLAND, q), pre = hv("prevention", ENGLAND, q), rel = hv("relief", ENGLAND, q);
  const rs = rsLatest(ENGLAND), sup = supportLatest(ENGLAND);
  const G = D.grants, gi = G.quarters.length - 1;
  const top = rankLAs("total", q).slice(0, 5);
  const share = shareAll(ENGLAND, q);
  const relShare = tot ? rel / tot : null;
  const dirWord = (a, b) => (a == null || b == null || !b ? "" : a > b ? `up ${Math.round(((a - b) / b) * 100)}%` : a < b ? `down ${Math.round(((b - a) / b) * 100)}%` : "unchanged");

  $view.innerHTML = `
  <div class="headline">
    <div class="headline-grid">
      <div>
        <div class="hero-label">Households owed a homelessness duty after being required to leave Home Office asylum accommodation, England, ${qLong(q)}</div>
        <div class="hero">${fmt(tot)}</div>
        <div class="delta">${deltaSpan(tot, hv("total", ENGLAND, pq))} vs previous quarter</div>
        <div class="delta">${deltaSpan(tot, hv("total", ENGLAND, yq))} vs ${qLong(yq)}</div>
      </div>
      <div class="tiles">
        ${tile("Prevention duties", fmt(pre), `${deltaSpan(pre, hv("prevention", ENGLAND, pq))} vs last quarter`, "var(--prevention)")}
        ${tile("Relief duties", fmt(rel), `${deltaSpan(rel, hv("relief", ENGLAND, pq))} vs last quarter`, "var(--relief)")}
        ${tile("Share of all homelessness duties", fmtPct(share), `of ${fmt(hv("total_all", ENGLAND, q))} households owed a duty`)}
        ${tile("Sleeping rough after leaving asylum support", fmt(rs.value), `${rs.month ? mLong(rs.month) : ""} · ${deltaSpan(rs.value, rs.prev, { pct: false })} vs previous month`, "var(--rough)")}
        ${tile("Rate per 100 people in asylum support", fmtRate(rate(ENGLAND, q)), `households owed a duty per 100 people in support at the start of the quarter · ${fmtRate(rate(ENGLAND, pq))} last quarter`)}
        ${tile("People in asylum support (England)", fmt(sup.value), `at end of ${sup.quarter ? qLong(sup.quarter) : ""} · ${deltaSpan(sup.value, sup.prev, { abs: false })} on a year earlier`, "var(--support)")}
        ${tile("Grants of protection (UK)", fmt(G.grants[gi]), `${qLong(G.quarters[gi])}, main applicants · ${deltaSpan(G.grants[gi], G.grants[gi - 1], { abs: false })} vs last quarter`)}
      </div>
    </div>
    <p class="summary">In ${qLong(q)}, councils in England owed a homelessness duty to <b>${fmt(tot)}</b> households because they had to leave Home Office asylum accommodation: ${fmt(pre)} prevention duties and ${fmt(rel)} relief duties.
    That is ${dirWord(tot, hv("total", ENGLAND, pq)) || "–"} on the previous quarter and ${dirWord(tot, hv("total", ENGLAND, yq)) || "–"} on the same quarter last year.
    <b>${fmtPct(relShare, 0)}</b> were already homeless when they were assessed (relief duty), compared with ${fmtPct(hv("relief_all", ENGLAND, q) / hv("total_all", ENGLAND, q), 0)} of all households owed a duty.
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
        <p class="sub">${esc(areaName(area))}, per quarter</p>${legend([["var(--prevention)", "Prevention duties"], ["var(--relief)", "Relief duties"]])}<div class="chart" id="c-duties"></div>
        <p class="embed-source">Source: MHCLG statutory homelessness statistics</p></div>
      <div class="card"><h3>People sleeping rough after leaving asylum support</h3>
        <p class="sub">${esc(areaName(area))}, people seen sleeping rough during the month who had left asylum support in the previous 85 days</p><div class="chart" id="c-rough"></div>
        <p class="note">Estimates from councils' management information (Rough Sleeping Data Framework). Not comparable with the statutory homelessness figures.</p></div>
      <div class="card"><h3>Share of all homelessness duties</h3>
        <p class="sub">Households leaving asylum accommodation as a % of all households owed a prevention or relief duty, ${esc(areaName(area))}</p><div class="chart" id="c-share"></div></div>
      <div class="card"><h3>People in asylum support</h3>
        <p class="sub">${esc(areaName(area))}, people receiving Home Office asylum support at the end of each quarter (Section 95, 4 and 98). This is where future move-on need will arise.</p><div class="chart" id="c-support"></div></div>
      <div class="card"><h3>Rate per 100 people in asylum support</h3>
        <p class="sub">${esc(areaName(area))}, households owed a duty after leaving asylum accommodation per 100 people in asylum support in the area at the start of the quarter</p><div class="chart" id="c-rate"></div>
        <p class="note">People often leave support in one area and approach a council in another, so area rates are a guide, not an exact measure.</p></div>
      <div class="card"><h3>Grants of protection and homelessness duties</h3>
        <p class="sub">Grants of protection (UK, main applicants) compared with households owed a duty after leaving asylum accommodation (England), per quarter</p>
        ${legend([["var(--context)", "Grants of protection (UK)"], ["var(--accent)", "Duties owed (England)"]])}<div class="chart" id="c-grants"></div>
        <p class="note">Different populations: grants are UK-wide and count main applicants, duties are England-only and count households. Shown together to compare timing.</p></div>
    </div>
  </div>

  <div class="section">
    <div class="card"><div class="section-head" style="margin-bottom:4px"><div><h3>Where need is highest, ${qLong(q)}</h3>
        <p class="sub" style="margin:0">${topBy === "rate" ? `Highest number of households owed a duty per 100 people in asylum support (areas with at least ${RATE_MIN_BASE} people in support)` : "Local authorities with the most households owed a duty (prevention + relief)"}</p></div>
        ${seg("top", [["total", "Number"], ["rate", "Rate per 100 in support"]], topBy)}</div>
      <ol class="toplist" id="top10"></ol>
      <p class="note"><a href="#/rankings">See all local authorities →</a> · <a href="#/regions">Top 5 in each region →</a></p></div>
  </div>`;

  document.getElementById("area").addEventListener("change", (e) => setParams({ area: e.target.value === ENGLAND ? null : e.target.value }));
  onSeg($view, "range", (v) => setParams({ range: v === "3y" ? null : v }));

  const qs = range === "all" ? splitQuarters() : Q.slice(-12);
  columnChart(document.getElementById("c-duties"), {
    labels: qs.map(qShort), tipLabels: qs.map(qLong),
    series: [
      { name: "Prevention duties", color: "var(--prevention)", values: qs.map((x) => hv("prevention", area, x)), flags: qs.map((x) => flagOf("prevention", area, x)) },
      { name: "Relief duties", color: "var(--relief)", values: qs.map((x) => hv("relief", area, x)), flags: qs.map((x) => flagOf("relief", area, x)) },
    ],
    onClick: null,
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
    series: [{ name: "Share of all duties", color: "var(--accent)", values: qsAll.map((x) => shareAll(area, x)) }],
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
  topList(document.getElementById("top10"), rankLAs(topBy, q).slice(0, 10), q, topBy, true);
};

function tile(label, value, delta, color) {
  return `<div class="tile"><div class="label">${color ? `<i class="key" style="background:${color}"></i>` : ""}${esc(label)}</div>
    <div class="value">${value}</div><div class="delta">${delta}</div></div>`;
}

function topList(el, items, q, measure, showRegion = false) {
  const max = d3.max(items, (d) => d.value) || 1;
  el.innerHTML = items.length ? items.map((a, i) => {
    if (measure === "rate") {
      const n = hv("total", a.code, q), base = rateBase(a.code, q);
      return `<li><span class="rank">${i + 1}</span><a href="#/la/${a.code}" title="${esc(a.name)}">${esc(a.name)}${showRegion ? ` <span class="muted" style="font-size:12px">${esc(regionName(a.region))}</span>` : ""}</a>
        <span class="num">${fmtRate(a.value)}<span class="chg delta" style="color:var(--ink-2)">${fmt(n)} of ${fmt(base)}</span></span>
        <span class="bar"><i style="width:${(a.value / max) * 100}%"></i></span></li>`;
    }
    const prev = measure === "last4" ? sumLast("total", a.code, prevQ(q)) : hv(measure, a.code, prevQ(q));
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
    <p class="lede">How each region compares, and the five local authorities with the highest numbers in each region. Select a quarter and measure; click a local authority to see its profile.</p>
    <div class="controls">
      <label class="control">Quarter<select id="q">${quarterOptions(qList, q)}</select></label>
      <div class="control">Measure${seg("m", [["total", "Prevention + relief"], ["prevention", "Prevention"], ["relief", "Relief"], ["rate", "Rate per 100 in support"]], measure)}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">Area</th><th>${esc(MEASURES[measure].short)}, ${qShort(q)}</th><th>vs previous quarter</th><th>vs ${qShort(yq)}</th><th>Share of all duties</th><th>Relief as % of total</th>${measure === "rate" ? "" : "<th>Per 100 in support</th>"}<th class="l">Last 12 quarters</th></tr></thead>
      <tbody>${rows.map((c) => {
        const v = mv(c, q);
        const t = hv("total", c, q), r = hv("relief", c, q);
        const sep = c === REST ? ' style="border-bottom:2px solid var(--axis)"' : "";
        return `<tr${sep}><td class="l"><a href="#/overview?area=${c}">${c === ENGLAND ? "<b>England</b>" : esc(areaName(c))}</a></td><td><b>${mf(v)}</b></td>
          <td class="delta">${md(v, mv(c, pq))}</td><td class="delta">${md(v, mv(c, yq))}</td>
          <td>${fmtPct(shareAll(c, q))}</td><td>${t && r != null ? fmtPct(r / t, 0) : "–"}</td>${measure === "rate" ? "" : `<td>${fmtRate(rate(c, q))}</td>`}
          <td class="l">${sparkline(spanQ.map((x) => mv(c, x)), { color: MEASURES[measure].color })}</td></tr>`;
      }).join("")}</tbody></table></div>
    <p class="note">London and Rest of England are shown separately as well as within the regional list. Regional figures are rounded to the nearest 10; local authority figures are not rounded, so they may not add up to regional totals. "Per 100 in support" = households owed a duty per 100 people in asylum support in the area at the start of the quarter.</p>

    <div class="section">
      <h2>Top 5 local authorities in each region, ${qLong(q)}</h2>
      <p class="lede">${measure === "rate" ? `Households owed a duty after leaving asylum accommodation per 100 people in asylum support at the start of the quarter. Only areas with at least ${RATE_MIN_BASE} people in support are ranked; the small figures show households and people in support.` : `${esc(MEASURES[measure].label)} for households required to leave Home Office asylum accommodation. Change shown against the previous quarter.`}</p>
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
      ${tile("Prevention duties", latestMissing ? notSubmitted : fmt(p), latestMissing ? "" : `${deltaSpan(p, hv("prevention", code, pq), { pct: false })} vs last quarter`, "var(--prevention)")}
      ${tile("Relief duties", latestMissing ? notSubmitted : fmt(r), latestMissing ? "" : `${deltaSpan(r, hv("relief", code, pq), { pct: false })} vs last quarter`, "var(--relief)")}
      ${tile("Rank this quarter", rank ? `${rank} <span style="font-size:14px;font-weight:400;color:var(--ink-2)">of ${all.length}</span>` : "–", rankR ? `${ordinal(rankR)} of ${inReg.length} in ${esc(regionName(a.region))}` : "Not ranked: no data this quarter")}
      ${tile("Last 12 months", last12 == null ? notSubmitted.replace("Not submitted", "Incomplete") : fmt(last12),
        last12 == null ? `Missing data for ${missingIn(code, q).map(qShort).join(", ") || "a quarter"}` : `${deltaSpan(last12, sumLast("total", code, yq))} vs year before`)}
      ${tile("Share of all duties in this area", fmtPct(shareAll(code, q)), `England: ${fmtPct(shareAll(ENGLAND, q))}`)}
      ${tile("Rate per 100 people in asylum support", fmtRate(rate(code, q)),
        rate(code, q) != null ? `${fmt(t)} households / ${fmt(rateBase(code, q))} people in support · England: ${fmtRate(rate(ENGLAND, q))}`
          : (rateBase(code, q) ?? 0) < RATE_MIN_BASE ? `Not calculated: fewer than ${RATE_MIN_BASE} people in support here` : "No data this quarter")}
      ${tile("Sleeping rough after leaving asylum support", fmt(rs.value), rs.month ? mLong(rs.month) : "No data", "var(--rough)")}
      ${tile("People in asylum support here", fmt(sup.value), sup.quarter ? `end of ${qLong(sup.quarter)} · ${deltaSpan(sup.value, sup.prev, { abs: false })} on a year earlier` : "None reported", "var(--support)")}
    </div>
    <div class="section"><div class="section-head"><h2>Trends</h2><div class="control no-embed">${seg("range", [["3y", "Last 3 years"], ["all", "All"]], range)}</div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Households owed a duty after leaving Home Office accommodation</h3><p class="sub">${esc(a.name)}, per quarter</p>
        ${legend([["var(--prevention)", "Prevention duties"], ["var(--relief)", "Relief duties"]])}<div class="chart" id="c-duties"></div>
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
      { name: "Prevention duties", color: "var(--prevention)", values: qs.map((x) => hv("prevention", code, x)), flags: qs.map((x) => flagOf("prevention", code, x)) },
      { name: "Relief duties", color: "var(--relief)", values: qs.map((x) => hv("relief", code, x)), flags: qs.map((x) => flagOf("relief", code, x)) },
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
  document.getElementById("la-table").innerHTML = `<thead><tr><th class="l">Quarter</th><th>Prevention</th><th>Relief</th><th>Total</th><th>All duties (any reason)</th><th>Share</th></tr></thead><tbody>${
    tq.map((x) => `<tr><td class="l">${qLong(x)}</td><td>${cell("prevention", code, x)}</td><td>${cell("relief", code, x)}</td><td><b>${cell("total", code, x)}</b></td><td>${fmt(hv("total_all", code, x))}</td><td>${fmtPct(shareAll(code, x))}</td></tr>`).join("")}</tbody>
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
const MAP_MEASURES = {
  total: { label: "Households owed a duty (prevention + relief), quarter", quarterly: true },
  prevention: { label: "Prevention duties, quarter", quarterly: true },
  relief: { label: "Relief duties, quarter", quarterly: true },
  last4: { label: "Households owed a duty, last 12 months", quarterly: true },
  rate: { label: "Households owed a duty per 100 people in asylum support, quarter", quarterly: true },
  rough: { label: "Sleeping rough after leaving asylum support, latest month", quarterly: false },
  support: { label: "People in asylum support, latest quarter", quarterly: false },
};
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

function niceBreaks(values) {
  const pos = values.filter((v) => v > 0).sort(d3.ascending);
  if (!pos.length) return [1];
  const qs = [0.3, 0.5, 0.7, 0.85, 0.95].map((p) => d3.quantileSorted(pos, p));
  const nice = (v) => { if (v < 10) return Math.ceil(v); const m = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / (m / 2)) * (m / 2); };
  return [...new Set([1, ...qs.map(nice)])].sort(d3.ascending);
}

VIEWS.map = async ({ params }) => {
  const measure = MAP_MEASURES[params.get("m")] ? params.get("m") : "total";
  const qList = measure === "total" || measure === "last4" ? Q : measure === "rate" ? Q.filter((x) => D.asylum_support.quarters.includes(prevQ(x))) : splitQuarters();
  let q = params.get("q"); if (!qList.includes(q)) q = latestQ();
  const region = params.get("region") || "";
  const focus = params.get("focus");
  const valueOf = (code) => {
    if (measure === "rough") return rsLatest(code).value;
    if (measure === "support") return supportLatest(code).value ?? 0;
    if (measure === "last4") return sumLast("total", code, q);
    if (measure === "rate") return rate(code, q);
    return hv(measure, code, q);
  };
  const when = measure === "rough" ? mLong(D.rough_sleeping.months.at(-1)) : measure === "support" ? "end of " + qLong(D.asylum_support.quarters.at(-1)) : measure === "last4" ? `${qShort(prevQ(q, 3))} to ${qShort(q)}` : qLong(q);

  $view.innerHTML = `
    <h2>Map</h2>
    <p class="lede">Where people leaving asylum accommodation are presenting as homeless. Hover over an area for its figures, click to open its profile.</p>
    <div class="controls">
      <label class="control">Measure<select id="m">${Object.entries(MAP_MEASURES).map(([k, v]) => `<option value="${k}" ${k === measure ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      ${MAP_MEASURES[measure].quarterly ? `<label class="control">Quarter<select id="q">${quarterOptions(qList, q)}</select></label>` : ""}
      <label class="control">Zoom to region<select id="region"><option value="">All England</option>${REGION_ORDER.map((c) => `<option value="${c}" ${c === region ? "selected" : ""}>${esc(regionName(c))}</option>`).join("")}</select></label>
    </div>
    <div class="map-layout">
      <div class="card map"><div id="map" style="width:100%"></div>
        <div id="scale" class="scale"></div><p class="note">${esc(MAP_MEASURES[measure].label.split(",")[0])}, ${esc(when)}. Grey = none recorded. Hatched = no data (the council did not submit${measure === "rate" ? `, or fewer than ${RATE_MIN_BASE} people were in asylum support there` : ", or, for 12-month totals, a quarter is missing"}). Boundaries: ONS, December 2024.</p></div>
      <div class="card"><div id="map-info"><h3>${region ? esc(regionName(region)) : "England"}: highest</h3><ol class="toplist" id="map-top"></ol></div></div>
    </div>`;
  document.getElementById("m").addEventListener("change", (e) => setParams({ m: e.target.value === "total" ? null : e.target.value }));
  document.getElementById("q")?.addEventListener("change", (e) => setParams({ q: e.target.value === latestQ() ? null : e.target.value }));
  document.getElementById("region").addEventListener("change", (e) => setParams({ region: e.target.value || null, focus: null }));

  const $map = document.getElementById("map");
  if (!GEO) {
    $map.innerHTML = `<p class="empty">Loading map…</p>`;
    try { GEO = await (await fetch("data/la_boundaries.geojson")).json(); }
    catch { $map.innerHTML = `<p class="empty">Map boundaries could not be loaded.</p>`; return; }
    if (parseRoute().view !== "map") return;
  }
  const values = new Map(GEO.features.map((f) => [f.properties.code, valueOf(f.properties.code)]));
  const isRate = measure === "rate";
  // Rates are continuous: bands start at 0 and are labelled "a–b"; counts use whole-number bands.
  const breaks = isRate ? [0.0001, ...niceBreaks([...values.values()].filter((v) => v != null)).slice(1)] : niceBreaks([...values.values()].filter((v) => v != null));
  // spread however many classes there are evenly across the ramp (light -> dark)
  const color = (v) => {
    if (v == null) return "url(#missing-hatch)";
    if (v <= 0) return "var(--zero)";
    const idx = Math.max(0, d3.bisectRight(breaks, v) - 1);
    return RAMP[breaks.length > 1 ? Math.round((idx * (RAMP.length - 1)) / (breaks.length - 1)) : RAMP.length - 1];
  };
  // legend
  const classes = breaks.map((b, i) => [b, breaks[i + 1] ? (isRate ? breaks[i + 1] : breaks[i + 1] - 1) : null]);
  const bandLabel = (lo, hi) => isRate ? (hi == null ? `${fmtRate(lo)}+` : `${lo < 0.001 ? "0" : fmtRate(lo)}–${fmtRate(hi)}`)
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
        tipRow(null, MAP_MEASURES[measure].label.split(",")[0], v == null ? (isRate ? (hv("total", c, q) == null ? "not submitted" : `under ${RATE_MIN_BASE} in support`) : MAP_MEASURES[measure].quarterly ? "not submitted" : "no data") : isRate ? fmtRate(v) : fmt(v)) +
        (MAP_MEASURES[measure].quarterly && measure !== "last4" ? tipRow("var(--prevention)", "Prevention", fmt(hv("prevention", c, q))) + tipRow("var(--relief)", "Relief", fmt(hv("relief", c, q))) : "") +
        tipRow("var(--support)", "In asylum support", fmt(supportLatest(c).value ?? 0)), ev);
    })
    .on("mouseleave", hideTip)
    .on("click", (ev, f) => { if (D.areas[f.properties.code]) location.hash = `#/la/${f.properties.code}`; });
  svg.select("path.sel").raise();

  const ranked = LAS.filter((a) => !region || a.region === region).map((a) => ({ ...a, value: valueOf(a.code) }))
    .filter((a) => a.value > 0).sort((a, b) => b.value - a.value).slice(0, 15);
  const max = ranked[0]?.value || 1;
  document.getElementById("map-top").innerHTML = ranked.map((a, i) => `<li><span class="rank">${i + 1}</span><a href="#/la/${a.code}">${esc(a.name)}</a><span class="num">${isRate ? fmtRate(a.value) : fmt(a.value)}</span><span class="bar"><i style="width:${(a.value / max) * 100}%"></i></span></li>`).join("") || `<li class="muted">None recorded</li>`;
};

// ---------------------------------------------------------------- Rankings & data
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
    ["total", `Total ${qShort(q)}`], ["prevention", "Prevention"], ["relief", "Relief"],
    ["change", "Change vs prev. quarter"], ["last4", "Last 12 months"], ["share", "Share of all duties"], ["rate", "Per 100 in asylum support"],
    ["rough", `Rough sleeping ${mShort(lastMonth)}`], ["support", "In asylum support"],
  ];
  let rows = LAS.filter((a) => (!region || a.region === region) && (!search || a.name.toLowerCase().includes(search.toLowerCase()))).map((a) => {
    const t = hv("total", a.code, q), tp = hv("total", a.code, pq);
    return {
      code: a.code, name: a.name, region: regionName(a.region), total: t,
      prevention: hv("prevention", a.code, q), relief: hv("relief", a.code, q),
      change: t != null && tp != null ? t - tp : null, last4: sumLast("total", a.code, q), share: shareAll(a.code, q), rate: rate(a.code, q),
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
    <h2>Rankings &amp; data</h2>
    <p class="lede">Every local authority in England. Sort by any column, filter by region, and download the figures.</p>
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
        <td>${fmtPct(r.share)}</td><td>${fmtRate(r.rate)}</td><td>${fmt(r.rough)}</td><td>${fmt(r.support)}</td></tr>`).join("")}</tbody></table></div>
    <p class="note">${rows.length} local authorities. "[x]" = missing: the council did not submit data for this quarter, or MHCLG excluded it for data quality reasons. "Last 12 months" is left blank if any of the four quarters is missing. Rough sleeping figures are monthly estimates from the Rough Sleeping Data Framework. Asylum support is people receiving Home Office support at the end of ${qLong(D.asylum_support.quarters.at(-1))}.</p>

    <div class="section card">
      <h3>Download the full datasets</h3>
      <p class="sub">Long-format CSV files covering every area and period, updated with each release.</p>
      <ul>
        <li><a href="data/homelessness_duties_asylum_support_leavers.csv" download>Homelessness duties owed to households leaving asylum accommodation, by area and quarter (CSV)</a></li>
        <li><a href="data/rough_sleeping_asylum_support_leavers.csv" download>Rough sleeping after leaving asylum support, by area and month (CSV)</a></li>
        <li><a href="data/people_in_asylum_support_by_area.csv" download>People in asylum support, by area and quarter (CSV)</a></li>
        <li><a href="data/data.json">Everything as one JSON file</a> (used by this site)</li>
      </ul>
    </div>`;

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
    const head = ["area_code", "local_authority", "region", "quarter", "prevention_duties", "relief_duties", "total_duties", "change_vs_previous_quarter", "total_last_12_months", "share_of_all_duties", "per_100_in_asylum_support", `rough_sleeping_${lastMonth}`, "people_in_asylum_support"];
    const lines = [head.join(",")].concat(rows.map((r) => [r.code, `"${r.name}"`, `"${r.region}"`, q, r.prevention ?? "", r.relief ?? "", r.total ?? "", r.change ?? "", r.last4 ?? "", r.share != null ? r.share.toFixed(4) : "", r.rate != null ? r.rate.toFixed(2) : "", r.rough ?? "", r.support ?? ""].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `migrant-homelessness-${q}${region ? "-" + regionName(region).replace(/\W+/g, "-").toLowerCase() : ""}.csv` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
};

// ---------------------------------------------------------------- About
VIEWS.about = () => {
  const s = D.meta.sources;
  const embedBase = location.origin + location.pathname;
  $view.innerHTML = `<div class="prose">
    <h2>About the data</h2>
    <p class="lede">This tracker brings together official statistics about people who become homeless after leaving Home Office asylum accommodation, usually after being granted refugee status and given notice to leave. It follows GOV.UK's release calendar and updates itself on the day new data is published, with a weekly check for corrections.</p>

    <h3>What the measures mean</h3>
    <dl>
      <dt>Prevention duty</dt><dd>The council must help a household that is <i>threatened</i> with homelessness within 56 days. A high share of prevention duties means people are getting help before they lose their accommodation.</dd>
      <dt>Relief duty</dt><dd>The council must help a household that is <i>already</i> homeless to secure accommodation. A high share of relief duties means people are reaching the council only after they have become homeless.</dd>
      <dt>Households leaving Home Office accommodation</dt><dd>Households whose reason for loss, or threat of loss, of their last settled home was recorded as "Required to leave accommodation provided by Home Office as asylum support" (MHCLG tables A2P and A2R). Before April 2020 MHCLG published prevention and relief combined, so only the total is shown for those quarters.</dd>
      <dt>Share of all duties</dt><dd>These households as a percentage of all households owed a prevention or relief duty, for any reason, in the same area and quarter.</dd>
      <dt>Rate per 100 people in asylum support</dt><dd>Households owed a duty after leaving asylum accommodation in a quarter, per 100 people receiving asylum support in the same area at the start of that quarter (the end of the previous quarter). It shows where homelessness is high <i>relative to</i> the number of people in support, not just where numbers are biggest. It is not calculated for areas with fewer than 50 people in support, where a handful of cases would give misleading rates. People often leave support in one area and approach a council in another, especially in and around London, so area rates are a guide. The rate also mixes households (duties) with people (support), so it is not the percentage of people leaving support who become homeless.</dd>
      <dt>Rough sleeping after leaving asylum support</dt><dd>People seen sleeping rough during the month who had left asylum support in the previous 85 days. These are estimates from councils' management information, collected through the Rough Sleeping Data Framework, and are not directly comparable with the statutory homelessness figures.</dd>
      <dt>People in asylum support</dt><dd>People receiving Home Office asylum support (Section 95, Section 4 and Section 98) on the last day of the quarter, by the local authority where they live. Areas with large numbers in support are where future move-on need is likely to arise.</dd>
      <dt>Grants of protection</dt><dd>Initial asylum decisions granting refugee status or humanitarian protection to main applicants (UK-wide). Shown to compare timing with homelessness duties.</dd>
    </dl>

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
