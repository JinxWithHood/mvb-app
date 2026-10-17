/* ============================================================
   Magdeburg Mobil — Live-Netzkarte v2
   - physical tram track network (OSM, incl. Wendeschleifen) as grey base
   - current line routes from the live timetable (HAFAS trip polylines)
   - live vehicles (HAFAS radar) that glide along their real path
   - line focus  (progress of every vehicle + line changes)
   - trip focus  (remaining route highlighted, line changes, stop list)
   Usage: LiveMap.init({ apiBase, onOpenJourney }); LiveMap.show(); LiveMap.hide(); LiveMap.setTheme(t)
   ============================================================ */
(function () {
    'use strict';

    const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    const CENTER = [52.1290, 11.6290];
    const POLL_MS = 15000;
    const SHAPES_FAST_MS = 20000;
    const SHAPES_SLOW_MS = 300000;
    const TRIP_TTL_MS = 60000;
    const BLEND_MS = 900;
    const M_LAT = 110540;
    const M_LON = 111320 * Math.cos(52.13 * Math.PI / 180);

    const LiveMap = {};
    let opts = {};
    let L = null;
    let map = null;
    let tileLayer = null;
    let labelLayer = null;
    let theme = 'light';
    let leafletPromise = null;
    let networkLoaded = false;
    let networkData = null;
    let pollTimer = null;
    let shapesTimer = null;
    let rafId = null;
    let visible = false;
    let lastFrame = 0;
    let lastFocusTick = 0;
    let shapesBuilding = false;
    let lastRadarText = '';

    const trackLayers = [];        // {layer, role}
    const lineShapes = new Map();  // key -> {meta, layers:[{layer, role}], sig}
    let stationLayer = null;
    const vehicles = new Map();    // id -> state
    const tripCache = new Map();   // id -> {ts, trip, prep}
    const tripLoading = new Map(); // id -> promise
    const filters = { tram: true, bus: true, train: false };
    let focus = null;              // {kind:'line'|'trip', ...}
    let delayMode = false;         // colour vehicles by punctuality
    try { delayMode = localStorage.getItem('map_delay_mode') === '1'; } catch (e) { /* ignore */ }
    let legendSig = '';

    // ---------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        if (leafletPromise) return leafletPromise;
        leafletPromise = new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = LEAFLET_CSS;
            document.head.appendChild(css);
            const s = document.createElement('script');
            s.src = LEAFLET_JS;
            s.onload = () => resolve(window.L);
            s.onerror = () => { leafletPromise = null; reject(new Error('Leaflet konnte nicht geladen werden')); };
            document.head.appendChild(s);
        });
        return leafletPromise;
    }

    // Esri Canvas basemaps: free, no API key, calm grey style that makes the line colours pop
    function tileUrl(kind) {
        const style = theme === 'light' ? 'Light' : 'Dark';
        const layer = kind === 'labels' ? 'Reference' : 'Base';
        return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
    }

    function palette() {
        if (theme === 'jinx') return { casing: '#0e0818', rail: '#4a3d63', stop: '#1f2937', asphalt: '#2a2140', mark: '#ff9bd0' };
        if (theme === 'dark') return { casing: '#1a2023', rail: '#56616b', stop: '#0f1416', asphalt: '#3a4249', mark: '#e8edf0' };
        return { casing: '#ffffff', rail: '#4b5260', stop: '#1f2937', asphalt: '#5d666e', mark: '#ffffff' };
    }

    function luminance(hex) {
        const h = (hex || '').replace('#', '');
        if (h.length !== 6) return 0;
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }
    const darkText = (c) => luminance(c) > 180 ? ' dark-text' : '';

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    }

    // Punctuality colours: late = yellow/red, early = turquoise → blue → dark blue → violet → pink
    const DELAY_SCALE = [
        { min: 6, c: '#dc2626', label: '> +5' },
        { min: 3, c: '#eab308', label: '+3 bis +5', dark: true },
        { min: 0, c: '#16a34a', label: 'pünktlich' },
        { min: -1, c: '#06b6d4', label: '−1', dark: true },
        { min: -2, c: '#2563eb', label: '−2' },
        { min: -3, c: '#1e3a8a', label: '−3' },
        { min: -4, c: '#7c3aed', label: '−4' },
        { min: -Infinity, c: '#ec4899', label: '−5 und früher' },
    ];
    function delayStyle(d) {
        if (d == null || isNaN(d)) return null;
        const step = DELAY_SCALE.find(x => d >= x.min);
        const txt = d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '±0';
        return { c: step.c, dark: !!step.dark, txt };
    }
    // only "interesting" deviations get a badge outside of the punctuality mode
    const delayNotable = (d) => d != null && (d >= 3 || d <= -1);

    function vehicleGroup(type) {
        if (type === 'tram') return 'tram';
        if (type === 'bus' || type === 'sev') return 'bus';
        return 'train';
    }

    function lineKeyOf(v) {
        const g = vehicleGroup(v.type);
        if (g === 'train') return null;
        return `${g}:${v.short || v.line}`;
    }

    const keyNum = (k) => parseInt(String(k).replace(/^\w+:/, '').replace(/\D/g, ''), 10) || 999;
    const keyShort = (k) => String(k).replace(/^\w+:/, '');

    function setStatus(text, loading) {
        const el = $('mapUpdated');
        if (el) el.textContent = text;
        const ld = $('mapLoading');
        if (ld) ld.hidden = !loading;
    }

    function refreshStatus() {
        if (!lastRadarText) return;
        setStatus(lastRadarText + (shapesBuilding ? ' · Linienwege werden ergänzt…' : ''), false);
    }

    function zoomScale() {
        const z = map ? map.getZoom() : 13;
        return z >= 17 ? 2 : z >= 16 ? 1.6 : z >= 15 ? 1.3 : z >= 14 ? 1.0 : z >= 13 ? 0.8 : 0.6;
    }

    // ---------------------------------------------------------
    // Geometry
    // ---------------------------------------------------------
    function prepShape(pts) {
        const xy = pts.map(p => [p[1] * M_LON, p[0] * M_LAT]);
        const cum = [0];
        for (let i = 1; i < xy.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
        }
        return { pts, xy, cum, total: cum[cum.length - 1] || 0 };
    }

    // nearest point on the shape within the index window [lo, hi]
    function project(sh, pos, lo, hi) {
        const n = sh.pts.length;
        if (n < 2) return null;
        lo = Math.max(0, lo || 0);
        hi = Math.min(n - 2, hi == null ? n - 2 : hi);
        const px = pos[1] * M_LON, py = pos[0] * M_LAT;
        let best = null;
        for (let i = lo; i <= hi; i++) {
            const a = sh.xy[i], b = sh.xy[i + 1];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy;
            let f = len2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
            f = Math.max(0, Math.min(1, f));
            const d = Math.hypot(a[0] + dx * f - px, a[1] + dy * f - py);
            if (!best || d < best.d - 0.5) best = { i, f, d };
        }
        if (!best) return null;
        const a = sh.pts[best.i], b = sh.pts[best.i + 1];
        best.pt = [a[0] + (b[0] - a[0]) * best.f, a[1] + (b[1] - a[1]) * best.f];
        best.along = sh.cum[best.i] + (sh.cum[best.i + 1] - sh.cum[best.i]) * best.f;
        return best;
    }

    function pointAtAlong(sh, s) {
        const { cum, pts } = sh;
        if (s <= 0) return { i: 0, pt: pts[0] };
        if (s >= sh.total) return { i: pts.length - 2, pt: pts[pts.length - 1] };
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
        const f = (s - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
        const a = pts[lo], b = pts[lo + 1];
        return { i: lo, pt: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] };
    }

    function ptsBetween(sh, s0, s1) {
        if (s1 <= s0) return [];
        const a = pointAtAlong(sh, s0), b = pointAtAlong(sh, s1);
        const out = [a.pt];
        for (let i = a.i + 1; i <= b.i; i++) out.push(sh.pts[i]);
        out.push(b.pt);
        return out;
    }

    // ---------------------------------------------------------
    // Map setup
    // ---------------------------------------------------------
    function createMap() {
        map = L.map('liveMap', {
            center: CENTER,
            zoom: 13,
            minZoom: 11,
            maxZoom: 18,
            zoomControl: false,
            attributionControl: true,
        });
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        map.attributionControl.setPrefix(false);
        tileLayer = L.tileLayer(tileUrl('base'), {
            maxZoom: 19,
            maxNativeZoom: 16,
            attribution: 'Karte © Esri, HERE, Garmin, © OpenStreetMap-Mitwirkende · Gleise © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Linienwege & Live-Daten: INSA/HAFAS',
        }).addTo(map);

        const pane = (name, z, pointer) => {
            map.createPane(name);
            map.getPane(name).style.zIndex = z;
            if (!pointer) map.getPane(name).style.pointerEvents = 'none';
        };
        pane('tracks', 404);
        pane('buslines', 408, true);
        pane('tramlines', 412, true);
        pane('focusLow', 414);
        pane('focusHigh', 416);
        pane('stations', 420, true);
        pane('labels', 430);
        pane('focusMarks', 640, true);

        labelLayer = L.tileLayer(tileUrl('labels'), { maxZoom: 19, maxNativeZoom: 16, pane: 'labels', opacity: 0.85 }).addTo(map);
        const updateLabels = () => {
            if (!labelLayer) return;
            const show = map.getZoom() <= 13;
            if (show && !map.hasLayer(labelLayer)) labelLayer.addTo(map);
            if (!show && map.hasLayer(labelLayer)) map.removeLayer(labelLayer);
        };
        map.on('zoomend', () => {
            applyAllStyles();
            updateStationVisibility();
            updateLabels();
        });
        map.on('click', () => { if (focus) clearFocus(); });
        document.querySelector('.map-shell')?.setAttribute('data-theme', theme);
        createFocusCard();
    }

    // ---------------------------------------------------------
    // Physical track network + stations (OpenStreetMap)
    // ---------------------------------------------------------
    async function loadNetwork() {
        if (networkLoaded) return;
        setStatus('Gleisnetz wird geladen…', true);
        try {
            const res = await fetch(`${opts.apiBase}/network`);
            const data = await res.json();
            if (!data.lines && !data.tracks) throw new Error(data.error || 'keine Daten');
            networkData = data;
            drawTracks(data);
            drawStations(data);
            networkLoaded = true;
        } catch (e) {
            console.warn('Netz konnte nicht geladen werden:', e);
            setStatus('Gleisnetz nicht verfügbar – Fahrzeuge werden trotzdem angezeigt', false);
        }
    }

    function drawTracks(data) {
        let segs = data.tracks || [];
        if (!segs.length) segs = (data.lines || []).flatMap(l => l.segs || []);
        if (!segs.length) return;
        ['rail'].forEach(role => {
            const layer = L.polyline(segs, { pane: 'tracks', interactive: false, lineCap: 'round', lineJoin: 'round', smoothFactor: 1.2 });
            layer.addTo(map);
            trackLayers.push({ layer, role });
        });
        applyTrackStyles();
    }

    function applyTrackStyles() {
        if (!map) return;
        const z = map.getZoom();
        const s = zoomScale();
        const p = palette();
        const fade = focus ? 0.55 : 1;
        // plain dark-grey track network (incl. Wendeschleifen and depot tracks)
        trackLayers.forEach(({ layer }) => {
            layer.setStyle({ color: p.rail, weight: (z >= 15 ? 3.4 : 2.4) * s, opacity: 0.9 * fade });
        });
    }

    function drawStations(data) {
        stationLayer = L.layerGroup();
        const colorOf = (ref) => {
            const sh = lineShapes.get(`tram:${ref}`);
            if (sh) return sh.meta.color;
            const ln = (data.lines || []).find(x => x.ref === ref);
            return ln ? ln.color : '#888';
        };
        (data.stations || []).forEach(st => {
            const m = L.circleMarker([st.lat, st.lon], {
                pane: 'stations', radius: 4, weight: 2, color: palette().stop, fillColor: '#ffffff', fillOpacity: 1,
            });
            m.bindTooltip(() => {
                const badges = (st.lines || []).map(r => {
                    const c = colorOf(r);
                    return `<span class="map-line-badge${darkText(c)}" style="background:${c}">${escapeHtml(r)}</span>`;
                }).join('');
                return `<div class="map-tip"><strong>${escapeHtml(st.name)}</strong><div class="map-tip-lines">${badges}</div></div>`;
            }, { direction: 'top', offset: [0, -6], className: 'map-tooltip', opacity: 1 });
            m.addTo(stationLayer);
        });
        updateStationVisibility();
    }

    function updateStationVisibility() {
        if (!map || !stationLayer) return;
        const show = map.getZoom() >= 14 || (map.getZoom() >= 13 && !focus);
        if (show && !map.hasLayer(stationLayer)) stationLayer.addTo(map);
        if (!show && map.hasLayer(stationLayer)) map.removeLayer(stationLayer);
    }

    // ---------------------------------------------------------
    // Current line routes (live timetable polylines)
    // ---------------------------------------------------------
    async function loadLineShapes() {
        if (shapesTimer) clearTimeout(shapesTimer);
        let next = SHAPES_SLOW_MS;
        try {
            const res = await fetch(`${opts.apiBase}/line-shapes`);
            const data = await res.json();
            if (Array.isArray(data.lines)) drawLineShapes(data.lines);
            shapesBuilding = !!(data.building || data.pending);
            if (shapesBuilding) next = SHAPES_FAST_MS;
        } catch (e) {
            console.warn('Linienwege nicht verfügbar:', e);
            next = SHAPES_FAST_MS * 2;
        }
        refreshStatus();
        if (visible) shapesTimer = setTimeout(loadLineShapes, next);
    }

    function drawLineShapes(lines) {
        const seen = new Set();
        lines.forEach(line => {
            if (!line.key || !line.shapes || !line.shapes.length) return;
            seen.add(line.key);
            const sig = line.color + '|' + line.shapes.map(s => s.length + ':' + (s[0] || []).join(',')).join(';');
            const existing = lineShapes.get(line.key);
            if (existing && existing.sig === sig) { existing.meta = line; return; }
            if (existing) existing.layers.forEach(({ layer }) => map.removeLayer(layer));
            const isBus = line.type === 'bus';
            // trams are drawn as a track (sleepers + two rails), buses as a road (kerbs, asphalt, centre line)
            const roles = isBus ? ['edge', 'asphalt', 'center'] : ['casing', 'sleepers', 'rails', 'gap'];
            const layers = roles.map(role => {
                const layer = L.polyline(line.shapes, {
                    pane: isBus ? 'buslines' : 'tramlines',
                    interactive: role === 'casing' || role === 'rails' || role === 'edge',
                    bubblingMouseEvents: false,
                    lineCap: role === 'sleepers' || role === 'center' ? 'butt' : 'round',
                    lineJoin: 'round',
                });
                layer.on('click', () => setLineFocus(line.key));
                layer.on('mouseover', () => { if (!focus) layer.getElement()?.classList.add('ml-hover'); });
                layer.on('mouseout', () => layer.getElement()?.classList.remove('ml-hover'));
                layer.bindTooltip(`Linie ${escapeHtml(line.short)}`, { sticky: true, className: 'map-tooltip ml-tip', direction: 'top', offset: [0, -8] });
                layer.addTo(map);
                return { layer, role };
            });
            lineShapes.set(line.key, { meta: line, layers, sig, isBus });
        });
        // draw low numbers on top (classic trunk lines)
        [...lineShapes.entries()]
            .sort((a, b) => keyNum(b[0]) - keyNum(a[0]))
            .forEach(([, e]) => e.layers.forEach(({ layer }) => layer.bringToFront()));
        applyLineStyles();
        rebuildLegend();
        if (focus && focus.kind === 'line') renderFocusCard();
    }

    function lineVisible(entry) {
        return entry.isBus ? filters.bus : filters.tram;
    }

    function applyLineStyles() {
        if (!map) return;
        const z = map.getZoom();
        const s = zoomScale();
        const p = palette();
        lineShapes.forEach((e, key) => {
            const c = e.meta.color || '#888';
            const show = lineVisible(e);
            let k = 1;
            if (focus && focus.kind === 'line') k = focus.key === key ? 1 : 0.1;
            if (focus && focus.kind === 'trip') k = 0.12;
            if (!show) k = 0;
            const strong = focus && focus.kind === 'line' && focus.key === key;
            const detail = z >= 14;          // close enough to see rails / road markings
            const f = strong ? 1.35 : 1;
            e.layers.forEach(({ layer, role }) => {
                if (e.isBus) {
                    // road: coloured kerbs, grey asphalt, dashed white centre line
                    const busOp = z <= 12 ? 0.45 : 0.8;
                    if (role === 'edge') layer.setStyle({ color: c, weight: (detail ? 7 : 2.2) * s * f, opacity: (strong ? 1 : busOp) * k });
                    else if (role === 'asphalt') layer.setStyle({ color: p.asphalt, weight: detail ? 4.6 * s * f : 0, opacity: detail ? 0.95 * k : 0 });
                    else if (role === 'center') layer.setStyle({ color: p.mark, weight: detail ? 0.9 * s * f : 0, opacity: detail ? 0.9 * k : 0, dashArray: `${3.5 * s} ${4 * s}` });
                } else {
                    // track: sleepers across, two rails in the line colour
                    if (role === 'casing') layer.setStyle({ color: p.casing, weight: (detail ? 13 : 8) * s * f, opacity: (focus ? (strong ? 1 : 0) : 0.9) * k });
                    else if (role === 'sleepers') layer.setStyle({ color: c, weight: detail ? 11.5 * s * f : 0, opacity: detail ? 0.45 * k : 0, dashArray: `${1.7 * s} ${4.2 * s}` });
                    else if (role === 'rails') layer.setStyle({ color: c, weight: (detail ? 6.4 : 5) * s * f, opacity: 0.95 * k });
                    else if (role === 'gap') layer.setStyle({ color: p.casing, weight: detail ? 3 * s * f : 0, opacity: detail ? k : 0 });
                }
            });
            if (strong) e.layers.forEach(({ layer }) => layer.bringToFront());
        });
    }

    function applyAllStyles() {
        applyTrackStyles();
        applyLineStyles();
        if (focus) updateFocusGeometry(true);
    }

    // ---------------------------------------------------------
    // Legend (line chips: trams, then buses)
    // ---------------------------------------------------------
    function rebuildLegend() {
        const legend = $('mapLegend');
        if (!legend) return;
        const keys = new Set(lineShapes.keys());
        vehicles.forEach(st => { if (st.key) keys.add(st.key); });
        const list = [...keys].filter(k => (k.startsWith('tram:') && filters.tram) || (k.startsWith('bus:') && filters.bus));
        list.sort((a, b) => (a.startsWith('tram:') ? 0 : 1) - (b.startsWith('tram:') ? 0 : 1) || keyNum(a) - keyNum(b) || a.localeCompare(b));
        // worst punctuality per line (late wins over early)
        const worst = new Map();
        vehicles.forEach(st => {
            const d = st.data.delay;
            if (!st.key || d == null) return;
            const w = worst.get(st.key) || { max: -99, min: 99 };
            w.max = Math.max(w.max, d); w.min = Math.min(w.min, d);
            worst.set(st.key, w);
        });
        const chipDelay = (k) => {
            const w = worst.get(k);
            if (!w) return null;
            if (w.max >= 3) return w.max;
            if (w.min <= -1) return w.min;
            return delayMode ? 0 : null;
        };
        const sig = list.map(k => k + ':' + chipDelay(k)).join(',') + '|' + (focus && focus.kind === 'line' ? focus.key : '') + '|' + delayMode;
        if (sig === legendSig) return;
        legendSig = sig;
        const scroll = legend.scrollLeft;
        let html = `<button class="map-chip${!focus || focus.kind !== 'line' ? ' active' : ''}" data-line="">Alle</button>`;
        let busStarted = false;
        list.forEach(k => {
            const isBus = k.startsWith('bus:');
            if (isBus && !busStarted) { busStarted = true; html += '<span class="map-chip-sep" aria-hidden="true"></span>'; }
            const color = colorForKey(k);
            const active = focus && focus.kind === 'line' && focus.key === k;
            const cd = chipDelay(k);
            const ds = delayStyle(cd);
            const dot = ds ? `<span class="chip-delay${ds.dark ? ' dc-dark' : ''}" style="--dc:${ds.c}">${cd === 0 ? '' : ds.txt}</span>` : '';
            const tip = `${isBus ? 'Bus' : 'Straßenbahn'} ${keyShort(k)}${cd > 0 ? ` – bis zu ${cd} Min. Verspätung` : cd < 0 ? ` – bis zu ${-cd} Min. zu früh` : ''}`;
            html += `<button class="map-chip line${isBus ? ' bus' : ''}${darkText(color)}${active ? ' active' : ''}${ds ? ' has-delay' : ''}" data-line="${escapeHtml(k)}" style="--c:${color}" title="${escapeHtml(tip)}">${escapeHtml(keyShort(k))}${dot}</button>`;
        });
        legend.innerHTML = html;
        legend.scrollLeft = scroll;
    }

    function colorForKey(k) {
        const e = lineShapes.get(k);
        if (e && e.meta.color) return e.meta.color;
        for (const st of vehicles.values()) if (st.key === k) return st.data.color;
        return '#64748b';
    }

    // ---------------------------------------------------------
    // Vehicles
    // ---------------------------------------------------------
    function makeIcon(v) {
        const group = vehicleGroup(v.type);
        return L.divIcon({
            className: 'mv-icon',
            iconSize: [0, 0],
            html: `<div class="mv mv-${group}${darkText(v.color)}" style="--c:${v.color}">
                      <div class="mv-body"><span class="mv-nose"></span></div>
                      <div class="mv-label">${escapeHtml(v.short || v.line)}<span class="mv-delay" hidden></span></div>
                   </div>`,
        });
    }

    function applyDelay(st) {
        const el = st.marker.getElement();
        const root = el && el.querySelector('.mv');
        if (!root) return false;
        const d = st.data.delay;
        const ds = delayStyle(d);
        root.style.setProperty('--dc', ds ? ds.c : '#94a3b8');
        root.classList.toggle('dc-dark', !!(ds && ds.dark));
        root.classList.toggle('mv-late', d != null && d >= 3);
        const pill = root.querySelector('.mv-delay');
        if (pill) {
            const show = ds && (delayMode ? true : delayNotable(d));
            pill.hidden = !show;
            if (show) pill.textContent = ds.txt;
        }
        return true;
    }

    function setDelayMode(on) {
        delayMode = !!on;
        try { localStorage.setItem('map_delay_mode', delayMode ? '1' : '0'); } catch (e) { /* ignore */ }
        const shell = document.querySelector('.map-shell');
        if (shell) shell.classList.toggle('map-delaymode', delayMode);
        const btn = $('mapDelayBtn');
        if (btn) { btn.classList.toggle('active', delayMode); btn.setAttribute('aria-pressed', delayMode ? 'true' : 'false'); }
        renderDelayLegend();
        vehicles.forEach(applyDelay);
        legendSig = '';
        rebuildLegend();
    }

    function renderDelayLegend() {
        const box = $('mapDelayLegend');
        if (!box) return;
        box.hidden = !delayMode;
        if (!delayMode || box.childElementCount) return;
        const steps = [
            ['#ec4899', '≤−5'], ['#7c3aed', '−4'], ['#1e3a8a', '−3'], ['#2563eb', '−2'], ['#06b6d4', '−1'],
            ['#16a34a', '±0'], ['#eab308', '+3'], ['#dc2626', '>+5'],
        ];
        box.innerHTML = '<span class="mdl-title">früher</span>' +
            steps.map(([c, t]) => `<span class="mdl-step" style="--dc:${c}">${t}</span>`).join('') +
            '<span class="mdl-title">später</span>';
    }

    function trackPos(track, t) {
        if (!track || !track.length) return null;
        if (t <= track[0][0]) return [track[0][1], track[0][2]];
        for (let i = 1; i < track.length; i++) {
            if (t <= track[i][0]) {
                const a = track[i - 1], b = track[i];
                const f = (t - a[0]) / Math.max(1, b[0] - a[0]);
                return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
            }
        }
        const last = track[track.length - 1];
        return [last[1], last[2]];
    }

    // time on a track whose position is closest to pos (so a refreshed track never pulls a vehicle backwards)
    function nearestTrackTime(track, pos) {
        if (!track || track.length < 2) return { t: 0, d: Infinity };
        const px = pos[1] * M_LON, py = pos[0] * M_LAT;
        let best = { t: 0, d: Infinity };
        for (let i = 1; i < track.length; i++) {
            const a = track[i - 1], b = track[i];
            const ax = a[2] * M_LON, ay = a[1] * M_LAT, bx = b[2] * M_LON, by = b[1] * M_LAT;
            const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
            let f = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            f = Math.max(0, Math.min(1, f));
            const d = Math.hypot(ax + dx * f - px, ay + dy * f - py);
            if (d < best.d - 0.3) best = { t: a[0] + (b[0] - a[0]) * f, d };
        }
        return best;
    }

    function headingOf(track, t) {
        const p = trackPos(track, t);
        const lastT = track[track.length - 1][0];
        let q = trackPos(track, Math.min(lastT, t + 4000));
        let dx = (q[1] - p[1]) * M_LON, dy = (q[0] - p[0]) * M_LAT;
        if (Math.hypot(dx, dy) < 3) {
            // standing still: look at the direction of the upcoming movement
            q = trackPos(track, Math.min(lastT, t + 15000));
            dx = (q[1] - p[1]) * M_LON; dy = (q[0] - p[0]) * M_LAT;
            if (Math.hypot(dx, dy) < 3) return null;
        }
        return Math.atan2(-dy, dx) * 180 / Math.PI; // screen angle (y down)
    }

    function ingestVehicles(list) {
        const now = performance.now();
        const seen = new Set();
        list.forEach(v => {
            if (!v.id || v.lat == null) return;
            seen.add(v.id);
            const track = (v.track && v.track.length > 1) ? v.track : [[0, v.lat, v.lon]];
            let st = vehicles.get(v.id);
            if (!st) {
                const marker = L.marker([track[0][1], track[0][2]], { icon: makeIcon(v), keyboard: false, riseOnHover: true, bubblingMouseEvents: false });
                st = { marker, data: v, key: lineKeyOf(v), track, t0: now, from: null, fromT: 0, pos: [track[0][1], track[0][2]], angle: null, root: null, body: null };
                marker.on('click', (e) => {
                    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
                    focusTrip(st.data.id);
                });
                vehicles.set(v.id, st);
                if (isVisible(st)) marker.addTo(map);
            } else {
                // continue from where the vehicle currently is on the new track (never jump back)
                const near = st.pos ? nearestTrackTime(track, st.pos) : { t: 0, d: Infinity };
                if (near.d < 60) {
                    st.t0 = now - near.t;
                    st.from = near.d > 2 ? st.pos.slice() : null;
                } else {
                    st.t0 = now;
                    st.from = st.pos ? st.pos.slice() : null;
                }
                st.fromT = now;
                st.track = track;
                const iconChanged = st.data.color !== v.color || st.data.short !== v.short;
                st.data = v;
                st.key = lineKeyOf(v);
                if (iconChanged) { st.marker.setIcon(makeIcon(v)); st.root = null; st.body = null; }
            }
            applyDelay(st);
        });
        vehicles.forEach((st, id) => {
            if (!seen.has(id)) {
                const el = st.marker.getElement();
                if (el) el.classList.add('mv-leaving');
                setTimeout(() => map && map.removeLayer(st.marker), 700);
                vehicles.delete(id);
            }
        });
        refreshVehicleVisibility();
        rebuildLegend();
    }

    function isVisible(st) {
        return !!filters[vehicleGroup(st.data.type)];
    }

    function refreshVehicleVisibility() {
        vehicles.forEach(st => {
            const show = isVisible(st);
            if (show && !map.hasLayer(st.marker)) { st.marker.addTo(map); st.root = null; st.body = null; }
            if (!show && map.hasLayer(st.marker)) map.removeLayer(st.marker);
        });
        updateVehicleFocusClasses();
        updateCounts();
    }

    function updateVehicleFocusClasses() {
        vehicles.forEach(st => {
            const el = st.marker.getElement();
            const root = el && el.querySelector('.mv');
            if (!root) return;
            let dim = false, hi = false;
            if (focus && focus.kind === 'line') { hi = st.key === focus.key; dim = !hi; }
            if (focus && focus.kind === 'trip') { hi = st.data.id === focus.id; dim = !hi; }
            root.classList.toggle('mv-dim', dim);
            root.classList.toggle('mv-focus', hi);
            st.marker.setZIndexOffset(hi ? 1000 : 0);
        });
    }

    function updateCounts() {
        let tram = 0, bus = 0, train = 0;
        vehicles.forEach(st => {
            const g = vehicleGroup(st.data.type);
            if (g === 'tram') tram++; else if (g === 'bus') bus++; else train++;
        });
        const c = $('mapCount');
        if (c) c.textContent = `${tram} Trams · ${bus} Busse${train ? ` · ${train} Züge` : ''}`;
        const set = (id, n) => { const el = $(id); if (el) el.textContent = n; };
        set('mapCntTram', tram); set('mapCntBus', bus); set('mapCntTrain', train);
    }

    function animate(ts) {
        rafId = requestAnimationFrame(animate);
        if (!visible || !map || document.hidden) return;
        const dtFrame = ts - lastFrame;
        if (dtFrame < 33) return; // ~30 fps is plenty
        lastFrame = ts;
        const now = performance.now();
        vehicles.forEach(st => {
            if (!map.hasLayer(st.marker)) return;
            const elapsed = now - st.t0;
            let p = trackPos(st.track, elapsed);
            if (!p) return;
            if (st.from && now - st.fromT < BLEND_MS) {
                const k = (now - st.fromT) / BLEND_MS;
                const e = k * k * (3 - 2 * k);
                p = [st.from[0] + (p[0] - st.from[0]) * e, st.from[1] + (p[1] - st.from[1]) * e];
            }
            const target = st.track.length > 1 ? headingOf(st.track, elapsed) : null;
            if (target != null) {
                if (st.angle == null) st.angle = target;
                else {
                    // shortest way round + smoothing: no more spinning
                    const delta = ((target - st.angle + 540) % 360) - 180;
                    // a sudden U-turn is usually a data hiccup: only accept it if it persists
                    if (Math.abs(delta) > 135) {
                        if (!st.flipSince) st.flipSince = now;
                    } else st.flipSince = 0;
                    if (!st.flipSince || now - st.flipSince > 2500) {
                        const maxStep = 160 * Math.min(100, dtFrame) / 1000; // max 160°/s
                        const step = delta * Math.min(1, dtFrame / 280);
                        st.angle += Math.max(-maxStep, Math.min(maxStep, step));
                    }
                }
            }
            st.pos = p;
            st.marker.setLatLng(p);
            if (!st.body) {
                const el = st.marker.getElement();
                st.body = el && el.querySelector('.mv-body');
                if (st.body) applyDelay(st);
                if (st.body && focus) updateVehicleFocusClasses();
            }
            if (st.body) {
                if (st.angle != null) st.body.style.transform = `translate(-50%, -50%) rotate(${st.angle.toFixed(1)}deg)`;
                st.body.classList.toggle('stopped', st.angle == null);
            }
        });
        if (focus && ts - lastFocusTick > 500) {
            lastFocusTick = ts;
            updateFocusGeometry(false);
        }
    }

    async function poll() {
        try {
            const res = await fetch(`${opts.apiBase}/radar`);
            const data = await res.json();
            if (!res.ok || !Array.isArray(data.vehicles)) throw new Error(data.error || `HTTP ${res.status}`);
            ingestVehicles(data.vehicles);
            const t = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lastRadarText = `live · aktualisiert ${t}`;
            refreshStatus();
            if (focus && focus.kind === 'line') loadLineTrips();
            if (focus && focus.kind === 'trip' && !vehicles.has(focus.id)) renderFocusCard();
        } catch (e) {
            console.warn('Radar-Fehler:', e);
            setStatus('Live-Positionen gerade nicht erreichbar – neuer Versuch…', false);
        }
    }

    async function startPolling() {
        stopPolling();
        await poll();
        pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
        if (!rafId) rafId = requestAnimationFrame(animate);
        loadLineShapes();
    }

    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        if (shapesTimer) clearTimeout(shapesTimer);
        shapesTimer = null;
    }

    // ---------------------------------------------------------
    // Trips (real route of a single vehicle)
    // ---------------------------------------------------------
    async function getTrip(id, force) {
        const hit = tripCache.get(id);
        if (hit && !force && Date.now() - hit.ts < TRIP_TTL_MS) return hit;
        if (tripLoading.has(id)) return tripLoading.get(id);
        const pr = (async () => {
            try {
                const res = await fetch(`${opts.apiBase}/trip?jid=${encodeURIComponent(id)}`);
                const trip = await res.json();
                if (!res.ok || trip.error) throw new Error(trip.error || `HTTP ${res.status}`);
                const entry = { ts: Date.now(), trip, prep: prepTrip(trip) };
                tripCache.set(id, entry);
                return entry;
            } finally {
                tripLoading.delete(id);
            }
        })();
        tripLoading.set(id, pr);
        return pr;
    }

    function prepTrip(trip) {
        let pts = (trip.shape && trip.shape.length > 1) ? trip.shape : null;
        const stops = trip.stops || [];
        let approx = false;
        if (!pts) {
            pts = stops.filter(s => s.lat).map(s => [s.lat, s.lon]);
            stops.forEach((s, i) => { s.shapeIdx = i; });
            approx = true;
        }
        const sh = prepShape(pts);
        // along-distance of each stop
        stops.forEach(s => {
            if (s.shapeIdx != null && s.shapeIdx < pts.length) s.along = sh.cum[s.shapeIdx];
        });
        // colour runs (a trip may change its line number on the way)
        const runs = [];
        const withIdx = stops.filter(s => s.along != null);
        for (let i = 0; i < withIdx.length - 1; i++) {
            const s = withIdx[i];
            const last = runs[runs.length - 1];
            if (last && last.short === s.short) { last.to = withIdx[i + 1].along; last.toStop = withIdx[i + 1]; }
            else runs.push({ short: s.short, line: s.line, color: s.color || trip.color, from: s.along, to: withIdx[i + 1].along, fromStop: s, toStop: withIdx[i + 1] });
        }
        if (!runs.length) runs.push({ short: trip.short, line: trip.line, color: trip.color, from: 0, to: sh.total, fromStop: stops[0], toStop: stops[stops.length - 1] });
        runs[0].from = 0;
        runs[runs.length - 1].to = sh.total;
        const changes = [];
        for (let i = 1; i < runs.length; i++) {
            changes.push({ stop: runs[i].fromStop, from: runs[i - 1], to: runs[i] });
        }
        return { sh, runs, changes, approx, hint: null };
    }

    // where on its trip is the vehicle right now?
    function tripProgress(entry, st) {
        const { sh } = entry.prep;
        if (!st || !st.pos || sh.pts.length < 2) return null;
        const stops = entry.trip.stops || [];
        let lo = 0, hi = sh.pts.length - 2;
        if (entry.prep.hint != null) {
            lo = entry.prep.hint - 6;
            hi = entry.prep.hint + 400;
        } else {
            const passed = stops.filter(s => s.passed && s.shapeIdx != null);
            const next = stops.find(s => !s.passed && s.shapeIdx != null);
            if (passed.length) lo = passed[passed.length - 1].shapeIdx - 2;
            if (next) hi = next.shapeIdx + 2;
        }
        let pr = project(sh, st.pos, lo, hi);
        if (!pr || pr.d > 150) {
            const full = project(sh, st.pos, 0, sh.pts.length - 2);
            if (full && (!pr || full.d < pr.d)) pr = full;
        }
        if (!pr) return null;
        entry.prep.hint = pr.i;
        pr.frac = sh.total ? pr.along / sh.total : 0;
        return pr;
    }

    function runGradient(prep) {
        const total = prep.sh.total || 1;
        if (prep.runs.length < 2) return prep.runs[0] ? prep.runs[0].color : '#888';
        const parts = [];
        prep.runs.forEach((r, i) => {
            const a = (r.from / total) * 100, b = (r.to / total) * 100;
            parts.push(`${r.color} ${i === 0 ? 0 : (a + 1.5).toFixed(1)}%`);
            parts.push(`${r.color} ${i === prep.runs.length - 1 ? 100 : (b - 1.5).toFixed(1)}%`);
        });
        return `linear-gradient(90deg, ${parts.join(', ')})`;
    }

    // ---------------------------------------------------------
    // Focus modes
    // ---------------------------------------------------------
    function setMapFocusClass() {
        const shell = document.querySelector('.map-shell');
        if (!shell) return;
        shell.classList.toggle('mf-line', !!focus && focus.kind === 'line');
        shell.classList.toggle('mf-trip', !!focus && focus.kind === 'trip');
    }

    function clearFocus(keepCard) {
        if (!focus) return;
        if (focus.refreshTimer) clearTimeout(focus.refreshTimer);
        if (focus.group) map.removeLayer(focus.group);
        if (focus.markGroup) map.removeLayer(focus.markGroup);
        focus = null;
        setMapFocusClass();
        applyAllStyles();
        updateVehicleFocusClasses();
        updateStationVisibility();
        rebuildLegend();
        if (!keepCard) hideFocusCard();
    }

    function newFocus(f) {
        clearFocus(true);
        focus = Object.assign({ group: L.layerGroup().addTo(map), markGroup: L.layerGroup().addTo(map) }, f);
        setMapFocusClass();
        applyAllStyles();
        updateVehicleFocusClasses();
        updateStationVisibility();
        rebuildLegend();
    }

    // ---------- line focus ----------
    function setLineFocus(key) {
        if (!key) { clearFocus(); return; }
        if (focus && focus.kind === 'line' && focus.key === key) { clearFocus(); return; }
        newFocus({ kind: 'line', key, tails: new Map(), contLayers: new Map(), changeMarks: new Map() });
        const e = lineShapes.get(key);
        (e && e.meta.changes || []).forEach(ch => addChangeMarker(ch.id, ch.lat, ch.lon, ch.from, ch.fromColor, ch.to, ch.toColor, ch.stop));
        renderFocusCard();
        loadLineTrips();
    }

    function lineVehicles() {
        if (!focus || focus.kind !== 'line') return [];
        return [...vehicles.values()].filter(st => st.key === focus.key);
    }

    async function loadLineTrips() {
        if (!focus || focus.kind !== 'line') return;
        const myFocus = focus;
        const list = lineVehicles().filter(st => {
            const hit = tripCache.get(st.data.id);
            return !hit || Date.now() - hit.ts > TRIP_TTL_MS;
        });
        let idx = 0;
        const worker = async () => {
            while (idx < list.length && focus === myFocus) {
                const st = list[idx++];
                try {
                    await getTrip(st.data.id);
                } catch (e) { /* ignore single failures */ }
                if (focus === myFocus) { drawLineTripExtras(); renderFocusCard(); }
            }
        };
        await Promise.all([worker(), worker(), worker()]);
    }

    function addChangeMarker(id, lat, lon, from, fromColor, to, toColor, stopName) {
        if (!focus || lat == null || focus.changeMarks?.has(id)) return;
        const html = `<div class="mf-chg" title="Linienwechsel an ${escapeHtml(stopName)}">
            <span class="mf-chg-b${darkText(fromColor)}" style="background:${fromColor}">${escapeHtml(from)}</span>
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="mf-chg-b${darkText(toColor)}" style="background:${toColor}">${escapeHtml(to)}</span>
        </div>`;
        const m = L.marker([lat, lon], {
            pane: 'focusMarks', interactive: false, keyboard: false,
            icon: L.divIcon({ className: 'mf-chg-icon', iconSize: [0, 0], html }),
        }).addTo(focus.markGroup);
        if (focus.changeMarks) focus.changeMarks.set(id, m);
        else (focus.changeList = focus.changeList || []).push(m);
    }

    // continuation of Linienwechsler (other-line parts of the trips) + change markers
    function drawLineTripExtras() {
        if (!focus || focus.kind !== 'line') return;
        const s = zoomScale();
        const short = keyShort(focus.key);
        lineVehicles().forEach(st => {
            const hit = tripCache.get(st.data.id);
            if (!hit) return;
            const { prep } = hit;
            prep.runs.forEach(r => {
                if (r.short === short) return;
                const id = `${r.short}|${r.fromStop?.name}|${r.toStop?.name}`;
                if (focus.contLayers.has(id)) return;
                const pts = ptsBetween(prep.sh, r.from, r.to);
                if (pts.length < 2) return;
                const casing = L.polyline(pts, { pane: 'focusLow', interactive: false, color: palette().casing, weight: 7 * s, opacity: 0.85, lineCap: 'round' });
                const line = L.polyline(pts, { pane: 'focusLow', interactive: false, color: r.color, weight: 4 * s, opacity: 0.95, dashArray: `${8 * s} ${7 * s}`, lineCap: 'butt' });
                focus.group.addLayer(casing);
                focus.group.addLayer(line);
                focus.contLayers.set(id, [casing, line]);
            });
            prep.changes.forEach(ch => {
                const id = `${ch.from.short}>${ch.to.short}@${ch.stop?.name}`;
                if (ch.stop) addChangeMarker(id, ch.stop.lat, ch.stop.lon, ch.from.short, ch.from.color, ch.to.short, ch.to.color, ch.stop.name);
            });
        });
    }

    // progress tails ("comet") behind every vehicle of the focused line
    function updateLineTails(restyle) {
        const s = zoomScale();
        const alive = new Set();
        lineVehicles().forEach(st => {
            const hit = tripCache.get(st.data.id);
            if (!hit || !map.hasLayer(st.marker)) return;
            const pr = tripProgress(hit, st);
            if (!pr) return;
            st.progress = pr.frac;
            st.progressAlong = pr.along;
            alive.add(st.data.id);
            let tail = focus.tails.get(st.data.id);
            if (!tail) {
                tail = [0.18, 0.4, 0.75].map(op => L.polyline([], { pane: 'focusHigh', interactive: false, lineCap: 'round', lineJoin: 'round', opacity: op }));
                tail.forEach(l => focus.group.addLayer(l));
                focus.tails.set(st.data.id, tail);
                restyle = true;
            }
            const len = 700;
            const cuts = [pr.along - len, pr.along - len * 0.6, pr.along - len * 0.25, pr.along];
            tail.forEach((l, i) => {
                l.setLatLngs(ptsBetween(hit.prep.sh, Math.max(0, cuts[i]), Math.max(0, cuts[i + 1])));
                if (restyle) l.setStyle({ color: st.data.color, weight: (6 + i * 2.2) * s });
            });
        });
        focus.tails.forEach((tail, id) => {
            if (!alive.has(id)) { tail.forEach(l => focus.group.removeLayer(l)); focus.tails.delete(id); }
        });
    }

    // ---------- trip focus ----------
    async function focusTrip(id) {
        const st = vehicles.get(id);
        if (!st) return;
        newFocus({ kind: 'trip', id, key: st.key, entry: null, loading: true, error: null, layers: null });
        renderFocusCard();
        try {
            const entry = await getTrip(id, true);
            if (!focus || focus.kind !== 'trip' || focus.id !== id) return;
            focus.entry = entry;
            focus.loading = false;
            buildTripLayers();
        } catch (e) {
            if (!focus || focus.id !== id) return;
            focus.loading = false;
            focus.error = 'Linienweg dieser Fahrt gerade nicht abrufbar.';
        }
        renderFocusCard();
        panToVehicle(id);
        // refresh the trip (delays, cancellations) every 45 s while focused
        const myFocus = focus;
        const refresh = async () => {
            if (focus !== myFocus) return;
            try {
                const entry = await getTrip(id, true);
                if (focus !== myFocus) return;
                entry.prep.hint = focus.entry ? focus.entry.prep.hint : null;
                focus.entry = entry;
                buildTripLayers();
                renderFocusCard();
            } catch (e) { /* keep old data */ }
            if (focus === myFocus) myFocus.refreshTimer = setTimeout(refresh, 45000);
        };
        if (focus) focus.refreshTimer = setTimeout(refresh, 45000);
    }

    // free part of the map (not covered by the top bar / focus card)
    function freeArea() {
        const size = map.getSize();
        const shell = map.getContainer().getBoundingClientRect();
        const bar = document.querySelector('.map-topbar');
        const card = $('mapFocus');
        let top = 20, bottom = size.y - 60, right = size.x - 20;
        if (bar) top = bar.getBoundingClientRect().bottom - shell.top + 12;
        if (card && !card.hidden) {
            const r = card.getBoundingClientRect();
            if (isMobile()) bottom = r.top - shell.top - 12;
            else right = r.left - shell.left - 12;
        }
        if (bottom - top < 80) bottom = top + 80;
        return L.bounds([20, top], [Math.max(60, right), bottom]);
    }

    function panToVehicle(id) {
        const st = vehicles.get(id);
        if (!st || !st.pos) return;
        const free = freeArea();
        const pt = map.latLngToContainerPoint(st.pos);
        const inner = L.bounds(free.min.add([20, 20]), free.max.subtract([20, 20]));
        if (inner.contains(pt)) return;
        const target = free.getCenter();
        map.panBy([pt.x - target.x, pt.y - target.y], { animate: true, duration: 0.6 });
    }

    function fitTrip(remainingOnly) {
        if (!focus || !focus.entry) return;
        const st = vehicles.get(focus.id);
        const { sh } = focus.entry.prep;
        const pr = st ? tripProgress(focus.entry, st) : null;
        const pts = remainingOnly && pr ? ptsBetween(sh, Math.max(0, pr.along - 200), sh.total) : sh.pts;
        if (pts.length < 2) return;
        map.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: [30, 90], paddingBottomRight: isMobile() ? [30, 300] : [390, 70], duration: 0.8, maxZoom: 16 });
    }

    function buildTripLayers() {
        if (!focus || focus.kind !== 'trip' || !focus.entry) return;
        focus.group.clearLayers();
        focus.markGroup.clearLayers();
        const { prep, trip } = focus.entry;
        const p = palette();
        focus.layers = prep.runs.map(r => {
            const done = L.polyline([], { pane: 'focusLow', interactive: false, color: r.color, opacity: 0.5, lineCap: 'round', lineJoin: 'round' });
            const casing = L.polyline([], { pane: 'focusHigh', interactive: false, color: p.casing, opacity: 1, lineCap: 'round', lineJoin: 'round' });
            const line = L.polyline([], { pane: 'focusHigh', interactive: false, color: r.color, opacity: 1, lineCap: 'round', lineJoin: 'round' });
            const mid = L.polyline([], { pane: 'focusHigh', interactive: false, color: p.casing, opacity: 1, lineCap: 'round', lineJoin: 'round' });
            const flow = L.polyline([], { pane: 'focusHigh', interactive: false, color: '#ffffff', opacity: 0.9, lineCap: 'butt', className: 'mf-flow' });
            [done, casing, line, mid, flow].forEach(l => focus.group.addLayer(l));
            return { r, done, casing, line, mid, flow };
        });
        // stops
        focus.stopMarks = (trip.stops || []).filter(s => s.lat).map((s, i, arr) => {
            const terminus = i === arr.length - 1;
            const m = L.circleMarker([s.lat, s.lon], { pane: 'focusMarks', radius: terminus ? 7 : 4.5, weight: terminus ? 3 : 2.2, color: s.color || trip.color, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false });
            m.bindTooltip(`<div class="map-tip"><strong>${escapeHtml(s.name)}</strong><div class="mf-tip-time">${escapeHtml(s.rt || s.time || '')}${s.delay > 0 ? ` <b class="late">+${s.delay}</b>` : ''}</div></div>`, {
                direction: 'top', offset: [0, -6], className: 'map-tooltip', opacity: 1, permanent: terminus,
            });
            m.addTo(focus.markGroup);
            return { s, m, terminus };
        });
        prep.changes.forEach(ch => {
            if (ch.stop) addChangeMarker(`c${ch.stop.name}`, ch.stop.lat, ch.stop.lon, ch.from.short, ch.from.color, ch.to.short, ch.to.color, ch.stop.name);
        });
        updateFocusGeometry(true);
    }

    function updateTripGeometry(restyle) {
        const { prep } = focus.entry;
        const st = vehicles.get(focus.id);
        const pr = st ? tripProgress(focus.entry, st) : null;
        const cut = pr ? pr.along : 0;
        focus.progress = pr;
        const s = zoomScale();
        const isBus = vehicleGroup(focus.entry.trip.type) === 'bus';
        const p = palette();
        focus.layers.forEach(({ r, done, casing, line, mid, flow }) => {
            const a = r.from, b = r.to;
            done.setLatLngs(ptsBetween(prep.sh, a, Math.min(b, cut)));
            const rem = ptsBetween(prep.sh, Math.max(a, cut), b);
            casing.setLatLngs(rem);
            line.setLatLngs(rem);
            mid.setLatLngs(rem);
            flow.setLatLngs(rem);
            if (restyle) {
                done.setStyle({ weight: 4 * s, dashArray: `${0.1} ${9 * s}`, opacity: 0.75 });
                casing.setStyle({ weight: 14 * s, color: p.casing });
                line.setStyle({ weight: 10 * s });
                if (isBus) {
                    // road: kerbs in line colour, asphalt, moving white centre markings
                    mid.setStyle({ weight: 7 * s, color: p.asphalt });
                    flow.setStyle({ weight: 1.3 * s, color: p.mark, dashArray: `${5 * s} ${11 * s}` });
                } else {
                    // track: two rails, sleepers running along the remaining route
                    mid.setStyle({ weight: 4.4 * s, color: p.casing });
                    flow.setStyle({ weight: 12.5 * s, color: r.color, opacity: 0.5, dashArray: `${2 * s} ${14 * s}` });
                }
            }
        });
        // passed / upcoming stops
        let nextFound = false;
        (focus.stopMarks || []).forEach(({ s: stop, m, terminus }) => {
            const passed = stop.along != null ? stop.along < cut - 15 : stop.passed;
            const isNext = !passed && !nextFound;
            if (isNext) nextFound = true;
            const state = passed ? 'p' : isNext ? 'n' : 'u';
            if (m._mfState === state && !restyle) return;
            m._mfState = state;
            if (passed) m.setStyle({ color: '#9aa4ae', fillColor: palette().casing, radius: 3.2, weight: 1.6, opacity: 0.8 });
            else m.setStyle({ color: stop.color || focus.entry.trip.color, fillColor: '#fff', radius: terminus ? 7 : isNext ? 6.5 : 4.5, weight: terminus ? 3 : isNext ? 3.2 : 2.2, opacity: 1 });
            if (isNext && !terminus) { m.unbindTooltip(); m.bindTooltip(`<div class="map-tip"><small>Nächster Halt</small><strong>${escapeHtml(stop.name)}</strong></div>`, { permanent: true, direction: 'right', offset: [8, 0], className: 'map-tooltip mf-next-tip', opacity: 1 }); }
            else if (!terminus && m.getTooltip()?.options.permanent) {
                m.unbindTooltip();
                m.bindTooltip(`<div class="map-tip"><strong>${escapeHtml(stop.name)}</strong><div class="mf-tip-time">${escapeHtml(stop.rt || stop.time || '')}</div></div>`, { direction: 'top', offset: [0, -6], className: 'map-tooltip', opacity: 1 });
            }
        });
    }

    let lastCardRender = 0;
    function updateFocusGeometry(restyle) {
        if (!focus) return;
        if (focus.kind === 'trip' && focus.entry && focus.layers) updateTripGeometry(restyle);
        if (focus.kind === 'line') {
            updateLineTails(restyle);
            if (restyle) {
                const s = zoomScale();
                focus.contLayers.forEach(([casing, line]) => {
                    casing.setStyle({ weight: 7 * s, color: palette().casing });
                    line.setStyle({ weight: 4 * s, dashArray: `${8 * s} ${7 * s}` });
                });
            }
        }
        const now = performance.now();
        if (now - lastCardRender > 2500) renderFocusCard();
    }

    // ---------------------------------------------------------
    // Focus card (side panel / bottom sheet)
    // ---------------------------------------------------------
    function isMobile() { return window.matchMedia('(max-width: 720px)').matches; }

    function createFocusCard() {
        const shell = document.querySelector('.map-shell');
        if (!shell || $('mapFocus')) return;
        const card = document.createElement('div');
        card.id = 'mapFocus';
        card.className = 'map-focus';
        card.hidden = true;
        shell.appendChild(card);
        L.DomEvent.disableClickPropagation(card);
        L.DomEvent.disableScrollPropagation(card);
        card.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'close') clearFocus();
            else if (act === 'trip') focusTrip(btn.dataset.id);
            else if (act === 'fit') fitTrip(false);
            else if (act === 'line') setLineFocus(btn.dataset.key);
            else if (act === 'journey') openJourney(focus && focus.id);
        });
    }

    function hideFocusCard() {
        const card = $('mapFocus');
        if (card) { card.hidden = true; card.innerHTML = ''; card._html = ''; }
    }

    function openJourney(id) {
        const st = vehicles.get(id);
        const d = st ? st.data : null;
        if (!d || typeof opts.onOpenJourney !== 'function') return;
        opts.onOpenJourney({ journey_id: d.id, line: d.line, direction: d.direction, time: '', delay: d.delay || 0, lineColor: d.color });
    }

    function delayHtml(delay) {
        const ds = delayStyle(delay);
        if (!ds) return '';
        if (delay === 0) return '<span class="mf-delay ok">pünktlich</span>';
        return `<span class="mf-delay dyn${ds.dark ? ' dc-dark' : ''}" style="--dc:${ds.c}">${ds.txt}</span>`;
    }

    const closeBtn = '<button class="mf-close" data-act="close" aria-label="Fokus schließen"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button>';

    function renderFocusCard() {
        const card = $('mapFocus');
        if (!card) return;
        lastCardRender = performance.now();
        if (!focus) { hideFocusCard(); return; }
        const html = focus.kind === 'trip' ? tripCardHtml() : lineCardHtml();
        card.hidden = false;
        if (card._html === html) return;
        card._html = html;
        const scroll = card._focusRef === focus ? card.scrollTop : 0;
        card._focusRef = focus;
        card.innerHTML = html;
        card.scrollTop = scroll;
    }

    function tripCardHtml() {
        const st = vehicles.get(focus.id);
        const v = st ? st.data : null;
        const color = v ? v.color : '#64748b';
        const head = `<div class="mf-head">
            <span class="mf-badge${darkText(color)}" style="background:${color}">${escapeHtml(v ? (v.short || v.line) : '?')}</span>
            <div class="mf-title"><small>${v ? (vehicleGroup(v.type) === 'bus' ? 'Bus' : 'Straßenbahn') + ' · Richtung' : 'Fahrt'}</small><strong>${escapeHtml(v ? v.direction : '')}</strong></div>
            ${closeBtn}</div>`;
        if (!v) return head + '<p class="mf-empty">Dieses Fahrzeug hat die Fahrt beendet.</p>';
        if (focus.loading) return head + '<div class="mf-loading"><span class="mf-spin"></span>Linienweg wird geladen…</div>';
        if (focus.error || !focus.entry) return head + `<p class="mf-empty">${escapeHtml(focus.error || 'Keine Daten')}</p>`;

        const { trip, prep } = focus.entry;
        const pr = focus.progress || tripProgress(focus.entry, st);
        const pct = pr ? Math.round(pr.frac * 100) : 0;
        const cut = pr ? pr.along : 0;
        const stops = trip.stops || [];
        const upcoming = stops.filter(s => (s.along != null ? s.along >= cut - 15 : !s.passed));
        const passedCount = stops.length - upcoming.length;
        const next = upcoming[0];
        const first = stops[0], last = stops[stops.length - 1];
        const ticks = prep.changes.map(ch => `<span class="mf-tick" style="left:${(ch.to.from / (prep.sh.total || 1) * 100).toFixed(1)}%" title="Linienwechsel ${escapeHtml(ch.from.short)} → ${escapeHtml(ch.to.short)}"></span>`).join('');
        const changeNotes = prep.changes.map(ch => {
            const before = ch.to.from > cut;
            return `<div class="mf-change-note">
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>${before ? 'Wechselt' : 'Wechselte'} an <b>${escapeHtml(ch.stop.name)}</b> von
                <span class="mf-mini${darkText(ch.from.color)}" style="background:${ch.from.color}">${escapeHtml(ch.from.short)}</span> zu
                <span class="mf-mini${darkText(ch.to.color)}" style="background:${ch.to.color}">${escapeHtml(ch.to.short)}</span>
                ${before ? `– weiter bis ${escapeHtml(ch.to.toStop?.name || last.name)}` : ''}</span></div>`;
        }).join('');
        let prevShort = null;
        const rows = upcoming.map((s, i) => {
            const changed = prevShort != null && s.short !== prevShort;
            prevShort = s.short;
            return `<li class="mf-stop${i === 0 ? ' next' : ''}${s.cancelled ? ' cancelled' : ''}" style="--sc:${s.color || color}">
                <span class="mf-stop-time">${escapeHtml(s.rt || s.time)}</span>
                <span class="mf-stop-dot"></span>
                <span class="mf-stop-name">${escapeHtml(s.name)}${changed ? ` <span class="mf-mini${darkText(s.color)}" style="background:${s.color}">ab hier ${escapeHtml(s.short)}</span>` : ''}</span>
                ${s.delay ? delayHtml(s.delay) : ''}</li>`;
        }).join('');
        return head + `
            <div class="mf-progress">
                <div class="mf-bar" style="--grad:${runGradient(prep)}">
                    <div class="mf-rest" style="left:${pct}%"></div>${ticks}
                    <span class="mf-pos" style="left:${pct}%;--c:${color}"></span>
                </div>
                <div class="mf-ends"><span><b>${escapeHtml(first?.name)}</b>${escapeHtml(first?.rt || first?.time || '')}</span><span class="mf-pct">${pct} %</span><span><b>${escapeHtml(last?.name)}</b>${escapeHtml(last?.rt || last?.time || '')}</span></div>
            </div>
            ${next ? `<div class="mf-next"><small>Nächster Halt</small><strong>${escapeHtml(next.name)}</strong><span>${escapeHtml(next.rt || next.time)} ${delayHtml(next.delay != null ? next.delay : v.delay)}</span></div>` : ''}
            ${changeNotes}
            <div class="mf-scroll">
                ${passedCount ? `<div class="mf-passed">${passedCount} ${passedCount === 1 ? 'Halt' : 'Halte'} bereits gefahren</div>` : ''}
                <ol class="mf-stops">${rows}</ol>
            </div>
            ${prep.approx ? '<p class="mf-hint">Genauer Linienweg nicht verfügbar – Verbindung zwischen den Halten vereinfacht.</p>' : ''}
            <div class="mf-actions">
                <button class="mf-btn" data-act="journey">Live-Verlauf öffnen</button>
                <button class="mf-btn ghost" data-act="fit">Ganze Fahrt</button>
                ${st.key ? `<button class="mf-btn ghost" data-act="line" data-key="${escapeHtml(st.key)}">Linie ${escapeHtml(keyShort(st.key))}</button>` : ''}
            </div>`;
    }

    function lineCardHtml() {
        const key = focus.key;
        const short = keyShort(key);
        const color = colorForKey(key);
        const isBus = key.startsWith('bus:');
        const list = lineVehicles();
        const head = `<div class="mf-head">
            <span class="mf-badge${darkText(color)}" style="background:${color}">${escapeHtml(short)}</span>
            <div class="mf-title"><small>${isBus ? 'Buslinie' : 'Straßenbahnlinie'}</small><strong>${list.length ? `${list.length} ${list.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'} unterwegs` : 'gerade kein Fahrzeug unterwegs'}</strong></div>
            ${closeBtn}</div>`;
        // changes known for this line (from line shapes + fetched trips)
        const changes = new Map();
        const e = lineShapes.get(key);
        (e && e.meta.changes || []).forEach(ch => changes.set(`${ch.from}>${ch.to}@${ch.stop}`, ch));
        list.forEach(st => {
            const hit = tripCache.get(st.data.id);
            if (hit) hit.prep.changes.forEach(ch => changes.set(`${ch.from.short}>${ch.to.short}@${ch.stop.name}`, { from: ch.from.short, to: ch.to.short, fromColor: ch.from.color, toColor: ch.to.color, stop: ch.stop.name }));
        });
        const changeHtml = changes.size ? `<div class="mf-changes"><small>Linienwechsel</small>${[...changes.values()].map(ch => `
            <div class="mf-change-note compact"><span class="mf-mini${darkText(ch.fromColor)}" style="background:${ch.fromColor}">${escapeHtml(ch.from)}</span>
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="mf-mini${darkText(ch.toColor)}" style="background:${ch.toColor}">${escapeHtml(ch.to)}</span><span>an <b>${escapeHtml(ch.stop)}</b></span></div>`).join('')}</div>` : '';
        const sorted = list.slice().sort((a, b) => (a.data.direction || '').localeCompare(b.data.direction || '') || (b.progress || 0) - (a.progress || 0));
        const rows = sorted.map(st => {
            const hit = tripCache.get(st.data.id);
            const pct = st.progress != null && hit ? Math.round(st.progress * 100) : null;
            const grad = hit ? runGradient(hit.prep) : st.data.color;
            const ticks = hit ? hit.prep.changes.map(ch => `<span class="mf-tick" style="left:${(ch.to.from / (hit.prep.sh.total || 1) * 100).toFixed(1)}%"></span>`).join('') : '';
            return `<button class="mf-veh" data-act="trip" data-id="${escapeHtml(st.data.id)}">
                <div class="mf-veh-top"><strong>→ ${escapeHtml(st.data.direction || '—')}</strong>${delayHtml(st.data.delay)}</div>
                <div class="mf-bar small${pct == null ? ' loading' : ''}" style="--grad:${grad}">
                    <div class="mf-rest" style="left:${pct == null ? 0 : pct}%"></div>${ticks}
                    ${pct == null ? '' : `<span class="mf-pos" style="left:${pct}%;--c:${st.data.color}"></span>`}
                </div>
                <div class="mf-veh-sub"><span>${st.data.nextStop ? `nächster Halt: ${escapeHtml(st.data.nextStop.replace('Magdeburg, ', ''))}` : ''}</span><span>${pct == null ? '…' : pct + ' %'}</span></div>
            </button>`;
        }).join('');
        return head + changeHtml + `<div class="mf-scroll"><div class="mf-vehs">${rows || '<p class="mf-empty">Sobald ein Fahrzeug dieser Linie unterwegs ist, erscheint es hier.</p>'}</div></div>
            <p class="mf-hint">Leuchtspur = bisher gefahrener Weg · Tippe ein Fahrzeug für seinen restlichen Linienweg.</p>`;
    }

    // ---------------------------------------------------------
    // Controls
    // ---------------------------------------------------------
    function wireControls() {
        document.querySelectorAll('.map-toggle').forEach(btn => {
            const key = btn.dataset.group;
            btn.classList.toggle('active', !!filters[key]);
            btn.setAttribute('aria-pressed', filters[key] ? 'true' : 'false');
            btn.addEventListener('click', () => {
                filters[key] = !filters[key];
                btn.classList.toggle('active', filters[key]);
                btn.setAttribute('aria-pressed', filters[key] ? 'true' : 'false');
                refreshVehicleVisibility();
                applyLineStyles();
                rebuildLegend();
            });
        });
        const dBtn = $('mapDelayBtn');
        if (dBtn) dBtn.addEventListener('click', () => setDelayMode(!delayMode));
        setDelayMode(delayMode);
        const legend = $('mapLegend');
        if (legend) legend.addEventListener('click', (e) => {
            const chip = e.target.closest('.map-chip');
            if (!chip) return;
            const key = chip.dataset.line || null;
            if (!key) { clearFocus(); return; }
            setLineFocus(key);
        });
        const fs = $('mapFullscreenBtn');
        if (fs) fs.addEventListener('click', () => {
            const shell = document.querySelector('.map-shell');
            shell.classList.toggle('fullscreen');
            document.body.classList.toggle('map-fullscreen', shell.classList.contains('fullscreen'));
            setTimeout(() => map.invalidateSize(), 250);
        });
        const loc = $('mapLocateBtn');
        if (loc) loc.addEventListener('click', () => {
            if (!navigator.geolocation) return;
            loc.classList.add('spinning');
            navigator.geolocation.getCurrentPosition(p => {
                loc.classList.remove('spinning');
                const ll = [p.coords.latitude, p.coords.longitude];
                if (LiveMap._me) map.removeLayer(LiveMap._me);
                LiveMap._me = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, className: 'map-me' }).addTo(map);
                map.flyTo(ll, 16, { duration: 0.9 });
            }, () => loc.classList.remove('spinning'), { enableHighAccuracy: true, timeout: 8000 });
        });
        const home = $('mapHomeBtn');
        if (home) home.addEventListener('click', () => map.flyTo(CENTER, 13, { duration: 0.8 }));
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !visible) return;
            if (focus) { clearFocus(); return; }
            const shell = document.querySelector('.map-shell.fullscreen');
            if (shell) { shell.classList.remove('fullscreen'); document.body.classList.remove('map-fullscreen'); setTimeout(() => map.invalidateSize(), 250); }
        });
    }

    // ---------------------------------------------------------
    // Public API
    // ---------------------------------------------------------
    LiveMap.init = function (o) {
        opts = o || {};
    };

    LiveMap.show = async function () {
        visible = true;
        setStatus('Karte wird geladen…', true);
        try {
            L = await loadLeaflet();
        } catch (e) {
            setStatus('Kartenbibliothek konnte nicht geladen werden (Internet?)', false);
            return;
        }
        if (!visible) return;
        if (!map) {
            createMap();
            wireControls();
        }
        setTimeout(() => map.invalidateSize(), 60);
        await loadNetwork();
        if (!visible) return;
        startPolling();
    };

    LiveMap.hide = function () {
        visible = false;
        stopPolling();
    };

    LiveMap.focusTrip = (id) => focusTrip(id);
    LiveMap.focusLine = (key) => setLineFocus(key);

    LiveMap.setTheme = function (t) {
        theme = t || 'light';
        const shell = document.querySelector('.map-shell');
        if (shell) shell.setAttribute('data-theme', theme);
        if (tileLayer) tileLayer.setUrl(tileUrl('base'));
        if (labelLayer) labelLayer.setUrl(tileUrl('labels'));
        if (stationLayer) stationLayer.eachLayer(m => m.setStyle({ color: palette().stop }));
        applyAllStyles();
        if (focus && focus.kind === 'trip') buildTripLayers();
    };

    window.LiveMap = LiveMap;
})();
