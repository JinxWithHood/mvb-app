/* Magdeburg Mobil — Wagenreihung in den Abfahrten (nur Züge & S-Bahnen)
   Lädt die Wagenreihung erst, wenn eine Zug-Abfahrt sichtbar wird, und zeigt
   Wagen als Seiten-Silhouette mit Nummer, Klasse und Abschnitt, dazu die
   Fahrtrichtung und – wenn vorhanden – die erwartete Auslastung.
   Gibt es keine Daten, bleibt die Abfahrt einfach wie sie ist. */
(function () {
    'use strict';

    const TRAIN_TYPES = new Set(['regional', 'express', 'sbahn']);
    const OK_TTL = 2 * 60 * 1000;
    const MISS_TTL = 10 * 60 * 1000;
    const MAX_PARALLEL = 2;
    const cache = new Map();      // key -> { at, data } | { promise }
    let disabledUntil = 0;        // server can't reach bahn.de -> pause
    let running = 0;
    const queue = [];

    const apiBase = () => (window.MVBApp && window.MVBApp.apiBase) || '/api';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pad = (n) => String(n).padStart(2, '0');

    function evaOf(station) {
        const id = String((station && station.id) || '');
        let m = id.match(/@L=(\d{7})@/);
        if (m) return m[1];
        if (/^8[01]\d{5}$/.test(id)) return id;
        m = id.match(/(?:^|\D)(8[01]\d{5})(?!\d)/);
        return m ? m[1] : null;
    }

    function requestOf(dep, eva) {
        const at = new Date();
        at.setDate(at.getDate() + (dep.day_offset || 0));
        const [h, mi] = String(dep.time).split(':').map(Number);
        at.setHours(h, mi, 0, 0);
        return requestAt({ eva, trainCat: dep.trainCat, trainNum: dep.trainNum, at });
    }

    // planned departure of one train at one station -> our API request + the direct bahn.de request
    function requestAt(o) {
        const at = o.at;
        const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
        const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
        const key = `${o.eva}|${o.trainCat}|${o.trainNum}|${date}|${time}`;
        const qs = `eva=${o.eva}&cat=${encodeURIComponent(o.trainCat)}&num=${encodeURIComponent(o.trainNum)}&date=${date}&time=${encodeURIComponent(time)}`;
        // the same request straight to bahn.de (time in UTC, as bahn.de expects it)
        const direct = 'https://www.bahn.de/web/api/reisebegleitung/wagenreihung/vehicle-sequence?' + new URLSearchParams({
            administrationId: '80', category: o.trainCat, date: at.toISOString().slice(0, 10),
            evaNumber: o.eva, number: o.trainNum, time: at.toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        }).toString();
        return { key, qs, at, direct };
    }

    // ------------------------------------------------------------------
    // bahn.de answer -> app format (mirror of formation.py normalize)
    // ------------------------------------------------------------------
    const AMENITY = { BISTRO: 'bistro', ZONE_QUIET: 'quiet', ZONE_FAMILY: 'family', WHEELCHAIR_SPACE: 'wheelchair', BIKE_SPACE: 'bike', SEATS_BAHN_COMFORT: 'comfort', CABIN_INFANT: 'infant', TOILET_WHEELCHAIR: 'wc' };
    const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const pf = raw.platform || {};
        const p0 = num(pf.start), p1 = num(pf.end);
        if (p0 == null || p1 == null || p1 <= p0) return null;
        const pct = (v) => Math.round(Math.max(0, Math.min(100, (v - p0) * 100 / (p1 - p0))) * 100) / 100;
        const groups = [], cars = [], listed = [];
        (raw.groups || []).forEach((g, gi) => {
            const vehicles = g.vehicles || [];
            const hauled = vehicles.some((v) => ['LOCOMOTIVE', 'POWERCAR'].includes(String((v.type || {}).category || '').toUpperCase()));
            const gcars = [];
            vehicles.forEach((v) => {
                const pos = v.platformPosition || {};
                const a = num(pos.start), b = num(pos.end);
                if (a == null || b == null) return;
                const t = v.type || {};
                const cat = String(t.category || '').toUpperCase();
                const first = !!t.hasFirstClass, second = !!t.hasEconomyClass;
                const amen = [];
                (v.amenities || []).forEach((am) => { const k = AMENITY[(am || {}).type]; if (k && !amen.includes(k)) amen.push(k); });
                let kind, cls = null;
                if (cat === 'LOCOMOTIVE') kind = 'loco';
                else if (cat === 'POWERCAR') kind = 'powercar';
                else {
                    const dd = cat.includes('DOUBLEDECK'), cab = cat.includes('CONTROLCAR');
                    kind = dd ? (cab ? 'ddcab' : 'dd') : (cab ? 'cab' : 'car');
                    if (cat.includes('DININGCAR') && !first && !second) cls = 'B';
                    else if (first && second) cls = '12';
                    else if (first) cls = '1';
                    else if (second) cls = '2';
                    else if (cat.includes('DINING')) cls = 'B';
                    if (cat.includes('DININGCAR') && !amen.includes('bistro')) amen.unshift('bistro');
                }
                const car = {
                    num: String(v.wagonIdentificationNumber || '').trim() || null, cls, kind, sector: pos.sector || null,
                    start: pct(Math.min(a, b)), end: pct(Math.max(a, b)), closed: String(v.status || '').toUpperCase() === 'CLOSED',
                    amenities: amen.slice(0, 4), group: gi, multipleUnit: !hauled,
                };
                gcars.push(car); listed.push(car);
            });
            if (!gcars.length) return;
            const tr = g.transport || {};
            groups.push({ index: gi, cat: tr.category || null, num: tr.number != null ? String(tr.number) : null, destination: ((tr.destination || {}).name || '').trim() || null });
            cars.push(...gcars);
        });
        if (!cars.length) return null;
        let direction = null;
        if (listed.length > 1) direction = listed[0].start > listed[listed.length - 1].start ? 'right' : 'left';
        // draw the platform like the station signs: section A on the left
        const secs = (pf.sectors || []).filter((x) => x && x.name && num(x.start) != null).sort((x, y) => num(x.start) - num(y.start));
        if (secs.length > 1 && String(secs[0].name) > String(secs[secs.length - 1].name)) {
            cars.forEach((c) => { const a = c.start; c.start = Math.round((100 - c.end) * 100) / 100; c.end = Math.round((100 - a) * 100) / 100; });
            direction = direction === 'left' ? 'right' : direction === 'right' ? 'left' : direction;
        }
        cars.sort((x, y) => x.start - y.start);
        [...new Set(cars.map((c) => c.group))].forEach((gi) => {
            const gc = cars.filter((c) => c.group === gi);
            const head = gc[0], tail = gc[gc.length - 1];
            if ((head.multipleUnit && ['car', 'cab'].includes(head.kind)) || head.kind === 'powercar') head.nose = 'left';
            if ((tail.multipleUnit && ['car', 'cab'].includes(tail.kind)) || tail.kind === 'powercar') tail.nose = 'right';
            gc.forEach((c) => { if (['ddcab', 'cab'].includes(c.kind) && !c.nose) c.nose = c === head ? 'left' : 'right'; });
        });
        const dests = new Set(groups.map((g) => g.destination).filter(Boolean));
        return { available: true, platform: raw.departurePlatform || raw.departurePlatformSchedule || null, direction, groups, split: groups.length > 1 && dests.size > 1, cars };
    }

    // Our server is blocked by bahn.de (datacenter IP) -> ask bahn.de straight from this device.
    let serverBlocked = false;
    let directBroken = false;
    function fetchDirect(url) {
        if (directBroken) return Promise.resolve(null);
        return fetch(url, { credentials: 'omit', mode: 'cors' })
            .then((r) => (r.ok ? r.json() : null))
            .then((raw) => normalize(raw))
            .catch(() => { directBroken = true; return null; });   // CORS / network: stop trying
    }

    function cached(key) {
        const hit = cache.get(key);
        if (!hit || hit.promise) return undefined;
        if (Date.now() - hit.at > (hit.data ? OK_TTL : MISS_TTL)) { cache.delete(key); return undefined; }
        return hit.data;
    }

    function pump() {
        while (running < MAX_PARALLEL && queue.length) {
            const job = queue.shift();
            running++;
            const ask = () => fetch(`${apiBase()}/formation?${job.qs}`).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
            // the home helper fetches it: ask again a few times while it is "pending"
            const askPatiently = (tries) => ask().then((d) => (d && d.pending && tries > 0
                ? new Promise((res) => setTimeout(res, 3500)).then(() => askPatiently(tries - 1))
                : d));
            const viaServer = serverBlocked ? Promise.resolve({ blocked: true }) : askPatiently(5);
            viaServer
                .then((data) => {
                    if (data && data.blocked) {
                        serverBlocked = true;
                        return fetchDirect(job.direct);
                    }
                    return data && data.available ? data : null;
                })
                .then((data) => {
                    const ok = data && data.available && Array.isArray(data.cars) && data.cars.length ? data : null;
                    if (directBroken && serverBlocked) disabledUntil = Date.now() + 10 * 60 * 1000;
                    if (data && data.pending) cache.delete(job.key);          // helper slow: try again next time
                    else cache.set(job.key, { at: Date.now(), data: ok });
                    job.resolve(ok);
                })
                .finally(() => { running--; pump(); });
        }
    }

    function load(req) {
        const hit = cache.get(req.key);
        if (hit && hit.promise) return hit.promise;
        const promise = new Promise((resolve) => queue.push({ key: req.key, qs: req.qs, direct: req.direct, resolve }));
        cache.set(req.key, { promise });
        pump();
        return promise;
    }

    let observer = null;
    const pending = new WeakMap();
    function whenVisible(el, fn) {
        if (!('IntersectionObserver' in window)) { fn(); return; }
        if (!observer) {
            observer = new IntersectionObserver((entries) => {
                entries.forEach((en) => {
                    if (!en.isIntersecting) return;
                    observer.unobserve(en.target);
                    const cb = pending.get(en.target);
                    pending.delete(en.target);
                    if (cb) cb();
                });
            }, { rootMargin: '200px 0px' });
        }
        pending.set(el, fn);
        observer.observe(el);
    }

    // ------------------------------------------------------------------
    // Silhouettes (side view, front to the LEFT; flipped for the right)
    // ------------------------------------------------------------------
    const f = (n) => Math.round(n * 10) / 10;
    function panes(x0, x1, y0, y1, pitch) {
        const n = Math.max(1, Math.floor((x1 - x0 + 1) / pitch));
        const w = (x1 - x0 - (n - 1) * 1.4) / n;
        let d = '';
        for (let i = 0; i < n; i++) { const x = x0 + i * (w + 1.4); d += `M${f(x)} ${y0}h${f(w)}v${y1 - y0}h${f(-w)}Z`; }
        return d;
    }
    const wheel = (x) => `M${f(x - 1.8)} 26a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0`;
    const wheels = (W, a) => wheel(a || 4) + wheel((a || 4) + 3.6) + wheel(W - 7.6) + wheel(W - 4);
    const dbl = (x) => `M${f(x)} 7v14M${f(x + 2.6)} 7v14`;

    function shape(kind, W) {
        const v = { body: '', win: '', doors: '', wheels: wheels(W), panto: '' };
        const box = `M1.5 3H${W - 1.5}Q${W} 3 ${W} 4.5V21.5Q${W} 23 ${W - 1.5} 23H1.5Q0 23 0 21.5V4.5Q0 3 1.5 3Z`;
        if (kind === 'mid') {
            v.body = box; v.win = panes(6.5, W - 6.5, 7.5, 12.5, 5.2); v.doors = dbl(2) + dbl(W - 4.6);
        } else if (kind === 'emuMid') {
            v.body = box;
            v.win = panes(3, W / 2 - 3.5, 7.5, 12.5, 5.2) + panes(W / 2 + 3.5, W - 3, 7.5, 12.5, 5.2);
            v.doors = dbl(W / 2 - 1.3);
        } else if (kind === 'nose') {
            v.body = `M${W} 3H14C8.4 3 4 7.6 1.6 14.4Q0.4 18.2 0.8 20.6Q1.2 23 4.4 23H${W}Z`;
            v.win = 'M12.8 5C9 5.3 6.2 8.2 4.6 12H10Q11.8 12 12.2 10Z' + panes(16.5, W - 6.5, 7.5, 12.5, 5.2);
            v.doors = dbl(W - 4.6); v.wheels = wheels(W, 6.5);
        } else if (kind === 'emuNose') {
            v.body = `M${W} 3H9.5Q3 3 1.4 8.5Q0.6 11.5 0.6 15V21Q0.6 23 2.6 23H${W}Z`;
            v.win = 'M8.8 5Q5 5.4 3.6 9.5L3.2 12H8.4Q9.6 12 9.8 10.6Z' + panes(12, W * 0.55 - 3, 7.5, 12.5, 5.2) + panes(W * 0.55 + 5.6, W - 3, 7.5, 12.5, 5.2);
            v.doors = dbl(W * 0.55); v.wheels = wheels(W, 5);
        } else if (kind === 'loco') {
            v.body = `M2.5 3H${W - 2.5}Q${W} 3 ${W} 6V21.5Q${W} 23 ${W - 1.5} 23H1.5Q0 23 0 21.5V6Q0 3 2.5 3Z`;
            v.win = `M1.4 6.6h3.4v4.8H1.4Z M${f(W - 4.8)} 6.6h3.4v4.8h-3.4Z M${f(W / 2 - 5)} 8h10v3.4h-10Z`;
            v.doors = `M6.6 6.6v14M${f(W - 6.6)} 6.6v14`;
            v.panto = `M${f(W / 2 - 5)} 3L${f(W / 2 - 1)} 0H${f(W / 2 + 4)}M${f(W / 2 - 1)} 0L${f(W / 2 + 3)} 3`;
        } else if (kind === 'dd' || kind === 'ddcab') {
            const cab = kind === 'ddcab';
            v.body = cab
                ? `M${W} 2.5Q${W} 0.5 ${W - 2} 0.5H11C5.6 0.5 2.4 7 0.8 14.5Q0.3 17.5 0.4 21.5Q0.5 23 1.8 23H${W - 1.5}Q${W} 23 ${W} 21.5Z`
                : `M2 0.5H${W - 2}Q${W} 0.5 ${W} 2.5V21.5Q${W} 23 ${W - 1.5} 23H1.5Q0 23 0 21.5V2.5Q0 0.5 2 0.5Z`;
            const x0 = cab ? 13 : 6;
            v.win = panes(x0, W - 6, 3.5, 7.5, 5.4) + panes(x0, W - 6, 11.5, 15.5, 5.4) + (cab ? 'M10.2 2.2C6.6 2.6 4.4 6.4 3.2 10.6H8.4Q10 10.6 10.4 8.4Z' : '');
            v.doors = `M${f(W * 0.26)} 10v13M${f(W * 0.26 + 2.8)} 10v13M${f(W * 0.7)} 10v13M${f(W * 0.7 + 2.8)} 10v13`;
        }
        return v;
    }

    const HIGHSPEED = new Set(['ICE', 'ICD', 'ECE', 'TGV', 'RJ', 'RJX']);
    function silhouetteOf(car, groupCat) {
        let kind = 'mid';
        if (car.kind === 'loco') kind = 'loco';
        else if (car.kind === 'powercar') kind = 'nose';
        else if (car.kind === 'dd') kind = 'dd';
        else if (car.kind === 'ddcab') kind = 'ddcab';
        else if (car.nose) kind = HIGHSPEED.has(groupCat) ? 'nose' : 'emuNose';
        else if (car.multipleUnit && !HIGHSPEED.has(groupCat)) kind = 'emuMid';
        const W = { loco: 30, nose: 46, emuNose: 48, dd: 54, ddcab: 58, emuMid: 44, mid: 40 }[kind];
        const flip = car.nose === 'right';
        return { kind, W, flip };
    }

    function carHtml(car, groupCat) {
        const s = silhouetteOf(car, groupCat);
        const v = shape(s.kind, s.W);
        const loco = car.kind === 'loco' || car.kind === 'powercar';
        const clsLabel = loco ? '' : car.cls === '1' ? '1. Kl.' : car.cls === '2' ? '2. Kl.' : car.cls === '12' ? '1./2. Kl.' : car.cls === 'B' ? 'Bistro' : '';
        const tone = loco ? 'loco' : car.cls === '1' || car.cls === '12' ? 'c1' : car.cls === 'B' ? 'cb' : 'c2';
        const title = loco ? (car.kind === 'loco' ? 'Lok' : 'Triebkopf')
            : `Wagen ${car.num || '?'}${clsLabel ? ', ' + clsLabel.replace('Kl.', 'Klasse') : ''}${car.sector ? ', Abschnitt ' + car.sector : ''}${car.closed ? ', geschlossen' : ''}`;
        const flip = s.flip ? ` transform="translate(${s.W} 0) scale(-1 1)"` : '';
        return `<span class="fm-car ${tone}${car.closed ? ' closed' : ''}" title="${esc(title)}">
            <svg width="${s.W}" height="30" viewBox="0 -1 ${s.W} 30" role="img" aria-label="${esc(title)}">
              <g${flip} fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round">
                <path d="${v.panto}" stroke-width="0.9"/>
                <path d="${v.body}" stroke-width="1.4"${car.closed ? ' stroke-dasharray="2.5 2"' : ''}/>
                <path d="${v.win}" stroke-width="0.8" opacity="0.75"/>
                <path d="${v.doors}" stroke-width="0.8" opacity="0.55"/>
                <path d="${v.wheels}" stroke-width="0.9"/>
              </g>
            </svg>
            <strong>${loco ? (car.kind === 'loco' ? 'Lok' : '') : esc(car.num || '')}</strong>
            <span class="fm-cls">${esc(car.closed ? 'zu' : clsLabel)}</span>
            ${car.sector ? `<span class="fm-sec">${esc(car.sector)}</span>` : '<span class="fm-sec empty"></span>'}
        </span>`;
    }

    const OCC = { 1: ['gering', 'o1'], 2: ['mittel', 'o2'], 3: ['hoch', 'o3'], 4: ['sehr hoch', 'o4'] };
    const ARROW_L = 'M19 12H5M11 6l-6 6 6 6';
    const ARROW_R = 'M5 12h14M13 6l6 6-6 6';
    const arrowSvg = (d) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

    function render(slot, data, dep) {
        if (!slot || !slot.isConnected) return;
        if (!data) { slot.remove(); return; }
        const cars = data.cars;
        const groupCat = {};
        (data.groups || []).forEach((g) => { groupCat[g.index] = String(g.cat || dep.trainCat || '').toUpperCase(); });
        const partTone = {};
        if (data.split) (data.groups || []).forEach((g, i) => { partTone[g.index] = i % 2 ? 'pb' : 'pa'; });

        let html = '';
        const dir = data.direction;
        if (dir === 'left') html += `<span class="fm-lead">${arrowSvg(ARROW_L)}</span>`;
        cars.forEach((c, i) => {
            if (i > 0 && cars[i - 1].group !== c.group) html += '<span class="fm-coupler" aria-hidden="true"></span>';
            const inner = carHtml(c, groupCat[c.group] || String(dep.trainCat || '').toUpperCase());
            html += partTone[c.group] ? inner.replace('class="fm-car ', `class="fm-car ${partTone[c.group]} `) : inner;
        });
        if (dir === 'right') html += `<span class="fm-lead">${arrowSvg(ARROW_R)}</span>`;

        const chips = [];
        if (dir) {
            const front = dir === 'left' ? cars[0] : cars[cars.length - 1];
            chips.push(`<span class="fm-chip fm-dir">${arrowSvg(dir === 'left' ? ARROW_L : ARROW_R)}Fährt nach ${dir === 'left' ? 'links' : 'rechts'} aus${front && front.sector ? ` (Abschnitt ${esc(front.sector)})` : ''}</span>`);
        }
        const first = [...new Set(cars.filter((c) => c.cls === '1' || c.cls === '12').map((c) => c.sector).filter(Boolean))];
        if (first.length) chips.push(`<span class="fm-chip fm-first"><i></i>1. Klasse: ${esc(first.join(', '))}</span>`);
        const occ = dep.occupancy || {};
        ['1', '2'].forEach((k) => {
            const o = OCC[occ[k]];
            if (o) chips.push(`<span class="fm-chip fm-occ ${o[1]}"><b><i></i><i></i><i></i></b>${k}. Kl. ${o[0]}</span>`);
        });

        let split = '';
        if (data.split) {
            split = '<div class="fm-split">' + (data.groups || []).map((g, i) => {
                const secs = [...new Set(cars.filter((c) => c.group === g.index).map((c) => c.sector).filter(Boolean))];
                const range = secs.length ? ` · ${secs[0]}${secs.length > 1 ? '–' + secs[secs.length - 1] : ''}` : '';
                return `<span class="fm-part ${i % 2 ? 'pb' : 'pa'}"><small>${esc((g.cat || '') + ' ' + (g.num || ''))}</small><strong>${esc(g.destination || '')}${esc(range)}</strong></span>`;
            }).join('') + '</div>';
        }

        slot.innerHTML = `<div class="fm" aria-label="Wagenreihung">
            <div class="fm-scroll"><div class="fm-train">${html}</div></div>
            ${split}
            <div class="fm-meta">${chips.join('')}</div>
        </div>`;
        slot.classList.add('ready');
        const fit = () => {
            const sc = slot.querySelector('.fm-scroll');
            if (sc && sc.scrollWidth > sc.clientWidth + 4) {
                sc.classList.add('overflow');
                if (dir === 'right' && !sc.dataset.touched) sc.scrollLeft = sc.scrollWidth;
                const edge = () => sc.classList.toggle('at-end', sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 2);
                edge();
                if (!sc.dataset.edge) { sc.dataset.edge = '1'; sc.addEventListener('scroll', edge, { passive: true }); }
            }
        };
        const sc0 = slot.querySelector('.fm-scroll');
        if (sc0) sc0.addEventListener('pointerdown', () => { sc0.dataset.touched = '1'; }, { once: true });
        requestAnimationFrame(fit);
        setTimeout(fit, 350);
    }

    function usable(req) {
        const mins = (req.at - Date.now()) / 60000;
        return mins >= -30 && mins <= 6 * 60;          // bahn.de knows formations only around departure
    }

    // fill `slot` (already in the page) for one request; `watch` = element whose visibility starts the load
    function mount(slot, req, info, watch) {
        slot.addEventListener('click', (e) => { if (e.target.closest('.fm-scroll')) e.stopPropagation(); });
        const hit = cached(req.key);
        if (hit !== undefined) { render(slot, hit, info); return; }
        whenVisible(watch || slot, () => {
            if (Date.now() < disabledUntil) { slot.remove(); return; }
            load(req).then((data) => render(slot, data, info));
        });
    }

    // departure list card
    function attach(card, dep, station) {
        try {
            if (!card || !dep || !TRAIN_TYPES.has(dep.type) || !dep.trainCat || !dep.trainNum || dep.cancelled) return;
            if (Date.now() < disabledUntil) return;
            const eva = evaOf(station);
            if (!eva) return;
            const req = requestOf(dep, eva);
            if (!usable(req)) return;
            const slot = document.createElement('div');
            slot.className = 'fm-slot';
            card.appendChild(slot);
            mount(slot, req, dep, card);
        } catch (e) {
            /* never break the departure list */
        }
    }

    // journey detail (Linienverlauf) of a departure: box right above `anchor`
    function attachDetail(anchor, dep, station) {
        try {
            if (!anchor || !anchor.parentNode) return;
            const old = anchor.parentNode.querySelector(':scope > .fm-detail');
            if (old) old.remove();
            if (!dep || !TRAIN_TYPES.has(dep.type) || !dep.trainCat || !dep.trainNum || dep.cancelled) return;
            if (Date.now() < disabledUntil) return;
            const eva = dep.fromEva || evaOf(station || { id: dep.station_id });
            if (!eva) return;
            const req = requestOf(dep, eva);
            if (!usable(req)) return;
            const slot = document.createElement('div');
            slot.className = 'fm-slot fm-detail';
            anchor.parentNode.insertBefore(slot, anchor);
            mount(slot, req, dep, slot.parentNode);
        } catch (e) { /* optional */ }
    }

    // Verbindungssuche: one transit leg (needs trainCat, trainNum, fromEva, from.plannedIso)
    function mountLeg(slot, leg) {
        try {
            if (!slot || !leg || !TRAIN_TYPES.has(leg.type) || !leg.trainCat || !leg.trainNum || !leg.fromEva || leg.cancelled) { if (slot) slot.remove(); return; }
            if (Date.now() < disabledUntil) { slot.remove(); return; }
            const at = leg.from && leg.from.plannedIso ? new Date(leg.from.plannedIso) : null;
            if (!at || isNaN(at)) { slot.remove(); return; }
            const req = requestAt({ eva: leg.fromEva, trainCat: leg.trainCat, trainNum: leg.trainNum, at });
            if (!usable(req)) { slot.remove(); return; }
            slot.classList.add('fm-slot');
            mount(slot, req, { trainCat: leg.trainCat, occupancy: leg.occupancy }, slot.parentNode);
        } catch (e) { /* optional */ }
    }

    // Selbsttest: ?fmtest=1 an die Adresse hängen -> zeigt, ob dieses Gerät bahn.de direkt fragen darf
    async function selfTest() {
        const say = (msg, kind) => { if (window.MVBApp && window.MVBApp.showToast) window.MVBApp.showToast(msg, kind || 'info'); else console.log(msg); };
        try {
            const d = await fetch(`${apiBase()}/formation/diag`).then((r) => r.json());
            const t = (d.trains || []).find((x) => x.trainCat && x.trainNum);
            if (!t) { say('Wagenreihung-Test: gerade kein Zug am Magdeburg Hbf gefunden.'); return; }
            const req = requestOf({ trainCat: t.trainCat, trainNum: t.trainNum, time: t.time, day_offset: 0 }, '8010224');
            let res;
            try {
                const r = await fetch(req.direct, { credentials: 'omit', mode: 'cors' });
                res = `HTTP ${r.status}`;
                if (r.ok) { const n = normalize(await r.json()); res += n ? ` · ${n.cars.length} Wagen erkannt ✅` : ' · keine Wagen'; }
            } catch (e) {
                res = 'vom Browser blockiert (CORS) ❌';
            }
            say(`Wagenreihung-Test (${t.trainCat} ${t.trainNum}): ${res}`, res.includes('✅') ? 'success' : 'info');
        } catch (e) {
            say('Wagenreihung-Test fehlgeschlagen: Server nicht erreichbar.');
        }
    }
    if (/[?&]fmtest=1/.test(location.search)) setTimeout(selfTest, 2500);

    window.MVBFormation = { attach, attachDetail, mountLeg, selfTest };
})();
