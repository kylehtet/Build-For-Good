/* BellyUp — voluntary surplus reports in, collector→hotspot dispatch out.

   Data and scoring both come from the API (they used to be baked into
   data.js). That is what lets a restaurant register mid-demo and lets the
   engine apply expiry, pickup windows and a server-side ledger — none of
   which a static file can do. The map, animation, ledger and result panel
   are unchanged. */

"use strict";

let HOTSPOTS = [], SUPPLIERS = [], AGENCIES = [], PANTRIES = [], C = {}, CLAIMS = {};
let REQUESTS = {};
let showForecast = false;

/* How many pickup requests are waiting on this collector right now, right
   now being the operative words -- once accepted it is a claim, not a
   pending request, so CLAIMS is checked too or an already-answered request
   would keep showing red forever. Mirrors claims.Requests.visible_to()
   exactly (declined_by, open_to_all, withdrawn) since a collector should
   never see a red mark for a request it cannot actually act on. */
function pendingRequestCount(collectorId) {
  let n = 0;
  for (const sid in REQUESTS) {
    const r = REQUESTS[sid];
    if (!r || r.withdrawn || CLAIMS[sid]) continue;
    if ((r.declined_by || []).includes(collectorId)) continue;
    if (r.open_to_all || r.target === collectorId) n++;
  }
  return n;
}
let HISTORY = [], tonight = [], OPTED_OUT = 0;
let CANDIDATES = [], REPORTING = [], COLLECTORS = [];

const api = (path, opts) => fetch(path, opts).then(async r => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || r.statusText);
  return body;
});

async function loadBoard() {
  const b = await api("/api/board");
  /* The board is replaced wholesale on every refresh. __match is the cached
     dispatch preview, keyed to the report rather than to the request, so carry
     it over -- dropping it left the panel on "Finding a collector..." after a
     withdrawal until the restaurant was clicked again. */
  const prevMatch = {};
  for (const s of (SUPPLIERS || [])) if (s.__match) prevMatch[s.id] = s.__match;
  HOTSPOTS = b.hotspots; SUPPLIERS = b.suppliers;
  for (const s of SUPPLIERS) if (prevMatch[s.id]) s.__match = prevMatch[s.id];
  AGENCIES = b.agencies; PANTRIES = b.pantries; C = b.constants;
  HISTORY = b.history || []; tonight = b.tonight || [];
  CLAIMS = b.claims || {};
  REQUESTS = b.requests || {};
  OPTED_OUT = b.optedOut || 0;
  CANDIDATES = HOTSPOTS.filter(h => h.need >= C.MIN_CANDIDATE_NEED);
  REPORTING = SUPPLIERS.filter(s => s.report);
  COLLECTORS = [
    ...AGENCIES.map(a => ({ ...a, kind: "agency", capacityLbs: C.AGENCY_CAPACITY_LBS })),
    ...PANTRIES.filter(p => p.dispatchable).map(p => ({ ...p, kind: "pantry", capacityLbs: C.PANTRY_CAPACITY_LBS })),
  ];
  return b;
}

/* ---------------------------------------------------------------- helpers */
const $ = id => document.getElementById(id);
const fmt$ = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const fmtInt = v => Math.round(v).toLocaleString();
const agShort = a => a.name
  .replace("Jacobs & Cushman San Diego Food Bank", "SD Food Bank")
  .replace("Catholic Charities Diocese of San Diego", "Catholic Charities")
  .replace("Stepping Higher Incorporated", "Stepping Higher");

function haversineMi(a, b) {
  const R = 3958.76, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const roadMi = (a, b) => haversineMi(a, b) * C.ROAD_FACTOR;

/* ------------------------------------------------------------------ theme */
/* Light is the default. The choice persists per browser. Map geometry reads
   the --c-* tokens so both themes drive colors from styles.css. */
const TILE_URLS = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};
let theme = "light";
try { theme = localStorage.getItem("bellyup.theme") || "light"; } catch (e) { /* private mode */ }

/* getComputedStyle forces a style recalculation, and hotspotStyle plus
   hotspotTip call this for every one of 207 blocks on every render -- roughly
   400 forced recalcs per redraw, which was the whole of the lag. The tokens
   only change when the theme does, so read them once per theme.
   Declared before applyThemeAttr() runs: `let` is not hoisted, so clearing the
   cache from init would otherwise throw on the temporal dead zone. */
let _themeCache = {};
function themeColor(token) {
  if (token in _themeCache) return _themeCache[token];
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  _themeCache[token] = v;
  return v;
}
function clearThemeCache() { _themeCache = {}; }

applyThemeAttr();

function applyThemeAttr() {
  clearThemeCache();
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

/* ----------------------------------------------------------------- ledger */
/* HISTORY is the past week, read-only. `tonight` is what has been CONFIRMED
   this evening; both come from the server, so a reload does not lose the
   evening and two people watching see the same board. */
const dispatchedSupplierIds = () => new Set(tonight.map(r => r.supplierId));
const servedMealsTonight = hid =>
  tonight.filter(r => r.hotspotId === hid).reduce((t, r) => t + r.servedMeals, 0);
const dropsTonight = hid => tonight.filter(r => r.hotspotId === hid).length;
function hotspotClosed(h) {
  if (h.need < C.MIN_CANDIDATE_NEED) return false;   // never in the pool
  return dropsTonight(h.id) >= C.MAX_DROPS_PER_NIGHT ||
    h.need - servedMealsTonight(h.id) < 1;
}

/* ------------------------------------------------------- matching engine */
/* Lives on the server now: bellyup/dispatch.py. Same reward−cost shape, with
   freshness decay, expiry and pickup-window constraints layered on, plus the
   serving limits (need met, or MAX_DROPS_PER_NIGHT deliveries to one block).

     net    = reward − cost
     reward = served × MEAL_VALUE × accessBoost × freshness
              + surplus × MEAL_VALUE × 0.5
     cost   = (drive + handling) × WAGE_PER_HR + road miles × COST_PER_MILE  */
const dispatchFor = s => api(`/api/board/dispatch/${s.id}`, { method: "POST" });

/* ------------------------------------------------------------------- map */
const map = L.map("map", { zoomControl: true, attributionControl: true });
const tiles = L.tileLayer(TILE_URLS[theme], {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

const fxLayer = L.layerGroup().addTo(map);   // scan lines, routes, radar
const baseLayer = L.layerGroup().addTo(map); // hotspots, collectors, suppliers

const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h11v9H3zM14 8h4l3 3v3h-7zM6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>';
const typeIcon = { grocery: "GR", hotel: "HT", venue: "VN", health: "HC", restaurant: "RS" };

/* hotspot circles — magenta, sized by need; aqua once served/at limit */
const hotspotMarkers = {}, agencyMarkers = {}, pantryMarkers = {}, supplierMarkers = {};
function hotspotStyle(h) {
  const closed = hotspotClosed(h);
  /* Only significant clusters reach the map at all now (see buildLayers).
     Among those, an emerging or cooling read is the one thing that is
     actually predictive (giPredict, from the real trend in
     BlockLevel_Counts_Panel261.csv) -- "established" is just a real cluster
     with no trend signal either way. It stays on the map for context, but
     smaller and fainter, so the two predictive colours are what the eye
     lands on rather than getting lost among plain clusters. */
  const cluster = h.giFlag === "hot95" || h.giFlag === "hot99";
  const predictive = h.giPredict === "emerging" || h.giPredict === "cooling";
  const col = closed ? themeColor("--c-route")
            : h.giPredict === "emerging" ? themeColor("--c-emerging")
            : h.giPredict === "cooling" ? themeColor("--c-cooling")
            : themeColor("--c-hotspot");
  const sizeMult = closed || predictive ? 1 : 0.68;
  return {
    radius: (3 + Math.sqrt(h.need) * 2.1) * sizeMult,
    color: col,
    weight: closed ? 2.6 : predictive ? 2.6 : cluster ? 1.6 : 1.4,
    opacity: closed ? 0.9 : predictive ? 0.95 : cluster ? 0.55 : 0.8,
    fillColor: col,
    fillOpacity: closed ? 0.3
      : predictive ? 0.16 + Math.min(h.need / 40, 0.34)
      : (0.16 + Math.min(h.need / 40, 0.34)) * 0.5,
  };
}
function hotspotTip(h) {
  const servedNow = servedMealsTonight(h.id);
  const status = hotspotClosed(h)
    ? `<br><b style="color:${themeColor("--c-route")}">served tonight — off the candidate list</b>`
    : servedNow > 0 ? `<br>${fmtInt(servedNow)} meals delivered tonight; ${(h.need - servedNow).toFixed(1)} need remaining` : "";
  /* Only significant clusters ever reach this tooltip now (buildLayers only
     binds one for hot95/hot99), so this is always the real claim, never a
     hedge about an isolated spike -- those no longer appear on the map at
     all. Gi* itself is a snapshot, not a forecast -- the trend line below is
     what makes a genuine prediction, stated as its own claim. */
  const cluster = h.giFlag === "hot99"
    ? `<br><b>significant cluster</b> (p&lt;0.01, z=${h.giZ})`
    : `<br><b>significant cluster</b> (p&lt;0.05, z=${h.giZ})`;
  const predict = h.giPredict === "emerging"
    ? `<br><b style="color:${themeColor("--c-emerging")}">emerging</b> — growing ${Math.abs(h.giTrend).toFixed(1)}/yr, becoming a cluster`
    : h.giPredict === "cooling"
    ? `<br><b style="color:${themeColor("--c-cooling")}">cooling</b> — declining ${Math.abs(h.giTrend).toFixed(1)}/yr from its peak`
    : h.giPredict === "established"
    ? `<br>established — steady, not sharply moving`
    : "";
  /* The area cross-check (area_forecast.py) only ever appears when the
     WHOLE neighbourhood's trend clears p<0.05 -- below that bar it is
     omitted entirely, on purpose, rather than shown as a weak or uncertain
     read. A block-level pattern too thin to call is still clutter even
     with a caveat attached. */
  const areaCheck = h.giAreaSignal === "reinforced"
    ? `<br><span style="opacity:.85">↳ ${h.area} is also trending that way (${h.giAreaTrend > 0 ? "+" : ""}${h.giAreaTrend}/mo, p&lt;0.05)</span>`
    : h.giAreaSignal === "contradicted"
    ? `<br><span style="opacity:.85">↳ but ${h.area} overall is trending the other way (${h.giAreaTrend > 0 ? "+" : ""}${h.giAreaTrend}/mo, p&lt;0.05)</span>`
    : "";
  return `<b>${h.location}</b> &middot; ${h.area}` +
    `<div class="tip-k">need ${h.need.toFixed(1)} person-equivalents &middot; rank #${h.rank}` +
    `<br>food access ${h.accessDays.toFixed(h.accessDays % 1 ? 1 : 0)} days/week${status}${cluster}${predict}${areaCheck}</div>`;
}
/* The forecast toggle is an OVERLAY, not a swap: the current-hotspot layer
   below always renders exactly as it does today. This just adds a handful
   of extra markers for demo_data.forecast_changes() -- the small set of
   blocks where Gi*'s cluster verdict actually flips between today and the
   projection (typically single digits, out of 52+ current clusters), so
   what changed stays visible next to what's real right now instead of
   replacing it.

     "gained"  not a cluster today -- a genuinely new marker, dashed, in the
               emerging colour (nothing was drawn there before)
     "lost"    a cluster today -- drawn as a second, larger dashed ring
               AROUND the existing current marker at that spot, in the same
               cooling colour the current view already uses for a declining
               cluster (dashed + larger + no fill keeps it distinct from
               that solid marker underneath, which stays untouched and
               visible); this one says "fading out", not "gone already" */
let FORECAST_MONTHS = 6;
let FORECAST_CHANGES = null;
const changeMarkers = {};

function changeStyle(c) {
  const col = c.change === "gained" ? themeColor("--c-emerging") : themeColor("--c-cooling");
  return {
    radius: (3 + Math.sqrt(c.projectedNeed) * 2.1) + (c.change === "lost" ? 6 : 0),
    color: col,
    weight: 2.6,
    opacity: 0.9,
    fillColor: col,
    fillOpacity: c.change === "gained" ? 0.22 : 0,
    dashArray: "2 5",
    interactive: true,
  };
}
function changeTip(c) {
  const delta = c.projectedNeed - c.currentNeed;
  const trend = c.hadTrendData
    ? `need ${c.currentNeed.toFixed(1)} now &rarr; ${c.projectedNeed.toFixed(1)} projected (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`
    : `no trend history for this block`;
  return c.change === "gained"
    ? `<b>${c.location}</b> &middot; ${c.area}<div class="tip-k">` +
      `<b style="color:${themeColor("--c-emerging")}">predicted NEW cluster</b> in ~${FORECAST_MONTHS} months (z=${c.giZ})` +
      `<br>${trend} &middot; not significant today</div>`
    : `<b>${c.location}</b> &middot; ${c.area}<div class="tip-k">` +
      `<b style="color:${themeColor("--c-cooling")}">predicted to fall out</b> of significance in ~${FORECAST_MONTHS} months` +
      `<br>${trend} &middot; a real cluster today, fading</div>`;
}

async function toggleForecast() {
  showForecast = !showForecast;
  const btn = $("forecastBtn");
  if (showForecast) {
    btn.textContent = "Loading…";
    if (!FORECAST_CHANGES) {
      try {
        const r = await api(`/api/board/hotspots/forecast?months=${FORECAST_MONTHS}`);
        FORECAST_CHANGES = r.changes;
      } catch (e) {
        showForecast = false;
        btn.textContent = "Show predicted changes";
        alert("Couldn't load the forecast: " + e.message);
        return;
      }
    }
    btn.textContent = `Hide predicted changes (${FORECAST_CHANGES.length})`;
    btn.classList.add("on");
  } else {
    btn.textContent = "Show predicted changes";
    btn.classList.remove("on");
  }
  buildLayers();
}
$("forecastBtn").addEventListener("click", toggleForecast);

function refreshHotspots() {
  for (const h of HOTSPOTS) {
    if (!hotspotMarkers[h.id]) continue;
    hotspotMarkers[h.id].setStyle(hotspotStyle(h));
    hotspotMarkers[h.id].setTooltipContent(hotspotTip(h));
  }
  for (const c of (FORECAST_CHANGES || [])) {
    if (!changeMarkers[c.id]) continue;
    changeMarkers[c.id].setStyle(changeStyle(c));
    changeMarkers[c.id].setTooltipContent(changeTip(c));
  }
}

/* Everything below used to run at load. It now runs from buildLayers() once
   /api/board has answered, and again whenever the roster changes. */
function buildLayers() {
  baseLayer.clearLayers();
  for (const k of [hotspotMarkers, agencyMarkers, pantryMarkers, supplierMarkers, changeMarkers])
    for (const id in k) delete k[id];

  map.fitBounds(L.latLngBounds(HOTSPOTS.map(h => [h.lat, h.lon])).pad(0.12));

/* Only blocks that clear Gi*'s own significance bar (p<0.05) go on the map
   at all -- the rest are exactly the isolated spikes the whole exercise
   exists to tell apart from real clusters, and showing them at the same
   density just re-clutters the map with the noise Gi* was supposed to
   filter out. This is a DISPLAY decision only: dispatch.py's matching still
   runs against the full need>=MIN_CANDIDATE_NEED list untouched -- a real
   23-person block does not stop being eligible for a pickup just because it
   is not a statistical cluster (GI_STAR_SPEC.md 3.3). */
$("forecastBtn").hidden = role !== "agency";
const significantHotspots = HOTSPOTS.filter(h => h.giFlag === "hot95" || h.giFlag === "hot99");
for (const h of (role === "agency" ? significantHotspots : [])) {
  const m = L.circleMarker([h.lat, h.lon], { ...hotspotStyle(h), className: "hs-path" }).addTo(baseLayer);
  m.bindTooltip(hotspotTip(h), { className: "hs-tip", direction: "top", opacity: 1 });
  hotspotMarkers[h.id] = m;
}
if (showForecast && role === "agency") {
  for (const c of (FORECAST_CHANGES || [])) {
    const m = L.circleMarker([c.lat, c.lon], { ...changeStyle(c), className: "hs-path" }).addTo(baseLayer);
    m.bindTooltip(changeTip(c), { className: "hs-tip", direction: "top", opacity: 1 });
    changeMarkers[c.id] = m;
  }
}

/* agency HQ markers */
const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h11v9H3zM14 8h4l3 3v3h-7zM6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>';
/* A truck only for agencies that can actually be dispatched. The rest are
   fixed sites that receive donations -- drawing them with a truck would
   promise a fleet they do not have. */
/* Collectors are visible to a business -- those are the people who come to
   it. A pantry that runs a van collects too, so gating pantries to the agency
   view left the matched collector undrawn and the route line ending in blank
   map. The public view draws its own list in fxLayer, so it takes neither. */
for (const a of (role === "public" ? [] : AGENCIES)) {
  const collects = a.mobileCapable !== false;
  const pending = pendingRequestCount(a.id);
  const badge = pending ? `<span class="req-pending-dot" title="${pending} pending request${pending>1?"s":""}"></span>` : "";
  const html = collects
    ? `<div class="mk-agency" id="col-${a.id}">${TRUCK_SVG}${badge}</div>`
    : `<div class="mk-dropoff" id="col-${a.id}">${badge}</div>`;
  L.marker([a.lat, a.lon], {
    icon: L.divIcon({ className: "", html,
      iconSize: collects ? [26, 26] : [14, 14],
      iconAnchor: collects ? [13, 13] : [7, 7] }),
    zIndexOffset: collects ? 500 : 300,
  }).addTo(baseLayer).bindTooltip(
    `<b>${a.name}</b><div class="tip-k">${a.program}` +
    `<br>${a.acceptsPrepared ? "accepts prepared food" : "packaged/produce"}` +
    (collects ? "" : "<br>fixed drop-off site — no collection vehicle") +
    (pending ? `<br><b style="color:#e03b3b">${pending} request${pending>1?"s":""} waiting</b>` : "") + `</div>`,
    { className: "hs-tip", direction: "top", opacity: 1 }
  );
}

/* mobile pantry sites — violet diamonds; solid = unit available tonight.
   Agency-view only, same reasoning as hotspots above: the public/find-food
   view builds its OWN pantry markers from the search result (renderPantries)
   so only pantries within the searched range ever show there, and only
   after a search -- these always-on markers would defeat that. */
for (const p of (role === "agency" ? PANTRIES
                 : role === "business" ? PANTRIES.filter(x => x.dispatchable)
                 : [])) {
  const cls = p.dispatchable ? "mk-pantry" : "mk-pantry idle";
  const status = p.dispatchable
    ? '<br><b class="tip-pantry">mobile unit available tonight</b>'
    : `<br>${p.whyNot}`;
  L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: "", html: `<div class="${cls}" id="col-${p.id}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 400,
  }).addTo(baseLayer).bindTooltip(
    `<b>${p.name}</b><div class="tip-k">${p.operator} &middot; ${p.program}` +
    `<br>runs ${p.schedule}${status}</div>`,
    { className: "hs-tip", direction: "top", opacity: 1 }
  );
}

/* supplier markers ("input markers") — business view only. Clicking one on
   the map does exactly what clicking it in the left sidebar does
   (pickRestaurant): same selection, same agency-only route. Never jumps to
   the ledger -- a restaurant already collected/delivered just shows that
   status inline (renderBusiness), the same as any other restaurant. */
for (const s of (role === "business" ? SUPPLIERS : [])) {
  const cls = s.report ? "mk-supplier" : "mk-supplier quiet";
  const m = L.marker([s.lat, s.lon], {
    icon: L.divIcon({ className: "", html: `<div class="${cls}" id="sp-${s.id}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    zIndexOffset: 700,
  }).addTo(baseLayer);
  const rep = s.report
    ? `<br><b class="tip-supplier">${s.report.lbs} lbs</b> ${s.surplus} &middot; reported ${s.report.time}`
    : "<br>no surplus reported tonight";
  m.bindTooltip(
    `<b>${s.name}</b><div class="tip-k">${s.type}${rep}</div>`,
    { className: "hs-tip", direction: "top", opacity: 1 }
  );
  m.on("click", () => {
    if (!s.report) return openForm(s);
    pickRestaurant(s.id);
  });
}

}   /* ---- end buildLayers() ---- */

/* ------------------------------------------------------------------ feed */
const rcWindow = r => {
  const bits = [];
  if (r.pickupTo) bits.push(`pickup <b>${r.pickupFrom}\u2013${r.pickupTo}</b>`);
  if (r.expiresAt) bits.push(`good until <b>${r.expiresAt}</b>`);
  return bits.length ? `<div class="rc-window">${bits.join(" &middot; ")}</div>` : "";
};

function renderFeed() {
  const done = dispatchedSupplierIds();
  $("feed").innerHTML = REPORTING.map(s => {
    const rec = tonight.find(r => r.supplierId === s.id);
    return `
    <div class="report-card ${done.has(s.id) ? "done" : ""}" id="card-${s.id}">
      <div class="rc-top">
        <span class="type-badge">${typeIcon[s.type] || "RS"}</span>
        <span class="rc-name">${s.registered ? '<span class="rc-saved">SAVED</span>' : ""}${
          s.report.updated ? '<span class="rc-upd">UPDATED</span>' : ""}${s.name}</span>
        <span class="rc-time">${s.report.time}</span>
        <button class="rc-edit" data-edit="${s.id}" title="Surplus differs every night — update tonight's numbers">Update</button>
      </div>
      <div class="rc-mid">
        <span class="rc-lbs">${s.report.lbs} lbs</span>
        <span class="rc-meals">&asymp; ${fmtInt(s.report.lbs / C.LBS_PER_MEAL)} meals</span>
        <span class="rc-chip ${s.surplus === "prepared" ? "prepared" : ""}">${s.surplus}</span>
      </div>
      <div class="rc-items">${s.report.items}</div>
      ${rcWindow(s.report)}
      ${rec ? `<div class="rc-done">✓ dispatched &middot; ${agShort({ name: rec.collector })} &rarr; ${rec.hotspot}</div>` : ""}
    </div>`;
  }).join("");
  /* Partners with nothing tonight are not a dead list — tomorrow they may
     have something, and reporting it is the whole point of the platform. */
  const quietOnes = SUPPLIERS.filter(s => !s.report);
  if (quietOnes.length) {
    $("feed").insertAdjacentHTML("beforeend", `
      <div class="quiet-list">
        <div class="quiet-head">${quietOnes.length} partners &mdash; no surplus tonight</div>
        ${quietOnes.map(s => `
          <button class="quiet-row" data-edit="${s.id}">
            <span class="type-badge">${typeIcon[s.type] || "RS"}</span>
            <span class="qr-name">${s.name}</span>
            <span class="qr-act">report&nbsp;+</span>
          </button>`).join("")}
      </div>`);
  }

  for (const s of REPORTING) {
    $("card-" + s.id).addEventListener("click", ev => {
      if (ev.target.dataset.edit) return;          /* Update handles itself */
      if (dispatchedSupplierIds().has(s.id)) openLedger(); else selectReport(s);
    });
  }
  $("feed").querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      openForm(SUPPLIERS.find(x => x.id === btn.dataset.edit));
    });
  });
  for (const s of REPORTING) {
    const el = $("sp-" + s.id);
    if (el) el.classList.toggle("dispatched", done.has(s.id));
  }
}

/* --------------------------------------------------------------- topbar */
function renderStats() {
  /* Two figures only. Four chips crowded the bar and the detail belongs in
     the panel, where there is room to say what it means. */
  const reporting = SUPPLIERS.filter(s => s.report);
  const lbs = reporting.reduce((t, s) => t + s.report.lbs, 0);
  const fed = tonight.reduce((t, r) => t + r.servedMeals, 0);
  $("topstats").innerHTML = [
    [fmtInt(lbs) + " lbs", "reported"],
    [fmtInt(fed), "people fed"],
  ].map(([v, k]) => `<div class="stat-chip"><span class="v">${v}</span><span class="k">${k}</span></div>`).join("");
}

/* ------------------------------------------------- selection + animation */
let animToken = 0;
let selectedId = null;
let currentMatch = null;   // { supplier, result } for the confirm button

function clearFx() {
  fxLayer.clearLayers();
  $("calcOverlay").classList.remove("show");
  document.querySelectorAll(".mk-agency.winner, .mk-pantry.winner").forEach(el => el.classList.remove("winner"));
  document.querySelectorAll(".mk-supplier.selected").forEach(el => el.classList.remove("selected"));
  for (const id in hotspotMarkers) {
    const el = hotspotMarkers[id].getElement();
    if (el) el.classList.remove("hs-winner", "hs-scanned");
  }
}

async function selectReport(s, opts = {}) {
  if (selectedId === s.id && !opts.force) return;
  selectedId = s.id;
  const token = ++animToken;
  clearFx();

  document.querySelectorAll(".report-card.active").forEach(el => el.classList.remove("active"));
  const card = $("card-" + s.id);
  if (card) {
    card.classList.add("active");
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  const pin = $("sp-" + s.id);
  if (pin) pin.classList.add("selected");

  /* Scoring is a round trip now. On a local server the answer lands long
     before the scan animation would finish; the token guard covers the rest. */
  let result;
  try {
    result = await dispatchFor(s);
  } catch (err) {
    $("resultEmpty").style.display = "";
    $("resultBody").hidden = true;
    $("calcOverlay").classList.remove("show");
    return;
  }
  if (token !== animToken) return;
  currentMatch = { supplier: s, result };
  runTriangulation(s, result, token);
}

function runTriangulation(s, result, token) {
  /* No viable pair is a real answer, not a failure. Refusing a run that costs
     more than the food is worth is the point -- so say so plainly rather than
     animating toward a recommendation that does not exist. */
  if (!result.pairs.length) return renderRefusal(s, result);

  const best = result.pairs[0];
  const live = () => token === animToken;

  /* hide any previous result while we "compute" */
  $("resultBody").hidden = true;
  $("resultEmpty").style.display = "none";

  const scanBounds = L.latLngBounds(HOTSPOTS.map(h => [h.lat, h.lon])).extend([s.lat, s.lon]);
  map.flyToBounds(scanBounds.pad(0.1), { duration: 0.55 });

  /* radar pulse at the supplier */
  fxLayer.addLayer(L.marker([s.lat, s.lon], {
    icon: L.divIcon({ className: "", html: '<div class="radar"><span></span><span></span><span></span></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
    interactive: false, zIndexOffset: 900,
  }));

  /* calc overlay */
  const constraint = result.prepared
    ? `constraint: prepared food &rarr; ${result.eligibleCount} of ${result.collectorCount} collectors eligible`
    : `${result.eligibleCount} collectors &times; ${result.candidateCount} open blocks`;
  $("calcTitle").textContent = "TRIANGULATING";
  $("calcLine").innerHTML = `${s.name} &middot; ${constraint}`;
  $("calcOverlay").classList.add("show");

  const SCAN_MS = 1350, SHORTLIST_MS = 850;

  /* pair counter counts up through the scan */
  const t0 = performance.now();
  (function tick(now) {
    if (!live()) return;
    const p = Math.min((now - t0) / SCAN_MS, 1);
    $("calcCount").textContent = fmtInt(result.evaluated * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);

  /* scan lines: quick flicks from the supplier to sampled candidate blocks */
  const openIds = new Set(result.pairs.map(p => p.hotspot.id));
  const sample = CANDIDATES.filter(h => openIds.has(h.id)).sort(() => Math.random() - 0.5).slice(0, 26);
  sample.forEach((h, i) => {
    setTimeout(() => {
      if (!live()) return;
      const line = L.polyline([[s.lat, s.lon], [h.lat, h.lon]], {
        color: themeColor("--c-supplier"), weight: 1.3, opacity: 0.9,
        className: "scan-line", interactive: false,
      });
      fxLayer.addLayer(line);
      setTimeout(() => fxLayer.removeLayer(line), 520);
      const el = hotspotMarkers[h.id].getElement();
      if (el) { el.classList.remove("hs-scanned"); void el.getBBox; el.classList.add("hs-scanned"); }
    }, 90 + i * (SCAN_MS - 200) / sample.length);
  });

  /* shortlist: top-3 hotspots pulse while collectors are weighed */
  setTimeout(() => {
    if (!live()) return;
    $("calcTitle").textContent = "SHORTLISTING";
    $("calcLine").innerHTML = "weighing need, access gap, serving limits and deployment cost";
    const seen = new Set(), top = [];
    for (const p of result.pairs) {
      if (!seen.has(p.hotspot.id)) { seen.add(p.hotspot.id); top.push(p.hotspot); }
      if (top.length === 3) break;
    }
    for (const h of top) {
      fxLayer.addLayer(L.polyline([[s.lat, s.lon], [h.lat, h.lon]], {
        color: themeColor("--c-hotspot"), weight: 2, opacity: 0.85,
        className: "short-line", interactive: false,
      }));
    }
  }, SCAN_MS);

  /* lock: draw the winning route, light up the pair, show the result */
  setTimeout(() => {
    if (!live()) return;
    $("calcTitle").textContent = "DISPATCH LOCKED";
    $("calcLine").innerHTML =
      `${agShort(best.collector)} &rarr; pickup &rarr; ${best.hotspot.location}`;
    $("calcCount").textContent = fmtInt(result.evaluated);

    /* keep only radar + winning graphics */
    fxLayer.eachLayer(l => { if (l.options.className === "short-line") fxLayer.removeLayer(l); });

    const a = best.collector, h = best.hotspot;
    const role = best.dropoff ? "--c-agency"
      : (a.kind === "pantry" ? "--c-pantry" : "--c-agency");

    /* A drop-off is one leg: the food goes to the site and people come to it.
       Drawing a second leg would imply a delivery run that never happens. */
    fxLayer.addLayer(L.polyline([[s.lat, s.lon], [a.lat, a.lon]], {
      color: themeColor(role), bellyRole: role,
      weight: best.dropoff ? 3.5 : 2.5, opacity: 0.9,
      className: best.dropoff ? "route-leg2" : "route-leg1", interactive: false,
    }));
    if (h) {
      fxLayer.addLayer(L.polyline([[s.lat, s.lon], [h.lat, h.lon]], {
        color: themeColor("--c-route"), bellyRole: "--c-route",
        weight: 3.5, opacity: 0.95, className: "route-leg2", interactive: false,
      }));
    }
    const colEl = $("col-" + a.id);
    if (colEl) colEl.classList.add("winner");
    if (h && hotspotMarkers[h.id]) {
      const hEl = hotspotMarkers[h.id].getElement();
      if (hEl) hEl.classList.add("hs-winner");
    }

    const bounds = [[a.lat, a.lon], [s.lat, s.lon]];
    if (h) bounds.push([h.lat, h.lon]);
    map.flyToBounds(L.latLngBounds(bounds).pad(0.18), { duration: 0.8 });

    renderResult(s, result);
    setTimeout(() => { if (live()) $("calcOverlay").classList.remove("show"); }, 2600);
  }, SCAN_MS + SHORTLIST_MS);
}

function renderRefusal(s, result) {
  clearFx();
  $("calcOverlay").classList.remove("show");
  $("resultEmpty").style.display = "none";

  const top = result.rejections.slice(0, 5);
  const meals = fmtInt(result.meals);
  $("resultBody").innerHTML = `
    <div class="rb-eyebrow rb-refused">No viable dispatch</div>
    <div class="rb-source">from <b>${s.name}</b> &middot; ${fmtInt(s.report.lbs)} lbs
      ${s.surplus} &middot; ${meals} meals &middot; reported ${result.reportedAt}
      <br>pickup window ${result.window.from}&ndash;${result.window.to}
      &middot; good until ${result.expiresAt}</div>

    <div class="refused-box">
      <div class="rf-title">Nothing here is worth the run.</div>
      <div class="rf-sub">Every collector and every open block was checked, and
        none of them covers its own fuel and staff time for ${meals} meals.
        Holding this for a larger pickup moves more food per mile than driving
        for it now.</div>
    </div>

    <div class="rb-h">Why each option failed
      (${fmtInt(result.evaluated + result.rejections.reduce((t, r) => t + r.count, 0))} evaluated)</div>
    ${top.map(r => `<div class="alt-row">
      <span class="alt-rank">&times;${r.count}</span>
      <span class="alt-pair">${r.example}</span></div>`).join("")}`;
  $("resultBody").hidden = false;
}

/* ---------------------------------------------------------- result panel */
function renderResult(s, result) {
  const b = result.pairs[0];
  const h = b.hotspot, a = b.collector;
  const isPantry = a.kind === "pantry";
  const boostPct = Math.round((b.boost - 1) * 100);
  const fmv = result.fmv;
  const freshPct = Math.round(b.freshness * 100);
  const servedBefore = h ? servedMealsTonight(h.id) : 0;

  /* alternates: next best pairs with a distinct collector or hotspot */
  const alts = [];
  for (const p of result.pairs.slice(1)) {
    if (alts.length === 3) break;
    /* compare by id: these came off the wire, not from the same objects */
    const sameTarget = p.hotspot && h ? p.hotspot.id === h.id : (!p.hotspot && !h);
    if (p.collector.id !== a.id || !sameTarget) alts.push(p);
  }

  $("resultBody").innerHTML = `
    <div class="rb-eyebrow">Dispatch recommendation</div>
    <div class="rb-source">from <b>${s.name}</b> &middot; ${s.report.lbs} lbs ${s.surplus}
      &middot; ${fmtInt(result.meals)} meals &middot; reported ${result.reportedAt}
      <br>pickup window ${result.window.from}&ndash;${result.window.to}
      &middot; good until ${result.expiresAt}
      &middot; collected ${b.pickupAt}, ${b.deferred
        ? `held overnight, delivered <b>${b.deliversAt}</b>`
        : `served ${b.arrivesAt}`}</div>

    <div class="pair">
      <div class="pair-node ${isPantry ? "pn-pantryunit" : "pn-agency"}">
        <div class="pn-badge">${TRUCK_SVG.replace("<svg", '<svg width="17" height="17"')}</div>
        <div>
          <div class="pn-role">${isPantry ? "Mobile pantry unit" : "Collecting agency"}</div>
          <div class="pn-name">${a.name}</div>
          <div class="pn-sub">${isPantry ? `${a.operator} &middot; ${a.program}` : a.program}</div>
        </div>
      </div>
      <div class="pair-arrow"></div>
      <div class="pair-node pn-pickup">
        <div class="pn-badge type-badge">${typeIcon[s.type] || "RS"}</div>
        <div>
          <div class="pn-role">Pickup</div>
          <div class="pn-name">${s.name}</div>
          <div class="pn-sub">${s.report.items}</div>
        </div>
      </div>
      <div class="pair-arrow"></div>
      ${h ? `<div class="pair-node pn-hotspot">
        <div class="pn-badge type-badge">HS</div>
        <div>
          <div class="pn-role">Distribution hotspot</div>
          <div class="pn-name">${h.location} &middot; ${h.area}</div>
          <div class="pn-sub">need ${h.need.toFixed(1)} &middot; rank #${h.rank} of 382
            &middot; food access ${h.accessDays.toFixed(h.accessDays % 1 ? 1 : 0)} d/wk${
              servedBefore > 0 ? ` &middot; ${fmtInt(servedBefore)} meals already tonight` : ""}</div>
        </div>
      </div>` : `<div class="pair-node pn-dropoff">
        <div class="pn-badge type-badge">FX</div>
        <div>
          <div class="pn-role">Fixed drop-off</div>
          <div class="pn-name">${a.name}</div>
          <div class="pn-sub">people collect here — no distribution run tonight</div>
        </div>
      </div>`}
    </div>

    <div class="outcomes">
      <div class="oc oc-people"><div class="v" data-count="${b.served}">0</div><div class="k">people fed</div></div>
      <div class="oc"><div class="v" data-count="${b.miles}" data-dec="1">0</div><div class="k">route miles</div></div>
      <div class="oc oc-net ${b.net < 0 ? "neg" : ""}"><div class="v" data-count="${b.net}" data-money="1">0</div><div class="k">net benefit</div></div>
    </div>

    <div class="score-viz">
      <div class="sv-row"><span class="sv-label">Freshness</span>
        <span class="sv-track"><span class="sv-fill sv-fresh" data-pct="${freshPct}"></span></span>
        <span class="sv-val">${freshPct}%</span></div>
      <div class="sv-row sv-reward"><span class="sv-label">Reward</span>
        <span class="sv-track"><span class="sv-fill" data-w="${b.reward}"></span></span>
        <span class="sv-val">${fmt$(b.reward)}</span></div>
      <div class="sv-row sv-cost"><span class="sv-label">Op. cost</span>
        <span class="sv-track"><span class="sv-fill" data-w="${b.cost}"></span></span>
        <span class="sv-val">&minus;${fmt$(b.cost).slice(1)}</span></div>
      <div class="sv-row sv-net"><span class="sv-label">Net</span>
        <span class="sv-track"><span class="sv-fill" data-w="${Math.max(b.net, 0)}"></span></span>
        <span class="sv-val">${fmt$(b.net)}</span></div>
    </div>

    <button class="btn-confirm" id="confirmBtn">✓ Confirm dispatch &amp; log receipt</button>

    ${b.deferred ? `<div class="rb-note"><b>Held overnight, delivered ${b.deliversAt}</b>
      — the crew could not reach ${h ? h.location : "the block"} before standing
      down tonight, so it goes back to ${agShort(a)} and out on their next
      scheduled run. Costed for both trips (${b.miles.toFixed(1)} mi in total),
      and the food is ${freshPct}% of its value by the time it is handed over.
      This only happens when the food still keeps that long.</div>` : ""}
    ${a.kind === "agency" ? `<div class="rb-note"><b>Box truck, ${b.crew}-person crew</b>
      — a ${fmtInt(a.capacityLbs)} lb truck run is not a one-person job, and it burns
      ${C.MPG.agency} mpg against a van's ${C.MPG.pantry}. It wins here because the load
      is big enough to justify that.</div>` : ""}
    ${b.dropoff ? `<div class="rb-note"><b>Fixed drop-off — one leg, no distribution run</b>
      — ${a.name} has no collection vehicle, so this is scored on the
      ${b.miles.toFixed(1)} mi between the donor and the site alone. Stocking a
      pantry is credited at ${Math.round(C.DROPOFF_CREDIT * 100)}% of feeding a
      counted block tonight, so this only wins when no hotspot run was worth
      making.</div>` : ""}
    <div class="rb-note"><b>${b.hoursToPeople}h from report to served</b> —
      arrives ${b.arrivesAt}, ${freshPct}% of its value intact against a
      ${result.expiresAt} expiry. Reward is scaled by that.</div>
    ${result.prepared ? `<div class="rb-note"><b>Prepared food</b> — only collectors that accept
      prepared meals were considered (${result.eligibleCount} of ${result.collectorCount}).</div>` : ""}
    ${servedBefore > 0 ? `<div class="rb-note"><b>Serving limit</b> — this block already received
      ${fmtInt(servedBefore)} meals tonight; only its remaining need of ${b.remaining.toFixed(1)}
      counts toward the reward.</div>` : ""}
    ${h && boostPct > 0 ? `<div class="rb-note"><b>Access-gap boost +${boostPct}%</b> — this block has
      scheduled food access only ${h.accessDays.toFixed(h.accessDays % 1 ? 1 : 0)} days/week, so its
      reward is weighted up.</div>` : ""}
    ${b.uncollectedLbs >= 1 ? `<div class="rb-note"><b>Unit capacity ${a.capacityLbs} lbs</b> —
      the pantry van collects ${fmtInt(b.collectedLbs)} lbs; ${fmtInt(b.uncollectedLbs)} lbs stay
      with the donor for a second pickup.</div>` : ""}
    ${b.surplus >= 1 ? `<div class="rb-note">Block need absorbs ${fmtInt(b.served)} meals;
      remaining <b>${fmtInt(b.surplus)} meals</b> ${isPantry
        ? `stock ${agShort(a)}&rsquo;s next scheduled distribution`
        : `ride along to ${agShort(a)}&rsquo;s pantry network`}.</div>` : ""}
    <div class="rb-note tax">Confirming logs a receipt for <b>${s.name}</b> — est. deductible
      fair market value <b>${fmt$(fmv)}</b> (${s.report.lbs} lbs &times; $${C.FMV_PER_LB}/lb).</div>

    <table class="rb-table">
      <tr><td>${b.dropoff ? "Donor &rarr; site (one leg)"
        : (b.deferred ? "Out, back, then out again next run"
        : `${isPantry ? "Site" : "HQ"} &rarr; pickup &rarr; hotspot &rarr; back`)}</td>
        <td>${b.dropoff ? `${b.leg1.toFixed(1)} mi`
          : `${b.miles.toFixed(1)} mi`}</td></tr>
      <tr><td>Drive + handling time</td><td>${fmtInt(b.driveMin)} + ${C.HANDLING_MIN} min</td></tr>
      <tr><td>Fuel (${b.miles.toFixed(1)} mi &divide; ${C.MPG[a.kind] || C.MPG.pantry} mpg
        &times; $${C.FUEL_PRICE_PER_GAL}/gal)</td><td>${fmt$(b.fuel)}</td></tr>
      <tr><td>Vehicle wear ($${(C.WEAR_PER_MILE[a.kind] || C.WEAR_PER_MILE.pantry).toFixed(3)}/mi)</td>
        <td>${fmt$(b.vehicle)}</td></tr>
      <tr><td>Crew (${b.crew} &times; $${C.WAGE_PER_HR}/hr)</td><td>${fmt$(b.labor)}</td></tr>
      <tr class="total"><td>Deployment cost</td><td>${fmt$(b.cost)}</td></tr>
    </table>

    ${result.rejections.length ? `<div class="rb-h">Ruled out</div>
      ${result.rejections.map(r => `<div class="alt-row">
        <span class="alt-rank">&times;${r.count}</span>
        <span class="alt-pair">${r.example}</span></div>`).join("")}` : ""}

    <div class="rb-h">Runners-up (${fmtInt(result.evaluated)} pairs evaluated)</div>
    ${alts.map((p, i) => `
      <div class="alt-row"><span class="alt-rank">${i + 2}.</span>
        <span class="alt-pair"><b>${agShort(p.collector)}</b>
          &rarr; ${p.hotspot.location}</span>
        <span class="alt-net">${fmt$(p.net)}</span></div>`).join("")}

    <details class="model">
      <summary>How this was scored — the reward&#8209;cost model</summary>
      <div class="model-body"><em>net = reward − cost</em>
collectors = agency trucks (${C.AGENCY_CAPACITY_LBS} lb) + pantry
  units on site tonight (${C.PANTRY_CAPACITY_LBS} lb van)
serving limit = ${C.MAX_DROPS_PER_NIGHT} deliveries/hotspot/night; served
  blocks leave the pool, partial blocks count remaining need
reward = min(collected meals, remaining need) × $${C.MEAL_VALUE}/meal × accessBoost
         + overflow meals × $${C.MEAL_VALUE} × 0.5 (pantry)
accessBoost = 1 + ${C.ACCESS_BOOST_MAX} × (7 − access days/wk)/7
cost = fuel    miles ÷ mpg × $${C.FUEL_PRICE_PER_GAL}/gal   [CA average]
     + vehicle miles × wear/mi (maintenance, tyres,
               insurance, depreciation)
     + crew    (drive + ${C.HANDLING_MIN} min) × $${C.WAGE_PER_HR}/hr × crew  [SD min. wage 2026]
  truck  10 mpg, $0.275/mi wear, 2 crew  → $0.76/mi   [= IRS rate 2026]
  van    18 mpg, $0.220/mi wear, 1 crew  → $0.49/mi
meals = lbs ÷ ${C.LBS_PER_MEAL}                        [Feeding America]
distances: haversine × ${C.ROAD_FACTOR} at ${C.AVG_SPEED_MPH} mph city speed</div>
    </details>`;

  $("resultBody").hidden = false;
  $("confirmBtn").addEventListener("click", confirmDispatch);

  /* count-up + bar-grow animations */
  const maxBar = Math.max(b.reward, b.cost, 1);
  requestAnimationFrame(() => {
    document.querySelectorAll(".sv-fill").forEach(el => {
      el.style.width = el.dataset.pct !== undefined
        ? el.dataset.pct + "%"                      /* freshness is already a % */
        : (parseFloat(el.dataset.w) / maxBar * 100) + "%";
    });
  });
  document.querySelectorAll("#resultBody .v[data-count]").forEach(el => {
    const target = parseFloat(el.dataset.count);
    const money = el.dataset.money, dec = el.dataset.dec ? 1 : 0;
    const start = performance.now();
    (function step(now) {
      const p = Math.min((now - start) / 900, 1);
      const v = target * (1 - Math.pow(1 - p, 3));
      el.textContent = money ? fmt$(v) : v.toFixed(dec ? 1 : 0);
      if (p < 1) requestAnimationFrame(step);
    })(start);
  });
}

/* ------------------------------------------------------------ confirming */
async function confirmDispatch() {
  if (!currentMatch) return;
  const { supplier: s } = currentMatch;
  if (dispatchedSupplierIds().has(s.id)) return;

  const btn = $("confirmBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Confirming…"; }

  let res;
  try {
    res = await api(`/api/board/confirm/${s.id}`, { method: "POST" });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Confirm dispatch"; }
    return;
  }

  tonight = res.tonight;
  refreshHotspots();
  renderFeed();
  renderStats();
  $("ledgerCount").textContent = tonight.length;

  const h = res.hotspot;
  if (btn) btn.outerHTML = `<div class="confirmed-note">✓ Dispatched — receipt ${res.receipt.receipt} logged
    <div class="cn-sub">${h.location} ${h.closed
      ? (h.closedWhy === "drops"
          ? `has had its ${C.MAX_DROPS_PER_NIGHT} deliveries for tonight and leaves the candidate pool`
          : "is now fully served tonight and leaves the candidate pool")
      : `has ${h.remaining} need remaining tonight`}</div></div>`;
}

/* ---------------------------------------------------------------- ledger */
function renderLedger() {
  const all = [...tonight].reverse().map(r => ({ ...r, isTonight: true }))
    .concat([...HISTORY].reverse());
  const grand = [...HISTORY, ...tonight];

  const totalLbs = grand.reduce((t, r) => t + r.lbs, 0);
  const totalFmv = grand.reduce((t, r) => t + r.fmv, 0);
  const totalFed = grand.reduce((t, r) => t + r.servedMeals, 0);
  $("ledgerTiles").innerHTML = [
    [fmtInt(grand.length), "deliveries logged", ""],
    [fmtInt(tonight.length), "tonight", "lt-route"],
    [fmtInt(totalLbs) + " lbs", "food recovered", ""],
    [fmtInt(totalFed), "people fed", "lt-route"],
    ["$" + fmtInt(totalFmv), "est. FMV deductions", "lt-good"],
  ].map(([v, k, cls]) => `<div class="lt ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  $("ledgerLog").innerHTML = all.length ? all.map(r => `
    <div class="receipt ${r.isTonight ? "tonight" : ""}">
      <div class="rt-top">
        <span class="rt-id">${r.receipt}</span>
        ${r.isTonight ? '<span class="rt-badge">tonight</span>' : ""}
        <span class="rt-when">${r.date} &middot; ${r.time}</span>
      </div>
      <div class="rt-flow"><b>${r.supplier}</b> <span class="rt-arrow">&rarr;</span>
        ${agShort({ name: r.collector })}
        <span class="rt-arrow">&rarr;</span> ${r.hotspot}</div>
      <div class="rt-nums">
        <span><b>${r.lbs}</b> lbs donated</span>
        <span><b>${r.servedMeals}</b> people fed</span>
        <span class="fmv">est. FMV <b>${fmt$(r.fmv)}</b></span>
        <span>net ${fmt$(r.net)}</span>
      </div>
    </div>`).join("") : '<div class="served-empty">No deliveries logged yet.</div>';

  /* donor tax summary */
  const byDonor = {};
  for (const r of grand) {
    (byDonor[r.supplier] ||= { n: 0, lbs: 0, fmv: 0 });
    byDonor[r.supplier].n++; byDonor[r.supplier].lbs += r.lbs; byDonor[r.supplier].fmv += r.fmv;
  }
  const donors = Object.entries(byDonor).sort((a, b) => b[1].fmv - a[1].fmv);
  $("ledgerDonors").innerHTML = `
    <table class="donor-table">
      <tr><th>Donor</th><th>Deliveries</th><th>Lbs</th><th>Est. FMV</th></tr>
      ${donors.map(([name, d]) => `
        <tr><td>${name}</td><td>${d.n}</td><td>${fmtInt(d.lbs)}</td>
        <td class="fmv">${fmt$(d.fmv)}</td></tr>`).join("")}
    </table>`;

  /* hotspots served tonight */
  $("limitLabel").textContent = C.MAX_DROPS_PER_NIGHT;
  const servedIds = [...new Set(tonight.map(r => r.hotspotId))];
  $("ledgerServed").innerHTML = servedIds.length ? servedIds.map(hid => {
    const h = HOTSPOTS.find(x => x.id === hid);
    const meals = servedMealsTonight(hid), drops = dropsTonight(hid);
    const closed = hotspotClosed(h);
    return `
    <div class="served-row">
      <div class="sr-top">
        <span class="sr-loc">${h.location}</span>
        ${closed ? '<span class="sr-limit">at limit</span>' : ""}
        <span class="sr-stat">${fmtInt(meals)}/${h.need.toFixed(0)} meals &middot; ${drops}/${C.MAX_DROPS_PER_NIGHT} drops</span>
      </div>
      <div class="sr-bar"><span style="width:${Math.min(meals / h.need * 100, 100)}%"></span></div>
    </div>`;
  }).join("") : '<div class="served-empty">Nothing served yet tonight — every block is still in the pool.</div>';
}

function openLedger() {
  renderLedger();
  $("ledger").hidden = false;
  document.body.classList.add("ledger-open");
}
function closeLedger() {
  $("ledger").hidden = true;
  document.body.classList.remove("ledger-open");
}
$("ledgerBtn").addEventListener("click", openLedger);
$("ledgerClose").addEventListener("click", closeLedger);
$("ledger").addEventListener("click", e => { if (e.target === $("ledger")) closeLedger(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("ledger").hidden) closeLedger();
  if (e.key === "Escape" && !$("dashboard").hidden) closeDashboard();
});
$("resetBtn").addEventListener("click", async () => {
  await api("/api/board/ledger/reset", { method: "POST" });
  location.reload();
});

/* ------------------------------------------------------------- dashboard */
/* One aggregate call (GET /api/board/dashboard) rather than re-deriving
   pipeline/ledger/prediction totals from client state three different ways
   -- the same numbers a real ops screen would need, computed once,
   server-side, from the same board() every other route reads. */
async function renderDashboard() {
  let d;
  try { d = await api("/api/board/dashboard"); }
  catch (e) {
    $("dashTiles").innerHTML = `<div class="served-empty">Could not load: ${e.message}</div>`;
    return;
  }

  $("dashTiles").innerHTML = [
    [fmtInt(d.reports.total), "reports tonight", ""],
    [fmtInt(d.requests.pendingTotal), "requests waiting", d.requests.pendingTotal ? "kpi-warn" : ""],
    [fmtInt(d.ledger.deliveries), "delivered", "kpi-route"],
    [fmtInt(d.ledger.servedMeals), "people fed", "kpi-route"],
    ["$" + fmtInt(d.ledger.fmvTotal), "est. FMV tonight", "kpi-good"],
  ].map(([v, k, cls]) => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  // one horizontal flow instead of five stacked bars -- a shape read in one
  // glance rather than one row at a time; per-status lb totals live in the
  // ledger already, so they aren't repeated here
  const STAGES = ["reported", "requested", "accepted", "delivered", "declined"];
  const maxN = Math.max(1, ...STAGES.map(s => d.reports.byStatus[s] || 0));
  $("dashPipeline").innerHTML = STAGES.map(s => {
    const n = d.reports.byStatus[s] || 0;
    return `
    <div class="funnel-step ${s === "declined" ? "fs-declined" : ""}">
      <div class="fs-n">${fmtInt(n)}</div>
      <div class="fs-k">${s}</div>
      <div class="fs-bar"><span style="width:${n / maxN * 100}%"></span></div>
    </div>`;
  }).join("");

  const pending = Object.entries(d.requests.pendingByCollector);
  $("dashPending").innerHTML = pending.length ? pending.map(([cid, n]) => {
    const c = COLLECTORS.find(x => x.id === cid);
    return `<div class="pending-row"><span>${c ? c.name : cid}</span>
      <span class="pr-n">${n} waiting</span></div>`;
  }).join("") : '<div class="served-empty">Nothing waiting on anyone right now.</div>';

  $("dashPredictSummary").innerHTML = `
    <div class="opsboard-predict-line"><b>${d.prediction.totalClusters}</b> significant clusters
      on the map &middot; ${d.prediction.byPredict.emerging || 0} emerging,
      ${d.prediction.byPredict.cooling || 0} cooling,
      ${d.prediction.byPredict.established || 0} established</div>
    <div class="opsboard-predict-line"><b>${d.prediction.predictedChanges}</b>
      block${d.prediction.predictedChanges === 1 ? "" : "s"} predicted to change in ~6 months</div>`;

  // top 3, not 5 -- a bar you can compare at a glance beats a longer table
  const moverRows = (list, cls) => {
    if (!list.length) return '<div class="served-empty">None right now.</div>';
    const top = list.slice(0, 3);
    const maxAbs = Math.max(...top.map(h => Math.abs(h.trend)), 0.1);
    return top.map(h => `
      <div class="mover-row">
        <div class="mover-top"><span class="mv-loc">${h.location}</span>
          <span class="mv-val">${h.trend >= 0 ? "+" : ""}${h.trend.toFixed(1)}/yr</span></div>
        <div class="mover-bar ${cls}"><span style="width:${Math.abs(h.trend) / maxAbs * 100}%"></span></div>
      </div>`).join("");
  };
  $("dashEmerging").innerHTML = moverRows(d.prediction.topEmerging, "mv-emerging");
  $("dashCooling").innerHTML = moverRows(d.prediction.topCooling, "mv-cooling");
}

function openDashboard() {
  renderDashboard();
  $("dashboard").hidden = false;
  document.body.classList.add("ledger-open");
}
function closeDashboard() {
  $("dashboard").hidden = true;
  document.body.classList.remove("ledger-open");
}
$("dashboardBtn").addEventListener("click", openDashboard);
$("dashboardClose").addEventListener("click", closeDashboard);
$("dashboard").addEventListener("click", e => { if (e.target === $("dashboard")) closeDashboard(); });

/* ----------------------------------------------------------- theme toggle */
const THEME_ICON_SUN = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const THEME_ICON_MOON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
function setThemeButton() {
  // icon only, no label -- its color is `currentColor`, inherited from
  // --ink, which is the theme's own black/white, so it never needs a
  // per-theme color rule of its own
  $("themeBtn").innerHTML = theme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON;
  $("themeBtn").title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
$("themeBtn").addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("bellyup.theme", theme); } catch (e) { /* best effort */ }
  applyThemeAttr();
  setThemeButton();
  tiles.setUrl(TILE_URLS[theme]);
  refreshHotspots();
  fxLayer.eachLayer(l => {
    if (l.options.bellyRole && l.setStyle) l.setStyle({ color: themeColor(l.options.bellyRole) });
  });
});

/* ------------------------------------------------------ map legend toggle */
/* Starts collapsed on phones, where its 11 rows would otherwise eat more
   than half the map; starts expanded everywhere else, matching how it's
   always behaved on desktop. */
(() => {
  const legend = $("mapLegend"), toggle = $("legendToggle");
  const setCollapsed = collapsed => {
    legend.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  setCollapsed(window.matchMedia("(max-width: 700px)").matches);
  toggle.addEventListener("click", () => setCollapsed(!legend.classList.contains("collapsed")));
})();

/* ============================================ report in / update / boot */
/* The form does two jobs. A restaurant not yet on the platform registers and
   reports in one step; one already on it revises TONIGHT's numbers. Surplus
   differs every night — a fixed quantity per partner would make the feed a
   fixture rather than a report. */

let formMode = "register";
let formTarget = null;

function openForm(supplier) {
  const form = $("regForm");
  formTarget = supplier || null;
  formMode = supplier ? "edit" : "register";

  $("regOpen").hidden = true;
  form.hidden = false;
  $("regErr").hidden = true;
  delete form.dataset.lat;
  delete form.dataset.lon;

  const isEdit = formMode === "edit";
  $("regWho").hidden = isEdit;
  $("regFor").hidden = !isEdit;
  $("regNone").hidden = !(isEdit && supplier && supplier.report);
  $("regRemove").hidden = !isEdit;
  $("regRemove").textContent = supplier && supplier.registered
    ? "Remove this restaurant from the platform"
    : "This business has left the platform";
  $("regTitle").textContent = isEdit
    ? "Tonight's surplus"
    : "Register & report tonight's surplus";
  $("regSubmit").textContent = isEdit ? "Update & re-match" : "Find a collector";

  if (isEdit) {
    const r = supplier.report;
    $("regFor").innerHTML = `<b>${supplier.name}</b><br>${supplier.address}`
      + (supplier.registered ? "<br>saved to the restaurant dataset" : "")
      + (r ? "" : "<br>no surplus reported yet tonight");
    $("regKind").value = supplier.surplus || "prepared";
    $("regLbs").value = r ? r.lbs : 40;
    $("regItems").value = r ? (r.items || "") : "";
    $("regFrom").value = (r && r.pickupFrom) || "18:30";
    $("regTo").value = (r && r.pickupTo) || "20:30";
    $("regExp").value = (r && r.expiresAt) || "22:00";
    $("regFresh").value = (r && r.freshness) || "fresh";
    $("regLbs").focus();
    $("regLbs").select();
  } else {
    $("regName").value = "";
    $("regAddr").value = "";
    $("regItems").value = "";
    $("regLbs").value = 40;
    $("regGeo").className = "reg-hint";
    $("regGeo").textContent = "Type your address and press Enter.";
    $("regName").focus();
  }
  form.scrollIntoView({ block: "start", behavior: "smooth" });
}

function closeForm() {
  $("regForm").hidden = true;
  $("regOpen").hidden = false;
  $("regErr").hidden = true;
  formTarget = null;
  formMode = "register";
}

async function refreshAll() {
  await loadBoard();
  buildLayers();
  if (role === "agency") await loadOffers();
  else if (role === "public") await renderPantries();
  else renderBusiness();
  renderStats();
  refreshHotspots();
  $("ledgerCount").textContent = tonight.length;
}

/* Autocomplete dropdown for an address <input>, backed by
   /api/geocode/suggest (Nominatim, debounced 350ms so typing fast never
   sends one request per keystroke). onPick(hit) fires the instant someone
   chooses a suggestion with {label, lat, lon} already known -- no second
   geocode round-trip needed, unlike pressing Enter on free text. */
function wireAddressAutocomplete(inputId, listId, onPick) {
  const input = $(inputId), list = $(listId);
  let items = [], hiIndex = -1, debounceTimer = null, requestId = 0;

  function hide() { list.hidden = true; list.innerHTML = ""; items = []; hiIndex = -1; }
  function render() {
    if (!items.length) { hide(); return; }
    list.innerHTML = items.map((it, i) =>
      `<div class="addr-suggestion${i === hiIndex ? " hi" : ""}" data-i="${i}">${it.label}</div>`).join("");
    list.hidden = false;
    list.querySelectorAll("[data-i]").forEach(el => {
      // mousedown, not click: fires before the input's blur, so the row is
      // still in the DOM to read when the handler runs.
      el.addEventListener("mousedown", ev => { ev.preventDefault(); pick(items[+el.dataset.i]); });
    });
  }
  function pick(it) {
    input.value = it.label;
    hide();
    onPick(it);
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (q.length < 3) { hide(); return; }
    const myRequest = ++requestId;
    debounceTimer = setTimeout(async () => {
      list.hidden = false;
      list.innerHTML = `<div class="addr-suggestion-loading">Searching…</div>`;
      try {
        const r = await api(`/api/geocode/suggest?q=${encodeURIComponent(q)}`);
        if (myRequest !== requestId) return;   // a newer keystroke already fired
        items = r.suggestions || [];
        hiIndex = -1;
        if (items.length) render();
        else list.innerHTML = `<div class="addr-suggestion-loading">No matches nearby</div>`;
      } catch (e) { if (myRequest === requestId) hide(); }
    }, 350);
  });

  input.addEventListener("keydown", e => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); hiIndex = Math.min(hiIndex + 1, items.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hiIndex = Math.max(hiIndex - 1, 0); render(); }
    else if (e.key === "Enter" && hiIndex >= 0) { e.preventDefault(); pick(items[hiIndex]); }
    else if (e.key === "Escape") { hide(); }
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
}

function wireForm() {
  const form = $("regForm");

  $("regOpen").addEventListener("click", () => openForm(null));
  $("regCancel").addEventListener("click", closeForm);

  /* resolve the address as they leave the field, so a bad one is caught
     before they submit rather than after */
  $("regAddr").addEventListener("change", async e => {
    const q = e.target.value.trim();
    const hint = $("regGeo");
    if (!q) {
      hint.className = "reg-hint";
      hint.textContent = "Type your address and press Enter.";
      return;
    }
    hint.className = "reg-hint";
    hint.textContent = "Looking up…";
    try {
      const d = await api("/api/geocode?address=" + encodeURIComponent(q));
      hint.className = "reg-hint ok";
      hint.textContent = d.matched;
      form.dataset.lat = d.lat;
      form.dataset.lon = d.lon;
    } catch (err) {
      hint.className = "reg-hint bad";
      hint.textContent = err.message;
      delete form.dataset.lat;
      delete form.dataset.lon;
    }
  });
  wireAddressAutocomplete("regAddr", "regAddrSuggest", hit => {
    const hint = $("regGeo");
    hint.className = "reg-hint ok";
    hint.textContent = hit.label;
    form.dataset.lat = hit.lat;
    form.dataset.lon = hit.lon;
  });

  /* "nothing tonight" is a real answer, not a missing one */
  $("regNone").addEventListener("click", async () => {
    if (!formTarget) return;
    const id = formTarget.id;
    try {
      await api(`/api/board/report/${id}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ has_surplus: false }),
      });
      closeForm();
    } catch (e) {
      $("regErr").textContent = e.message;
      $("regErr").hidden = false;
    }
    await refreshAll();
    if (selectedId === id) { selectedId = null; clearFx(); showEmpty(); }
  });

  $("regRemove").addEventListener("click", async () => {
    if (!formTarget) return;
    const gone = formTarget.id;
    try {
      await api(`/api/board/supplier/${gone}`, { method: "DELETE" });
      closeForm();
    } catch (e) {
      /* most likely the page holds a supplier the server no longer has */
      $("regErr").textContent = e.message + " — refreshing the feed.";
      $("regErr").hidden = false;
      setTimeout(closeForm, 1400);
    }
    await refreshAll();
    if (selectedId === gone) { selectedId = null; clearFx(); showEmpty(); }
  });

  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const err = $("regErr"), btn = $("regSubmit");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = formMode === "edit" ? "Updating…" : "Matching…";

    const common = {
      surplus: $("regKind").value,
      lbs: parseFloat($("regLbs").value),
      items: $("regItems").value.trim(),
      pickup_from: $("regFrom").value || null,
      pickup_to: $("regTo").value || null,
      expires_at: $("regExp").value || null,
      freshness: $("regFresh").value,
    };

    try {
      let supplier;
      if (formMode === "edit") {
        const res = await api(`/api/board/report/${formTarget.id}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ has_surplus: true, ...common }),
        });
        supplier = res.supplier;
      } else {
        const body = {
          name: $("regName").value.trim(),
          address: $("regAddr").value.trim(),
          facility_type: "restaurant",
          ...common,
        };
        if (!body.name) throw new Error("Give the restaurant a name.");
        if (form.dataset.lat) {
          body.lat = +form.dataset.lat;
          body.lon = +form.dataset.lon;
        }
        const res = await api("/api/board/register", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        supplier = res.supplier;
      }
      closeForm();
      await refreshAll();
      await pickRestaurant(supplier.id);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = formMode === "edit" ? "Update & re-match" : "Find a collector";
    }
  });
}

function showEmpty(msg) {
  $("resultBody").hidden = true;
  $("resultBody").innerHTML = "";     // don't keep the last role's panel around
  const e = $("resultEmpty");
  e.style.display = "";
  if (msg) e.innerHTML = msg;
}

const EMPTY_BY_ROLE = {
  business: `<div class="re-icon">&#9678;</div><p>Pick a restaurant on the left to
     see which agency is collecting from it.</p>`,
  agency: `<div class="re-icon">&#9678;</div><p>Add offers to a run on the right to
     see the optimal route. Nothing is taken until you accept.</p>`,
  public: `<div class="re-icon">&#9678;</div><p>Enter your address on the left to
     find food near you.</p>`,
};

/* ============================================================= role views */
/* Three audiences, three different boards. The split is enforced on the
   server too -- a business asking for /api/board/business is never sent a
   hotspot, and neither is the public view. This is the map half of that. */

let role = "agency";
let myAgency = null;
let offers = { offers: [], accepted: [] };
let planned = null;
let basket = [];       // chosen but NOT yet accepted -- previewing is free

function setRole(next) {
  role = next;
  document.querySelectorAll("#roleSwitch button")
    .forEach(b => b.classList.toggle("on", b.dataset.role === next));
  document.body.dataset.role = next;

  const heads = {
    business: ["Restaurants tonight",
               "Pick one to see which agency is collecting from it."],
    agency:   ["Collectors",
               "Pick who you are. Offers appear on the right."],
    public:   ["Food near you",
               "Enter your address; the closest option is shown here."],
  };
  $("feedTitle").textContent = heads[next][0];
  $("feedSub").textContent = heads[next][1];
  $("publicBar").hidden = next !== "public";
  $("regOpen").hidden = next !== "business";
  if (next !== "business") { $("regForm").hidden = true; }

  selectedId = null;
  basket = []; planned = null;
  clearFx();
  showEmpty(EMPTY_BY_ROLE[next]);
  buildLayers();
  if (next === "agency") {
    const list = collectingList();
    selectAgency(myAgency || (list[0] && list[0].id));
  }
  else if (next === "public") renderPantries();
  else { renderBusiness(); }
}

/* ------------------------------------------------------------- business */
function renderBusiness() {
  const reporting = SUPPLIERS.filter(s => s.report);
  const quiet = SUPPLIERS.filter(s => !s.report);

  const badge = s => {
    if (s.status === "delivered") return '<span class="rc-saved">DELIVERED</span>';
    if (s.status === "accepted")  return '<span class="rc-saved">ACCEPTED</span>';
    if (s.status === "requested") return '<span class="rc-upd">REQUESTED</span>';
    return "";
  };

  $("feed").innerHTML = `
    <div class="sec-head">Reporting tonight (${reporting.length})</div>
    ${reporting.map(s => `
      <div class="offer pick ${selectedId === s.id ? "on" : ""}" data-pick="${s.id}">
        <div class="offer-top">
          <span class="type-badge">${typeIcon[s.type] || "RS"}</span>
          <span class="offer-name">${badge(s)}${s.name}</span>
          <span class="offer-net">${fmtInt(s.report.lbs)} lb</span>
          <button class="rc-edit" data-edit="${s.id}"
            title="Surplus differs every night — update tonight's numbers">Update</button>
          <button class="rc-remove" data-remove="${s.id}"
            title="Remove ${s.name} from the platform">&times;</button>
        </div>
        <div class="offer-sub">${s.report.items || ""}<br>
          pickup ${s.report.pickupFrom || s.report.time}–${s.report.pickupTo || "?"}
          ${s.windowClosed ? ' &middot; <span style="color:var(--bad)">window shut</span>' : ""}
        </div>
        ${selectedId === s.id ? bizMatch(s) : ""}
      </div>`).join("")}
    ${quiet.length ? `<div class="sec-head">Quiet tonight (${quiet.length})</div>
      ${quiet.map(s => `
        <div class="quiet-row" data-edit="${s.id}" role="button" tabindex="0">
          <span class="type-badge">${typeIcon[s.type] || "RS"}</span>
          <span class="qr-name">${s.name}</span>
          <span class="qr-act">report&nbsp;+</span>
          <button class="qr-remove" data-remove="${s.id}"
            title="Remove ${s.name} from the platform">&times;</button>
        </div>`).join("")}` : ""}`;

  $("feed").querySelectorAll("[data-pick]").forEach(el =>
    el.addEventListener("click", ev => {
      /* Anything inside the detail panel -- the fallback checkbox especially --
         must not bubble into a re-pick, which would re-render and reset it. */
      if (ev.target.closest(".pickdetail")) return;
      if (ev.target.dataset.edit || ev.target.dataset.remove) return;
      pickRestaurant(el.dataset.pick);
    }));
  $("feed").querySelectorAll("[data-edit]").forEach(b =>
    b.addEventListener("click", ev => {
      ev.stopPropagation();
      if (ev.target.dataset.remove) return;   /* the nested × inside a quiet-row */
      openForm(SUPPLIERS.find(x => x.id === b.dataset.edit));
    }));
  $("feed").querySelectorAll("[data-edit][role=button]").forEach(el =>
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); el.click(); }
    }));
  $("feed").querySelectorAll("[data-remove]").forEach(b =>
    b.addEventListener("click", async ev => {
      ev.stopPropagation();
      const s = SUPPLIERS.find(x => x.id === b.dataset.remove);
      if (!confirm(`Remove ${s ? s.name : "this restaurant"} from the platform?`)) return;
      try {
        await api(`/api/board/supplier/${b.dataset.remove}`, { method: "DELETE" });
      } catch (e) { alert(e.message); return; }
      if (selectedId === b.dataset.remove) { selectedId = null; clearFx(); showEmpty(); }
      await refreshAll();
    }));
  $("feed").querySelectorAll("[data-req]").forEach(b =>
    b.addEventListener("click", async ev => {
      ev.stopPropagation();
      await sendRequest(b.dataset.req);
    }));
  $("feed").querySelectorAll("[data-cancel]").forEach(b =>
    b.addEventListener("click", async ev => {
      ev.stopPropagation();
      await cancelRequest(b.dataset.cancel);
    }));

  $("feedFoot").innerHTML =
    `<span class="dot dot-quiet"></span> Nothing is offered to a collector until
     you request a pickup.`;
  renderStats();
}

/* The one collector a report is addressed to, as a full record with coords.

   `matchedToId` is assigned server-side across ALL reports at once -- least-
   loaded collector first, best net value only as the tie-break (see
   dispatch.assign_targets). So it is deliberately NOT the top row of this
   report's own ranking: a collector already holding four reports loses to a
   quieter one scoring slightly worse. The panel read `matchedTo` from the
   server while the map drew this report's own best pair, so the route pointed
   at Feeding San Diego while the request went to Jacobs & Cushman. Everything
   donor-facing resolves through here instead. */
function matchedCollector(s) {
  if (!s) return null;
  const all = [...AGENCIES, ...PANTRIES];
  const byName = n => all.find(x => x.name === n) || null;
  /* whoever actually holds it outranks whoever it was offered to */
  if (s.acceptedBy) return byName(s.acceptedBy);
  if (s.matchedToId) {
    const hit = all.find(x => x.id === s.matchedToId);
    if (hit) return hit;
  }
  return s.matchedTo ? byName(s.matchedTo) : null;
}

/* A straight line is drawn first, always -- instant, and correct for the
   distance/cost math (dispatch.py's estimate is untouched by any of this).
   This then asks /api/route for the real street path and swaps the line's
   points in place once it answers, so a slow or rate-limited routing
   server (the public OSRM demo -- see routing.py) never blocks or breaks
   the map, it just draws a straight line a beat longer. */
async function upgradeRouteGeometry(line, points) {
  try {
    const q = points.map(([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`).join(";");
    const r = await api(`/api/route?points=${encodeURIComponent(q)}`);
    if (r.source === "osrm" && r.coords && r.coords.length > 2) line.setLatLngs(r.coords);
  } catch (e) { /* keep the straight line already on the map */ }
}

/* One blue leg: the collector coming to this restaurant, and nothing else.
   Keyed off matchedCollector so it cannot drift from the panel beside it. */
function drawMatchRoute(s) {
  const c = matchedCollector(s);
  if (!c) return;
  const pts = [[c.lat, c.lon], [s.lat, s.lon]];
  const line = L.polyline(pts, {
    color: themeColor("--c-agency"), bellyRole: "--c-agency",
    weight: 3, opacity: .9, className: "route-leg1", interactive: false });
  fxLayer.addLayer(line);
  upgradeRouteGeometry(line, pts);
  fxLayer.addLayer(L.circleMarker([s.lat, s.lon], {
    radius: 8, color: themeColor("--c-supplier"), weight: 3,
    fillOpacity: .9, interactive: false }));
  return c;
}

/* The request lives beside the restaurant it belongs to: who it was matched
   to, whether it has been asked for yet, and who has said no. */
function bizMatch(s) {
  const m = s.__match;
  const to = s.matchedTo || (m && m.ok ? m.collector : null);

  if (s.status === "delivered")
    return `<div class="pickdetail"><div class="pd-row"><span class="pd-k">Delivered by</span>
      <span class="pd-v">${s.acceptedBy || to}</span></div></div>`;

  if (s.status === "accepted")
    return `<div class="pickdetail">
      <div class="pd-row"><span class="pd-k">Accepted by</span>
        <span class="pd-v">${s.acceptedBy}</span></div>
      <div class="pd-note">They are coming for it. Nothing more for you to do.</div>
    </div>`;

  if (s.status === "declined")
    return `<div class="pickdetail bad">
      <div class="pd-row"><span class="pd-k">Declined by</span>
        <span class="pd-v">${(s.declinedBy || []).join(", ")}</span></div>
      <div class="pd-note">You asked them only. Nobody else can see it.
        Request again to open it to any collector.</div>
      <button class="offer-act" data-req="${s.id}">Ask anyone who can come</button>
    </div>`;

  if (s.status === "requested")
    return `<div class="pickdetail">
      <div class="pd-row"><span class="pd-k">Requested from</span>
        <span class="pd-v">${to || "—"}</span></div>
      <div class="pd-row"><span class="pd-k">Sent</span>
        <span class="pd-v">${s.requestedAt || ""}</span></div>
      ${s.declinedBy && s.declinedBy.length ? `<div class="pd-row">
        <span class="pd-k">Declined by</span>
        <span class="pd-v">${s.declinedBy.join(", ")}</span></div>` : ""}
      <div class="pd-note">${s.openToAll
        ? "Now open to every other collector."
        : s.allowFallback === false
          ? "Waiting on them. If they decline, the request ends there — that is what you chose."
          : "Waiting for them to accept or decline."}
        ${s.windowClosed ? "<br><b>Your pickup window has closed</b>, so it is off "
          + "their boards. Update the window to put it back." : ""}</div>
      <button class="offer-act ghost" data-cancel="${s.id}">Withdraw request</button>
    </div>`;

  /* reported, not yet requested -- the action */
  if (!m) return `<div class="pickdetail"><div class="pd-note">Finding a collector…</div></div>`;
  if (!m.ok) return `<div class="pickdetail bad">${m.reason}</div>`;
  return `
    <div class="pickdetail">
      <div class="pd-row"><span class="pd-k">Best match</span>
        <span class="pd-v">${m.collector}</span></div>
      <div class="pd-row"><span class="pd-k">Distance</span>
        <span class="pd-v">${m.miles.toFixed(1)} mi to you</span></div>
      <div class="pd-row"><span class="pd-k">Your deduction</span>
        <span class="pd-v">${fmt$(m.fmv)} est.</span></div>
      <div class="pd-note">Nobody has been asked yet. Requesting sends it to
        ${m.collector} and to them alone.</div>
      <label class="pd-check">
        <input type="checkbox" id="fallback-${s.id}" checked>
        <span>If ${m.collector} declines, let any other collector take it.
          Untick and a decline ends the request.</span>
      </label>
      <button class="offer-act" data-req="${s.id}">Request pickup</button>
    </div>`;
}

async function sendRequest(id) {
  /* Default true: the box is ticked, and a re-ask after a decline has no box
     to read, which is the donor saying open it up. */
  const box = $(`fallback-${id}`);
  const fb = box ? box.checked : true;
  try {
    await api(`/api/board/request/${id}?allow_fallback=${fb}`, { method: "POST" });
  }
  catch (e) { alert(e.message); }
  await afterRequestChange(id);
}

async function cancelRequest(id) {
  try { await api(`/api/board/request/${id}/cancel`, { method: "POST" }); }
  catch (e) { alert(e.message); }
  await afterRequestChange(id);
}

/* Shared tail for both. The stale blue leg was the visible half of the bug:
   refreshAll() rebuilds baseLayer but never touches fxLayer, so the line drawn
   before the request survived it -- and if the target had moved on (a decline
   reopening the offer, someone else accepting) it kept pointing at the old
   collector while the panel named the new one. Redraw from the fresh record. */
async function afterRequestChange(id) {
  await refreshAll();
  selectedId = id;
  const s = SUPPLIERS.find(x => x.id === id);
  renderBusiness();
  renderRequestPanel(s);
  fxLayer.clearLayers();
  drawMatchRoute(s);
}

/* RIGHT, business view: where this request stands.
   Not a list of collectors -- a donor does not choose one, and ranking eight
   of them was information they could not act on. This is the pipeline for the
   selected restaurant, so the state is legible: reported, requested, accepted,
   delivered. */
function renderRequestPanel(s) {
  if (!s || !s.report) return;
  const status = s.status || "reported";
  const steps = status === "declined"
    ? ["reported", "requested", "declined"]
    : ["reported", "requested", "accepted", "delivered"];
  const at = steps.indexOf(status);
  const label = {
    reported: ["Surplus reported", "Nobody has been asked yet."],
    requested: ["Pickup requested", `Sent to ${s.matchedTo || "a collector"}${
      s.requestedAt ? " at " + s.requestedAt : ""}.`],
    accepted: ["Accepted", `${s.acceptedBy || "A collector"} is coming for it.`],
    delivered: ["Delivered", "It reached people tonight."],
    declined: ["Declined", `${(s.declinedBy || []).join(", ") || "The collector"} `
      + `said no, and you asked them exclusively.`],
  };

  /* Build first, reveal second. Unhiding before the template is evaluated
     means any error in it leaves the PREVIOUS role's panel on screen -- that
     is how a dead `label[undefined]` showed an agency's offer list to a
     business. */
  const html = `
    <div class="rb-eyebrow">${label[status][0]}</div>
    <div class="rb-source">${s.name} &middot; ${fmtInt(s.report.lbs)} lb
      ${s.surplus}<br>${label[s.status][1]}</div>

    <div class="pipeline">
      ${steps.map((st, i) => `
        <div class="pl-step ${i < at ? "done" : i === at ? "now" : ""}">
          <span class="pl-dot"></span>
          <span class="pl-name">${st}</span>
        </div>`).join('<span class="pl-line"></span>')}
    </div>

    <table class="rb-table">
      <tr><td>Reported</td><td>${s.report.time || "—"}</td></tr>
      <tr><td>Pickup window</td><td>${s.report.pickupFrom || "—"}–${s.report.pickupTo || "—"}
        ${s.windowClosed ? ' <span style="color:var(--bad)">shut</span>' : ""}</td></tr>
      <tr><td>Good until</td><td>${s.report.expiresAt || "—"}</td></tr>
      <tr><td>Matched collector</td><td>${s.matchedTo || "—"}</td></tr>
      ${status === "requested" || status === "declined"
        ? `<tr><td>If declined</td><td>${s.allowFallback === false
            ? "request ends" : "open to others"}</td></tr>` : ""}
      ${s.declinedBy && s.declinedBy.length
        ? `<tr><td>Declined by</td><td>${s.declinedBy.join(", ")}</td></tr>` : ""}
      <tr class="total"><td>Est. deduction</td>
        <td>${fmt$(s.report.lbs * (C.FMV_PER_LB || 1.79))}</td></tr>
    </table>

    <div class="rb-note">Estimated fair market value at
      $${C.FMV_PER_LB}/lb toward an IRC &sect;170(e)(3) enhanced deduction.
      An estimate — confirm with your accountant.</div>
    ${status === "reported"
      ? `<div class="rb-note">You are never charged and never arrange the run.
         Requesting a pickup is the only thing you need to do.</div>` : ""}`;

  $("resultBody").innerHTML = html;
  $("resultEmpty").style.display = "none";
  $("resultBody").hidden = false;
}

/* The scan is not decoration standing in for work. The lines flick out to the
   collectors actually being considered, and the count that ticks up is the pair
   total the server reports. It also covers the round trip, so the panel never
   flashes empty. */
function beginScan(s) {
  clearFx();
  fxLayer.addLayer(L.marker([s.lat, s.lon], {
    icon: L.divIcon({ className: "",
      html: '<div class="radar"><span></span><span></span><span></span></div>',
      iconSize: [12, 12], iconAnchor: [6, 6] }),
    interactive: false, zIndexOffset: 900,
  }));
  $("calcTitle").textContent = "FINDING A COLLECTOR";
  $("calcLine").innerHTML = `${s.name} &middot; ${fmtInt(s.report.lbs)} lb
    ${s.surplus}`;
  $("calcCount").textContent = "0";
  $("calcOverlay").classList.add("show");

  const cols = [
    ...AGENCIES.filter(a => a.mobileCapable !== false),
    ...PANTRIES.filter(p => p.dispatchable),
  ];
  cols.forEach((c, i) => setTimeout(() => {
    if (selectedId !== s.id) return;
    const line = L.polyline([[s.lat, s.lon], [c.lat, c.lon]], {
      color: themeColor("--c-supplier"), weight: 1.3, opacity: 0.9,
      className: "scan-line", interactive: false,
    });
    fxLayer.addLayer(line);
    setTimeout(() => fxLayer.removeLayer(line), 480);
  }, 60 + i * 70));
}

function endScan(s, evaluated, collector) {
  const t0 = performance.now();
  (function tick(now) {
    if (selectedId !== s.id) return;
    const p = Math.min((now - t0) / 700, 1);
    $("calcCount").textContent = fmtInt(evaluated * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);

  $("calcTitle").textContent = collector ? "COLLECTOR MATCHED" : "NO COLLECTOR";
  $("calcLine").innerHTML = collector
    ? `${collector} &rarr; ${s.name}`
    : `nothing can take this tonight`;
  setTimeout(() => {
    if (selectedId === s.id) $("calcOverlay").classList.remove("show");
  }, 2400);
}

/* A decline has two possible meanings and the collector should see which one
   landed, rather than inferring it from a row disappearing. */
let _toastT = null;
function toast(msg) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast"; el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove("on"), 4200);
}

async function pickRestaurant(id) {
  selectedId = id;
  const s = SUPPLIERS.find(x => x.id === id);
  beginScan(s);
  const SCAN_MS = 900;
  const started = performance.now();
  try {
    const r = await dispatchFor(s);
    /* The pair for the collector this report is ADDRESSED to, not the pair
       that scores highest. Requesting a pickup sends it to the server's
       target, so quoting anyone else here would name a collector the button
       is not going to ask. */
    const want = matchedCollector(s);
    const b = (want && r.pairs.find(p => p.collector.id === want.id)) || r.pairs[0];
    /* Target present but with no viable pair left -- the board caches its
       assignment and the clock has moved on since. Measured on tonight's data
       that is 1 report in 26. Keep the collector honest and measure the leg
       ourselves rather than quoting a different collector's numbers under its
       name. */
    const own = !want || !b || want.id === b.collector.id;
    s.__match = b ? {
      ok: true,
      collector: (want || b.collector).name,
      lat: (want || b.collector).lat, lon: (want || b.collector).lon,
      miles: own ? b.leg1 : roadMi(want, s),
      pickupAt: own ? b.pickupAt : null,
      deferred: own ? b.deferred : null,
      fmv: r.fmv,
    } : { ok: false, reason: r.headline || "No agency can collect this yet." };
    s.__evaluated = r.evaluated || 0;
  } catch (e) { s.__match = { ok: false, reason: e.message }; }

  /* the server answers in ~20 ms; let the scan play rather than flashing */
  const left = SCAN_MS - (performance.now() - started);
  if (left > 0) await new Promise(r => setTimeout(r, left));
  if (selectedId !== id) return;          // a different pick overtook this one

  endScan(s, s.__evaluated || 0, s.__match.ok ? s.__match.collector : null);
  renderBusiness();
  renderRequestPanel(s);

  const c = s.__match.ok ? drawMatchRoute(s) : null;
  if (c) map.flyToBounds(L.latLngBounds([[c.lat, c.lon], [s.lat, s.lon]]).pad(0.3),
                         { duration: 0.7 });
  /* NOT showEmpty() here -- renderRequestPanel has just filled this panel,
     and calling it re-hid the content and restored the "pick a restaurant"
     prompt over the top of it. */
}

/* --------------------------------------------------------------- agency */
function collectingList() {
  return [
    ...AGENCIES.filter(a => a.mobileCapable !== false)
      .map(a => ({ id: a.id, name: a.name, kind: "agency",
                   sub: a.program || "", lat: a.lat, lon: a.lon })),
    ...PANTRIES.filter(p => p.dispatchable)
      .map(p => ({ id: p.id, name: p.name, kind: "pantry",
                   sub: p.operator || "", lat: p.lat, lon: p.lon })),
  ];
}

/* Select a collector and show what is offered to it.
   NOT auto-basketed: on this branch an offer is visible to every agency that
   could take it, and whoever accepts first gets it (see claims.py). Filling
   the basket on selection would therefore propose a run over all fourteen
   reports and immediately leave most of them behind on capacity. The driver
   adds what they want. */
async function selectAgency(id) {
  myAgency = id; basket = []; planned = null;
  await loadOffers();
}

/* LEFT: who you are. Same shape as the restaurant list in the business view,
   so the left panel always answers "which one of these am I looking at". */
function renderAgencyList() {
  const list = collectingList();
  if (!myAgency) myAgency = list[0] && list[0].id;
  $("feed").innerHTML =
    `<div class="sec-head">Collectors (${list.length})</div>`
    + list.map(a => {
      const pending = pendingRequestCount(a.id);
      return `
      <div class="offer pick ${a.id === myAgency ? "on" : ""}" data-agency="${a.id}">
        <div class="offer-top">
          
          <span class="offer-name">${a.name}</span>
          ${pending ? `<span class="req-pending-badge">${pending} waiting</span>` : ""}
        </div>
        <div class="offer-sub">${a.sub}${a.id === myAgency && offers.agency
          ? ` · ${offers.agency.capacityLbs} lb capacity` : ""}</div>
      </div>`; }).join("");
  $("feed").querySelectorAll("[data-agency]").forEach(el =>
    el.addEventListener("click", () => selectAgency(el.dataset.agency)));
  $("feedFoot").innerHTML =
    `<span class="dot dot-quiet"></span> Pick a collector to see what is offered to it.`;
}

/* RIGHT: the run you are building for the selected collector. */
async function loadOffers() {
  const list = collectingList();
  myAgency = myAgency || (list[0] || {}).id;
  try { offers = await api(`/api/board/agency/${myAgency}/offers`); }
  catch (e) { $("resultBody").innerHTML = `<div class="empty">${e.message}</div>`; return; }

  if (!offers || !offers.agency) {
    $("resultBody").innerHTML = `<div class="empty">Could not load offers for
      this collector.</div>`;
    return;
  }
  basket = basket.filter(id => offers.offers.some(o => o.supplier.id === id));
  renderAgencyList();

  const row = o => {
    const inRun = basket.includes(o.supplier.id);
    return `
    <div class="offer ${inRun ? "taken" : (o.viable ? "" : "dead")}">
      <div class="offer-top">
        <span class="type-badge">${typeIcon[o.supplier.type] || "RS"}</span>
        <span class="offer-name">${o.supplier.name}</span>
        <span class="offer-net">${o.net != null ? fmt$(o.net) : "—"}</span>
      </div>
      <div class="offer-sub">
        ${o.exclusiveToMe
          ? `<span class="tag-excl">${o.allowFallback === false
              ? "asked you only" : "asked you first"}</span> `
          : `<span class="tag-open">passed on by others</span> `}
        ${fmtInt(o.report.lbs)} lb ${o.supplier.surplus} ·
        pickup ${o.report.pickupFrom || o.report.time}–${o.report.pickupTo || "?"}
        ${o.report.expiresAt ? `· good until ${o.report.expiresAt}` : ""}
        ${o.viable
          ? `<br>${o.deferred ? `hold &amp; deliver ${o.deliversAt}` : `→ ${o.target || "drop-off"}`}
             · ${o.miles.toFixed(1)} mi alone`
          : `<br><span style="color:var(--bad)">${o.whyNot}</span>`}
      </div>
      <div class="offer-acts">
        ${o.viable ? `<button class="offer-act ${inRun ? "ghost" : ""}"
            data-toggle="${o.supplier.id}">${inRun ? "Remove" : "Add to run"}</button>
          <button class="offer-act solo" data-solo="${o.supplier.id}">Accept</button>` : ""}
        <button class="offer-act ghost" data-decline="${o.supplier.id}"
          title="${o.allowFallback === false
            ? "The donor asked you only — declining ends their request"
            : "Declining releases it to the other collectors"}"
          >Decline</button>
      </div>
    </div>`;
  };

  $("resultEmpty").style.display = "none";
  $("resultBody").hidden = false;
  $("resultBody").innerHTML = `
    <div class="rb-eyebrow">${offers.agency.name}</div>
    <div class="rb-source">${offers.agency.capacityLbs} lb capacity ·
      <b>${basket.length}</b> in this run ·
      ${offers.offers.filter(o => o.viable).length} offers open</div>
    ${basket.length ? (planned ? renderPlan(planned) : `<div class="empty">Solving…</div>`) : ""}
    ${basket.length ? `<button class="plan-btn" id="acceptBtn">
        Accept this run &amp; log receipts</button>` : ""}
    <div class="rb-h">Offered to you (${offers.offers.length})</div>
    ${offers.offers.map(row).join("") || `<div class="empty">Nothing waiting.</div>`}`;

  $("resultBody").querySelectorAll("[data-toggle]").forEach(b =>
    b.addEventListener("click", () => {
      const id = b.dataset.toggle;
      basket = basket.includes(id) ? basket.filter(x => x !== id) : [...basket, id];
      previewRun();
    }));
  $("resultBody").querySelectorAll("[data-solo]").forEach(b =>
    b.addEventListener("click", () => acceptRun([b.dataset.solo])));
  $("resultBody").querySelectorAll("[data-decline]").forEach(b =>
    b.addEventListener("click", async () => {
      try {
        const r = await api(
          `/api/board/agency/${myAgency}/decline/${b.dataset.decline}`,
          { method: "POST" });
        toast(r.requestEnded
          ? `${r.supplier}: declined. The donor asked you only, so the request ends.`
          : `${r.supplier}: declined and released to the other collectors.`);
      } catch (e) { alert(e.message); }
      basket = basket.filter(x => x !== b.dataset.decline);
      planned = null;
      await refreshAll();
      loadOffers();
    }));
  const ab = $("acceptBtn");
  if (ab) ab.addEventListener("click", () => acceptRun(basket));

  renderStats();
  buildLayers();
  drawAgencyMarkers();
  if (planned && planned.feasible) drawPlan(planned);
}

async function previewRun() {
  if (!basket.length) { planned = null; clearFx(); return loadOffers(); }
  try {
    planned = await api(
      `/api/board/agency/${myAgency}/preview?supplier_ids=${basket.join(",")}`,
      { method: "POST" });
  } catch (e) { planned = { feasible: false, reason: e.message }; }
  loadOffers();
}

/* Only accepting books anything. Everything before this is a sketch. */
async function acceptRun(ids) {
  if (!ids || !ids.length) return;
  const acceptedPlan = planned;   // about to be reset -- keep it to draw bold below
  try {
    const res = await api(
      `/api/board/agency/${myAgency}/accept-run?supplier_ids=${ids.join(",")}`,
      { method: "POST" });
    tonight = res.tonight;
    basket = basket.filter(x => !ids.includes(x));
    planned = null;
    await refreshAll();
    $("ledgerCount").textContent = tonight.length;
    if (res.leftOnOffer.length)
      alert("Too much for one load — still on offer: " + res.leftOnOffer.join(", "));
    loadOffers();
    /* Now real: redraw the same route bold and animated instead of faded --
       "this is taken" should look different from "this is proposed". */
    if (acceptedPlan && acceptedPlan.feasible) drawPlan(acceptedPlan, { faded: false });
    openLedger();
  } catch (e) { alert(e.message); }
}

/* -------------------------------------------------------- combined run */
/* combine_run()'s output (bellyup/dispatch.py), rendered the same way
   renderResult() renders a single dispatch: an eyebrow, an outcomes strip,
   rb-note callouts for anything that needs explaining, then the cost table. */
function renderPlan(planned) {
  if (!planned.feasible) {
    return `<div class="rb-note" style="border-color:var(--bad);">
      &times; <b>Not feasible</b> &mdash; ${planned.reason}</div>`;
  }
  const isPantry = planned.collector.kind === "pantry";
  const pickupRows = planned.pickups.map((p, i) => `
    <div class="alt-row">
      <span class="alt-rank">${i + 1}.</span>
      <span class="alt-pair"><b>${p.name}</b> &mdash; ${fmtInt(p.lbs)} lb${
        p.lbs < p.offeredLbs ? ` of ${fmtInt(p.offeredLbs)}` : ""} &middot; ${p.window}</span>
    </div>`).join("");
  const stopRows = planned.stops.map((s, i) => `
    <div class="alt-row">
      <span class="alt-rank">${planned.pickups.length + i + 1}.</span>
      <span class="alt-pair"><b>${s.location}</b> &middot; ${s.area} &mdash;
        ${fmtInt(s.meals)} meals &middot; ${s.detourMi.toFixed(1)} mi detour</span>
    </div>`).join("");

  return `
    <div class="rb-h">Pickups, in order (${planned.pickups.length})</div>
    ${pickupRows}
    <div class="rb-h">Drop-offs, in order (${planned.stops.length})</div>
    ${stopRows}

    <div class="outcomes">
      <div class="oc oc-people"><div class="v">${fmtInt(planned.servedMeals)}</div><div class="k">people fed</div></div>
      <div class="oc"><div class="v">${planned.miles.toFixed(1)}</div><div class="k">route miles</div></div>
      <div class="oc oc-net ${planned.net < 0 ? "neg" : ""}"><div class="v">${fmt$(planned.net)}</div><div class="k">net benefit</div></div>
    </div>

    ${planned.saved > 0 ? `<div class="rb-note"><b>${fmt$(planned.saved)} saved</b> by combining
      ${planned.pickups.length} pickups into one run instead of ${planned.pickups.length}
      separate trips (would have cost ${fmt$(planned.soloCost)}).</div>` : ""}
    ${planned.partial ? `<div class="rb-note"><b>Partial take &mdash; ${planned.partial.name}</b>:
      collected ${fmtInt(planned.partial.took)} of ${fmtInt(planned.partial.of)} lb offered;
      ${fmtInt(planned.partial.leaves)} lb stays with the donor.</div>` : ""}
    ${planned.leftBehind.length ? `<div class="rb-note"><b>Left behind (no room this run):</b>
      ${planned.leftBehind.map(x => `${x.name} (${fmtInt(x.lbs)} lb)`).join(", ")}.</div>` : ""}
    ${planned.missedWindows.length ? `<div class="rb-note" style="border-color:var(--bad);">
      <b>Missed pickup windows:</b> ${planned.missedWindows.join(", ")} &mdash; shown is the
      fewest-misses, then-shortest order available for this basket.</div>` : ""}
    ${planned.leftoverMeals >= 1 ? `<div class="rb-note">Block need absorbs
      ${fmtInt(planned.servedMeals)} meals; <b>${fmtInt(planned.leftoverMeals)} meals</b> ride
      along to ${agShort(planned.collector)}&rsquo;s network.</div>` : ""}

    <table class="rb-table">
      <tr><td>Working miles / deadhead</td><td>${planned.workingMi.toFixed(1)} / ${planned.deadheadMi.toFixed(1)} mi</td></tr>
      <tr><td>Drive + handling time</td><td>${fmtInt(planned.minutes)} min</td></tr>
      <tr><td>Fuel</td><td>${fmt$(planned.fuel)}</td></tr>
      <tr><td>Vehicle wear</td><td>${fmt$(planned.vehicle)}</td></tr>
      <tr><td>Crew (${planned.crew})</td><td>${fmt$(planned.labor)}</td></tr>
      <tr class="total"><td>Deployment cost</td><td>${fmt$(planned.cost)}</td></tr>
    </table>`;
}

/* Pickup phase (collector -> pickups, in solved order) in the agency/pantry
   role color; delivery phase (last pickup -> stops, in order -> back to
   collector) in route-green -- reuses the exact route-leg1/route-leg2
   flowing-dash classes runTriangulation() already uses for a single leg
   each, just looped over several legs so a multi-stop run is still
   unambiguous about which direction is "out" vs. "back" without needing
   real street routing. */
function drawPlan(planned, opts = {}) {
  /* Faded + static by default: this is a PROPOSED run, not yet taken -- the
     driver hasn't committed to it. Once accept-run actually confirms it,
     the caller passes {faded:false} and the same route redraws bold and
     animated (route-leg1/route-leg2's existing flowing-dash), so "this is
     real now" is a visible state change, not just a modal popping up. */
  const faded = opts.faded !== false;
  clearFx();
  const col = planned.collector;

  const pickupChain = [col, ...planned.pickups];
  for (let i = 0; i < pickupChain.length - 1; i++) {
    const a = pickupChain[i], b = pickupChain[i + 1];
    const pts = [[a.lat, a.lon], [b.lat, b.lon]];
    const line = L.polyline(pts, {
      color: themeColor(isPantryKind(col) ? "--c-pantry" : "--c-agency"),
      weight: faded ? 2 : 2.5, opacity: faded ? 0.4 : 0.9,
      className: faded ? "route-leg1-faded" : "route-leg1", interactive: false,
    });
    fxLayer.addLayer(line);
    upgradeRouteGeometry(line, pts);
  }

  const deliveryChain = [pickupChain[pickupChain.length - 1], ...planned.stops, col];
  for (let i = 0; i < deliveryChain.length - 1; i++) {
    const a = deliveryChain[i], b = deliveryChain[i + 1];
    const pts = [[a.lat, a.lon], [b.lat, b.lon]];
    const line = L.polyline(pts, {
      color: themeColor("--c-route"),
      weight: faded ? 2.5 : 3, opacity: faded ? 0.45 : 0.95,
      className: faded ? "route-leg2-faded" : "route-leg2", interactive: false,
    });
    fxLayer.addLayer(line);
    upgradeRouteGeometry(line, pts);
  }

  planned.pickups.forEach((p, i) => {
    fxLayer.addLayer(L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
        html: `<div class="mk-stopnum pickup">${i + 1}</div>` }),
      interactive: false, zIndexOffset: 850,
    }));
  });
  planned.stops.forEach((s, i) => {
    fxLayer.addLayer(L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
        html: `<div class="mk-stopnum dropoff">${planned.pickups.length + i + 1}</div>` }),
      interactive: false, zIndexOffset: 850,
    }));
    if (hotspotMarkers[s.id]) {
      const el = hotspotMarkers[s.id].getElement();
      if (el) el.classList.add("hs-winner");
    }
  });
  const colEl = $("col-" + col.id);
  if (colEl) colEl.classList.add("winner");

  const bounds = [col, ...planned.pickups, ...planned.stops].map(p => [p.lat, p.lon]);
  map.flyToBounds(L.latLngBounds(bounds).pad(0.15), { duration: 0.6 });
}
function isPantryKind(col) { return col.kind === "pantry"; }

function drawAgencyMarkers() {
  const a = (offers.agency || {});
  if (a.lat) fxLayer.addLayer(L.circleMarker([a.lat, a.lon],
    { radius: 9, color: themeColor("--c-agency"), weight: 3,
      fillOpacity: .2, interactive: false }));
}

/* --------------------------------------------------------------- public */
let myPlace = null;
let selectedPantryId = null;

async function renderPantries() {
  if (!myPlace) {
    selectedPantryId = null;
    $("feed").innerHTML = `<div class="empty">Enter your address above.</div>`;
    $("feedFoot").innerHTML = "";
    showEmpty(EMPTY_BY_ROLE.public);
    clearFx();
    return;
  }
  const km = +($("pubRange")?.value || 5);
  const r = await api(`/api/board/pantries?lat=${myPlace.lat}&lon=${myPlace.lon}&max_km=${km}`);
  const list = r.pantries;
  const nearest = list.find(p => p.openTonight) || list[0];
  /* fall back to nearest if nothing picked yet, or the pick fell outside
     the current range (new address, or the range slider narrowed) */
  const picked = list.find(p => p.id === selectedPantryId) || nearest;
  selectedPantryId = picked ? picked.id : null;

  /* LEFT: every pantry in range, clickable -- picking one redraws the route */
  $("feed").innerHTML = list.length ? `
    <div class="sec-head">${list.length} pantr${list.length === 1 ? "y" : "ies"} within ${km} km</div>
    ${list.map(p => `
      <div class="offer pick ${p.id === selectedPantryId ? "on" : ""}" data-pick="${p.id}">
        <div class="offer-top">
          ${p === nearest ? '<span class="type-badge">NEAREST</span>' : ""}
          <span class="offer-name">${p.name}</span>
          <span class="offer-net">${p.distanceKm} km</span>
        </div>
        <div class="offer-sub">${p.walkMinutes} min walk ·
          ${p.openTonight ? "open tonight" : "not open tonight"}
          ${p === nearest ? " · closest open" : ""}</div>
      </div>`).join("")}` : `<div class="empty">Nothing within ${km} km.</div>`;
  $("feedFoot").innerHTML =
    `<span class="dot dot-quiet"></span> Pantry locations only.`;

  $("feed").querySelectorAll("[data-pick]").forEach(el =>
    el.addEventListener("click", () => {
      selectedPantryId = el.dataset.pick;
      renderPantries();
    }));

  /* RIGHT: detail on whichever pantry is selected */
  $("resultEmpty").style.display = "none";
  $("resultBody").hidden = false;
  $("resultBody").innerHTML = picked ? `
    <div class="rb-eyebrow">${picked === nearest ? "Closest to you" : "Your pick"}</div>
    <div class="rb-source">${r.count} within ${km} km · ${r.openNow} open tonight</div>
    <div class="pantry closest">
      ${picked === nearest ? `<div class="pantry-badge">GO HERE</div>` : ""}
      <div class="pantry-name">${picked.name}</div>
      <div class="pantry-sub">${picked.distanceKm} km · about
        ${picked.walkMinutes} min walk ·
        ${picked.openTonight ? "open tonight" : "not open tonight"}</div>
      <div class="pantry-far">${picked.kind}${picked.schedule ? " · runs " + picked.schedule : ""}${
        picked.whyNot ? " · " + picked.whyNot : ""}</div>
    </div>` : `<div class="empty">Try a wider range.</div>`;

  clearFx();
  list.forEach(p => fxLayer.addLayer(L.circleMarker([p.lat, p.lon], {
    radius: p.id === selectedPantryId ? 11 : 7,
    color: themeColor(p.id === selectedPantryId ? "--c-route" : "--c-pantry"),
    weight: p.id === selectedPantryId ? 3 : 1.5,
    fillOpacity: p.id === selectedPantryId ? .35 : .18,
  }).bindTooltip(`<b>${p.name}</b><div class="tip-k">${p.distanceKm} km · ${p.walkMinutes} min walk</div>`,
                 { className: "hs-tip", direction: "top", opacity: 1 })));

  fxLayer.addLayer(L.circleMarker([myPlace.lat, myPlace.lon], {
    radius: 6, color: themeColor("--c-supplier"), weight: 3,
    fillOpacity: .9, interactive: false }));

  /* the way to whichever pantry is selected, so it is obvious where to walk */
  if (picked) {
    fxLayer.addLayer(L.polyline([[myPlace.lat, myPlace.lon], [picked.lat, picked.lon]], {
      color: themeColor("--c-route"), bellyRole: "--c-route",
      weight: 3.5, opacity: .95, className: "route-leg2", interactive: false }));
    map.flyToBounds(L.latLngBounds(
      [[myPlace.lat, myPlace.lon], [picked.lat, picked.lon]]).pad(0.45),
      { duration: 0.7 });
  }
  renderStats();
}

function wireRoles() {
  document.querySelectorAll("#roleSwitch button").forEach(b =>
    b.addEventListener("click", () => setRole(b.dataset.role)));

  $("pubRange").addEventListener("change", () => renderPantries());
  $("pubAddr").addEventListener("change", async e => {
    const q = e.target.value.trim();
    const hint = $("pubGeo");
    if (!q) return;
    hint.className = "reg-hint"; hint.textContent = "Looking up…";
    try {
      const d = await api("/api/geocode?address=" + encodeURIComponent(q));
      myPlace = { lat: d.lat, lon: d.lon };
      selectedPantryId = null;
      hint.className = "reg-hint ok";
      hint.textContent = d.matched;
      renderPantries();
    } catch (err) {
      hint.className = "reg-hint bad"; hint.textContent = err.message;
    }
  });
  wireAddressAutocomplete("pubAddr", "pubAddrSuggest", hit => {
    myPlace = { lat: hit.lat, lon: hit.lon };
    selectedPantryId = null;
    $("pubGeo").className = "reg-hint ok";
    $("pubGeo").textContent = hit.label;
    renderPantries();
  });
}

/* ------------------------------------------------------------------- boot */
(async function boot() {
  setThemeButton();
  wireForm();          /* static elements — wire before the first fetch, or
                          the visible button swallows an early click */
  wireRoles();
  try {
    await loadBoard();
  } catch (err) {
    $("resultEmpty").innerHTML =
      `<div class="re-icon">&#9888;</div><p>Could not reach the API.<br>` +
      `Start it with <code>uvicorn app:app --port 8000</code> and reload.</p>`;
    return;
  }
  buildLayers();
  setRole("agency");
  $("ledgerCount").textContent = tonight.length;
})();
