"use strict";
// 날씨가 지운 운동시간 — static client. Data built by build_service_data.py.

const $ = (s, el = document) => el.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WEEK = ["월", "화", "수", "목", "금", "토", "일"];
const OPEN = [6, 22];
const HOURS = Array.from({ length: OPEN[1] - OPEN[0] }, (_, i) => OPEN[0] + i);
const PM25_BAD = 36;

const state = { summary: null, regions: [], byCode: {}, cur: null, fac: null, user: null, map: null, layer: null, sort: ["lost_facility_hours", -1] };

/* ---------- model (same formulas as model.py) ---------- */
function apparentTemp(t, rh, windMs) {
  if (t >= 20) {
    const tw = t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.67633)
      + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
    return -0.2442 + 0.55399 * tw + 0.45535 * t - 0.0022 * tw * tw + 0.00278 * tw * t + 3.0;
  }
  const vk = windMs * 3.6;
  if (t <= 10 && vk >= 4.8) return 13.12 + 0.6215 * t - 11.37 * vk ** 0.16 + 0.3965 * vk ** 0.16 * t;
  return t;
}
function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  const i = xs.findIndex((v) => v > x);
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}
function rainBin(mm) {
  const edges = state.summary.curve.rain_edges_mm.slice(1, -1);
  return edges.filter((e) => mm >= e).length;
}
function factor(at, rain, rain3) {
  const c = state.summary.curve;
  const fa = Math.min(1, interp(at, c.at, c.at_factor));
  const fr = c.rain_factor_now[rainBin(rain)] * c.rain_factor_prev3h[rainBin(rain3 / 3)];
  return { f: fa * fr, fa, fr, at };
}
function reason(r) {
  if (r.fr < 0.97 && 1 - r.fr >= 1 - r.fa) return "비";
  if (r.fa < 0.97) return r.at > 20 ? "더위" : "추위";
  return "";
}

/* ---------- data ---------- */
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function init() {
  [state.summary, state.regions] = await Promise.all([getJSON("data/summary.json"), getJSON("data/regions.json")]);
  for (const r of state.regions) {
    state.byCode[r.code] = r;
    r.heat_sh = r.heat / r.lost_open; r.cold_sh = r.cold / r.lost_open; r.rain_sh = r.rain / r.lost_open;
  }
  setupPicker();
  setupTabs();
  setupNation();
  renderMethod();
  let code = null;
  try { code = localStorage.getItem("wlph-region"); } catch (e) { /* storage unavailable */ }
  const hash = location.hash.match(/r\d{3}/);
  selectRegion((hash && hash[0]) || (code && state.byCode[code] ? code : state.regions.find((r) => r.region.includes("송파구"))?.code || state.regions[0].code));
}

/* ---------- picker ---------- */
function setupPicker() {
  const sidos = [...new Set(state.regions.map((r) => r.sido))].sort((a, b) => a.localeCompare(b, "ko"));
  $("#sido").innerHTML = sidos.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#sido").addEventListener("change", () => { fillSgg(); selectRegion($("#sgg").value); });
  $("#sgg").addEventListener("change", () => selectRegion($("#sgg").value));
  $("#locate").addEventListener("click", locate);
}
function fillSgg() {
  const list = state.regions.filter((r) => r.sido === $("#sido").value).sort((a, b) => a.sigungu.localeCompare(b.sigungu, "ko"));
  $("#sgg").innerHTML = list.map((r) => `<option value="${r.code}">${esc(r.sigungu)}</option>`).join("");
}
function locate() {
  const msg = $("#locmsg");
  if (!navigator.geolocation) { msg.textContent = "이 브라우저는 위치 찾기를 지원하지 않습니다."; return; }
  msg.textContent = "위치 확인 중…";
  navigator.geolocation.getCurrentPosition((p) => {
    state.user = { lat: p.coords.latitude, lon: p.coords.longitude };
    let best = null, bd = Infinity;
    for (const r of state.regions) {
      const d = dist(state.user, r);
      if (d < bd) { bd = d; best = r; }
    }
    msg.textContent = "현재 위치 기준으로 가까운 곳부터 보여드립니다.";
    selectRegion(best.code);
  }, () => { msg.textContent = "위치를 가져오지 못했습니다. 지역을 직접 골라 주세요."; }, { timeout: 8000 });
}
function dist(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function selectRegion(code) {
  const r = state.byCode[code];
  if (!r) return;
  state.cur = r;
  try { localStorage.setItem("wlph-region", code); } catch (e) { /* ignore */ }
  history.replaceState(null, "", `#${code}`);
  $("#sido").value = r.sido; fillSgg(); $("#sgg").value = code;
  renderRegion();
  highlightNation();
  state.fac = null;
  renderToday();
  try {
    state.fac = await getJSON(`data/facilities/${code}.json`);
    if (state.cur === r) renderAlternatives();
  } catch (e) {
    $("#alts").innerHTML = `<li>시설 목록을 불러오지 못했습니다.</li>`;
  }
}

/* ---------- tabs ---------- */
function setupTabs() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
    if (b.dataset.tab === "today" && state.map) setTimeout(() => state.map.invalidateSize(), 50);
  }));
}

/* ---------- today ---------- */
async function renderToday() {
  const r = state.cur;
  $("#today-title").textContent = `${r.region} — 오늘과 내일, 밖에서 운동하기 좋은 시간`;
  $("#today-summary").textContent = "예보를 불러오는 중…";
  $("#strip").innerHTML = "";
  const q = `latitude=${r.lat}&longitude=${r.lon}&timezone=Asia%2FSeoul&forecast_days=2`;
  try {
    const [wx, aq] = await Promise.all([
      forecast(q),
      getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&hourly=pm2_5`).catch(() => null),
    ]);
    if (state.cur !== r) return;
    const h = wx.hourly;
    $("#model-note").textContent = wx.model;
    const pm = {};
    if (aq) aq.hourly.time.forEach((t, i) => { pm[t] = aq.hourly.pm2_5[i]; });
    const rows = h.time.map((t, i) => {
      const rain = h.precipitation[i] ?? 0;
      const rain3 = [1, 2, 3].reduce((s, k) => s + (h.precipitation[i - k] ?? 0), 0);
      const at = apparentTemp(h.temperature_2m[i], h.relative_humidity_2m[i], (h.wind_speed_10m[i] ?? 0) / 3.6);
      if (h.temperature_2m[i] == null || h.relative_humidity_2m[i] == null) return null;
      return { t, date: t.slice(0, 10), hour: +t.slice(11, 13), ...factor(at, rain, rain3), pm: pm[t] };
    }).filter((x) => x && x.hour >= OPEN[0] && x.hour < OPEN[1]);
    drawStrip(rows);
  } catch (e) {
    $("#today-summary").textContent = "예보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

// KMA models first; Open-Meteo's default blend when KMA returns no values
async function forecast(q) {
  const vars = "hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m";
  const base = `https://api.open-meteo.com/v1/forecast?${q}&past_hours=3&${vars}`;
  try {
    const kma = await getJSON(`${base}&models=kma_seamless`);
    if (kma.hourly.temperature_2m.some((v) => v != null)) return { ...kma, model: "기상청 KMA 모델 예보(Open-Meteo 제공)" };
  } catch (e) { /* fall through */ }
  const def = await getJSON(base);
  return { ...def, model: "Open-Meteo 기본 예보 모델(기상청 모델 값이 비어 대체)" };
}

function colorFor(f) { return f >= 0.9 ? "var(--good)" : f >= 0.75 ? "var(--mid)" : "var(--bad)"; }

function drawStrip(rows) {
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}`;
  const todayKey = nowKey.slice(0, 10);
  rows = rows.filter((x) => x.date >= todayKey);
  const dates = [...new Set(rows.map((x) => x.date))].slice(0, 2);
  // narrow screens get two 8-hour blocks so the numbers stay readable
  const narrow = window.matchMedia("(max-width: 560px)").matches;
  const blocks = narrow ? [HOURS.slice(0, 8), HOURS.slice(8)] : [HOURS];
  $("#strip").style.gridTemplateColumns = `${narrow ? 44 : 56}px repeat(${blocks[0].length}, minmax(0, 1fr))`;
  let html = "";
  blocks.forEach((hours) => {
    html += `<span></span>${hours.map((h) => `<span class="hr">${h}</span>`).join("")}`;
    dates.forEach((d, di) => {
      const dd = new Date(`${d}T00:00:00`);
      html += `<span class="lab">${di === 0 ? "오늘" : "내일"}<br>${dd.getMonth() + 1}/${dd.getDate()}(${WEEK[(dd.getDay() + 6) % 7]})</span>`;
      for (const h of hours) {
        const x = rows.find((y) => y.date === d && y.hour === h);
        if (!x) { html += "<span></span>"; continue; }
        const past = x.t.slice(0, 13) < nowKey;
        const why = reason(x);
        const bad = x.pm != null && x.pm >= PM25_BAD;
        html += `<span class="cell${past ? " past" : ""}" style="background:${colorFor(x.f)}" title="${h}시 · 체감 ${x.at.toFixed(1)}°C · 예상 이용 ${pct(x.f)}${why ? ` · ${why}` : ""}${bad ? ` · 초미세먼지 ${Math.round(x.pm)}㎍/㎥` : ""}">${Math.round(x.f * 100)}${why ? `<small>${why}</small>` : ""}${bad ? '<b class="pm">미</b>' : ""}</span>`;
      }
    });
  });
  $("#strip").innerHTML = html;

  const today = rows.filter((x) => x.date === dates[0] && x.t.slice(0, 13) >= nowKey);
  const scope = today.length >= 3 ? today : rows.filter((x) => x.date === dates[1]);
  const label = scope === today ? "오늘 남은 시간" : "내일";
  const lost = scope.reduce((s, x) => s + (1 - Math.min(1, x.f)), 0);
  const good = bestWindow(scope);
  const causes = {};
  scope.forEach((x) => { const w = reason(x); if (w) causes[w] = (causes[w] || 0) + (1 - x.f); });
  const main = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  $("#today-summary").innerHTML = `${label} ${scope.length}시간 가운데 날씨가 약 <b>${fmt(lost, 1)}시간</b>을 지웁니다${main ? `(주로 ${main[0]})` : ""}. `
    + (good ? `밖에서 운동하기 가장 좋은 때는 <b>${good}</b>입니다.` : "밖보다는 실내 대안을 권합니다.");
}

function bestWindow(rows) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j < rows.length && rows[j].f >= 0.9 && (j === i || rows[j].hour === rows[j - 1].hour + 1)) j++;
    if (j - i >= 1 && (!best || j - i > best[1] - best[0])) best = [i, j];
  }
  if (!best) {
    const top = rows.reduce((a, b) => (b.f > (a?.f ?? -1) ? b : a), null);
    return top && top.f >= 0.8 ? `${top.hour}시 무렵` : null;
  }
  return `${rows[best[0]].hour}~${rows[best[1] - 1].hour + 1}시`;
}

/* ---------- alternatives ---------- */
function renderAlternatives() {
  const r = state.cur, F = state.fac;
  const origin = state.user && dist(state.user, r) < 30 ? state.user : { lat: r.lat, lon: r.lon };
  const indoor = F.facilities.filter((f) => f.e === "i").map((f) => ({ kind: "공공 실내", name: f.n, ev: f.t, addr: f.a, lat: f.y, lon: f.x, courses: [] }));
  // the voucher list repeats a venue under slightly different names; merge by address + event
  const merged = new Map();
  for (const v of F.venues) {
    const key = `${(v.a || v.n || "").replace(/\s/g, "")}|${v.ev || ""}`;
    const m = merged.get(key);
    if (m) m.courses.push(...v.c);
    else merged.set(key, { kind: "이용권 가맹", name: v.n, ev: v.ev, addr: v.a, lat: v.y, lon: v.x, courses: [...v.c] });
  }
  const venues = [...merged.values()];
  const events = [...new Set([...venues.flatMap((v) => v.courses.map((c) => c.i)), ...indoor.map((f) => f.ev)])].filter(Boolean).sort((a, b) => a.localeCompare(b, "ko"));
  const sel = $("#event");
  const keep = sel.value;
  sel.innerHTML = `<option value="">전체</option>${events.map((e) => `<option>${esc(e)}</option>`).join("")}`;
  sel.value = events.includes(keep) ? keep : "";
  sel.onchange = renderAlternatives;
  const ev = sel.value;

  let items = [...indoor, ...venues].filter((x) => !ev || x.ev === ev || x.courses.some((c) => c.i === ev));
  items.forEach((x) => { x.d = x.lat != null ? dist(origin, x) : null; });
  items.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
  const shown = items.slice(0, 60);

  $("#alt-note").textContent = `${r.region}의 실내 공공체육시설 ${fmt(indoor.length)}곳, 스포츠강좌이용권 가맹시설 ${fmt(venues.length)}곳 중 ${state.user && origin === state.user ? "현재 위치" : "지역 중심"}에서 가까운 순서입니다. 강좌 금액은 월 이용권 한도와 비교해 보세요. 좌표를 찾지 못한 가맹시설은 목록 끝에 있습니다.`;
  $("#alts").innerHTML = shown.map((x) => `<li>
      <div class="name">${esc(x.name)} <span class="tag">${x.kind}</span>${x.ev ? `<span class="tag">${esc(x.ev)}</span>` : ""}</div>
      <div class="meta">${esc(x.addr || "")}${x.d != null ? ` · ${fmt(x.d, 1)}km` : ""}</div>
      ${x.courses.filter((c) => !ev || c.i === ev).slice(0, 3).map((c) => `<div class="course">· ${esc(c.n)} — ${days(c.d)}${timeRange(c)}${c.p ? ` · ${fmt(c.p)}원` : ""}</div>`).join("")}
    </li>`).join("") || "<li>조건에 맞는 시설이 없습니다.</li>";
  drawMap(shown, origin);
}
function timeRange(c) {
  if (!c.s || !c.e || c.s === c.e) return "";
  return ` ${esc(c.s)}~${esc(c.e)}`;
}
function days(v) {
  if (!v || v.length !== 7) return "";
  return [...v].map((c, i) => (c === "1" ? WEEK[i] : "")).join("");
}

function drawMap(items, origin) {
  if (!window.L) return;
  if (!state.map) {
    state.map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(state.map);
  }
  if (state.layer) state.layer.remove();
  state.layer = L.layerGroup().addTo(state.map);
  const pts = [];
  const outdoor = state.fac.facilities.filter((f) => f.e !== "i");
  for (const f of outdoor.slice(0, 400)) {
    L.circleMarker([f.y, f.x], { radius: 3, color: f.e === "r" ? "#6c8a9a" : "#d4603f", weight: 1, fillOpacity: .5 })
      .bindTooltip(`${esc(f.n)} (${esc(f.t)}${f.e === "r" ? ", 지붕" : ", 실외"})`).addTo(state.layer);
  }
  for (const x of items.filter((i) => i.lat != null)) {
    L.circleMarker([x.lat, x.lon], { radius: 6, color: "#1f6f5c", weight: 2, fillOpacity: .8 })
      .bindPopup(`<b>${esc(x.name)}</b><br>${esc(x.kind)} · ${esc(x.ev || "")}<br>${esc(x.addr || "")}`).addTo(state.layer);
    pts.push([x.lat, x.lon]);
  }
  pts.push([origin.lat, origin.lon]);
  state.map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 14 });
}

/* ---------- region ---------- */
function renderRegion() {
  const r = state.cur, S = state.summary;
  const share = r.lost_open / r.nominal_hours;
  $("#rg-title").textContent = `${r.region} 실외 공공체육시설 진단`;
  $("#rg-kpis").innerHTML = [
    [`${fmt(r.outdoor)}곳`, `실외 공공체육시설 (지붕형 ${fmt(r.roofed)}곳, 실내 ${fmt(r.indoor)}곳 별도)`],
    [`${fmt(r.lost_open)}시간`, `1곳이 연 ${fmt(r.nominal_hours)}시간(6~22시) 중 날씨로 잃는 시간 · ${pct(share)}`],
    [`${fmt(r.lost_facility_hours)}`, "지역 전체 실외 시설이 1년에 잃는 시설·시간"],
    [`${fmt(r.roof_recoverable_hours)}`, `모든 실외 시설에 비 가림 지붕을 씌울 때 되찾는 시설·시간 (${pct(r.rain_sh)})`],
  ].map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

  const parts = [["더위", r.heat, "var(--heat)"], ["추위", r.cold, "var(--cold)"], ["비", r.rain, "var(--rain)"]];
  const W = 520, H = 70, total = r.nominal_hours;
  let x = 0;
  let bars = parts.map(([n, v, c]) => { const w = (v / total) * W; const s = `<rect x="${x}" y="10" width="${w}" height="26" fill="${c}"><title>${n} ${fmt(v)}시간</title></rect>`; x += w; return s; }).join("");
  bars += `<rect x="${x}" y="10" width="${W - x}" height="26" fill="var(--line)"><title>쓸 수 있는 시간</title></rect>`;
  $("#rg-bar").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="잃는 시간 구성">${bars}
    <text x="0" y="56">0</text><text x="${W}" y="56" text-anchor="end">${fmt(total)}시간</text></svg>
    <div class="legend">${parts.map(([n, v, c]) => `<span><i class="sw" style="background:${c}"></i>${n} ${fmt(v)}시간 (${pct(v / r.lost_open)})</span>`).join("")}<span><i class="sw" style="background:var(--line)"></i>쓸 수 있는 시간 ${fmt(total - r.lost_open)}</span></div>`;

  const med = (k) => { const a = state.regions.map((q) => q[k]).sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  const tips = [];
  if (r.heat_sh > med("heat_sh")) tips.push(`더위 비중(${pct(r.heat_sh)})이 전국 중앙값(${pct(med("heat_sh"))})보다 높습니다. 여름 11~16시 손실이 크므로 그늘막·차광과 이른 아침·저녁 운영 확대가 지붕보다 먼저입니다.`);
  if (r.cold_sh > med("cold_sh")) tips.push(`추위 비중(${pct(r.cold_sh)})이 전국 중앙값보다 높습니다. 12~2월에는 실내 공공시설·이용권 강좌 연계가 효과적입니다.`);
  if (r.rain_sh > med("rain_sh")) tips.push(`비 비중(${pct(r.rain_sh)})이 전국 중앙값보다 높아 전천후(지붕형) 전환의 효과가 상대적으로 큽니다.`);
  if (!tips.length) tips.push("손실 구성이 전국 평균과 비슷합니다. 시설 수가 많은 종목부터 개선 효과를 비교해 보세요.");
  $("#rg-rx").innerHTML = `<b>처방 제안</b><br>${tips.join("<br>")}`;

  drawHeatmap(r.pattern);
  $("#rg-types").innerHTML = Object.entries(r.outdoor_types).map(([k, v]) => `<span>${esc(k)} ${fmt(v)}</span>`).join("") || "<span>등록된 실외 시설 없음</span>";
}

function drawHeatmap(pattern) {
  const cw = 26, ch = 18, left = 34, top = 18;
  const W = left + cw * 16, H = top + ch * 12 + 4;
  let s = HOURS.map((h, i) => (i % 2 === 0 ? `<text x="${left + i * cw + cw / 2}" y="12" text-anchor="middle">${h}</text>` : "")).join("");
  pattern.forEach((row, m) => {
    s += `<text x="${left - 6}" y="${top + m * ch + 13}" text-anchor="end">${m + 1}월</text>`;
    row.forEach((v, i) => {
      const a = Math.max(0, Math.min(1, v / 0.45));
      s += `<rect x="${left + i * cw}" y="${top + m * ch}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="var(--bad)" fill-opacity="${(0.06 + a * 0.94).toFixed(2)}"><title>${m + 1}월 ${HOURS[i]}시: ${pct(v)} 손실</title></rect>`;
    });
  });
  $("#rg-heat").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W * 1.4}px" role="img" aria-label="월·시각별 손실 비율">${s}</svg><p class="muted small">진할수록 그 시간대에 이용이 많이 줄어듭니다 (2023~2025년 시간별 기상 재분석 자료 기준).</p>`;
}

/* ---------- nation ---------- */
function setupNation() {
  const S = state.summary;
  $("#nation-note").textContent = `실외 공공체육시설 ${fmt(S.outdoor)}곳 기준. 한 곳이 1년(6~22시, ${fmt(S.nominal_hours)}시간)에 날씨로 잃는 시간은 지역 중앙값 ${fmt(S.lost_open_median)}시간이고, 전국 합계는 ${fmt(S.lost_facility_hours)} 시설·시간입니다. 그중 비 가림 지붕으로 되찾을 수 있는 몫은 ${fmt(S.roof_recoverable_hours)} 시설·시간(${pct(S.roof_recoverable_hours / S.lost_facility_hours)})입니다. 행을 누르면 그 지역으로 이동합니다.`;
  document.querySelectorAll("#ntable th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k;
    state.sort = [k, state.sort[0] === k ? -state.sort[1] : (k === "region" ? 1 : -1)];
    drawNation();
  }));
  $("#q").addEventListener("input", drawNation);
  $("#ntable tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    selectRegion(tr.dataset.code);
    document.querySelector('.tabs button[data-tab="region"]').click();
  });
  drawNation();
}
function drawNation() {
  const [k, dir] = state.sort;
  const q = $("#q").value.trim();
  const rows = state.regions.filter((r) => !q || r.region.includes(q))
    .sort((a, b) => (k === "region" ? a.region.localeCompare(b.region, "ko") : a[k] - b[k]) * dir);
  document.querySelectorAll("#ntable th").forEach((th) => th.setAttribute("aria-sort", th.dataset.k === k ? (dir > 0 ? "ascending" : "descending") : "none"));
  $("#ntable tbody").innerHTML = rows.map((r) => `<tr data-code="${r.code}" class="${state.cur && state.cur.code === r.code ? "sel" : ""}">
    <td>${esc(r.region)}</td><td class="num">${fmt(r.outdoor)}</td><td class="num">${fmt(r.lost_open)}</td>
    <td class="num">${pct(r.heat_sh)}</td><td class="num">${pct(r.cold_sh)}</td><td class="num">${pct(r.rain_sh)}</td>
    <td class="num">${fmt(r.lost_facility_hours)}</td><td class="num">${fmt(r.roof_recoverable_hours)}</td></tr>`).join("");
}
function highlightNation() {
  document.querySelectorAll("#ntable tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.code === state.cur.code));
}

/* ---------- method ---------- */
function renderMethod() {
  const c = state.summary.curve;
  const W = 520, H = 260, l = 40, b = 30, t = 10, r = 10;
  const xs = (v) => l + ((v - c.at[0]) / (c.at[c.at.length - 1] - c.at[0])) * (W - l - r);
  const ys = (v) => t + (1 - (v - 0.4) / 0.65) * (H - t - b);
  const band = c.at.map((a, i) => `${xs(a)},${ys(c.at_factor_p95[i])}`).join(" ") + " " + c.at.map((a, i) => `${xs(a)},${ys(c.at_factor_p05[i])}`).reverse().join(" ");
  const line = c.at.map((a, i) => `${xs(a)},${ys(c.at_factor[i])}`).join(" ");
  let axes = "";
  for (let v = 0.4; v <= 1.05; v += 0.1) axes += `<line x1="${l}" x2="${W - r}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${l - 6}" y="${ys(v) + 4}" text-anchor="end">${Math.round(v * 100)}</text>`;
  for (let a = -10; a <= 40; a += 10) axes += `<text x="${xs(a)}" y="${H - 10}" text-anchor="middle">${a}°C</text>`;
  $("#curve").innerHTML = `<h3>체감온도별 이용 비율 (체감 20°C = 100)</h3><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="체감온도별 이용 비율 곡선">${axes}
    <polygon points="${band}" fill="var(--band)"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5"/></svg>`;
  $("#rainbox").innerHTML = `<h3>비가 올 때 남는 이용 비율</h3><table><thead><tr><th>강수</th><th class="num">지금 비</th><th class="num">직전 3시간 비</th></tr></thead><tbody>
    ${c.rain_labels.map((n, i) => `<tr><td>${esc(n)}</td><td class="num">${pct(c.rain_factor_now[i])}</td><td class="num">${pct(c.rain_factor_prev3h[i])}</td></tr>`).join("")}</tbody></table>
    <p class="muted small">두 값은 곱해집니다. 예: 지금 약한 비가 오고 직전에도 비가 왔다면 약 ${pct(c.rain_factor_now[1] * c.rain_factor_prev3h[1])}만 남습니다.</p>`;

  const S = state.summary;
  $("#method-text").innerHTML = `
    <h2>무엇을 다르게 재는가</h2>
    <p>공공체육시설 현황은 시설 수와 면적으로 공급을 셉니다. 실외 운동장 1곳과 실내 체육관 1곳이 같은 1곳이고, 폭염 오후와 선선한 아침이 같은 1시간입니다. 이 서비스는 공급을 <b>'날씨를 감안해 실제로 쓰이는 시간'</b>으로 다시 잽니다.</p>
    <h3>1. 날씨-이용 반응 곡선 (국민체육진흥공단 올림픽공원 이용 데이터)</h3>
    <ul>
      <li>원자료: 기상정보활용올림픽공원이용분석정보. 2012~2026년 시간별 입차 대수와 기온·습도·강수량·풍속이 들어 있습니다.</li>
      <li>평일 아침은 출근 주차가 섞이므로 여가 이용이 뚜렷한 주말 9~18시만 썼고, 코로나19 기간(2020~2022)은 뺐습니다.</li>
      <li>포아송 회귀에 연·월, 요일, 시각의 고정효과를 넣어 계절·요일 차이를 먼저 걷어냈습니다. 그다음 기상청 식으로 계산한 체감온도(스플라인)와 현재·직전 3시간 강수 구간의 효과를 추정했습니다.</li>
      <li>날씨 정보를 넣으면 처음 보는 날짜의 시간별 이용 예측 오차(MAE)가 6.7% 줄었습니다. 5겹 교차검증에서 날짜를 통째로 떼어 확인한 결과입니다.</li>
      <li>학습 자료의 체감온도는 대부분 −10~32.7°C 범위에 있습니다. 그 밖의 온도에는 범위 끝의 값을 그대로 씁니다.</li>
    </ul>
    <h3>2. 전국 시설에 적용</h3>
    <ul>
      <li>시설: 국민체육진흥공단 공공체육시설 상세 정보에서 운영 중이고 좌표가 있는 시설을 종목에 따라 실외 ${fmt(S.outdoor)}곳, 지붕형(전천후 게이트볼장) ${fmt(S.roofed)}곳, 실내 ${fmt(S.indoor)}곳으로 나눴습니다.</li>
      <li>기상: 시·군·구 대표 지점 ${fmt(S.weather_points)}곳의 2023~2025년 시간별 기상 재분석 자료(ERA5)를 가장 가까운 시설에 붙였습니다. 이 자료는 약 25km 단위라서 같은 지역 안의 차이는 반영하지 못합니다.</li>
      <li>잃는 시간은 6~22시 매시간 '1 − 이용 비율'을 더해 계산하고 연평균을 냈습니다. 지붕형 시설은 비로 인한 손실을 뺐습니다.</li>
    </ul>
    <h3>3. 대안 안내</h3>
    <ul>
      <li>실내 공공체육시설과 스포츠강좌이용권 가맹시설 ${fmt(S.voucher_venues)}곳, 강좌 ${fmt(S.courses)}건을 연결했습니다. 가맹시설 중 ${fmt(S.voucher_venues_located)}곳은 전국체육시설 정보와 도로명주소를 맞춰 위치를 찾았습니다.</li>
      <li>오늘 화면은 기상청 모델 예보와 CAMS 초미세먼지 예보(Open-Meteo)를 받아 같은 곡선을 적용합니다. 초미세먼지는 공단 데이터에 학습 근거가 없어 손실 계산에 넣지 않고, 환경부 '나쁨'(36㎍/㎥ 이상) 표시만 합니다.</li>
    </ul>
    <h3>한계</h3>
    <ul>
      <li>곡선은 서울 올림픽공원 방문 차량에서 나왔습니다. 동네 간이운동장 이용자의 민감도는 다를 수 있으므로, 지역별 이용 기록이 공개되면 다시 학습해야 합니다.</li>
      <li>그늘막·조명 같은 개선의 효과는 공개 데이터로 확인할 수 없어 수치로 제시하지 않습니다. 비 가림 지붕의 효과만 계산했습니다.</li>
    </ul>`;
}

init().catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card">데이터를 불러오지 못했습니다: ${esc(e.message)}</div>`);
});
