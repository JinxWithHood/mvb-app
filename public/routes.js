/* ============================================================
   Magdeburg Mobil — Verbindungssuche (Fahrplan-Tab)
   - "Nach"-Feld, Abfahrt/Ankunft, früher/später, Live-Aktualisierung
   - Daten: /api/routes (bahn.de bundesweit, NASA als Ersatz)
   - "Fahrt verfolgen": kompletter Linienverlauf jeder Teilstrecke
   ============================================================ */
(function () {
    'use strict';

    const RECENT_KEY = 'mvb_recent_routes';
    const REFRESH_MS = 60000;
    const TYPE_NAMES = {
        tram: 'Straßenbahn', bus: 'Bus', sev: 'Ersatzverkehr', sbahn: 'S-Bahn', ubahn: 'U-Bahn',
        regional: 'Regionalzug', express: 'Fernverkehr', ferry: 'Fähre', hsb: 'Harzer Schmalspurbahn',
    };

    let A = null;               // window.MVBApp
    let destStation = null;
    let timeMode = 'dep';
    let state = { conns: [], earlier: null, later: null, params: null, source: null, from: null, to: null, notice: null };
    let expanded = new Set();
    let reqSeq = 0;
    let refreshTimer = null;
    let lastLoadedAt = 0;

    const $ = (id) => document.getElementById(id);
    const esc = (s) => (A ? A.escapeHtml(s == null ? '' : String(s)) : String(s == null ? '' : s));

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------
    function fmtDur(min) {
        min = Math.max(0, Math.round(min || 0));
        if (min < 60) return `${min} Min`;
        const h = Math.floor(min / 60), m = min % 60;
        return m ? `${h} Std ${m} Min` : `${h} Std`;
    }

    function fmtTransfers(n) {
        if (!n) return 'Direkt';
        return `${n} Umstieg${n > 1 ? 'e' : ''}`;
    }

    function fmtPrice(p) {
        if (!p || p.amount == null) return '';
        const v = Number(p.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return `${p.partial ? 'ab ' : ''}${v} €`;
    }

    function shortName(n) {
        return (n || '').replace(/^Magdeburg,\s*/, '').replace(/,\s*Magdeburg$/, '');
    }

    function timeHtml(pt, big) {
        if (!pt) return '';
        const cls = big ? 'rt-time big' : 'rt-time';
        if (pt.cancelled) return `<span class="${cls} cancelled"><s>${esc(pt.planned)}</s></span>`;
        if (pt.rt && pt.rt !== pt.planned) {
            const late = (pt.delay || 0) > 0;
            return `<span class="${cls}"><s class="rt-planned">${esc(pt.planned)}</s><span class="rt-actual ${late ? 'late' : 'early'}">${esc(pt.rt)}</span></span>`;
        }
        return `<span class="${cls}${pt.rt ? ' ontime' : ''}">${esc(pt.planned)}</span>`;
    }

    function delayTag(pt) {
        if (!pt) return '';
        if (pt.cancelled) return '<span class="rt-tag bad">fällt aus</span>';
        if (pt.delay == null) return '';
        if (pt.delay >= 3) return `<span class="rt-tag warn">+${pt.delay} Min</span>`;
        if (pt.delay > 0) return `<span class="rt-tag mild">+${pt.delay}</span>`;
        if (pt.delay < 0) return `<span class="rt-tag early">${pt.delay}</span>`;
        return '<span class="rt-tag ok">pünktlich</span>';
    }

    function platformTag(pt) {
        if (!pt || !pt.platform) return '';
        const changed = pt.rtPlatform && pt.rtPlatform !== pt.platform;
        const label = /^[A-Za-z]$/.test(pt.platform) ? 'Steig' : 'Gl.';
        return changed
            ? `<span class="plat-tag changed" title="Gleiswechsel">${label} ${esc(pt.rtPlatform)} <s>${esc(pt.platform)}</s></span>`
            : `<span class="plat-tag">${label} ${esc(pt.platform)}</span>`;
    }

    function lineBadge(leg, small) {
        const dark = A && A.getLuminance(leg.color) > 180;
        const round = leg.type === 'bus' || leg.type === 'sev';
        return `<span class="rl-badge${small ? ' small' : ''}${dark ? ' dark-text' : ''}${round ? ' round' : ''}" style="background:${esc(leg.color)}">${esc(leg.label || leg.line)}</span>`;
    }

    function minutesUntil(iso) {
        if (!iso) return null;
        const t = new Date(iso).getTime();
        if (isNaN(t)) return null;
        return Math.round((t - Date.now()) / 60000);
    }

    // ------------------------------------------------------------------
    // Recent routes
    // ------------------------------------------------------------------
    function getRecent() {
        try {
            const l = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(l) ? l.filter(r => r && r.from && r.to && r.from.name && r.to.name) : [];
        } catch (e) { return []; }
    }

    function rememberRoute(from, to) {
        if (!from || !to) return;
        const key = (r) => `${r.from.name}→${r.to.name}`;
        const entry = { from: { id: from.id, name: from.name, kind: from.kind }, to: { id: to.id, name: to.name, kind: to.kind } };
        const list = [entry, ...getRecent().filter(r => key(r) !== key(entry))].slice(0, 5);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
        renderRecent();
    }

    function renderRecent() {
        let wrap = $('quickRoutes');
        const anchor = $('quickStations');
        if (!wrap && anchor) {
            wrap = document.createElement('div');
            wrap.id = 'quickRoutes';
            wrap.className = 'quick-stations quick-routes only-routes';
            wrap.setAttribute('aria-label', 'Letzte Strecken');
            anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
        }
        if (!wrap) return;
        const list = getRecent();
        wrap.hidden = list.length === 0;
        wrap.innerHTML = list.length ? '<span class="quick-stations-label"><svg class="ico" aria-hidden="true"><use href="#i-route"/></svg>Strecken</span>' : '';
        list.forEach(r => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'quick-station-chip route-chip';
            b.textContent = `${shortName(r.from.name)} → ${shortName(r.to.name)}`;
            b.title = `${r.from.name} → ${r.to.name}`;
            b.addEventListener('click', () => {
                A.setCurrentStation(r.from);
                setDest(r.to);
                A.submit();
            });
            wrap.appendChild(b);
        });
    }

    // ------------------------------------------------------------------
    // Form state
    // ------------------------------------------------------------------
    function hasDestination() {
        const di = $('destInput');
        return !!(di && di.value.trim());
    }

    function setDest(st) {
        destStation = st || null;
        const di = $('destInput');
        if (di) di.value = st ? st.name : '';
        const cl = $('clearDest');
        if (cl) cl.hidden = !st;
        updateMode();
    }

    function updateMode() {
        const form = $('form-departures');
        if (form) form.classList.toggle('has-dest', hasDestination());
    }

    function setTimeMode(mode) {
        timeMode = mode === 'arr' ? 'arr' : 'dep';
        document.querySelectorAll('#timeModeGroup .plan-seg-btn').forEach(b => {
            const on = b.dataset.timemode === timeMode;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    async function resolveDest() {
        const di = $('destInput');
        const text = di ? di.value.trim() : '';
        if (!text) return null;
        if (destStation && destStation.name === text) return destStation;
        const st = await A.resolveStationFromText(text);
        if (st) setDest(st);
        return st;
    }

    // ------------------------------------------------------------------
    // Search
    // ------------------------------------------------------------------
    function buildParams(page) {
        const s = window.MVBSettings ? window.MVBSettings.get() : null;
        const from = A.getCurrentStation();
        const to = destStation;
        const dt = A.getDateTime();
        const p = new URLSearchParams();
        p.set('from', from.id || '');
        p.set('fromName', from.name || '');
        p.set('to', to.id || '');
        p.set('toName', to.name || '');
        if (dt.date) p.set('date', dt.date);
        if (dt.time) p.set('time', dt.time);
        if (timeMode === 'arr') p.set('arrive', '1');
        if (s) {
            const modes = Object.keys(s.modes).filter(k => s.modes[k]);
            if (modes.length && modes.length < Object.keys(s.modes).length) p.set('modes', modes.join(','));
            if (s.maxChanges >= 0) p.set('maxChanges', String(s.maxChanges));
            if (s.minChange > 0) p.set('minChange', String(s.minChange));
            if (s.dticket) p.set('dticket', '1');
            if (s.bike) p.set('bike', '1');
        }
        if (page) p.set('page', page);
        return p;
    }

    async function search(opts) {
        opts = opts || {};
        const page = opts.page || null;
        const silent = !!opts.silent;
        const from = A.getCurrentStation();
        if (!from || !from.name) {
            A.showToast('Bitte gib einen Startpunkt ein', 'warning');
            return;
        }
        if (!page && !silent) {
            const to = await resolveDest();
            if (!to) {
                A.showToast('Ziel nicht gefunden – wähle es am besten aus der Liste', 'warning');
                const di = $('destInput');
                if (di) di.focus();
                return;
            }
            if (String(to.id) === String(from.id)) {
                A.showToast('Start und Ziel sind gleich 🙃', 'warning');
                return;
            }
        }
        if (!destStation) return;

        const params = page ? state.params : buildParams(null);
        const query = page ? new URLSearchParams(params) : params;
        if (page) query.set('page', page);
        const seq = ++reqSeq;

        const list = $('routesList'), loading = $('routesLoading'), empty = $('routesEmpty');
        if (!page && !silent) {
            expanded.clear();
            list.innerHTML = '';
            empty.hidden = true;
            loading.hidden = false;
            $('routesEarlier').hidden = true;
            $('routesLater').hidden = true;
            setMeta(`${shortName(from.name)} → ${shortName(destStation.name)}`, 'Suche läuft…');
        }
        const moreBtn = page ? (opts.dir === 'earlier' ? $('routesEarlier') : $('routesLater')) : null;
        if (moreBtn) { moreBtn.disabled = true; moreBtn.classList.add('loading'); }

        try {
            const res = await fetch(`${A.apiBase}/routes?${query.toString()}`);
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            if (seq !== reqSeq && !page) return;
            if (!res.ok || !data || data.error) {
                throw new Error((data && data.error) || 'Verbindungssuche gerade nicht möglich');
            }
            const incoming = Array.isArray(data.connections) ? data.connections : [];
            if (page) {
                const known = new Set(state.conns.map(c => c.key));
                const fresh = incoming.filter(c => !known.has(c.key));
                if (opts.dir === 'earlier') {
                    state.conns = fresh.concat(state.conns);
                    state.earlier = data.earlier;
                } else {
                    state.conns = state.conns.concat(fresh);
                    state.later = data.later;
                }
                if (!fresh.length) A.showToast(opts.dir === 'earlier' ? 'Keine früheren Verbindungen gefunden' : 'Keine weiteren Verbindungen gefunden', 'info');
            } else {
                state = {
                    conns: incoming, earlier: data.earlier, later: data.later, params,
                    source: data.source, from: data.from, to: data.to, notice: data.notice || null,
                };
                if (!silent) rememberRoute(from, destStation);
            }
            lastLoadedAt = Date.now();
            render();
            scheduleRefresh();
        } catch (err) {
            console.warn('Verbindungssuche:', err);
            if (silent) return;
            if (page) {
                A.showToast(err.message || 'Laden fehlgeschlagen', 'warning');
            } else {
                list.innerHTML = `<div class="error-card glass-card routes-error">
                    <strong>Verbindungen konnten nicht geladen werden.</strong>
                    <span>${esc(err.message || '')}</span>
                    <button type="button" class="routes-retry">Nochmal versuchen</button>
                </div>`;
                const r = list.querySelector('.routes-retry');
                if (r) r.addEventListener('click', () => search());
                setMeta(`${shortName(from.name)} → ${shortName(destStation.name)}`, 'Fehler beim Laden');
            }
        } finally {
            if (seq === reqSeq || page) loading.hidden = true;
            if (moreBtn) { moreBtn.disabled = false; moreBtn.classList.remove('loading'); }
        }
    }

    function setMeta(title, meta) {
        const t = $('routesTitle'), m = $('routesMeta');
        if (t) t.textContent = title;
        if (m) m.textContent = meta;
    }

    function scheduleRefresh() {
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => {
            const view = $('planRoutes');
            if (!view || view.hidden || document.hidden || !state.params || !A.isNowMode()) return;
            if (Date.now() - lastLoadedAt < REFRESH_MS - 2000) return;
            search({ silent: true });
        }, 15000);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function render() {
        const list = $('routesList'), empty = $('routesEmpty');
        const from = A.getCurrentStation();
        const conns = state.conns || [];
        const fromN = shortName((state.from && state.from.name) || from.name);
        const toN = shortName((state.to && state.to.name) || (destStation && destStation.name));
        const when = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        setMeta(`${fromN} → ${toN}`, `${conns.length} ${conns.length === 1 ? 'Verbindung' : 'Verbindungen'} · ${timeMode === 'arr' ? 'Ankunft' : 'Abfahrt'} · Echtzeit von ${when}`);

        const notice = $('routesNotice');
        if (notice) {
            notice.hidden = !state.notice;
            notice.textContent = state.notice || '';
        }

        list.innerHTML = '';
        if (!conns.length) {
            empty.hidden = false;
            const et = empty.querySelector('.empty-title'), es = empty.querySelector('.empty-subtitle');
            if (et) et.textContent = 'Keine Verbindung gefunden';
            if (es) es.textContent = 'Probier eine andere Uhrzeit, mehr Verkehrsmittel oder mehr Umstiege in den Optionen.';
        } else {
            empty.hidden = true;
        }
        const fastest = conns.length > 1 ? conns.reduce((a, b) => (b.durationMin < a.durationMin ? b : a)) : null;
        conns.forEach((c, i) => list.appendChild(card(c, i, c === fastest)));

        $('routesEarlier').hidden = !state.earlier;
        $('routesLater').hidden = !state.later;
    }

    function card(c, idx, isFastest) {
        const el = document.createElement('article');
        el.className = 'route-card' + (c.cancelled ? ' is-cancelled' : '') + (c.broken ? ' is-broken' : '');
        el.setAttribute('role', 'listitem');
        el.style.setProperty('--i', idx);
        const open = expanded.has(c.key);
        if (open) el.classList.add('open');

        const transit = c.legs.filter(l => l.kind === 'transit');
        const badges = [];
        if (c.cancelled) badges.push('<span class="route-chip bad">Fällt aus</span>');
        else if (c.broken) badges.push('<span class="route-chip bad">Anschluss nicht erreichbar</span>');
        else if (c.risky) badges.push('<span class="route-chip warn">Anschluss knapp</span>');
        const delayed = transit.filter(l => (l.from.delay || 0) >= 3);
        if (delayed.length && !c.cancelled) badges.push(`<span class="route-chip warn">${esc(delayed[0].label)} +${delayed[0].from.delay}</span>`);
        if (isFastest && !c.cancelled) badges.push('<span class="route-chip good">Schnellste</span>');
        if (c.price) badges.push(`<span class="route-chip price" title="${c.price.partial ? 'Preis für einen Teil der Strecke' : 'Normalpreis 2. Klasse'}">${esc(fmtPrice(c.price))}</span>`);
        else if (c.dticket) badges.push('<span class="route-chip good" title="Mit dem Deutschlandticket nutzbar">D-Ticket</span>');

        const mins = A.isNowMode() ? minutesUntil(c.dep && c.dep.iso) : null;
        const countdown = mins != null && mins >= 0 && mins <= 90
            ? `<span class="route-countdown${mins <= 5 ? ' soon' : ''}">${mins === 0 ? 'jetzt' : `in ${mins} Min`}</span>` : '';

        el.innerHTML = `
            <button type="button" class="route-summary" aria-expanded="${open}">
                <span class="route-times">${timeHtml(c.dep, true)}<span class="route-arrow" aria-hidden="true">→</span>${timeHtml(c.arr, true)}</span>
                <span class="route-meta">${esc(fmtDur(c.durationMin))} · ${esc(fmtTransfers(c.transfers))}${countdown ? ' · ' + countdown : ''}</span>
                ${fromLine(c)}
                <span class="route-badges">${badges.join('')}</span>
                ${bar(c)}
                <span class="route-toggle-hint"><span>${open ? 'Weniger' : 'Details'}</span><span class="chev" aria-hidden="true">▾</span></span>
            </button>
            <div class="route-details"${open ? '' : ' hidden'}>${details(c)}</div>
        `;
        el.querySelector('.route-summary').addEventListener('click', () => {
            const isOpen = !el.classList.contains('open');
            el.classList.toggle('open', isOpen);
            el.querySelector('.route-details').hidden = !isOpen;
            el.querySelector('.route-summary').setAttribute('aria-expanded', String(isOpen));
            el.querySelector('.route-toggle-hint span').textContent = isOpen ? 'Weniger' : 'Details';
            if (isOpen) expanded.add(c.key); else expanded.delete(c.key);
        });
        wireDetails(el, c);
        return el;
    }

    function fromLine(c) {
        const first = (c.legs || []).find(l => l.kind === 'transit');
        if (!first) return '';
        const walk = c.legs[0] && c.legs[0].kind === 'walk' ? c.legs[0] : null;
        const plat = first.from.rtPlatform || first.from.platform;
        const platTxt = plat ? ` · ${/^[A-Za-z]$/.test(plat) ? 'Steig' : 'Gl.'} ${esc(plat)}` : '';
        return `<span class="route-from">${walk ? `<span class="rf-walk">🚶 ${esc(walk.durationMin)} Min zu</span> ` : ''}${lineBadge(first, true)} ab <strong>${esc(shortName(first.from.name))}</strong>${platTxt}</span>`;
    }

    function bar(c) {
        const parts = [];
        c.legs.forEach(l => {
            if (l.kind === 'transit') {
                const dark = A.getLuminance(l.color) > 180;
                parts.push(`<span class="route-seg${dark ? ' dark-text' : ''}${l.cancelled ? ' cancelled' : ''}" style="flex:${Math.max(l.durationMin, 3)} 1 0;background:${esc(l.color)}" title="${esc(l.line)} · ${esc(fmtDur(l.durationMin))}">${esc(l.label || l.line)}</span>`);
            } else if (l.kind === 'transfer' && (l.walkMin || 0) > 0) {
                parts.push(`<span class="route-seg walk" style="flex:${Math.max(l.walkMin, 2)} 1 0" title="Umstieg ${l.walkMin} Min"></span>`);
            } else if (l.kind === 'walk') {
                parts.push(`<span class="route-seg walk" style="flex:${Math.max(l.durationMin, 2)} 1 0" title="Fußweg ${l.durationMin} Min"></span>`);
            }
        });
        return `<span class="route-bar" aria-hidden="true">${parts.join('')}</span>`;
    }

    function normName(n) {
        return shortName(n).toLowerCase().replace(/\s*\((tram|bus|tram\/bus)\)/g, '').replace(/[^a-z0-9äöüß]/g, '');
    }

    /* Timeline rows: [time | rail | content]. The rail draws the coloured ride segments and the dotted walks,
       a transfer at the very same stop merges arrival + departure into one node. */
    function details(c) {
        const items = c.legs || [];
        const rows = [];
        let prevSeg = null;        // what the rail above the next stop looks like
        let pending = null;        // arrival merged into the next departure (same-stop transfer)
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind === 'transit') {
                rows.push(stopRow({ name: it.from.name, dep: it.from, arr: pending && pending.pt, transfer: pending && pending.tr,
                    top: prevSeg, bottom: { color: it.color }, cancelled: it.cancelled }));
                rows.push(rideRow(it, i));
                pending = null;
                const tr = items[i + 1], nxt = items[i + 2];
                const sameStop = tr && tr.kind === 'transfer' && nxt && nxt.kind === 'transit' &&
                    normName(it.to.name) === normName(nxt.from.name);
                if (sameStop) {
                    pending = { pt: it.to, tr };
                    prevSeg = { color: it.color };
                    i += 1;            // the transfer is shown inside the merged stop
                    continue;
                }
                const after = items[i + 1];
                rows.push(stopRow({ name: it.to.name, arr: it.to, top: { color: it.color },
                    bottom: after ? { walk: true } : null, last: !after }));
                prevSeg = after ? { walk: true } : null;
            } else {
                rows.push(walkRow(it));
                prevSeg = { walk: true };
                if (i === 0) rows.unshift(stopRow({ name: it.from.name, dep: it.from, top: null, bottom: { walk: true }, start: true }));
                if (i === items.length - 1) rows.push(stopRow({ name: it.to.name, arr: it.to, top: { walk: true }, bottom: null, last: true }));
            }
        }
        const transit = items.filter(l => l.kind === 'transit');
        const out = [`<div class="tl">${rows.join('')}</div>`];
        out.push(`<div class="route-actions">
            <button type="button" class="route-action primary" data-act="follow"${transit.some(l => l.journeyId) ? '' : ' disabled'}><span class="live-dot" aria-hidden="true"></span>Fahrt verfolgen</button>
            <button type="button" class="route-action" data-act="share"><svg class="ico" aria-hidden="true"><use href="#i-share"/></svg>Teilen</button>
            <button type="button" class="route-action" data-act="return"><svg class="ico" aria-hidden="true"><use href="#i-swap"/></svg>Rückfahrt</button>
        </div>`);
        if (c.price) {
            out.push(`<p class="route-foot">${c.price.partial ? 'Teilpreis' : 'Normalpreis'} 2. Klasse laut bahn.de: <strong>${esc(fmtPrice(c.price))}</strong> · nicht mit dem Deutschlandticket (Fernverkehr).</p>`);
        }
        if (c.source === 'nasa') out.push('<p class="route-foot">Quelle: NASA (Mitteldeutschland).</p>');
        return out.join('');
    }

    function railHtml(top, bottom, dotColor, opts) {
        opts = opts || {};
        const seg = (sg, pos) => !sg ? '' : sg.walk
            ? `<span class="tl-seg ${pos} walk"></span>`
            : `<span class="tl-seg ${pos}" style="--c:${esc(sg.color)}"></span>`;
        const dotStyle = opts.split
            ? `style="--c:${esc(opts.split[0])};--c2:${esc(opts.split[1])}"`
            : `style="--c:${esc(dotColor || 'var(--text-muted)')}"`;
        return `<div class="tl-rail">${seg(top, 'top')}${seg(bottom, 'bottom')}<span class="tl-dot${opts.split ? ' split' : ''}${opts.end ? ' end' : ''}" ${dotStyle}></span></div>`;
    }

    function stopRow(o) {
        const dotColor = (o.bottom && o.bottom.color) || (o.top && o.top.color) || null;
        const split = o.arr && o.dep && o.top && o.top.color && o.bottom && o.bottom.color && o.top.color !== o.bottom.color
            ? [o.top.color, o.bottom.color] : null;
        let time;
        if (o.arr && o.dep) {
            time = `<span class="tl-arr">an ${esc(o.arr.rt || o.arr.planned)}</span>${timeHtml(o.dep)}`;
        } else {
            time = timeHtml(o.dep || o.arr);
        }
        const pt = o.dep || o.arr;
        let transfer = '';
        if (o.transfer) {
            const t = o.transfer;
            const cls = t.broken ? 'bad' : (t.risky ? 'warn' : '');
            const txt = t.broken ? 'Anschluss wahrscheinlich weg' : (t.risky ? `Umsteigen · nur ${t.bufferMin} Min – knapp!` : `Umsteigen · ${t.bufferMin != null ? t.bufferMin + ' Min' : 'gleicher Halt'}`);
            transfer = `<span class="tl-transfer ${cls}"><svg class="ico" aria-hidden="true"><use href="#${cls ? 'i-alert' : 'i-swap'}"/></svg>${esc(txt)}</span>`;
        }
        const tag = o.last ? '<span class="tl-goal">Ziel</span>' : (o.start ? '<span class="tl-goal start">Start</span>' : '');
        return `<div class="tl-row tl-stop${o.cancelled ? ' cancelled' : ''}">
            <div class="tl-time">${time}</div>
            ${railHtml(o.top, o.bottom, dotColor, { split, end: o.last })}
            <div class="tl-body"><div class="tl-stopline"><strong>${esc(o.name)}</strong>${platformTag(pt)}${delayTag(pt)}${tag}</div>${transfer}</div>
        </div>`;
    }

    function rideRow(l, i) {
        const stops = l.stops || [];
        const notes = l.notes || [];
        const attrs = (l.attrs || []).length ? `<span class="tl-attrs">${(l.attrs || []).map(esc).join(' · ')}</span>` : '';
        const noteHtml = notes.length ? `<div class="tl-notes"><p>${esc(notes[0])}</p>${notes.length > 1 || notes[0].length > 90 ? '<button type="button" class="tl-more">mehr</button>' : ''}${notes.slice(1).map(n => `<p class="extra">${esc(n)}</p>`).join('')}</div>` : '';
        return `<div class="tl-row tl-ride${l.cancelled ? ' cancelled' : ''}">
            <div class="tl-time"><span class="tl-dur">${esc(fmtDur(l.durationMin))}</span></div>
            <div class="tl-rail"><span class="tl-seg full" style="--c:${esc(l.color)}"></span></div>
            <div class="tl-body">
                <div class="tl-line">${lineBadge(l)}<span class="tl-dir">${esc(l.direction || '')}</span></div>
                <span class="tl-sub">${esc(TYPE_NAMES[l.type] || '')}${l.operator ? ' · ' + esc(l.operator) : ''}</span>
                ${stops.length ? `<button type="button" class="tl-stops-toggle" aria-expanded="false">${stops.length} Zwischenhalt${stops.length > 1 ? 'e' : ''}<span aria-hidden="true">▾</span></button>
                <ol class="tl-stops" hidden>${stops.map(st => `<li${st.cancelled ? ' class="cancelled"' : ''}><span class="ls-time">${esc(st.rt || st.planned || '')}</span><span class="ls-name">${esc(st.name)}</span>${st.delay > 0 ? `<span class="ls-delay">+${st.delay}</span>` : ''}</li>`).join('')}</ol>` : ''}
                ${noteHtml}
                ${attrs}
                ${l.journeyId ? `<button type="button" class="tl-line-btn" data-leg="${i}"><svg class="ico" aria-hidden="true"><use href="#i-route"/></svg>Ganzer Linienverlauf</button>` : ''}
            </div>
        </div>`;
    }

    function walkRow(w) {
        const isTransfer = w.kind === 'transfer';
        const mins = isTransfer ? w.walkMin : w.durationMin;
        const cls = isTransfer ? (w.broken ? ' bad' : (w.risky ? ' warn' : '')) : '';
        let text;
        if (isTransfer) {
            text = w.inStation ? `Umsteigen im Bahnhof${mins ? ' · ' + mins + ' Min Fußweg' : ''}` : `Fußweg${w.distance ? ' ' + w.distance + ' m' : ''}${mins ? ' · ' + mins + ' Min' : ''}`;
            if (!w.inStation && w.at) text += ` zu ${shortName(w.at)}`;
        } else {
            text = `Fußweg${w.distance ? ' ' + w.distance + ' m' : ''} · ${w.durationMin} Min`;
        }
        let buffer = '';
        if (isTransfer && w.bufferMin != null) {
            buffer = w.broken ? 'Anschluss wahrscheinlich weg' : (w.risky ? `nur ${w.bufferMin} Min Puffer – knapp!` : `${w.bufferMin} Min Puffer`);
        }
        return `<div class="tl-row tl-walk${cls}">
            <div class="tl-time"><span class="tl-dur">${mins ? esc(mins + ' Min') : ''}</span></div>
            <div class="tl-rail"><span class="tl-seg full walk"></span><span class="tl-walk-icon"><svg class="ico" aria-hidden="true"><use href="#${cls ? 'i-alert' : 'i-walk'}"/></svg></span></div>
            <div class="tl-body"><span class="tl-walktext">${esc(text)}</span>${buffer ? `<span class="tl-buffer">${esc(buffer)}</span>` : ''}</div>
        </div>`;
    }

    function wireDetails(el, c) {
        el.querySelectorAll('.tl-stops-toggle').forEach(b => {
            b.addEventListener('click', () => {
                const ol = b.nextElementSibling;
                const openNow = ol.hidden;
                ol.hidden = !openNow;
                b.setAttribute('aria-expanded', String(openNow));
                b.classList.toggle('open', openNow);
            });
        });
        el.querySelectorAll('.tl-more').forEach(b => {
            b.addEventListener('click', () => {
                const box = b.closest('.tl-notes');
                const open = !box.classList.contains('open');
                box.classList.toggle('open', open);
                b.textContent = open ? 'weniger' : 'mehr';
            });
        });
        el.querySelectorAll('.tl-line-btn').forEach(b => {
            b.addEventListener('click', () => follow(c, parseInt(b.dataset.leg, 10)));
        });
        el.querySelectorAll('.route-action').forEach(b => {
            b.addEventListener('click', () => {
                const act = b.dataset.act;
                if (act === 'follow') follow(c, null);
                else if (act === 'share') share(c);
                else if (act === 'return') reverse();
            });
        });
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    function legDeps(c) {
        const transit = c.legs.map((l, i) => ({ l, i })).filter(x => x.l.kind === 'transit' && x.l.journeyId);
        const deps = transit.map(({ l, i }) => ({
            journey_id: l.journeyId,
            card_journey_id: `route-${c.key}-${i}`,
            line: l.line, label: l.label, direction: l.direction,
            time: l.from.planned, delay: l.from.delay || 0, lineColor: l.color, type: l.type,
            operator: l.operator, station_name: l.from.name, boardStop: l.from.name, alightStop: l.to.name,
            date: (l.from.plannedIso || '').slice(0, 10), matchMvb: (l.src === 'db' || l.src === 'tr') && !!l.mvb,
            _legIndex: i,
        }));
        deps.forEach((d, k) => { d.tripLegs = deps; d.tripLegIndex = k; d.tripConn = c; });
        return deps;
    }

    function follow(c, legIdx) {
        if (legIdx == null) {
            // whole journey: boarding → stops → walk → next vehicle …
            A.openTripView(c, tripContext(c));
            return;
        }
        const deps = legDeps(c);
        const pick = deps.find(d => d._legIndex === legIdx);
        if (!pick) {
            A.showToast('Für diese Linie gibt es keinen Linienverlauf', 'info');
            return;
        }
        A.handleItemSelection(pick);
    }

    function tripContext(c) {
        const from = (state.from && state.from.name) || A.getCurrentStation().name;
        const to = (state.to && state.to.name) || (destStation && destStation.name);
        return {
            key: c.key, from: shortName(from), to: shortName(to),
            legDeps: legDeps(c),
            getFresh: () => state.conns.find(x => x.key === c.key) || c,
        };
    }

    function share(c) {
        const from = (state.from && state.from.name) || A.getCurrentStation().name;
        const to = (state.to && state.to.name) || (destStation && destStation.name);
        const lines = c.legs.filter(l => l.kind === 'transit').map(l =>
            `${l.from.rt || l.from.planned} ${l.label} ab ${l.from.name}${l.from.platform ? ' (' + l.from.platform + ')' : ''} → ${l.to.name} an ${l.to.rt || l.to.planned}`);
        const text = `🚋 ${shortName(from)} → ${shortName(to)}\n${c.dep.rt || c.dep.planned} – ${c.arr.rt || c.arr.planned} · ${fmtDur(c.durationMin)} · ${fmtTransfers(c.transfers)}\n\n${lines.join('\n')}\n\nGefunden mit Magdeburg Mobil`;
        if (navigator.share) {
            navigator.share({ title: 'Meine Verbindung', text }).catch(() => {});
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => A.showToast('Verbindung kopiert 📋', 'success'),
                () => A.showToast('Kopieren nicht möglich', 'warning'));
        }
    }

    function reverse() {
        const from = A.getCurrentStation();
        const to = destStation;
        if (!to) return;
        A.setCurrentStation(to);
        setDest(from);
        A.announceToScreenReader('Rückfahrt wird gesucht.');
        search();
    }

    function swap() {
        const btn = $('swapBtn');
        if (btn) {
            btn.classList.remove('spin');
            void btn.offsetWidth;
            btn.classList.add('spin');
        }
        if (!hasDestination()) {
            A.showToast('Gib zuerst ein Ziel ein, dann kann ich tauschen 😉', 'info');
            const di = $('destInput');
            if (di) di.focus();
            return;
        }
        const from = A.getCurrentStation();
        const di = $('destInput');
        const to = destStation || { id: di.value.trim(), name: di.value.trim() };
        A.setCurrentStation(to);
        setDest(from);
        A.announceToScreenReader('Start und Ziel getauscht.');
        const view = $('planRoutes');
        if (view && !view.hidden && state.params) search();
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    function init() {
        if (A) return;
        A = window.MVBApp;
        if (!A) return;
        const di = $('destInput'), ds = $('destSuggestions'), dc = $('clearDest');
        if (di && ds) {
            A.setupAutocomplete(di, ds, dc, (st) => {
                destStation = st;
                updateMode();
                A.submit();
            }, () => A.submit());
            di.addEventListener('input', () => {
                if (destStation && di.value.trim() !== destStation.name) destStation = null;
                updateMode();
            });
        }
        if (dc) dc.addEventListener('click', () => {
            destStation = null;
            updateMode();
        });
        const sw = $('swapBtn');
        if (sw) sw.addEventListener('click', swap);
        document.querySelectorAll('#timeModeGroup .plan-seg-btn').forEach(b => {
            b.addEventListener('click', () => {
                setTimeMode(b.dataset.timemode);
                if (state.params && hasDestination()) search();
            });
        });
        const e = $('routesEarlier'), l = $('routesLater'), r = $('routesRefreshBtn');
        if (e) e.addEventListener('click', () => state.earlier && search({ page: state.earlier, dir: 'earlier' }));
        if (l) l.addEventListener('click', () => state.later && search({ page: state.later, dir: 'later' }));
        if (r) r.addEventListener('click', () => {
            r.classList.add('spinning');
            Promise.resolve(hasDestination() ? search() : null).finally(() => setTimeout(() => r.classList.remove('spinning'), 400));
        });
        const si = $('stationInput');
        if (si) si.addEventListener('input', updateMode);
        document.addEventListener('mvb:settings', () => {
            const view = $('planRoutes');
            if (view && !view.hidden && state.params && hasDestination()) search();
        });
        // live countdowns on the cards
        setInterval(() => {
            const view = $('planRoutes');
            if (!view || view.hidden || !state.conns.length || !A.isNowMode()) return;
            document.querySelectorAll('.route-card').forEach((cardEl, i) => {
                const c = state.conns[i];
                const span = cardEl.querySelector('.route-countdown');
                if (!c || !span) return;
                const m = minutesUntil(c.dep && c.dep.iso);
                if (m == null || m < 0) { span.textContent = 'weg'; span.classList.add('gone'); return; }
                span.textContent = m === 0 ? 'jetzt' : `in ${m} Min`;
                span.classList.toggle('soon', m <= 5);
            });
        }, 20000);
        renderRecent();
        renderQuickTimes();
        updateMode();
    }

    function renderQuickTimes() {
        const when = document.querySelector('.plan-when');
        if (!when || $('quickTimes')) return;
        const wrap = document.createElement('div');
        wrap.id = 'quickTimes';
        wrap.className = 'quick-times only-routes';
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'Schnell eine Zeit wählen');
        const opts = [['now', 'Jetzt'], [15, '+15 Min'], [30, '+30 Min'], [60, '+1 Std'], ['tomorrow', 'Morgen 7:00']];
        wrap.innerHTML = opts.map(([v, l]) => `<button type="button" class="quick-time" data-v="${v}">${l}</button>`).join('');
        when.parentNode.insertBefore(wrap, when.nextSibling);
        wrap.addEventListener('click', (e) => {
            const b = e.target.closest('.quick-time');
            if (!b) return;
            const v = b.dataset.v;
            const nowBtn = $('nowBtn');
            if (v === 'now') {
                if (nowBtn && !A.isNowMode()) nowBtn.click();
            } else {
                const d = new Date();
                if (v === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0); }
                else d.setMinutes(d.getMinutes() + parseInt(v, 10));
                const pad = (n) => String(n).padStart(2, '0');
                const di = $('depDate'), ti = $('depTime');
                if (di) { di.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; di.dispatchEvent(new Event('change')); }
                if (ti) { ti.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`; ti.dispatchEvent(new Event('change')); }
            }
            wrap.querySelectorAll('.quick-time').forEach(x => x.classList.toggle('on', x === b));
            if (hasDestination()) search();
        });
    }

    function onViewChange(view) {
        if (view === 'routes' && A && hasDestination() && !state.params && destStation) search();
        updateMode();
    }

    window.MVBRoutes = {
        search, hasDestination, setDest, onViewChange, getDest: () => destStation,
        followTrip: (c) => A.openTripView(c, tripContext(c)),
    };

    if (window.MVBApp) init();
    else document.addEventListener('mvb:app-ready', init, { once: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (!A && window.MVBApp) init(); });
})();
