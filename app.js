"use strict";

const app = {
  data: null,
  route: "overview",
  chart: { pollutant: "pm25", year: "all", station: "all" },
  observations: { q: "", year: "", station: "", from: "", to: "", pollutant: "pm25", min: "", max: "", page: 1, pageSize: 20, sort: "timestamp", direction: "desc", request: 0 },
  rows: null,
  status: { status: "checking", rows: 0, progress: 0, message: "Checking the local observation index…" },
  statusPopover: false,
  sidebarCollapsed: false,
  sidebarOpen: false,
  toastTimer: null,
  statusTimer: null,
  map: { field: "pm25", month: "2025-12", station: "", surface: true, showStations: true, opacity: 0.82, radius: 18, zoom: 11.5, centerLat: 19.12, centerLon: 72.88, playTimer: null, leaflet: null, leafletPromise: null, leafletLoading: false, stationLayer: null, surfaceLayer: null, imageryLayer: null, imageryLoaded: false, imageryError: false, viewTimer: null },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const host = $("#page-host");
const pollutantLabels = {
  pm25: "PM₂.₅", pm10: "PM₁₀", no2: "NO₂", so2: "SO₂", co: "CO", o3: "O₃",
  PM25_GEOSCF: "PM₂.₅ · GEOS-CF", PM25_DUST_GEOSCF: "PM₂.₅ dust", PM25_OC_GEOSCF: "PM₂.₅ organic carbon",
  PM25_SEASALT_GEOSCF: "PM₂.₅ sea salt", PM25_SULFATE_GEOSCF: "PM₂.₅ sulfate", PM25_BC_GEOSCF: "PM₂.₅ black carbon",
  PM25_NITRATE_GEOSCF: "PM₂.₅ nitrate", PM25_SOA_GEOSCF: "PM₂.₅ secondary organic aerosol",
  NO2_GEOSCF: "NO₂ · GEOS-CF", SO2_GEOSCF: "SO₂ · GEOS-CF", CO_GEOSCF: "CO · GEOS-CF", O3_GEOSCF: "O₃ · GEOS-CF",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function number(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fullNumber(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function unitFor(key) {
  return app.data?.pollutants.find(item => item.key === key)?.unit || "";
}

function monthLabel(isoMonth, year = true) {
  const [y, m] = String(isoMonth).split("-").map(Number);
  if (!y || !m) return isoMonth;
  const date = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat("en", { month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(date);
}

function displayTimestamp(value) {
  if (!value) return "—";
  return value.replace("T", " ");
}

function getStation(id) {
  return app.data.stations.find(station => station.id === id);
}

function selectedStation() {
  return app.chart.station === "all" ? null : getStation(app.chart.station);
}

function activeMonthly() {
  const station = selectedStation();
  const source = station ? station.monthly : app.data.monthly;
  return source.filter(item => app.chart.year === "all" || item.month.startsWith(`${app.chart.year}-`));
}

function averageStation(station, key) {
  if (app.chart.year === "all") return station.means[key];
  const months = station.monthly.filter(item => item.month.startsWith(`${app.chart.year}-`));
  const count = months.reduce((total, item) => total + (item.n || 0), 0);
  if (!count) return null;
  return months.reduce((total, item) => total + Number(item[key] || 0) * (item.n || 0), 0) / count;
}

function activeHourly() {
  const station = selectedStation();
  if (app.chart.year === "all") return station ? station.hourly : app.data.hourly;
  const year = app.chart.year;
  return station ? (station.yearly_hourly[year] || []) : (app.data.yearly_hourly[year] || []);
}

function selectedMonths() {
  return activeMonthly().filter(item => Number.isFinite(Number(item[app.chart.pollutant])));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function renderStatus() {
  const button = $("#system-status");
  const label = $("#status-label");
  if (!button || !label) return;
  const names = { ready: "Index ready", indexing: "Indexing data", unavailable: "Snapshot mode", error: "Index issue", "not-started": "Checking source", checking: "Checking source" };
  label.textContent = names[app.status.status] || "Source status";
  button.dataset.state = app.status.status;
  if (app.statusPopover) renderStatusPopover();
}

function renderStatusPopover() {
  const previous = $(".status-popover");
  previous?.remove();
  if (!app.statusPopover) return;
  const status = app.status;
  const detail = status.status === "ready"
    ? `${fullNumber(status.rows)} indexed source rows support search, filters, and pagination.`
    : status.status === "indexing"
      ? `${escapeHtml(status.message)} ${Math.round(status.progress * 100)}% complete.`
      : status.status === "error"
        ? `${escapeHtml(status.message)} ${escapeHtml(status.error || "")}`
        : `The verified charts are available from the compact snapshot. To enable full-row search, start the server with the supplied CSV path.`;
  const popover = document.createElement("div");
  popover.className = "status-popover";
  popover.innerHTML = `<strong>${escapeHtml(status.message || "Source status")}</strong><div>${detail}</div>${status.status !== "ready" && status.status !== "indexing" ? '<code>python server.py --dataset "path\\to\\the\\supplied.csv"</code><br><button type="button" id="status-close">Got it</button>' : ''}`;
  document.body.append(popover);
  $("#status-close", popover)?.addEventListener("click", () => { app.statusPopover = false; popover.remove(); });
}

function routeFromHash() {
  const route = location.hash.replace(/^#/, "") || "overview";
  return ["overview", "satellite", "stations", "observations", "methodology"].includes(route) ? route : "overview";
}

function pageTitle(route) {
  return ({ overview: "Overview", satellite: "Satellite atlas", stations: "Station field", observations: "Observations", methodology: "Method & limits" })[route];
}

function goTo(route) {
  if (route === app.route) {
    app.sidebarOpen = false;
    $("#sidebar").classList.remove("mobile-open");
    return;
  }
  location.hash = route;
}

function render() {
  app.route = routeFromHash();
  if (app.route !== "satellite" && app.map.playTimer) {
    clearInterval(app.map.playTimer);
    app.map.playTimer = null;
  }
  if (app.route !== "satellite") {
    clearTimeout(app.map.viewTimer);
    app.map.viewTimer = null;
    if (app.map.leaflet) {
      const center = app.map.leaflet.getCenter();
      app.map.centerLat = center.lat;
      app.map.centerLon = center.lng;
      app.map.zoom = app.map.leaflet.getZoom();
    }
    app.map.leaflet?.remove();
    app.map.leaflet = null;
    app.map.stationLayer = null;
    app.map.surfaceLayer = null;
    app.map.imageryLayer = null;
    app.map.imageryLoaded = false;
  }
  $("#breadcrumb-current").textContent = pageTitle(app.route);
  $$(".nav-link").forEach(link => {
    const active = link.dataset.route === app.route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  app.statusPopover = false;
  $(".status-popover")?.remove();
  if (app.route === "overview") renderOverview();
  if (app.route === "satellite") renderSatellite();
  if (app.route === "stations") renderStations();
  if (app.route === "observations") renderObservations();
  if (app.route === "methodology") renderMethodology();
  $("#sidebar").classList.remove("mobile-open");
  app.sidebarOpen = false;
}

function pollutantOptions(value, groupFilter = "all") {
  const items = app.data.pollutants.filter(item => groupFilter === "all" || item.group === groupFilter);
  if (groupFilter !== "all") return items.map(item => `<option value="${escapeHtml(item.key)}" ${value === item.key ? "selected" : ""}>${escapeHtml(item.label)} · ${escapeHtml(item.unit)}</option>`).join("");
  const groups = new Map();
  for (const item of items) {
    const group = item.group || "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups].map(([group, entries]) => `<optgroup label="${escapeHtml(group === "CPCB" ? "CPCB · observed" : group === "GEOS-CF" ? "GEOS-CF · modeled" : group)}">${entries.map(item => `<option value="${escapeHtml(item.key)}" ${value === item.key ? "selected" : ""}>${escapeHtml(item.label)} · ${escapeHtml(item.unit)}</option>`).join("")}</optgroup>`).join("");
}

function yearOptions(value, allLabel = "All years") {
  return `<option value="all" ${value === "all" ? "selected" : ""}>${allLabel}</option>${Object.keys(app.data.meta.year_rows).sort().map(year => `<option value="${year}" ${value === year ? "selected" : ""}>${year}</option>`).join("")}`;
}

function stationOptions(value, includeAll = true) {
  return `${includeAll ? `<option value="all" ${value === "all" ? "selected" : ""}>All stations</option>` : ""}${app.data.stations.map(station => `<option value="${escapeHtml(station.id)}" ${value === station.id ? "selected" : ""}>${escapeHtml(station.name)}</option>`).join("")}`;
}

function hero(eyebrow, title, italic, paragraph, aside = "") {
  return `<section class="hero-row"><div class="hero-copy"><div class="eyebrow"><span class="eyebrow-mark"></span>${escapeHtml(eyebrow)}</div><h1>${title} <em>${italic}</em></h1><p>${paragraph}</p><a class="hero-cta" href="#satellite" data-route-link="satellite"><span>Open satellite atlas</span><b aria-hidden="true">↗</b></a></div>${aside ? `<div class="hero-aside"><span class="mini-globe"><span></span></span><div>${aside}</div></div>` : ""}</section>`;
}

function chartControls() {
  return `<section class="control-band"><div class="control-band-copy"><strong>Read the record your way</strong><span>Every curve is recalculated from the included hourly rows.</span></div><div class="control-group"><label class="control"><span>Pollutant</span><select id="chart-pollutant">${pollutantOptions(app.chart.pollutant)}</select></label><label class="control"><span>Period</span><select id="chart-year">${yearOptions(app.chart.year)}</select></label><label class="control"><span>Station</span><select id="chart-station">${stationOptions(app.chart.station)}</select></label></div></section>`;
}

function bindChartControls() {
  $("#chart-pollutant")?.addEventListener("change", event => { app.chart.pollutant = event.target.value; render(); });
  $("#chart-year")?.addEventListener("change", event => { app.chart.year = event.target.value; render(); });
  $("#chart-station")?.addEventListener("change", event => { app.chart.station = event.target.value; render(); });
}

function metricStrip() {
  const meta = app.data.meta;
  const metrics = [
    { label: "Hourly observations", value: meta.rows, note: "Merged source rows" },
    { label: "Monitoring sites", value: meta.station_count, note: "Each has 26,304 hourly records" },
    { label: "Coverage window", value: "3", suffix: "years", note: "Jan 2023 — Dec 2025" },
    { label: "Blank source cells", value: meta.blank_cells, note: "Across all 59 CSV columns" },
  ];
  return `<section class="metric-strip" aria-label="Verified dataset summary">${metrics.map(item => `<div class="metric"><span class="metric-label">${item.label}</span><div class="metric-value"><span class="metric-count" data-count="${typeof item.value === "number" ? item.value : ""}">${typeof item.value === "number" ? "0" : escapeHtml(item.value)}</span>${item.suffix ? `<small>${item.suffix}</small>` : ""}</div><div class="metric-note">${item.note}</div></div>`).join("")}</section>`;
}

function countUp() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$(".metric-count[data-count]").forEach(el => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    if (reduced || target === 0) { el.textContent = fullNumber(target); return; }
    const duration = 650;
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fullNumber(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function monthlyInsight(data) {
  const items = selectedMonths();
  const sorted = items.filter(item => Number.isFinite(Number(item[app.chart.pollutant]))).sort((a, b) => Number(a[app.chart.pollutant]) - Number(b[app.chart.pollutant]));
  const high = sorted.at(-1);
  const low = sorted[0];
  const station = selectedStation();
  if (!high || !low) return { value: "—", title: "No readings in this selection", copy: "Choose a different period or monitoring site to view its observed monthly averages.", high: "—", low: "—" };
  const unit = unitFor(app.chart.pollutant);
  return {
    value: `${number(high[app.chart.pollutant], 1)} <small>${unit}</small>`,
    title: `${monthLabel(high.month)} · highest month in view`,
    copy: `Across ${station ? station.name : "the selected citywide record"}, the highest monthly arithmetic mean in this selection is ${number(high[app.chart.pollutant], 1)} ${unit}. The lowest is ${number(low[app.chart.pollutant], 1)} ${unit} in ${monthLabel(low.month)}. These are observations, not a causal explanation or forecast.`,
    high: monthLabel(high.month), low: monthLabel(low.month),
  };
}

function renderOverview() {
  const meta = app.data.meta;
  const station = selectedStation();
  const scope = station ? escapeHtml(station.name) : "Mumbai · 25 monitoring sites";
  host.innerHTML = `<div class="page-enter">
    ${hero("FIELD RECORD  /  MUMBAI COAST", "Air, place", "& time.", `Explore hourly ground observations alongside matched ERA5 weather, GEOS-CF chemistry fields, and coastal features. This workspace summarizes the <strong>${fullNumber(meta.rows)} rows</strong> in the supplied model-ready dataset; it does not generate forecasts.`, `<strong>01 Jan 2023 — 31 Dec 2025</strong>25 CPCB monitoring sites`)}
    ${metricStrip()}
    ${chartControls()}
    <div class="content-grid">
      <section class="panel" aria-labelledby="trend-title"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">OBSERVED · MONTHLY MEAN</div><h2 class="panel-title" id="trend-title">${escapeHtml(pollutantLabels[app.chart.pollutant])} through the seasons</h2><p class="panel-subtitle">${scope} · arithmetic mean of available hourly rows</p></div><button type="button" class="panel-action" data-route-link="observations">Inspect rows →</button></div><div class="panel-body"><div class="chart-legend"><span class="legend-item"><i class="legend-line" style="--legend-color:${app.data.pollutants.find(p=>p.key===app.chart.pollutant).color}"></i>${escapeHtml(pollutantLabels[app.chart.pollutant])} · ${unitFor(app.chart.pollutant)}</span></div><div class="chart-wrap" id="monthly-chart"></div><p class="chart-note">Averages are calculated from the input CSV. No model output, AQI conversion, or interpolation is applied.</p></div></section>
      <section class="panel insight-panel" aria-labelledby="insight-heading"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">A SIGNAL IN THE SERIES</div><h2 class="panel-title" id="insight-heading">An observed high point</h2></div><span class="panel-kicker">${escapeHtml(app.chart.year === "all" ? "3 YEARS" : app.chart.year)}</span></div><div class="insight-body" id="monthly-insight"></div></section>
    </div>
    <div class="section-row">
      <section class="panel" aria-labelledby="coastal-title"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">DAILY CYCLE · OBSERVED</div><h2 class="panel-title" id="coastal-title">The coastal rhythm</h2><p class="panel-subtitle">Hourly ${escapeHtml(pollutantLabels[app.chart.pollutant])} mean alongside the sea-breeze flag share</p></div><span class="panel-kicker">00—23 H</span></div><div class="panel-body"><div class="chart-legend"><span class="legend-item"><i class="legend-line" style="--legend-color:${app.data.pollutants.find(p=>p.key===app.chart.pollutant).color}"></i>${escapeHtml(pollutantLabels[app.chart.pollutant])} · ${unitFor(app.chart.pollutant)}</span><span class="legend-item"><i class="legend-line dashed"></i>Sea-breeze flag share · right scale</span></div><div class="chart-wrap" id="hourly-chart"></div><p class="chart-note">Sea-breeze share is the hourly mean of the source’s 0/1 <code>is_sea_breeze</code> feature. The overlay shows timing, not causation.</p></div></section>
      <section class="panel map-card" aria-labelledby="map-title"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">SPATIAL FOOTPRINT · COORDINATES</div><h2 class="panel-title" id="map-title">Monitoring across the coast</h2><p class="panel-subtitle">Select a point to focus the charts on that station.</p></div><button type="button" class="panel-action" data-route-link="satellite">Open satellite atlas ↗</button></div><div class="panel-body"><div id="station-map"></div><div class="map-key"><span>Lower mean</span><span><span class="map-key-gradient"></span></span><span>Higher mean</span></div><p class="chart-note">Points use the CSV latitude / longitude fields; open the satellite atlas for an imagery-backed map and monthly surface view.</p></div></section>
    </div>
    <section class="panel"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">PERIOD MEAN · STATION COMPARISON</div><h2 class="panel-title">Where the observed averages differ</h2><p class="panel-subtitle">Sorted high to low for the selected pollutant and period.</p></div><button type="button" class="panel-action" data-route-link="stations">Explore the field →</button></div><div class="panel-body"><div class="station-list" id="top-stations"></div><p class="station-footnote">Station means are unweighted across each site’s hourly source rows. Differences describe this dataset and period only.</p></div></section>
  </div>`;
  countUp();
  bindChartControls();
  bindRouteLinks();
  renderMonthlyChart($("#monthly-chart"));
  renderInsight($("#monthly-insight"));
  renderHourlyChart($("#hourly-chart"));
  renderMap($("#station-map"));
  renderStationTop($("#top-stations"), 7);
}

function mapMonths() {
  return app.data.monthly.map(item => item.month);
}

function mapMonthIndex() {
  const months = mapMonths();
  const index = months.indexOf(app.map.month);
  return index < 0 ? Math.max(0, months.length - 1) : index;
}

function selectedMapField() {
  return app.data.map_fields.find(item => item.key === app.map.field) || app.data.map_fields[0];
}

function mapLayerOptions() {
  const groups = new Map();
  for (const layer of app.data.map_fields) {
    if (!groups.has(layer.group)) groups.set(layer.group, []);
    groups.get(layer.group).push(layer);
  }
  return [...groups].map(([group, layers]) => `<optgroup label="${escapeHtml(group === "CPCB" ? "CPCB · observed pollutants" : group === "GEOS-CF" ? "GEOS-CF · modeled species" : "ERA5 · weather context")}">${layers.map(layer => `<option value="${escapeHtml(layer.key)}" ${app.map.field === layer.key ? "selected" : ""}>${escapeHtml(layer.label)}</option>`).join("")}</optgroup>`).join("");
}

function mapSamples() {
  const field = selectedMapField();
  return app.data.stations.map(station => {
    const month = station.monthly.find(item => item.month === app.map.month);
    return { ...station, value: Number(month?.[field.key]) };
  }).filter(item => Number.isFinite(item.value) && Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

function mapColor(t) {
  const stops = [[30, 224, 199], [119, 241, 115], [255, 219, 72], [255, 140, 67], [250, 73, 121]];
  const n = Math.max(0, Math.min(0.99999, t)) * (stops.length - 1);
  const index = Math.floor(n), local = n - index;
  const a = stops[index], b = stops[index + 1];
  return `rgb(${a.map((value, i) => Math.round(value + (b[i] - value) * local)).join(",")})`;
}

function mapColorBytes(t) {
  const index = Math.max(0, Math.min(255, Math.round(t * 255)));
  return MAP_COLOR_LUT[index];
}

const MAP_COLOR_LUT = (() => {
  const stops = [[30, 224, 199], [119, 241, 115], [255, 219, 72], [255, 140, 67], [250, 73, 121]];
  return Array.from({ length: 256 }, (_, index) => {
    const position = index / 255 * (stops.length - 1);
    const stop = Math.min(stops.length - 2, Math.floor(position));
    const local = position - stop;
    return stops[stop].map((value, channel) => Math.round(value + (stops[stop + 1][channel] - value) * local));
  });
})();

function drawMapSurface(canvas, samples, bounds) {
  if (!canvas) return;
  const width = 256;
  const aspect = (bounds.maxLon - bounds.minLon) * Math.cos(19.1 * Math.PI / 180) / (bounds.maxLat - bounds.minLat);
  const height = Math.max(120, Math.round(width / aspect));
  canvas.width = width;
  canvas.height = height;
  canvas.style.display = app.map.surface && samples.length > 1 ? "block" : "none";
  if (!app.map.surface || samples.length < 2) return;
  const values = samples.map(item => item.value);
  const low = Math.min(...values), high = Math.max(...values);
  const range = high - low || 1;
  const image = canvas.getContext("2d", { willReadFrequently: true }).createImageData(width, height);
  const cosLat = Math.cos(19.1 * Math.PI / 180);
  const maxDistance = Number(app.map.radius);
  const maxDistanceSquared = maxDistance * maxDistance;
  const kmPerPixelX = (bounds.maxLon - bounds.minLon) * 111.32 * cosLat / width;
  const kmPerPixelY = (bounds.maxLat - bounds.minLat) * 111.32 / height;
  const pixels = samples.map(station => ({
    x: (station.longitude - bounds.minLon) / (bounds.maxLon - bounds.minLon) * width,
    y: (bounds.maxLat - station.latitude) / (bounds.maxLat - bounds.minLat) * height,
    value: station.value,
  }));
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let nearestSquared = Infinity, weighted = 0, weightTotal = 0;
      for (const station of pixels) {
        const dx = (px + 0.5 - station.x) * kmPerPixelX;
        const dy = (py + 0.5 - station.y) * kmPerPixelY;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < nearestSquared) nearestSquared = distanceSquared;
        const weight = 1 / Math.max(0.06, distanceSquared);
        weighted += station.value * weight;
        weightTotal += weight;
      }
      const offset = (py * width + px) * 4;
      if (nearestSquared > maxDistanceSquared) continue;
      const rgba = mapColorBytes((weighted / weightTotal - low) / range);
      image.data[offset] = rgba[0];
      image.data[offset + 1] = rgba[1];
      image.data[offset + 2] = rgba[2];
      image.data[offset + 3] = Math.round(218 * Math.min(1, 0.18 + (1 - Math.sqrt(nearestSquared) / maxDistance) * 0.82));
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
}

function renderSatellite() {
  const months = mapMonths();
  const index = mapMonthIndex();
  host.innerHTML = `<div class="page-enter atlas-page">
    <section class="atlas-hero">
      <div class="atlas-hero-copy"><div class="eyebrow"><span class="eyebrow-mark"></span>ORBITAL VIEW / MUMBAI COAST</div><h1>Read Mumbai<br><em>from above.</em></h1><p>Move through three years of CPCB station readings, GEOS-CF chemistry, and ERA5 weather on a satellite reference view of the city.</p><div class="atlas-hero-tags"><span>25 FIELD SITES</span><span>18 POLLUTANT LAYERS</span><span>06 WEATHER LAYERS</span></div></div>
      <div class="atlas-hero-note"><span class="orbit-mark"><i></i></span><div><small>FIELD WINDOW</small><strong>JAN 2023 — DEC 2025</strong><span>Observed and model-supplied values remain separately labeled.</span></div></div>
    </section>
    <section class="atlas-workbench" aria-label="Satellite pollutant map">
      <div class="atlas-main-column">
        <div class="atlas-map-heading"><div><span class="atlas-live-dot"></span><span id="map-imagery-status">CONNECTING TO SATELLITE MOSAIC</span></div><span class="atlas-map-readouts"><span class="atlas-coordinates" id="atlas-coordinates">19.120° N / 72.880° E</span><span class="atlas-zoom-label" id="atlas-zoom-label">ZOOM 12</span></span></div>
        <div class="satellite-map-frame" id="satellite-map-frame">
          <div class="map-fallback" aria-hidden="true"><div class="fallback-grid"></div><div class="fallback-coast"></div><span class="fallback-label sea-label">ARABIAN SEA</span><span class="fallback-label city-label">MUMBAI</span><span class="fallback-label navi-label">NAVI MUMBAI</span><span class="fallback-road road-one"></span><span class="fallback-road road-two"></span></div>
          <div id="leaflet-map" class="leaflet-map" role="application" aria-label="Interactive satellite map with Mumbai monitoring stations"></div>
          <div class="map-top-chip"><span>MONTHLY FIELD VALUE</span><strong id="map-month-badge">${escapeHtml(monthLabel(months[index]))}</strong></div>
          <div class="map-zoom-controls" aria-label="Map zoom controls"><button id="map-zoom-in" type="button" aria-label="Zoom in">+</button><button id="map-zoom-out" type="button" aria-label="Zoom out">−</button><button id="map-reset" type="button" aria-label="Reset map view">◎</button></div>
          <div class="map-north" aria-hidden="true"><span>N</span><b>↑</b></div>
          <div class="map-error-message" id="map-error-message">Satellite tiles could not load. Check your connection; the local pollutant data remains available.</div>
        </div>
        <div class="atlas-timeline"><button id="map-play" class="timeline-play" type="button" aria-label="Play monthly timeline"><span class="play-symbol">▶</span><span class="play-copy">PLAY</span></button><button id="map-step-back" class="timeline-step" type="button" aria-label="Previous month">‹</button><div class="timeline-core"><div class="timeline-month"><span>DATA TIMELINE</span><strong id="map-timeline-month">${escapeHtml(monthLabel(months[index]))}</strong><span id="map-timeline-year">${escapeHtml(months[index]?.slice(0, 4) || "2025")}</span></div><input id="map-month-range" type="range" min="0" max="${Math.max(0, months.length - 1)}" value="${index}" aria-label="Choose observation month"><div class="timeline-endpoints"><span>${escapeHtml(monthLabel(months[0]))}</span><span>${escapeHtml(monthLabel(months.at(-1)))}</span></div></div><button id="map-step-forward" class="timeline-step" type="button" aria-label="Next month">›</button></div>
        <div class="atlas-source-note"><span class="source-note-line"></span><p>The satellite mosaic is a geographic reference. The colorful surface is an <strong>illustrative inverse-distance estimate</strong> from the selected monthly station means; it is not a satellite measurement, forecast, or official gridded product.</p></div>
      </div>
      <aside class="atlas-inspector" aria-label="Map layer controls and station readings">
        <div class="inspector-topline"><span>LAYER CONTROL</span><span>01 / 03</span></div>
        <label class="map-layer-control"><span>Choose a field</span><select id="map-field-select">${mapLayerOptions()}</select></label>
        <div class="map-layer-meta"><span class="layer-source-badge" id="map-layer-source"></span><h2 id="map-layer-title"></h2><p id="map-layer-description"></p></div>
        <div class="map-legend-block"><div class="map-legend-title"><span>LOW</span><span id="map-layer-unit"></span><span>HIGH</span></div><div class="map-color-ramp"></div><div class="map-legend-values"><span id="map-range-low">—</span><span id="map-range-high">—</span></div></div>
        <div class="map-toggle-row"><div><strong>Station interpolation</strong><span id="map-surface-caption">IDW · 18 km radius</span></div><button id="map-surface-toggle" class="switch-control" type="button" aria-pressed="${app.map.surface}" aria-label="Toggle station interpolation"><span></span></button></div>
        <label class="map-range-control"><span>Surface intensity <strong id="map-opacity-value">${Math.round(app.map.opacity * 100)}%</strong></span><input id="map-opacity-range" type="range" min="25" max="100" value="${Math.round(app.map.opacity * 100)}" aria-label="Surface intensity"></label>
        <label class="map-range-control"><span>Influence radius <strong id="map-radius-value">${app.map.radius} km</strong></span><input id="map-radius-range" type="range" min="6" max="36" value="${app.map.radius}" aria-label="Interpolation influence radius in kilometres"></label>
        <div class="inspector-divider"></div>
        <div class="site-detail-head"><span class="site-detail-kicker">STATION INSPECTOR</span><span class="site-count">25 SITES</span></div><div class="map-selected-site" id="map-selected-site"></div>
        <div class="map-rank-heading"><span>HIGHEST IN THIS MONTH</span><span>VALUE</span></div><div class="map-station-rankings" id="map-station-rankings"></div>
        <a class="map-method-link" href="#methodology" data-route-link="methodology">How this map is calculated <span>↗</span></a>
      </aside>
    </section>
    <div class="atlas-footline"><span>BASEMAP: ESRI WORLD IMAGERY · MOSAIC DATES VARY</span><span>STATION VALUES ARE MONTHLY MEANS</span><span>GEOS-CF & ERA5 UNIT METADATA NOT PRESENT IN SOURCE CSV</span></div>
  </div>`;
  bindRouteLinks();
  bindSatelliteControls();
  renderSatelliteMap();
}

function setMapImageryStatus(message, unavailable = false) {
  const status = $("#map-imagery-status");
  if (status) status.textContent = message;
  if (unavailable) $("#map-error-message")?.classList.add("is-visible");
  else if (app.map.imageryLoaded) $("#map-error-message")?.classList.remove("is-visible");
}

function ensureLeafletAtlas() {
  if (window.L) {
    initializeLeafletMap();
    return Promise.resolve(true);
  }
  if (app.map.leafletPromise) return app.map.leafletPromise;
  app.map.leafletLoading = true;
  setMapImageryStatus("LOADING INTERACTIVE SATELLITE MAP");
  const loadAsset = (tag, url, attribute) => new Promise((resolve, reject) => {
    const element = document.createElement(tag);
    element.dataset.geooracleLeaflet = attribute;
    element[attribute === "css" ? "rel" : "src"] = attribute === "css" ? "stylesheet" : url;
    if (attribute === "css") element.href = url;
    element.onload = resolve;
    element.onerror = reject;
    document.head.append(element);
  });
  const versionRoot = "https://unpkg.com/leaflet@1.9.4/dist/";
  app.map.leafletPromise = Promise.all([
    loadAsset("link", `${versionRoot}leaflet.css`, "css"),
    loadAsset("script", `${versionRoot}leaflet.js`, "js"),
  ]).then(() => {
    app.map.leafletLoading = false;
    app.map.leafletPromise = null;
    if (app.route === "satellite") {
      initializeLeafletMap();
      renderSatelliteMap();
    }
    return true;
  }).catch(() => {
    app.map.leafletLoading = false;
    app.map.leafletPromise = null;
    $("#satellite-map-frame")?.classList.add("is-offline");
    $("#map-error-message") && ($("#map-error-message").textContent = "Interactive satellite tiles could not load. Check your connection, then reopen the atlas.");
    setMapImageryStatus("SATELLITE MAP OFFLINE · LOCAL DATA READY", true);
    return false;
  });
  return app.map.leafletPromise;
}

function initializeLeafletMap() {
  const container = $("#leaflet-map");
  if (!window.L || !container || app.route !== "satellite") return null;
  if (app.map.leaflet?.getContainer() === container) return app.map.leaflet;
  app.map.leaflet?.remove();
  $("#satellite-map-frame")?.classList.remove("is-offline");
  const map = window.L.map(container, {
    zoomControl: false, attributionControl: true,
    minZoom: 9, maxZoom: 19,
    scrollWheelZoom: true, wheelDebounceTime: 50, wheelPxPerZoomLevel: 70,
    zoomSnap: 0.25, zoomDelta: 0.75, zoomAnimation: true, fadeAnimation: true,
    touchZoom: true, doubleClickZoom: true, keyboard: true, maxBoundsViscosity: 0.8,
  });
  map.setView([app.map.centerLat, app.map.centerLon], app.map.zoom || 11.5);
  app.map.leaflet = map;
  app.map.stationLayer = window.L.layerGroup().addTo(map);
  map.createPane("pollutantPane").style.zIndex = "450";
  map.getPane("pollutantPane").style.pointerEvents = "none";
  map.createPane("stationPane").style.zIndex = "620";
  const imagery = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    minZoom: 2, maxZoom: 19, maxNativeZoom: 19, keepBuffer: 2, updateWhenIdle: true,
    attribution: 'Imagery © <a href="https://www.esri.com/">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(map);
  app.map.imageryLayer = imagery;
  let tileErrors = 0;
  imagery.on("loading", () => {
    tileErrors = 0;
    app.map.imageryLoaded = false;
    app.map.imageryError = false;
    $("#map-error-message")?.classList.remove("is-visible");
    setMapImageryStatus("LOADING SATELLITE TILES");
  });
  imagery.on("load", () => {
    app.map.imageryLoaded = tileErrors === 0;
    app.map.imageryError = tileErrors > 0;
    setMapImageryStatus(tileErrors ? "SATELLITE MOSAIC · SOME TILES UNAVAILABLE" : "LIVE SATELLITE MOSAIC · ESRI", tileErrors > 0);
  });
  imagery.on("tileerror", () => {
    tileErrors += 1;
    app.map.imageryError = true;
    setMapImageryStatus("SATELLITE TILES PARTIALLY UNAVAILABLE", true);
  });
  window.L.control.scale({ position: "bottomleft", metric: true, imperial: false, maxWidth: 100 }).addTo(map);
  const syncView = () => {
    clearTimeout(app.map.viewTimer);
    app.map.viewTimer = setTimeout(() => {
      if (app.route !== "satellite" || app.map.leaflet !== map) return;
      const center = map.getCenter();
      app.map.centerLat = center.lat;
      app.map.centerLon = center.lng;
      app.map.zoom = map.getZoom();
      updateMapReadouts(map);
      renderSatelliteMap();
    }, 70);
  };
  map.on("moveend zoomend", syncView);
  map.whenReady(() => setTimeout(() => {
    if (app.route === "satellite" && app.map.leaflet === map) {
      map.invalidateSize({ pan: false });
      updateMapReadouts(map);
      renderSatelliteMap();
    }
  }, 80));
  return map;
}

function updateMapReadouts(map) {
  const center = map.getCenter();
  const latHemisphere = center.lat < 0 ? "S" : "N";
  const lonHemisphere = center.lng < 0 ? "W" : "E";
  const coordinates = $("#atlas-coordinates");
  if (coordinates) coordinates.textContent = `${Math.abs(center.lat).toFixed(3)}° ${latHemisphere} / ${Math.abs(center.lng).toFixed(3)}° ${lonHemisphere}`;
  const zoom = $("#atlas-zoom-label");
  if (zoom) zoom.textContent = `ZOOM ${map.getZoom().toFixed(1)}`;
}

function renderLeafletSurface(map, samples) {
  if (app.map.surfaceLayer) {
    map.removeLayer(app.map.surfaceLayer);
    app.map.surfaceLayer = null;
  }
  if (!app.map.surface || samples.length < 2) return;
  const view = map.getBounds();
  const bounds = { minLat: view.getSouth(), maxLat: view.getNorth(), minLon: view.getWest(), maxLon: view.getEast() };
  const canvas = document.createElement("canvas");
  drawMapSurface(canvas, samples, bounds);
  const imageBounds = [[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]];
  app.map.surfaceLayer = window.L.imageOverlay(canvas.toDataURL("image/png"), imageBounds, {
    pane: "pollutantPane", opacity: app.map.opacity, interactive: false, className: "leaflet-pollutant-surface",
  }).addTo(map);
}

function renderSatelliteMap() {
  if (!app.data || app.route !== "satellite") return;
  const samples = mapSamples();
  const values = samples.map(item => item.value);
  const low = values.length ? Math.min(...values) : NaN, high = values.length ? Math.max(...values) : NaN;
  const field = selectedMapField();
  const map = app.map.leaflet || initializeLeafletMap();
  if (!map) ensureLeafletAtlas();
  if (map && app.map.stationLayer) {
    app.map.stationLayer.clearLayers();
    for (const station of samples) {
      const color = mapColor(Number.isFinite(low) ? (station.value - low) / (high - low || 1) : 0);
      const selected = app.map.station === station.id;
      const location = [Number(station.latitude), Number(station.longitude)];
      if (!Number.isFinite(location[0]) || !Number.isFinite(location[1])) continue;
      const zoomScale = Math.max(0.9, Math.min(1.35, 1 + (map.getZoom() - 11.5) * 0.045));
      const pointRadius = (selected ? 7.5 : 6) * zoomScale;
      const halo = window.L.circleMarker(location, {
        radius: pointRadius * 1.85, color, weight: 1, opacity: 0.55,
        fillColor: color, fillOpacity: 0.18, interactive: false, pane: "stationPane", className: "atlas-site-halo",
      }).addTo(app.map.stationLayer);
      const point = window.L.circleMarker(location, {
        radius: pointRadius, color: "#f5fff7", weight: selected ? 2 : 1.4,
        fillColor: color, fillOpacity: 1, pane: "stationPane", className: "atlas-site-marker",
      });
      point.bindTooltip(`<strong>${escapeHtml(station.name)}</strong><br>${escapeHtml(field.label)}: ${number(station.value, 2)} ${escapeHtml(field.unit)}`, {
        direction: "top", offset: [0, -9], opacity: 1, className: "atlas-map-tooltip",
      });
      point.on("click", () => { app.map.station = station.id; renderSatelliteMap(); });
      point.on("mouseover", () => point.setStyle({ weight: 2.4, fillOpacity: 1 }));
      point.on("mouseout", () => point.setStyle({ weight: selected ? 2 : 1.4, fillOpacity: 1 }));
      point.on("add", () => {
        const element = point.getElement();
        if (!element) return;
        element.setAttribute("role", "button");
        element.setAttribute("tabindex", "0");
        element.setAttribute("aria-label", `${station.name}: ${number(station.value, 2)} ${field.unit}`);
        element.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            app.map.station = station.id;
            renderSatelliteMap();
          }
        });
      });
      halo.bringToBack();
      point.addTo(app.map.stationLayer);
    }
    renderLeafletSurface(map, samples);
    app.map.zoom = map.getZoom();
    updateMapReadouts(map);
  }
  $("#map-month-badge").textContent = monthLabel(app.map.month);
  $("#map-timeline-month").textContent = monthLabel(app.map.month, false);
  $("#map-timeline-year").textContent = app.map.month.slice(0, 4);
  $("#map-month-range").value = String(mapMonthIndex());
  $("#map-layer-source").textContent = field.source;
  $("#map-layer-title").textContent = field.label;
  $("#map-layer-unit").textContent = field.unit;
  $("#map-layer-description").textContent = field.group === "GEOS-CF"
    ? "Model field joined to the same station-hour record. Color is normalized within this selected species; source units are retained as labeled."
    : field.group === "ERA5"
      ? "Matched weather field summarized at each monitoring location for the selected month. Source values are not converted."
      : "Ground monitor observation aggregated to a monthly arithmetic mean at each CPCB site.";
  $("#map-range-low").textContent = `${number(low, 2)} ${field.unit}`;
  $("#map-range-high").textContent = `${number(high, 2)} ${field.unit}`;
  $("#map-surface-caption").textContent = `IDW · ${app.map.radius} km radius`;
  $("#map-surface-toggle").setAttribute("aria-pressed", String(app.map.surface));
  $("#map-opacity-value").textContent = `${Math.round(app.map.opacity * 100)}%`;
  $("#map-radius-value").textContent = `${app.map.radius} km`;
  $("#map-selected-site").innerHTML = renderSelectedMapSite(samples, field);
  const ranked = [...samples].sort((a, b) => b.value - a.value).slice(0, 5);
  $("#map-station-rankings").innerHTML = ranked.map((site, index) => `<button type="button" class="map-ranking-row ${app.map.station === site.id ? "is-active" : ""}" data-station="${escapeHtml(site.id)}"><span class="map-ranking-index">${String(index + 1).padStart(2, "0")}</span><span class="map-ranking-name">${escapeHtml(site.name.split(",")[0])}</span><strong>${number(site.value, 1)}</strong></button>`).join("");
  bindMapStationInteractions(samples);
}

function renderSelectedMapSite(samples, field) {
  const selected = samples.find(site => site.id === app.map.station) || [...samples].sort((a, b) => b.value - a.value)[0];
  if (!selected) return `<p class="map-no-values">No station values are available for this selection.</p>`;
  const picked = app.map.station === selected.id;
  return `<div class="selected-site-value"><span>${picked ? "SELECTED MONITORING SITE" : "HIGHEST SITE IN VIEW"}</span><strong>${number(selected.value, 2)}<small>${escapeHtml(field.unit)}</small></strong></div><div class="selected-site-name">${escapeHtml(selected.name)}</div><div class="selected-site-coords">${Number(selected.latitude).toFixed(4)}° N &nbsp; / &nbsp; ${Number(selected.longitude).toFixed(4)}° E</div>`;
}

function bindMapStationInteractions(samples) {
  $$(".map-ranking-row").forEach(row => row.addEventListener("click", () => {
    const station = samples.find(site => site.id === row.dataset.station);
    if (!station) return;
    app.map.station = station.id;
    renderSatelliteMap();
    app.map.leaflet?.flyTo([station.latitude, station.longitude], Math.max(13, app.map.leaflet.getZoom()), { duration: 0.75 });
  }));
}

function bindSatelliteControls() {
  $("#map-field-select").addEventListener("change", event => { app.map.field = event.target.value; renderSatelliteMap(); });
  $("#map-month-range").addEventListener("input", event => { app.map.month = mapMonths()[Number(event.target.value)]; renderSatelliteMap(); });
  $("#map-step-back").addEventListener("click", () => setMapMonth(Math.max(0, mapMonthIndex() - 1)));
  $("#map-step-forward").addEventListener("click", () => setMapMonth(Math.min(mapMonths().length - 1, mapMonthIndex() + 1)));
  $("#map-play").addEventListener("click", () => {
    if (app.map.playTimer) {
      clearInterval(app.map.playTimer); app.map.playTimer = null;
      $("#map-play").classList.remove("is-playing"); $(".play-symbol", $("#map-play")).textContent = "▶"; $(".play-copy", $("#map-play")).textContent = "PLAY";
      return;
    }
    $("#map-play").classList.add("is-playing"); $(".play-symbol", $("#map-play")).textContent = "Ⅱ"; $(".play-copy", $("#map-play")).textContent = "PAUSE";
    app.map.playTimer = setInterval(() => setMapMonth((mapMonthIndex() + 1) % mapMonths().length), 900);
  });
  $("#map-surface-toggle").addEventListener("click", () => { app.map.surface = !app.map.surface; renderSatelliteMap(); });
  $("#map-opacity-range").addEventListener("input", event => {
    app.map.opacity = Number(event.target.value) / 100;
    $("#map-opacity-value").textContent = `${Math.round(app.map.opacity * 100)}%`;
    app.map.surfaceLayer?.setOpacity(app.map.opacity);
  });
  $("#map-radius-range").addEventListener("input", event => { app.map.radius = Number(event.target.value); renderSatelliteMap(); });
  $("#map-zoom-in").addEventListener("click", () => app.map.leaflet?.zoomIn(0.75, { animate: true }));
  $("#map-zoom-out").addEventListener("click", () => app.map.leaflet?.zoomOut(0.75, { animate: true }));
  $("#map-reset").addEventListener("click", () => app.map.leaflet?.flyTo([19.12, 72.88], 11.5, { duration: 0.85 }));
}

function setMapMonth(index) {
  const months = mapMonths();
  app.map.month = months[Math.max(0, Math.min(months.length - 1, index))];
  renderSatelliteMap();
}

function bindRouteLinks() {
  $$('[data-route-link]').forEach(el => el.addEventListener("click", () => goTo(el.dataset.routeLink)));
}

function svgTicks(max, count = 4) {
  return Array.from({ length: count + 1 }, (_, index) => max * index / count);
}

function makeLinePath(points) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function attachChartHover(container, svg, points, format) {
  if (!points.length) return;
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  container.append(tooltip);
  const show = (index, clientX = null, clientY = null) => {
    const point = points[Math.max(0, Math.min(points.length - 1, index))];
    tooltip.innerHTML = format(point.data);
    tooltip.style.display = "block";
    const box = container.getBoundingClientRect();
    const left = clientX == null ? (point.x / Number(svg.viewBox.baseVal.width)) * box.width : clientX - box.left;
    const top = clientY == null ? Math.max(0, (point.y / Number(svg.viewBox.baseVal.height)) * svg.getBoundingClientRect().height - 45) : clientY - box.top - 36;
    tooltip.style.left = `${Math.max(4, Math.min(box.width - 145, left + 8))}px`;
    tooltip.style.top = `${Math.max(3, top)}px`;
  };
  svg.addEventListener("pointermove", event => {
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * Number(svg.viewBox.baseVal.width);
    let nearest = 0;
    for (let i = 1; i < points.length; i += 1) if (Math.abs(points[i].x - x) < Math.abs(points[nearest].x - x)) nearest = i;
    show(nearest, event.clientX, event.clientY);
  });
  svg.addEventListener("pointerleave", () => { tooltip.style.display = "none"; });
  $$(".chart-point", svg).forEach((circle, index) => {
    circle.addEventListener("focus", () => show(index));
    circle.addEventListener("blur", () => { tooltip.style.display = "none"; });
  });
}

function revealWhenVisible(root) {
  const elements = $$(".chart-line, .chart-bar, .map-station", root);
  if (!elements.length) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    elements.forEach(element => element.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: .22, rootMargin: "0px 0px -5% 0px" });
  elements.forEach((element, index) => {
    if (element.classList.contains("chart-bar")) element.style.setProperty("--bar-delay", `${Math.min(index * .012, .22)}s`);
    if (element.classList.contains("map-station")) element.style.setProperty("--marker-delay", `${Math.min(index * .012, .28)}s`);
    observer.observe(element);
  });
}

function renderMonthlyChart(container) {
  const data = selectedMonths();
  const key = app.chart.pollutant;
  if (!data.length) { container.innerHTML = '<div class="table-empty">No monthly values for this selection.</div>'; return; }
  const width = Math.max(520, Math.round(container.clientWidth || 600));
  const height = 218, left = 42, right = 12, top = 13, bottom = 31;
  const values = data.map(item => Number(item[key]));
  const max = Math.max(1, Math.ceil(Math.max(...values) / 10) * 10);
  const y = value => top + (height - top - bottom) * (1 - value / max);
  const x = index => data.length === 1 ? (left + width - right) / 2 : left + index * (width - left - right) / (data.length - 1);
  const points = data.map((item, index) => ({ x: x(index), y: y(Number(item[key])), data: item }));
  const line = makeLinePath(points);
  const area = `${line} L${points.at(-1).x.toFixed(1)},${(height - bottom).toFixed(1)} L${points[0].x.toFixed(1)},${(height - bottom).toFixed(1)} Z`;
  const ticks = svgTicks(max, 4);
  const yGrid = ticks.map(value => `<g class="chart-grid"><line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/></g><g class="chart-axis"><text x="${left - 8}" y="${y(value) + 3}" text-anchor="end">${number(value, 0)}</text></g>`).join("");
  const xLabels = data.map((item, index) => {
    const monthNumber = Number(item.month.slice(5));
    const show = data.length <= 12 || monthNumber === 1 || monthNumber === 4 || monthNumber === 7 || monthNumber === 10;
    return show ? `<text x="${x(index)}" y="${height - 8}" text-anchor="middle">${monthLabel(item.month, data.length > 12)}</text>` : "";
  }).join("");
  const color = app.data.pollutants.find(item => item.key === key).color;
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly mean ${escapeHtml(pollutantLabels[key])} for ${app.chart.year === "all" ? "2023 to 2025" : app.chart.year}"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".19"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${yGrid}<path class="chart-area" d="${area}"/><path class="chart-line" style="--chart-color:${color}" d="${line}"/><g class="chart-axis">${xLabels}<text class="unit-label" x="${left}" y="10">${escapeHtml(unitFor(key))}</text></g>${points.map((point, index) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="3.2" tabindex="0" aria-label="${escapeHtml(monthLabel(point.data.month))}, ${number(point.data[key], 2)} ${escapeHtml(unitFor(key))}"/>`).join("")}</svg>`;
  revealWhenVisible(container);
  attachChartHover(container, $("svg", container), points, item => `<strong>${escapeHtml(monthLabel(item.month))}</strong>${escapeHtml(pollutantLabels[key])}: ${number(item[key], 2)} ${escapeHtml(unitFor(key))}`);
}

function renderInsight(container) {
  const insight = monthlyInsight();
  container.innerHTML = `<div class="insight-mark" aria-hidden="true">↗</div><div class="insight-value">${insight.value}</div><div class="insight-title">${escapeHtml(insight.title)}</div><p class="insight-copy">${escapeHtml(insight.copy)}</p><div class="insight-foot"><span>RANGE IN VIEW</span><span><strong>${escapeHtml(insight.low)}</strong> → <strong>${escapeHtml(insight.high)}</strong></span></div>`;
}

function renderHourlyChart(container) {
  const data = activeHourly();
  const key = app.chart.pollutant;
  if (!data?.length) { container.innerHTML = '<div class="table-empty">No hourly values for this selection.</div>'; return; }
  const width = Math.max(520, Math.round(container.clientWidth || 600));
  const height = 218, left = 42, right = 32, top = 16, bottom = 30;
  const values = data.map(item => Number(item[key])).filter(Number.isFinite);
  const max = Math.max(1, Math.ceil(Math.max(...values) / 10) * 10);
  const y = value => top + (height - top - bottom) * (1 - value / max);
  const x = index => left + index * (width - left - right) / Math.max(1, data.length - 1);
  const points = data.map((item, index) => ({ x: x(index), y: y(Number(item[key]) || 0), data: item }));
  const line = makeLinePath(points);
  const ticks = svgTicks(max, 4);
  const grid = ticks.map(value => `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}"/><text x="${left - 8}" y="${y(value) + 3}" text-anchor="end">${number(value, 0)}</text>`).join("");
  const bars = data.map((item, index) => {
    const share = Math.max(0, Math.min(1, Number(item.sea_breeze) || 0));
    const barHeight = (height - top - bottom) * share;
    return `<rect class="chart-bar" style="--bar-delay:${Math.min(index * .012, .22)}s" x="${x(index) - 3}" y="${height - bottom - barHeight}" width="6" height="${barHeight}" rx="2" opacity=".45"/>`;
  }).join("");
  const labels = [0, 6, 12, 18, 23].map(hour => `<text x="${x(hour)}" y="${height - 8}" text-anchor="middle">${String(hour).padStart(2, "0")}</text>`).join("");
  const color = app.data.pollutants.find(item => item.key === key).color;
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Hourly mean ${escapeHtml(pollutantLabels[key])} and sea breeze flag share"><g class="chart-grid chart-axis">${grid}</g>${bars}<path class="chart-line" style="--chart-color:${color}" d="${line}"/><g class="chart-axis"><text class="unit-label" x="${left}" y="10">${escapeHtml(unitFor(key))}</text><text class="unit-label" x="${width - right + 5}" y="10">%</text><text x="${width - right + 4}" y="${top + 4}">100</text><text x="${width - right + 4}" y="${(top + height - bottom) / 2 + 3}">50</text><text x="${width - right + 4}" y="${height - bottom + 3}">0</text>${labels}</g></svg>`;
  revealWhenVisible(container);
  attachChartHover(container, $("svg", container), points, item => `<strong>${String(item.hour).padStart(2, "0")}:00</strong>${escapeHtml(pollutantLabels[key])}: ${number(item[key], 2)} ${escapeHtml(unitFor(key))}<br>Sea-breeze flag: ${number((Number(item.sea_breeze) || 0) * 100, 1)}%`);
}

function averageForSelection(station, key) {
  return averageStation(station, key);
}

function stationColor(value, min, max) {
  if (!Number.isFinite(value)) return "#99b1a2";
  const t = max === min ? .5 : (value - min) / (max - min);
  if (t < .5) {
    const u = t * 2;
    return interpolateColor([143, 200, 163], [226, 179, 106], u);
  }
  return interpolateColor([226, 179, 106], [216, 122, 93], (t - .5) * 2);
}

function interpolateColor(a, b, t) {
  const vals = a.map((v, index) => Math.round(v + (b[index] - v) * t));
  return `rgb(${vals.join(",")})`;
}

function renderMap(container) {
  if (!container) return;
  const stations = app.data.stations.filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
  if (!stations.length) { container.innerHTML = '<div class="table-empty">No coordinates found in the source CSV.</div>'; return; }
  const width = Math.max(420, Math.round(container.clientWidth || 600));
  const height = 278, left = 42, right = 18, top = 12, bottom = 27;
  const lons = stations.map(s => s.longitude), lats = stations.map(s => s.latitude);
  const minLon = Math.min(...lons) - .025, maxLon = Math.max(...lons) + .025;
  const minLat = Math.min(...lats) - .025, maxLat = Math.max(...lats) + .025;
  const px = lon => left + (lon - minLon) / (maxLon - minLon) * (width - left - right);
  const py = lat => top + (maxLat - lat) / (maxLat - minLat) * (height - top - bottom);
  const means = stations.map(s => Number(averageForSelection(s, app.chart.pollutant))).filter(Number.isFinite);
  const low = Math.min(...means), high = Math.max(...means);
  const lonTicks = Array.from({ length: 4 }, (_, i) => minLon + (maxLon - minLon) * i / 3);
  const latTicks = Array.from({ length: 4 }, (_, i) => minLat + (maxLat - minLat) * i / 3);
  const grid = [...lonTicks.map(value => `<line x1="${px(value)}" y1="${top}" x2="${px(value)}" y2="${height - bottom}"/><text x="${px(value)}" y="${height - 7}" text-anchor="middle">${value.toFixed(2)}°</text>`), ...latTicks.map(value => `<line x1="${left}" y1="${py(value)}" x2="${width - right}" y2="${py(value)}"/><text x="${left - 7}" y="${py(value) + 3}" text-anchor="end">${value.toFixed(2)}°</text>`)].join("");
  container.innerHTML = `<svg class="map-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="Coordinate plot of 25 Mumbai monitoring sites"><g class="map-grid">${grid}</g><g class="map-axis"></g>${stations.map(station => {
    const mean = Number(averageForSelection(station, app.chart.pollutant));
    const selected = app.chart.station === station.id;
    const fill = stationColor(mean, low, high);
    return `<circle class="map-station ${selected ? "selected" : ""}" data-station="${escapeHtml(station.id)}" cx="${px(station.longitude)}" cy="${py(station.latitude)}" r="${selected ? 5.7 : 4.5}" fill="${fill}" stroke="#fff" stroke-width="2" tabindex="0" role="button" aria-label="${escapeHtml(station.name)}, ${number(mean, 1)} ${escapeHtml(unitFor(app.chart.pollutant))}"/>`;
  }).join("")}</svg>`;
  revealWhenVisible(container);
  const svg = $("svg", container);
  $$(".map-station", svg).forEach(point => {
    point.addEventListener("click", () => { app.chart.station = point.dataset.station; render(); });
    point.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); app.chart.station = point.dataset.station; render(); } });
    point.addEventListener("pointerenter", () => {
      const station = getStation(point.dataset.station);
      point.setAttribute("aria-label", `${station.name}, ${number(averageForSelection(station, app.chart.pollutant), 2)} ${unitFor(app.chart.pollutant)}`);
      point.setAttribute("title", `${station.name} · ${number(averageForSelection(station, app.chart.pollutant), 2)} ${unitFor(app.chart.pollutant)}`);
    });
  });
}

function sortedStations() {
  const key = app.chart.pollutant;
  return [...app.data.stations].map(station => ({ station, value: averageForSelection(station, key) })).filter(item => Number.isFinite(Number(item.value))).sort((a, b) => Number(b.value) - Number(a.value));
}

function renderStationTop(container, limit) {
  const items = sortedStations().slice(0, limit);
  const max = Math.max(...items.map(item => Number(item.value)), 1);
  container.innerHTML = items.map((item, index) => `<button type="button" class="station-row" data-station="${escapeHtml(item.station.id)}" aria-label="Focus ${escapeHtml(item.station.name)}"><span class="station-rank">${String(index + 1).padStart(2, "0")}</span><span class="station-name-wrap"><span class="station-name">${escapeHtml(item.station.name)}</span><span class="station-meter"><span style="width:${Math.max(3, Number(item.value) / max * 100)}%"></span></span></span><span class="station-value">${number(item.value, 1)} <small>${escapeHtml(unitFor(app.chart.pollutant))}</small></span></button>`).join("");
  $$(".station-row", container).forEach(button => button.addEventListener("click", () => { app.chart.station = button.dataset.station; render(); }));
}

function renderStations() {
  const station = selectedStation() || sortedStations()[0]?.station;
  const displayStation = station || app.data.stations[0];
  host.innerHTML = `<div class="page-enter">
    <section class="page-heading"><div><div class="eyebrow"><span class="eyebrow-mark"></span>FIELD COMPARISON</div><h1>Twenty-five sites, one city.</h1><p>Compare period means from each station’s hourly observations, then focus any chart or point to inspect its local series.</p></div><div class="heading-aside"><strong>${app.data.meta.station_count} sites</strong><br>${fullNumber(app.data.meta.rows)} shared hourly records</div></section>
    ${chartControls()}
    <div class="station-detail-banner"><span class="station-pin"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.15 7-12a7 7 0 1 0-14 0c0 5.85 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg></span><div><h2>${escapeHtml(displayStation.name)}</h2><p>Station ${escapeHtml(displayStation.id)} · ${Number(displayStation.latitude).toFixed(5)}° N, ${Number(displayStation.longitude).toFixed(5)}° E · ${fullNumber(displayStation.rows)} hourly rows</p></div></div>
    <div class="station-grid" style="margin-top:14px">
      <section class="panel"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">RANKED · OBSERVED AVERAGE</div><h2 class="panel-title">${escapeHtml(pollutantLabels[app.chart.pollutant])} at each site</h2><p class="panel-subtitle">${app.chart.year === "all" ? "Full 2023—25 period" : app.chart.year} · ${escapeHtml(unitFor(app.chart.pollutant))} · higher values shown first</p></div></div><div class="panel-body"><div class="ranking-list" id="station-ranking"></div><p class="chart-note">Select a row to focus the other panels. Ranking is descriptive, not a risk classification.</p></div></section>
      <div class="panel map-card"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">LATITUDE × LONGITUDE</div><h2 class="panel-title">Site coordinates</h2><p class="panel-subtitle">Point color encodes the selected pollutant’s mean.</p></div></div><div class="panel-body"><div id="station-map"></div><div class="map-key"><span>Lower mean</span><span><span class="map-key-gradient"></span></span><span>Higher mean</span></div></div></div>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">${escapeHtml(displayStation.name)} · MONTHLY MEAN</div><h2 class="panel-title">A local view of the series</h2><p class="panel-subtitle">Use the period selector above to change the displayed months.</p></div></div><div class="panel-body"><div class="chart-legend"><span class="legend-item"><i class="legend-line" style="--legend-color:${app.data.pollutants.find(p=>p.key===app.chart.pollutant).color}"></i>${escapeHtml(pollutantLabels[app.chart.pollutant])} · ${escapeHtml(unitFor(app.chart.pollutant))}</span></div><div class="chart-wrap" id="monthly-chart"></div><p class="chart-note">Each month is the arithmetic mean of that station’s matching hourly rows.</p></div></section>
  </div>`;
  bindChartControls();
  renderStationRanking($("#station-ranking"));
  renderMap($("#station-map"));
  renderMonthlyChart($("#monthly-chart"));
}

function renderStationRanking(container) {
  const items = sortedStations();
  const max = Math.max(...items.map(item => Number(item.value)), 1);
  container.innerHTML = items.map((item, index) => `<button class="rank-item" type="button" data-station="${escapeHtml(item.station.id)}" aria-label="Focus ${escapeHtml(item.station.name)}"><span class="rank-number">${String(index + 1).padStart(2, "0")}</span><span class="rank-main"><span class="rank-name">${escapeHtml(item.station.name)}</span><span class="rank-track"><span style="width:${Math.max(2, Number(item.value) / max * 100)}%;background:${stationColor(Number(item.value), Math.min(...items.map(i => i.value)), max)}"></span></span></span><span class="rank-reading">${number(item.value, 1)}<small>${escapeHtml(unitFor(app.chart.pollutant))}</small></span></button>`).join("");
  $$(".rank-item", container).forEach(button => button.addEventListener("click", () => { app.chart.station = button.dataset.station; render(); }));
}

function filtersQuery() {
  const filters = app.observations;
  const query = new URLSearchParams();
  for (const key of ["q", "year", "station", "from", "to", "pollutant", "min", "max", "page", "pageSize", "sort", "direction"]) {
    const value = filters[key];
    if (value !== "" && value != null) query.set(key === "pageSize" ? "page_size" : key, value);
  }
  return query;
}

function renderObservations() {
  const obs = app.observations;
  host.innerHTML = `<div class="page-enter">
    <section class="page-heading"><div><div class="eyebrow"><span class="eyebrow-mark"></span>ROW-LEVEL DATA</div><h1>Inside the hourly record.</h1><p>Search, filter, sort, and page through the source observations. A row opens the matched weather and GEOS-CF fields available in the local index.</p></div><div class="heading-aside"><strong>${fullNumber(app.data.meta.rows)} rows</strong><br>${app.data.meta.columns_count} source columns</div></section>
    <section class="filters-panel" aria-label="Observation filters"><div class="filters-top">
      <label class="filter-field search-field"><span class="field-label">Search stations</span><input id="obs-search" type="search" placeholder="Station name…" value="${escapeHtml(obs.q)}" autocomplete="off"></label>
      <label class="filter-field"><span class="field-label">Year</span><select id="obs-year"><option value="">All years</option>${Object.keys(app.data.meta.year_rows).sort().map(year => `<option value="${year}" ${obs.year === year ? "selected" : ""}>${year}</option>`).join("")}</select></label>
      <label class="filter-field"><span class="field-label">Station</span><select id="obs-station"><option value="">All stations</option>${stationOptions(obs.station, false)}</select></label>
      <label class="filter-field"><span class="field-label">From</span><input id="obs-from" type="date" value="${escapeHtml(obs.from)}" min="2023-01-01" max="2025-12-31"></label>
      <label class="filter-field"><span class="field-label">To</span><input id="obs-to" type="date" value="${escapeHtml(obs.to)}" min="2023-01-01" max="2025-12-31"></label>
      <span class="filter-separator"></span>
      <label class="filter-field"><span class="field-label">Pollutant range</span><select id="obs-pollutant">${pollutantOptions(obs.pollutant, "CPCB")}</select></label>
      <label class="filter-field range"><span class="field-label">Min</span><input id="obs-min" type="number" step="any" placeholder="—" value="${escapeHtml(obs.min)}"></label>
      <label class="filter-field range"><span class="field-label">Max</span><input id="obs-max" type="number" step="any" placeholder="—" value="${escapeHtml(obs.max)}"></label>
      <button class="button soft" id="apply-filters" type="button">Apply</button><button class="button" id="reset-filters" type="button">Reset</button>
    </div><div class="filter-meta"><span id="obs-result-count">${app.status.status === "ready" ? "Loading filtered rows…" : escapeHtml(app.status.message)}</span><span class="filter-pills" id="active-filter-pills"></span></div></section>
    <section class="table-panel" aria-label="Air quality observations"><div class="table-scroll"><table class="data-table"><thead><tr><th>Site / time</th><th data-sort="pm25">PM₂.₅<span class="sort-arrow"></span></th><th data-sort="pm10">PM₁₀<span class="sort-arrow"></span></th><th data-sort="no2">NO₂<span class="sort-arrow"></span></th><th data-sort="so2">SO₂<span class="sort-arrow"></span></th><th data-sort="co">CO<span class="sort-arrow"></span></th><th data-sort="o3">O₃<span class="sort-arrow"></span></th><th data-sort="Temperature_2m">Temp<span class="sort-arrow"></span></th><th>RH</th><th>Wind</th></tr></thead><tbody id="obs-table-body"></tbody></table></div><div class="table-footer"><span id="table-page-info">The table displays source measurements without changing their values.</span><div class="pagination"><button type="button" id="page-prev" aria-label="Previous page" disabled><svg viewBox="0 0 16 16"><path d="m10 3-5 5 5 5"/></svg></button><span class="page-indicator" id="page-indicator">— / —</span><button type="button" id="page-next" aria-label="Next page" disabled><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button></div><label class="filter-field" style="min-width:80px;display:flex;align-items:center;gap:6px"><span class="field-label">Rows</span><select id="obs-page-size" aria-label="Rows per page"><option value="20" ${obs.pageSize === 20 ? "selected" : ""}>20</option><option value="50" ${obs.pageSize === 50 ? "selected" : ""}>50</option><option value="100" ${obs.pageSize === 100 ? "selected" : ""}>100</option></select></label><button class="button" id="export-filtered" type="button"><svg viewBox="0 0 16 16"><path d="M8 2v8m-3-3 3 3 3-3M3 12v2h10v-2"/></svg>Export filtered CSV</button></div></section>
    <p class="chart-note">Observed pollutant units follow CPCB conventions: PM, NO₂, SO₂ and O₃ in µg/m³; CO in mg/m³. Weather and GEOS-CF fields are shown as stored in the supplied CSV.</p>
  </div>`;
  bindObservationControls();
  updateFilterPills();
  loadRows();
  refreshStatus();
}

function bindObservationControls() {
  const obs = app.observations;
  let searchTimer;
  $("#obs-search")?.addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { obs.q = event.target.value; obs.page = 1; updateFilterPills(); loadRows(); }, 220);
  });
  for (const [id, key] of [["obs-year", "year"], ["obs-station", "station"], ["obs-from", "from"], ["obs-to", "to"], ["obs-pollutant", "pollutant"], ["obs-min", "min"], ["obs-max", "max"]]) {
    $("#" + id)?.addEventListener("change", event => { obs[key] = event.target.value; });
  }
  $("#apply-filters")?.addEventListener("click", () => { obs.page = 1; updateFilterPills(); loadRows(); });
  $("#reset-filters")?.addEventListener("click", () => {
    Object.assign(obs, { q: "", year: "", station: "", from: "", to: "", pollutant: "pm25", min: "", max: "", page: 1, pageSize: 20, sort: "timestamp", direction: "desc" });
    renderObservations();
  });
  $("#page-prev")?.addEventListener("click", () => { if (obs.page > 1) { obs.page -= 1; loadRows(); } });
  $("#page-next")?.addEventListener("click", () => { if (app.rows && obs.page < app.rows.pages) { obs.page += 1; loadRows(); } });
  $("#obs-page-size")?.addEventListener("change", event => { obs.pageSize = Number(event.target.value); obs.page = 1; loadRows(); });
  $$("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (obs.sort === key) obs.direction = obs.direction === "asc" ? "desc" : "asc";
    else { obs.sort = key; obs.direction = "desc"; }
    loadRows();
  }));
  $("#export-filtered")?.addEventListener("click", () => {
    if (app.status.status !== "ready") { showToast("Full-row export is available after the source index is ready."); return; }
    const query = filtersQuery();
    query.delete("page"); query.delete("page_size"); query.delete("sort"); query.delete("direction");
    window.location.href = `/api/export?${query.toString()}`;
    showToast("Preparing your filtered CSV export.");
  });
}

function updateFilterPills() {
  const pillRoot = $("#active-filter-pills");
  if (!pillRoot) return;
  const obs = app.observations;
  const parts = [];
  if (obs.q) parts.push(`Station: ${obs.q}`);
  if (obs.year) parts.push(obs.year);
  if (obs.station) parts.push(getStation(obs.station)?.name || obs.station);
  if (obs.from) parts.push(`From ${obs.from}`);
  if (obs.to) parts.push(`To ${obs.to}`);
  if (obs.min !== "" || obs.max !== "") parts.push(`${pollutantLabels[obs.pollutant]} ${obs.min || "−∞"} to ${obs.max || "+∞"} ${unitFor(obs.pollutant)}`);
  pillRoot.innerHTML = parts.map(part => `<span class="filter-pill">${escapeHtml(part)}</span>`).join("");
}

function renderTableLoading() {
  const body = $("#obs-table-body");
  if (!body) return;
  body.innerHTML = Array.from({ length: 7 }, () => `<tr><td colspan="10"><div class="loading-skeleton" style="width:${50 + Math.random() * 35}%"></div></td></tr>`).join("");
}

async function loadRows() {
  if (app.route !== "observations") return;
  const body = $("#obs-table-body");
  if (!body) return;
  if (app.status.status !== "ready") {
    const message = app.status.status === "indexing" ? `${app.status.message} ${Math.round(app.status.progress * 100)}%` : ["error", "unavailable"].includes(app.status.status) ? app.status.message : "Waiting for the local observation index.";
    const detail = ["error", "unavailable"].includes(app.status.status) ? "Check the source status control above for setup details." : "Aggregate charts remain available while the row index is prepared.";
    body.innerHTML = `<tr><td colspan="10"><div class="table-empty">${escapeHtml(message)}<small>${escapeHtml(detail)}</small></div></td></tr>`;
    $("#obs-result-count").textContent = app.status.message;
    if (["indexing", "not-started", "checking"].includes(app.status.status)) {
      setTimeout(() => { if (app.route === "observations") refreshStatus(); }, 1200);
    }
    return;
  }
  const request = ++app.observations.request;
  renderTableLoading();
  const query = filtersQuery();
  query.set("sort", app.observations.sort);
  query.set("direction", app.observations.direction);
  try {
    const response = await fetch(`/api/observations?${query.toString()}`);
    if (!response.ok) throw new Error(`The observation service returned ${response.status}.`);
    const result = await response.json();
    if (request !== app.observations.request || app.route !== "observations") return;
    app.rows = result;
    renderObservationRows(result);
  } catch (error) {
    if (request !== app.observations.request) return;
    body.innerHTML = `<tr><td colspan="10"><div class="table-empty">Could not load these rows.<small>${escapeHtml(error.message)} Check the local server status and try again.</small></div></td></tr>`;
    $("#obs-result-count").textContent = "No rows loaded";
  }
}

function renderObservationRows(result) {
  const body = $("#obs-table-body");
  if (!body) return;
  $("#obs-result-count").innerHTML = `<strong>${fullNumber(result.total)}</strong> source rows match these filters`;
  $("#page-indicator").textContent = `${result.page} / ${result.pages}`;
  $("#page-prev").disabled = result.page <= 1;
  $("#page-next").disabled = result.page >= result.pages || result.total === 0;
  const first = result.total ? (result.page - 1) * result.page_size + 1 : 0;
  const last = Math.min(result.total, result.page * result.page_size);
  $("#table-page-info").textContent = result.total ? `Showing ${fullNumber(first)}–${fullNumber(last)} of ${fullNumber(result.total)} matched rows · select a row for details` : "No rows match this filter set.";
  $$("th[data-sort]").forEach(th => { const arrow = $(".sort-arrow", th); if (arrow) arrow.textContent = app.observations.sort === th.dataset.sort ? (app.observations.direction === "asc" ? "↑" : "↓") : "↕"; });
  if (!result.items.length) {
    body.innerHTML = '<tr><td colspan="10"><div class="table-empty">No observations match these filters.<small>Adjust the date, station, search, or concentration range and apply again.</small></div></td></tr>';
    return;
  }
  body.innerHTML = result.items.map(row => `<tr data-row-id="${row.id}" tabindex="0" aria-label="Open ${escapeHtml(row.station_name)} ${escapeHtml(displayTimestamp(row.timestamp))}"><td class="station-cell"><strong>${escapeHtml(row.station_name)}</strong><br><span class="timestamp-cell">${escapeHtml(displayTimestamp(row.timestamp))}</span></td><td class="numeric">${number(row.pm25, 1)}</td><td class="numeric">${number(row.pm10, 1)}</td><td class="numeric">${number(row.no2, 1)}</td><td class="numeric">${number(row.so2, 1)}</td><td class="numeric">${number(row.co, 2)}</td><td class="numeric">${number(row.o3, 1)}</td><td class="numeric">${number(row.Temperature_2m, 1)}</td><td class="numeric">${number(row.Humidity_RH, 0)}</td><td class="numeric">${number(row.Wind_Speed, 1)}</td></tr>`).join("");
  $$("tr[data-row-id]", body).forEach(row => {
    const open = () => openObservation(row.dataset.rowId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) return;
    const previous = app.status.status;
    app.status = await response.json();
    renderStatus();
    if (app.route === "observations" && app.status.status === "ready" && previous !== "ready") loadRows();
  } catch {
    app.status = { status: "unavailable", rows: 0, progress: 0, message: "The local dataset status endpoint is unavailable." };
    renderStatus();
  }
}

async function openObservation(id) {
  const modalRoot = $("#modal-root");
  const opener = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="modal-head"><div><div class="panel-kicker">SOURCE ROW · #${escapeHtml(id)}</div><h2 id="detail-title">Loading row detail</h2><p>Reading matched source values…</p></div><button class="modal-close" type="button" aria-label="Close details">×</button></div><div class="modal-body"><div class="loading-skeleton"></div></div></section></div>`;
  const dialog = $(".detail-modal", modalRoot);
  dialog.tabIndex = -1;
  const close = () => { modalRoot.innerHTML = ""; document.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); };
  const onKey = event => {
    if (event.key === "Escape") { close(); return; }
    if (event.key === "Tab") {
      const focusables = $$('button:not([disabled]), a[href], input, select, [tabindex="0"]', dialog);
      if (!focusables.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusables[0], last = focusables.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  $(".modal-close", modalRoot).addEventListener("click", close);
  $(".modal-backdrop", modalRoot).addEventListener("click", event => { if (event.target.classList.contains("modal-backdrop")) close(); });
  document.addEventListener("keydown", onKey);
  dialog.focus();
  try {
    const response = await fetch(`/api/observation/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Could not load row ${id}.`);
    const row = await response.json();
    if (!$(".detail-modal", modalRoot)) return;
    $("#detail-title", modalRoot).textContent = row.station_name;
    $(".modal-head p", modalRoot).textContent = `${displayTimestamp(row.timestamp)} · Site ${row.station_id} · ${Number(row.latitude).toFixed(5)}° N, ${Number(row.longitude).toFixed(5)}° E`;
    $(".modal-body", modalRoot).innerHTML = `<div class="detail-section-title">CPCB observation fields</div><div class="detail-grid">${[
      ["PM₂.₅", row.pm25, "µg/m³", 2], ["PM₁₀", row.pm10, "µg/m³", 2], ["NO₂", row.no2, "µg/m³", 2], ["SO₂", row.so2, "µg/m³", 2], ["CO", row.co, "mg/m³", 3], ["O₃", row.o3, "µg/m³", 2],
    ].map(([label, value, unit, digits]) => detailValue(label, value, unit, digits)).join("")}</div><div class="detail-section-title">Matched weather · CSV source values</div><div class="detail-grid">${[
      ["Temperature_2m", row.Temperature_2m, "source field", 2], ["Dewpoint_2m", row.Dewpoint_2m, "source field", 2], ["Humidity_RH", row.Humidity_RH, "source field", 2], ["Surface_Pressure", row.Surface_Pressure, "source field", 2], ["Precipitation", row.Precipitation, "source field", 3], ["Wind_Direction", row.Wind_Direction, "source field", 1], ["Wind_Speed", row.Wind_Speed, "source field", 2], ["PM25_GEOSCF", row.PM25_GEOSCF, "source field", 3],
    ].map(([label, value, unit, digits]) => detailValue(label, value, unit, digits)).join("")}</div><div class="detail-section-title">Source coverage & coastal flags</div><div class="detail-grid">${detailValue("is_sea_breeze", row.is_sea_breeze, "0 / 1 flag", 0)}${detailValue("is_land_breeze", row.is_land_breeze, "0 / 1 flag", 0)}${detailValue("has_era5", row.has_era5, "source flag", 0)}${detailValue("has_geoscf", row.has_geoscf, "source flag", 0)}</div><p class="detail-source-note">Weather and GEOS-CF units are not declared in the supplied CSV header; values are shown without conversion. Source observations and matched features are presented as stored.</p>`;
  } catch (error) {
    $(".detail-modal", modalRoot).innerHTML = `<div class="modal-head"><div><div class="panel-kicker">SOURCE ROW</div><h2 id="detail-title">Detail unavailable</h2><p>${escapeHtml(error.message)}</p></div><button class="modal-close" type="button" aria-label="Close details">×</button></div>`;
    $(".modal-close", modalRoot).addEventListener("click", close);
  }
}

function detailValue(label, value, unit, digits = 2) {
  return `<div class="detail-value"><span>${escapeHtml(label)}</span><strong>${escapeHtml(number(value, digits))}</strong><small>${escapeHtml(unit)}</small></div>`;
}

function fieldGroup(column) {
  if (["station_id", "station_key", "station_name", "latitude", "longitude", "cpcb_source_count", "cpcb_was_aggregated"].includes(column)) return "Site & provenance";
  if (["timestamp", "year", "month", "day", "hour", "dayofweek"].includes(column)) return "Time alignment";
  if (["pm25", "pm10", "no2", "so2", "co", "o3"].includes(column)) return "CPCB observations";
  if (column.endsWith("_GEOSCF")) return "GEOS-CF fields";
  if (["has_era5", "has_geoscf", "era5_valid"].includes(column)) return "Source coverage";
  if (["Temperature_2m", "Dewpoint_2m", "Humidity_RH", "Surface_Pressure", "Precipitation", "Wind_Direction", "Wind_Speed", "U_wind", "V_wind"].includes(column)) return "ERA5 weather fields";
  if (["is_sea_breeze", "is_land_breeze", "sea_breeze_strength", "land_breeze_strength"].includes(column)) return "Coastal features";
  if (["high_humidity", "very_high_humidity", "rain_flag", "heavy_rain_flag", "log_precipitation", "stagnation_flag", "ventilation_proxy", "temp_dewpoint_spread", "humidity_x_wind_inverse", "pressure_x_low_wind", "sea_salt_x_sea_breeze", "sulfate_x_high_humidity"].includes(column)) return "Engineered features";
  return "Other source field";
}

function groupHint(group) {
  return ({
    "Site & provenance": "Location and source aggregation identifiers",
    "Time alignment": "Hourly observation and calendar fields",
    "CPCB observations": "Observed pollutant concentration · CPCB convention units",
    "GEOS-CF fields": "Chemical-species and PM component fields; units are not declared in this CSV",
    "Source coverage": "Availability / validity flags carried by the merged table",
    "ERA5 weather fields": "Matched meteorological fields; values shown as stored",
    "Coastal features": "Sea-breeze and land-breeze indicators / strengths",
    "Engineered features": "Derived indicators and interactions already present in the CSV",
    "Other source field": "Field name preserved from the supplied CSV header",
  })[group];
}

function renderMethodology() {
  const groups = new Map();
  for (const column of app.data.meta.columns) {
    const group = fieldGroup(column);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(column);
  }
  const cards = [...groups.entries()].map(([group, columns]) => `<div class="dictionary-row"><div><div class="dictionary-label">${escapeHtml(group)}</div><div class="dictionary-hint">${escapeHtml(groupHint(group))}</div></div><div class="dictionary-group">${columns.map(column => `<span class="field-chip" title="Original CSV field">${escapeHtml(column)}</span>`).join("")}</div></div>`).join("");
  host.innerHTML = `<div class="page-enter">
    <section class="page-heading"><div><div class="eyebrow"><span class="eyebrow-mark"></span>HOW TO READ THIS WORKSPACE</div><h1>Evidence first. Models next.</h1><p>The report proposes a multisource DL–LLM pipeline and progressive fusion experiments. The supplied project files verify a model-ready merged dataset, but do not include trained-model predictions or evaluation results.</p></div><div class="heading-aside"><strong>59 source fields</strong><br>header names preserved</div></section>
    <div class="method-flow">
      <article class="flow-step"><span class="step-index">01 / INPUT</span><h3>Ground observations</h3><p>Hourly CPCB pollutant observations are joined to 25 station locations across Mumbai for 2023–2025.</p><span class="step-fields">PM₂.₅ · PM₁₀ · NO₂ · SO₂ · CO · O₃</span></article>
      <article class="flow-step"><span class="step-index">02 / CONTEXT</span><h3>Weather + chemistry</h3><p>The CSV carries ERA5 meteorology and 12 GEOS-CF pollutant/component fields alongside each station-hour record.</p><span class="step-fields">ERA5 · GEOS-CF · COASTAL FEATURES</span></article>
      <article class="flow-step"><span class="step-index">03 / MAP</span><h3>A layered city view</h3><p>Interactive Esri World Imagery tiles provide the geographic reference. A separate optional IDW surface estimates the selected monthly field around monitors.</p><span class="step-fields">LIVE SATELLITE MOSAIC · STATION-DERIVED SURFACE</span></article>
      <article class="flow-step"><span class="step-index">04 / THIS APP</span><h3>Traceable summaries</h3><p>Monthly and hourly arithmetic means, station comparisons, and paginated source-row inspection remain linked to the supplied rows.</p><span class="step-fields">NO TRAINED FORECAST · NO AQI CONVERSION</span></article>
    </div>
    <section class="method-note"><div class="note-icon" aria-hidden="true">i</div><div><h3>What is verified, and what is still proposed</h3><p>The input contains ${fullNumber(app.data.meta.rows)} rows, ${app.data.meta.columns_count} columns, and ${app.data.meta.station_count} stations. Every row has the ERA5 and GEOS-CF presence flags set; the CSV profile found ${fullNumber(app.data.meta.blank_cells)} blank cells, ${fullNumber(app.data.meta.invalid_timestamps)} invalid timestamps, and ${fullNumber(app.data.meta.duplicate_station_timestamps)} duplicate station-hour keys. The satellite atlas uses Esri World Imagery tiles as a live geographic reference; imagery capture dates vary by location. Its optional IDW field is a visualization from the selected month's station means, limited by a user-set influence radius. Neither layer represents satellite-measured pollutant concentrations. The report describes DL forecasting, risk classification, LLM interpretation, and progressive data-fusion evaluation as the intended framework. No fitted GeoOracle model, forecast horizon, prediction file, AQI method, risk threshold, or model metric was supplied, so this app does not imply those results exist.</p></div></section>
    <section class="panel dictionary"><div class="panel-head"><div class="panel-heading"><div class="panel-kicker">DATA DICTIONARY · ORIGINAL HEADER</div><h2 class="panel-title">What’s in the source table</h2><p class="panel-subtitle">Field groups are descriptive; source field names remain unchanged.</p></div><span class="dictionary-count">${app.data.meta.columns_count} fields</span></div>${cards}<div class="panel-body"><p class="chart-note">Pollutant labels follow <a class="source-link" href="https://cpcb.nic.in/displaypdf.php?id=bWFudWFsLW1vbml0b3JpbmcvQVFJX05BTVBfUmVwX1NlcHRlbWJlcjIwMTYucGRm" target="_blank" rel="noopener noreferrer">CPCB concentration conventions</a> (PM₂.₅, PM₁₀, NO₂, SO₂, O₃ in µg/m³; CO in mg/m³). The CSV does not declare units for ERA5-derived or GEOS-CF fields, so this interface does not infer or convert them.</p></div></section>
  </div>`;
}

async function initialize() {
  try {
    const response = await fetch("/api/summary", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the verified chart snapshot.");
    app.data = await response.json();
    app.map.month = app.data.monthly.at(-1)?.month || "2025-12";
    renderStatus();
    render();
    refreshStatus();
  } catch (error) {
    host.innerHTML = `<div class="page-enter"><section class="method-note"><div class="note-icon">!</div><div><h3>GeoOracle could not start</h3><p>${escapeHtml(error.message)} Confirm the local server is running from the application directory and reload.</p></div></section></div>`;
  }
}

window.addEventListener("hashchange", render);
$("#system-status").addEventListener("click", () => { app.statusPopover = !app.statusPopover; renderStatusPopover(); });
$("#sidebar-collapse").addEventListener("click", () => {
  const sidebar = $("#sidebar");
  app.sidebarCollapsed = !sidebar.classList.contains("is-collapsed");
  sidebar.classList.toggle("is-collapsed", app.sidebarCollapsed);
  sidebar.classList.toggle("is-expanded", !app.sidebarCollapsed && innerWidth <= 1200);
});
$("#mobile-menu").addEventListener("click", () => {
  app.sidebarOpen = !app.sidebarOpen;
  $("#sidebar").classList.toggle("mobile-open", app.sidebarOpen);
});
document.addEventListener("click", event => {
  if (app.statusPopover && !event.target.closest("#system-status") && !event.target.closest(".status-popover")) {
    app.statusPopover = false;
    $(".status-popover")?.remove();
  }
});
window.addEventListener("resize", () => {
  if (!app.data) return;
  if (app.route === "overview") { renderMonthlyChart($("#monthly-chart")); renderHourlyChart($("#hourly-chart")); renderMap($("#station-map")); }
  if (app.route === "stations") { renderMonthlyChart($("#monthly-chart")); renderMap($("#station-map")); }
  if (app.route === "satellite") renderSatelliteMap();
});
initialize();
