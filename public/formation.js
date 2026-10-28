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
        const d = new Date();
        d.setDate(d.getDate() + (dep.day_offset || 0));
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const key = `${eva}|${dep.trainCat}|${dep.trainNum}|${date}|${dep.time}`;
        const qs = `eva=${eva}&cat=${encodeURIComponent(dep.trainCat)}&num=${encodeURIComponent(dep.trainNum)}&date=${date}&time=${encodeURIComponent(dep.time)}`;
        const [h, mi] = String(dep.time).split(':').map(Number);
        const at = new Date(d); at.setHours(h, mi, 0, 0);
        return { key, qs, at };
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
            fetch(`${apiBase()}/formation?${job.qs}`)
                .then((r) => r.json().catch(() => ({})))
                .catch(() => ({}))
                .then((data) => {
                    if (data && data.blocked) disabledUntil = Date.now() + 10 * 60 * 1000;
                    const ok = data && data.available && Array.isArray(data.cars) && data.cars.length ? data : null;
                    cache.set(job.key, { at: Date.now(), data: ok });
                    job.resolve(ok);
                })
                .finally(() => { running--; pump(); });
        }
    }

    function load(req) {
        const hit = cache.get(req.key);
        if (hit && hit.promise) return hit.promise;
        const promise = new Promise((resolve) => queue.push({ key: req.key, qs: req.qs, resolve }));
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
        requestAnimationFrame(() => {
            const sc = slot.querySelector('.fm-scroll');
            if (sc && sc.scrollWidth > sc.clientWidth + 4) {
                sc.classList.add('overflow');
                if (dir === 'right') sc.scrollLeft = sc.scrollWidth;
            }
        });
    }

    function attach(card, dep, station) {
        try {
            if (!card || !dep || !TRAIN_TYPES.has(dep.type) || !dep.trainCat || !dep.trainNum || dep.cancelled) return;
            if (Date.now() < disabledUntil) return;
            const eva = evaOf(station);
            if (!eva) return;
            const req = requestOf(dep, eva);
            const mins = (req.at - Date.now()) / 60000;
            if (mins < -30 || mins > 6 * 60) return;      // bahn.de knows formations only around departure
            const slot = document.createElement('div');
            slot.className = 'fm-slot';
            slot.addEventListener('click', (e) => { if (e.target.closest('.fm-scroll')) e.stopPropagation(); });
            card.appendChild(slot);
            const hit = cached(req.key);
            if (hit !== undefined) { render(slot, hit, dep); return; }
            whenVisible(card, () => {
                if (Date.now() < disabledUntil) { slot.remove(); return; }
                load(req).then((data) => render(slot, data, dep));
            });
        } catch (e) {
            /* never break the departure list */
        }
    }

    window.MVBFormation = { attach };
})();
