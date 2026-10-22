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
        if (pt.delay == null) return '<span class="rt-tag none" title="Noch keine Echtzeitdaten">Plan</span>';
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

    function details(c) {
        const out = [];
        c.legs.forEach((l, i) => {
            if (l.kind === 'transit') out.push(legHtml(l, i));
            else if (l.kind === 'transfer') out.push(transferHtml(l));
            else if (l.kind === 'walk') out.push(walkHtml(l));
        });
        const transit = c.legs.filter(l => l.kind === 'transit');
        out.push(`<div class="route-actions">
            <button type="button" class="route-action primary" data-act="follow"${transit.some(l => l.journeyId) ? '' : ' disabled'}><span class="live-dot" aria-hidden="true"></span>Fahrt verfolgen</button>
            <button type="button" class="route-action" data-act="share"><svg class="ico" aria-hidden="true"><use href="#i-share"/></svg>Teilen</button>
            <button type="button" class="route-action" data-act="return"><svg class="ico" aria-hidden="true"><use href="#i-swap"/></svg>Rückfahrt</button>
        </div>`);
        if (c.price) {
            out.push(`<p class="route-foot">${c.price.partial ? 'Teilpreis' : 'Normalpreis'} 2. Klasse laut bahn.de: <strong>${esc(fmtPrice(c.price))}</strong>. Nicht mit dem Deutschlandticket nutzbar (Fernverkehr).</p>`);
        }
        if (c.source === 'nasa') out.push('<p class="route-foot">Quelle: NASA (Mitteldeutschland).</p>');
        return out.join('');
    }

    function legHtml(l, i) {
        const stops = l.stops || [];
        const notes = (l.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
        const attrs = (l.attrs || []).length ? `<span class="rl-attrs">${(l.attrs || []).map(esc).join(' · ')}</span>` : '';
        return `<div class="route-leg${l.cancelled ? ' cancelled' : ''}" style="--leg:${esc(l.color)}">
            <div class="rl-row">
                <div class="rl-time">${timeHtml(l.from)}</div>
                <div class="rl-dot start" aria-hidden="true"></div>
                <div class="rl-stop"><strong>${esc(l.from.name)}</strong>${platformTag(l.from)}${delayTag(l.from)}</div>
            </div>
            <div class="rl-body">
                <div class="rl-line-info">
                    ${lineBadge(l)}
                    <span class="rl-dir">Richtung ${esc(l.direction)}</span>
                    <span class="rl-sub">${esc(TYPE_NAMES[l.type] || '')}${l.operator ? ' · ' + esc(l.operator) : ''} · ${esc(fmtDur(l.durationMin))}</span>
                </div>
                ${stops.length ? `<button type="button" class="rl-stops-toggle" aria-expanded="false">${stops.length} Zwischenhalt${stops.length > 1 ? 'e' : ''} <span aria-hidden="true">▾</span></button>
                <ol class="rl-stops" hidden>${stops.map(s => `<li${s.cancelled ? ' class="cancelled"' : ''}><span class="ls-time">${esc(s.rt || s.planned || '')}</span><span class="ls-name">${esc(s.name)}</span>${s.delay > 0 ? `<span class="ls-delay">+${s.delay}</span>` : ''}</li>`).join('')}</ol>` : ''}
                ${notes ? `<ul class="rl-notes">${notes}</ul>` : ''}
                ${attrs}
                ${l.journeyId ? `<button type="button" class="rl-live-btn" data-leg="${i}"><span class="live-dot" aria-hidden="true"></span>Ganzer Linienverlauf</button>` : ''}
            </div>
            <div class="rl-row">
                <div class="rl-time">${timeHtml(l.to)}</div>
                <div class="rl-dot end" aria-hidden="true"></div>
                <div class="rl-stop"><strong>${esc(l.to.name)}</strong>${platformTag(l.to)}</div>
            </div>
        </div>`;
    }

    function transferHtml(t) {
        const cls = t.broken ? 'bad' : (t.risky ? 'warn' : '');
        let text;
        if (t.inStation) text = t.walkMin ? `Umstieg · ${t.walkMin} Min Fußweg im Bahnhof` : 'Umstieg am selben Halt';
        else text = `Umstieg · Fußweg${t.distance ? ' ' + t.distance + ' m' : ''} · ${t.walkMin} Min`;
        let buffer = '';
        if (t.bufferMin != null) {
            if (t.broken) buffer = ' · Anschluss wahrscheinlich weg';
            else if (t.risky) buffer = ` · nur ${t.bufferMin} Min Puffer – knapp!`;
            else buffer = ` · ${t.bufferMin} Min Puffer`;
        }
        if (t.at && t.fromStop && shortName(t.at) !== shortName(t.fromStop) && !t.inStation) text += ` zu ${esc(t.at)}`;
        return `<div class="route-transfer ${cls}"><svg class="ico" aria-hidden="true"><use href="#${cls ? 'i-alert' : 'i-walk'}"/></svg><span>${text}${esc(buffer)}</span></div>`;
    }

    function walkHtml(w) {
        return `<div class="route-transfer walk"><svg class="ico" aria-hidden="true"><use href="#i-walk"/></svg><span>Fußweg${w.distance ? ' ' + esc(w.distance) + ' m' : ''} · ${esc(w.durationMin)} Min · ${esc(w.from.name)} → ${esc(w.to.name)}</span></div>`;
    }

    function wireDetails(el, c) {
        el.querySelectorAll('.rl-stops-toggle').forEach(b => {
            b.addEventListener('click', () => {
                const ol = b.nextElementSibling;
                const openNow = ol.hidden;
                ol.hidden = !openNow;
                b.setAttribute('aria-expanded', String(openNow));
                b.classList.toggle('open', openNow);
            });
        });
        el.querySelectorAll('.rl-live-btn').forEach(b => {
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
            date: (l.from.plannedIso || '').slice(0, 10), matchMvb: l.src === 'db' && !!l.mvb,
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
        updateMode();
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
