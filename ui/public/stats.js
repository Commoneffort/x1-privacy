// X1 Privacy — statistics page.
// Reads /stats.json (written by indexer/index-stats.mjs from public chain history)
// and draws it. No wallet, no keys, no third-party code.
const NS = "http://www.w3.org/2000/svg";
const HOUR = 3600e3, DAY = 86400e3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANGES = ["24h", "7d", "30d", "all"];
const REFRESH_MS = 60e3, STALE_S = 1800;

let data = null, token = null, range = null;

// ---- small helpers
const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
function s(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
const int = (n) => Number(n).toLocaleString("en-US");

// exact amount from base units (BigInt), e.g. "1431955900", 9 -> "1.4319"
function fmtBase(str, dec) {
  const v = BigInt(str || "0"), base = 10n ** BigInt(dec);
  const whole = v / base;
  const places = whole >= 1000n ? 2 : 4;
  const frac = (v % base).toString().padStart(dec, "0").slice(0, places).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
const toNum = (str, dec) => Number(str || "0") / 10 ** dec;
function fmtVal(n) {
  const a = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 2 : a >= 1 ? 4 : 6 });
}
function fmtAxis(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return +(n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return +(n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return +(n / 1e3).toFixed(2) + "k";
  if (a >= 1 || a === 0) return String(+n.toFixed(2));
  return String(+n.toPrecision(2));
}
function niceTicks(max, whole) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  let step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  if (whole) step = Math.max(1, Math.round(step));
  const out = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(+v.toPrecision(12));
  return out;
}
const pad = (n) => String(n).padStart(2, "0");
const dayLabel = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
const hourLabel = (d) => `${pad(d.getUTCHours())}:00`;

// ---- turn the published hourly / daily rows into the buckets of the chosen period
function buckets(t) {
  const now = Date.now();
  let step, count, start, rows, parse;
  const hourly = () => { rows = t.hourly; parse = (r) => Date.parse(r.t + ":00:00Z"); };
  const daily = () => { rows = t.daily; parse = (r) => Date.parse(r.t + "T00:00:00Z"); };
  if (range === "24h") { step = HOUR; count = 24; hourly(); }
  else if (range === "7d") { step = 6 * HOUR; count = 28; hourly(); }
  else if (range === "30d") { step = DAY; count = 30; daily(); }
  else {
    daily();
    const first = rows.length ? parse(rows[0]) : now;
    const days = Math.max(7, Math.floor((now - first) / DAY) + 1);
    const k = Math.ceil(days / 60);
    step = k * DAY; count = Math.ceil(days / k);
  }
  start = (Math.floor(now / step) + 1) * step - count * step;
  const out = [];
  for (let i = 0; i < count; i++) out.push({ start: start + i * step, end: start + (i + 1) * step, wrapped: 0, unwrapped: 0, fees: 0, wraps: 0, unwraps: 0, transfers: 0 });
  for (const r of rows) {
    const i = Math.floor((parse(r) - start) / step);
    if (i < 0 || i >= count) continue;
    const b = out[i];
    b.wrapped += toNum(r.wrapped, t.decimals); b.unwrapped += toNum(r.unwrapped, t.decimals); b.fees += toNum(r.fees, t.decimals);
    b.wraps += r.wraps; b.unwraps += r.unwraps; b.transfers += r.transfers;
  }
  // currently wrapped at the end of each bucket, walking back from the live on-chain supply
  let sup = toNum(t.supply, t.decimals);
  for (let i = count - 1; i >= 0; i--) {
    out[i].supply = Math.max(0, sup);
    sup -= out[i].wrapped - out[i].fees - out[i].unwrapped;
  }
  out.before = Math.max(0, sup);
  out.step = step;
  for (const b of out) {
    const d = new Date(b.start), e = new Date(b.end - 1);
    b.label = step < DAY ? `${dayLabel(d)}, ${hourLabel(d)}–${pad((d.getUTCHours() + step / HOUR) % 24)}:00 UTC`
      : step === DAY ? `${dayLabel(d)}, ${d.getUTCFullYear()}` : `${dayLabel(d)} – ${dayLabel(e)}, ${e.getUTCFullYear()}`;
  }
  return out;
}

// which buckets get an x-axis label
function xLabels(bs) {
  const out = [], n = bs.length;
  bs.forEach((b, i) => {
    const d = new Date(b.start);
    if (bs.step === HOUR) { if (d.getUTCHours() % 4 === 0) out.push([i, hourLabel(d)]); }
    else if (bs.step < DAY) { if (d.getUTCHours() === 0) out.push([i, dayLabel(d)]); }
    else { const every = Math.ceil(n / 7); if ((n - 1 - i) % every === 0) out.push([i, dayLabel(d)]); }
  });
  return out;
}

// ---- chart frame shared by every chart: axes, grid, x labels, hover bands, tooltip
function frame(host, bs, max, opts = {}) {
  host.replaceChildren();
  const W = Math.max(300, host.clientWidth), H = opts.height || 250;
  const m = { l: 46, r: 10, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.title || "chart" });
  const ticks = niceTicks(max, opts.whole);
  const top = ticks[ticks.length - 1];
  const y = (v) => m.t + ph - (v / top) * ph;
  const band = pw / bs.length;
  const x = (i) => m.l + i * band;
  for (const v of ticks) {
    svg.append(s("line", { class: v === 0 ? "axis" : "grid", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.append(s("text", { class: "tick", x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, fmtAxis(v)));
  }
  for (const [i, text] of xLabels(bs)) {
    const cx = opts.edge || (bs.step > HOUR && bs.step < DAY) ? x(i) : x(i) + band / 2; // day labels sit on midnight
    svg.append(s("text", { class: "tick", x: cx, y: H - 6, "text-anchor": "middle" }, text));
  }
  const marks = s("g"), hover = s("g");
  svg.append(marks, hover);
  const tip = h("div", { class: "tip" });
  host.append(svg, tip);
  const showTip = (i, rows, px) => {
    tip.replaceChildren(h("b", { text: bs[i].label }));
    for (const [cls, name, value] of rows) tip.append(h("div", {}, h("span", { class: "sw " + cls }), name, h("i", { text: value })));
    tip.classList.add("on");
    const w = tip.offsetWidth, scale = host.clientWidth / W;
    let left = px * scale + 14;
    if (left + w > host.clientWidth - 4) left = px * scale - w - 14;
    tip.style.left = Math.max(4, left) + "px";
  };
  const hideTip = () => tip.classList.remove("on");
  if (!bs.some((b) => opts.has(b))) {
    svg.append(s("text", { class: "none", x: m.l + pw / 2, y: m.t + ph / 2, "text-anchor": "middle" }, "No activity in this period"));
  }
  return { svg, marks, hover, x, y, band, m, W, H, ph, pw, showTip, hideTip };
}
// a bar with a rounded data end and a square foot on the baseline
function bar(cls, x, yTop, w, hgt, round = true) {
  const r = round ? Math.min(4, w / 2, hgt) : 0;
  return s("path", { class: cls, d: `M${x},${yTop + hgt}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + hgt}Z` });
}
function bands(f, bs, rowsOf) {
  bs.forEach((b, i) => {
    const r = s("rect", { class: "band", x: f.x(i), y: f.m.t, width: f.band, height: f.ph });
    r.addEventListener("pointerenter", () => { r.classList.add("on"); f.showTip(i, rowsOf(b), f.x(i) + f.band / 2); });
    r.addEventListener("pointerleave", () => { r.classList.remove("on"); f.hideTip(); });
    f.hover.append(r);
  });
}

function volumeChart(t, bs) {
  const max = Math.max(...bs.map((b) => Math.max(b.wrapped, b.unwrapped)));
  const f = frame($("volPlot"), bs, max, { title: "Wrapped and unwrapped amounts", has: (b) => b.wrapped || b.unwrapped });
  const gap = 2, w = Math.max(2, Math.min(24, (f.band - gap - 4) / 2));
  bs.forEach((b, i) => {
    const cx = f.x(i) + f.band / 2;
    for (const [cls, v, x0] of [["f-wrap", b.wrapped, cx - gap / 2 - w], ["f-unwrap", b.unwrapped, cx + gap / 2]]) {
      if (!(v > 0)) continue;
      const hgt = Math.max(2, f.y(0) - f.y(v));
      f.marks.append(bar(cls, x0, f.y(0) - hgt, w, hgt));
    }
  });
  bands(f, bs, (b) => [["wrap", "Wrapped", `${fmtVal(b.wrapped)} ${t.backingSymbol}`], ["unwrap", "Unwrapped", `${fmtVal(b.unwrapped)} ${t.backingSymbol}`]]);
}

function activityChart(bs) {
  const max = Math.max(...bs.map((b) => b.wraps + b.unwraps + b.transfers));
  const f = frame($("actPlot"), bs, max, { title: "Number of wraps, unwraps and confidential transfers", whole: true, height: 230, has: (b) => b.wraps + b.unwraps + b.transfers });
  const w = Math.max(3, Math.min(24, f.band - 6));
  bs.forEach((b, i) => {
    const x0 = f.x(i) + (f.band - w) / 2;
    const parts = [["f-wrap", b.wraps], ["f-unwrap", b.unwraps], ["f-transfer", b.transfers]].filter((p) => p[1] > 0);
    let base = 0;
    parts.forEach(([cls, v], k) => {
      const y0 = f.y(base), y1 = f.y(base + v), last = k === parts.length - 1;
      // 2px of surface between stacked segments; only the top of the stack is rounded
      const hgt = Math.max(1, y0 - y1 - (last ? 0 : 2));
      f.marks.append(bar(cls, x0, y0 - (y0 - y1) + (last ? 0 : 2), w, hgt, last));
      base += v;
    });
  });
  bands(f, bs, (b) => [["wrap", "Wraps", int(b.wraps)], ["unwrap", "Unwraps", int(b.unwraps)], ["transfer", "Confidential transfers", int(b.transfers)]]);
}

function supplyChart(t, bs) {
  const pts = [{ v: bs.before, i: 0 }, ...bs.map((b, i) => ({ v: b.supply, i: i + 1 }))]; // values at bucket edges
  const max = Math.max(...pts.map((p) => p.v));
  const f = frame($("supPlot"), bs, max, { title: "Currently wrapped over time", edge: true, has: () => max > 0 });
  const px = (p) => f.x(p.i), py = (p) => f.y(p.v);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join("");
  f.marks.append(s("path", { class: "a-supply", d: `${line}L${px(pts[pts.length - 1])},${f.y(0)}L${px(pts[0])},${f.y(0)}Z` }));
  f.marks.append(s("path", { class: "l-supply", d: line }));
  const cross = s("line", { class: "cross", y1: f.m.t, y2: f.y(0), visibility: "hidden" });
  const dot = s("circle", { class: "pt", r: 4.5, visibility: "hidden" });
  f.marks.append(cross, dot);
  const area = s("rect", { class: "band", x: f.m.l, y: f.m.t, width: f.pw, height: f.ph });
  area.addEventListener("pointermove", (ev) => {
    const box = f.svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * f.W;
    const k = Math.max(1, Math.min(bs.length, Math.round((sx - f.m.l) / f.band)));
    const p = pts[k];
    cross.setAttribute("x1", px(p)); cross.setAttribute("x2", px(p)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px(p)); dot.setAttribute("cy", py(p)); dot.setAttribute("visibility", "visible");
    f.showTip(k - 1, [["supply", "Wrapped at end of period", `${fmtVal(p.v)} ${t.symbol}`]], px(p));
  });
  area.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); f.hideTip(); });
  f.hover.append(area);
}

// ---- tables
function table(el, head, rows) {
  el.replaceChildren(h("thead", {}, h("tr", {}, ...head.map((x) => h("th", { text: x, scope: "col" })))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((x) => h("td", { text: x }))))));
}

// ---- page
function setNum(id, value, unit) {
  const e = $(id);
  e.replaceChildren(value);
  if (unit) e.append(h("small", { text: unit }));
}
const RANGE_TEXT = { "24h": "per hour, last 24 hours", "7d": "per 6 hours, last 7 days", "30d": "per day, last 30 days", all: "since launch" };

function render() {
  if (!data) return;
  const t = data.tokens[token];
  if (!$("kSupply")) $("content").replaceChildren($("tpl").content.cloneNode(true));
  for (const b of $("tokenSeg").children) b.setAttribute("aria-pressed", String(b.dataset.token === token));
  for (const b of $("rangeSeg").children) b.setAttribute("aria-pressed", String(b.dataset.range === range));
  history.replaceState(null, "", `#${token}/${range}`);

  setNum("kSupply", fmtBase(t.supply, t.decimals), t.symbol);
  const backed = t.reserve != null && BigInt(t.reserve) >= BigInt(t.supply || "0");
  $("kBacking").textContent = t.reserve == null ? "reserve unavailable"
    : `Reserve holds ${fmtBase(t.reserve, t.decimals)} ${t.backingSymbol}${backed ? " — fully backed" : ""}`;
  setNum("kWrapped", fmtBase(t.wrapped, t.decimals), t.backingSymbol);
  $("kWraps").textContent = `in ${int(t.wraps)} wrap${t.wraps === 1 ? "" : "s"}`;
  setNum("kUnwrapped", fmtBase(t.unwrapped, t.decimals), t.backingSymbol);
  $("kUnwraps").textContent = `in ${int(t.unwraps)} unwrap${t.unwraps === 1 ? "" : "s"}`;
  setNum("kTransfers", int(t.transfers));
  setNum("mWraps", int(t.wraps)); setNum("mUnwraps", int(t.unwraps));
  setNum("mAccounts", int(t.accounts)); setNum("mWallets", int(t.wallets));
  setNum("mFees", fmtBase(t.fees, t.decimals), t.backingSymbol);

  const bs = buckets(t);
  $("volDesc").textContent = `${t.backingSymbol} ${RANGE_TEXT[range]}`;
  $("supDesc").textContent = `${t.symbol} in circulation, ${range === "all" ? "since launch" : RANGE_TEXT[range].split(", ")[1]}`;
  $("actDesc").textContent = `Number of operations ${RANGE_TEXT[range]}`;
  volumeChart(t, bs); supplyChart(t, bs); activityChart(bs);

  table($("periodTable"), ["Period (UTC)", `Wrapped (${t.backingSymbol})`, `Unwrapped (${t.backingSymbol})`, "Wraps", "Unwraps", "Transfers", `Wrapped at end (${t.symbol})`],
    [...bs].reverse().map((b) => [b.label, fmtVal(b.wrapped), fmtVal(b.unwrapped), int(b.wraps), int(b.unwraps), int(b.transfers), fmtVal(b.supply)]));
  table($("tokenTable"), ["Token", "Currently wrapped", "Total wrapped", "Total unwrapped", "Wraps", "Unwraps", "Transfers", "Accounts", "Wallets"],
    Object.values(data.tokens).map((x) => [x.symbol, fmtBase(x.supply, x.decimals), `${fmtBase(x.wrapped, x.decimals)} ${x.backingSymbol}`,
      `${fmtBase(x.unwrapped, x.decimals)} ${x.backingSymbol}`, int(x.wraps), int(x.unwraps), int(x.transfers), int(x.accounts), int(x.wallets)]));
  stamp();
}

function stamp() {
  if (!data) return;
  const age = Math.max(0, Math.floor(Date.now() / 1000) - data.updatedAt), e = $("updated");
  const ago = age < 90 ? "just now" : age < 3600 ? `${Math.round(age / 60)} min ago` : age < 172800 ? `${Math.round(age / 3600)} h ago` : `${Math.round(age / 86400)} days ago`;
  e.textContent = age > STALE_S ? `Last updated ${ago} — the figures may be behind` : `Updated ${ago}`;
  e.classList.toggle("stale", age > STALE_S);
}

function defaultRange(t) {
  const age = t.firstTime ? Date.now() / 1000 - t.firstTime : 0;
  return age < 1.5 * 86400 ? "24h" : age < 10 * 86400 ? "7d" : age < 45 * 86400 ? "30d" : "all";
}

async function load() {
  try {
    const res = await fetch("./stats.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    if (!data) $("msg").textContent = "Statistics are not available right now. Please try again in a few minutes.";
    return;
  }
  const syms = Object.keys(data.tokens);
  if (!syms.length) { $("msg").textContent = "No tokens yet."; return; }
  const badge = $("netBadge");
  badge.textContent = data.network; badge.className = "badge " + (data.network === "mainnet" ? "mainnet" : "testnet");
  $("programAddr").textContent = data.program;
  if (!$("tokenSeg").children.length) {
    for (const sym of syms) $("tokenSeg").append(h("button", { "data-token": sym, text: `${data.tokens[sym].symbol}` }));
  }
  const [hashToken, hashRange] = decodeURIComponent(location.hash.slice(1)).split("/");
  if (!token) token = syms.includes(hashToken) ? hashToken : syms[0];
  if (!range) range = RANGES.includes(hashRange) ? hashRange : defaultRange(data.tokens[token]);
  render();
}

$("tokenSeg").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { token = b.dataset.token; render(); } });
$("rangeSeg").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { range = b.dataset.range; render(); } });
let raf = 0, lastWidth = 0;
new ResizeObserver(() => {
  const w = $("content").clientWidth;
  if (w === lastWidth) return; // only a change of width needs the charts redrawn
  lastWidth = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(render);
}).observe($("content"));
setInterval(load, REFRESH_MS);
setInterval(stamp, 20e3);
load();
