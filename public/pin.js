/* Magdeburg Mobil — Fahrt anpinnen
   Im Linienverlauf: "Fahrt anpinnen" + Ausstieg wählen. Die Fahrt läuft dann als
   Live-Benachrichtigung mit (Server-Push, siehe pin.py) und als Karte auf der Startseite.
   Usage: MVBPin.render(slot, dep, stationName); MVBPin.setStops(slot, journeyStops) */
(function () {
    'use strict';

    const LS = 'mvb_pin';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = (n) => String(n || '').toLowerCase().replace(/^magdeburg,\s*/, '').replace(/,\s*magdeburg$/, '')
        .replace(/\s*\((tram|bus|tram\/bus)\)/g, '').replace(/[^a-z0-9äöüß]/g, '');
    const same = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
    const PIN_ICON = '<svg class="pin-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 15v6"/></svg>';

    const store = {
        get() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } },
        set(v) { try { if (v) localStorage.setItem(LS, JSON.stringify(v)); else localStorage.removeItem(LS); } catch (e) { /* ignore */ } },
    };
    let pin = store.get();
    if (pin && pin.planned < Date.now() - 8 * 3600000) { pin = null; store.set(null); }

    const push = () => window.MVBPush;
    const toast = (m, k) => { if (window.MVBApp && window.MVBApp.showToast) window.MVBApp.showToast(m, k || 'info'); };
    const slots = new Set();
    const state = new WeakMap();      // slot -> { dep, station, stops, picking, exitIdx }

    function hash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    const idFor = (dep, station) => 'p' + hash(`${dep.journey_id}|${norm(station)}|${dep.time}|${dep.day_offset || 0}`);

    function planned(dep) {
        if (push() && push().depEpoch) return push().depEpoch(dep);
        return null;
    }

    function usable(dep) {
        if (!dep || !dep.journey_id || dep.cancelled || !dep.time) return false;
        const t = planned(dep);
        return !!t && t > Date.now() - 6 * 3600000;
    }

    function boardIndex(st) {
        const stops = st.stops || [];
        let i = stops.findIndex((s) => norm(s.name) === norm(st.station));
        if (i < 0) i = stops.findIndex((s) => same(s.name, st.station));
        if (i < 0) i = stops.findIndex((s) => !s.passed);
        return i;
    }

    // ------------------------------------------------------------------
    // Linienverlauf: the bar under "Abfahrts-Wecker"
    // ------------------------------------------------------------------
    function render(slot, dep, station) {
        if (!slot) return;
        const can = push() && push().state() !== 'unsupported' && usable(dep);
        slot.hidden = !can;
        if (!can) { slot.innerHTML = ''; slots.delete(slot); return; }
        state.set(slot, { dep, station: station || dep.station_name || '', stops: null, picking: false, exitIdx: null });
        slots.add(slot);
        draw(slot);
        slot.onclick = (e) => onClick(slot, e);
    }

    function setStops(slot, stops) {
        const st = slot && state.get(slot);
        if (!st || !Array.isArray(stops)) return;
        st.stops = stops;
        if (st.picking) draw(slot);
    }

    function draw(slot) {
        const st = state.get(slot);
        if (!st || !slot.isConnected) { slots.delete(slot); return; }
        const id = idFor(st.dep, st.station);
        if (pin && pin.id === id) {
            slot.innerHTML = `<div class="pin-bar on">${PIN_ICON}<span class="pin-txt">Angepinnt bis <b>${esc(pin.exit)}</b><small>Läuft live in deiner Benachrichtigungsleiste</small></span>
                <button type="button" class="pin-btn ghost" data-act="unpin">Lösen</button></div>`;
            return;
        }
        if (!st.picking) {
            const other = pin ? `<small>Ersetzt: ${esc(pin.line)} bis ${esc(pin.exit)}</small>` : '<small>Live in deiner Benachrichtigungsleiste</small>';
            slot.innerHTML = `<div class="pin-bar">${PIN_ICON}<span class="pin-txt">Fahrt anpinnen${other}</span>
                <button type="button" class="pin-btn" data-act="pick">Anpinnen</button></div>`;
            return;
        }
        const b = boardIndex(st);
        const after = st.stops && b >= 0 ? st.stops.map((s, i) => ({ s, i })).filter((x) => x.i > b && !x.s.cancelled) : null;
        if (after && after.length && (st.exitIdx == null || !after.some((x) => x.i === st.exitIdx))) st.exitIdx = after[after.length - 1].i;
        const chips = !after ? '<span class="pin-wait">Halte werden geladen …</span>'
            : !after.length ? '<span class="pin-wait">Nach diesem Halt kommt nichts mehr.</span>'
                : after.map((x) => `<button type="button" class="pin-stop" role="option" aria-selected="${x.i === st.exitIdx}" data-exit="${x.i}">
                    <strong>${esc(x.s.name)}</strong><small>${esc(x.s.arrTime || x.s.time || '')}</small></button>`).join('');
        slot.innerHTML = `<div class="pin-bar picking">
            <div class="pin-head">${PIN_ICON}<span class="pin-txt">Wo steigst du aus?</span>
              <button type="button" class="pin-btn ghost" data-act="close">Abbrechen</button></div>
            <div class="pin-stops" role="listbox" aria-label="Ausstieg wählen">${chips}</div>
            <button type="button" class="pin-go" data-act="go" ${after && after.length ? '' : 'disabled'}>${PIN_ICON}Anpinnen${after && after.length ? ' bis ' + esc(st.stops[st.exitIdx].name) : ''}</button>
          </div>`;
        const on = slot.querySelector('.pin-stop[aria-selected="true"]');
        const box = slot.querySelector('.pin-stops');
        if (on && box) box.scrollLeft = Math.max(0, on.offsetLeft - box.clientWidth / 2 + on.offsetWidth / 2);
    }

    async function onClick(slot, e) {
        const b = e.target.closest('button');
        if (!b) return;
        e.stopPropagation();
        const st = state.get(slot);
        if (!st) return;
        if (b.dataset.exit != null) { st.exitIdx = Number(b.dataset.exit); draw(slot); return; }
        const act = b.dataset.act;
        if (act === 'pick') { st.picking = true; draw(slot); return; }
        if (act === 'close') { st.picking = false; draw(slot); return; }
        if (act === 'unpin') { b.disabled = true; await unpin(); return; }
        if (act === 'go') { b.disabled = true; await doPin(slot); if (b.isConnected) b.disabled = false; }
    }

    async function doPin(slot) {
        const st = state.get(slot);
        const b = boardIndex(st);
        if (!st || b < 0 || st.exitIdx == null) return;
        if (!(await push().ensureOn())) return;
        const dep = st.dep;
        const body = {
            endpoint: push().endpoint(),
            pin: {
                id: idFor(dep, st.station), jid: dep.journey_id, line: dep.line, direction: dep.direction,
                color: dep.lineColor, board: st.stops[b].name, boardIdx: b,
                exit: st.stops[st.exitIdx].name, exitIdx: st.exitIdx, planned: planned(dep),
                // trains: lets the server put the Wagenreihung into the notification
                trainCat: dep.trainCat || null, trainNum: dep.trainNum || null,
                boardEva: st.stops[b].eva || dep.fromEva || null, exitEva: st.stops[st.exitIdx].eva || null,
            },
        };
        try {
            const res = await push().api('/push/pin', body);
            pin = Object.assign({}, res.pin, { dep: slim(dep) });
            store.set(pin);
            st.picking = false;
            toast(`📌 Angepinnt bis ${pin.exit} – schau in deine Benachrichtigungen`, 'success');
            redrawAll();
            refreshCard();
        } catch (err) {
            toast(`Nicht angepinnt: ${err.message}`, 'warning');
        }
    }

    async function unpin() {
        const old = pin;
        pin = null;
        store.set(null);
        redrawAll();
        refreshCard();
        if (old && push() && push().endpoint()) {
            try { await push().api('/push/pin', { endpoint: push().endpoint(), cancel: true }); } catch (e) { /* server may be asleep */ }
        }
        toast('Fahrt gelöst', 'info');
    }

    // what we need to reopen the Linienverlauf later
    function slim(dep) {
        const keep = ['journey_id', 'card_journey_id', 'line', 'direction', 'lineColor', 'time', 'day_offset', 'delay', 'type',
            'platform', 'station_name', 'station_id', 'operator', 'trainCat', 'trainNum', 'fromEva', 'isSEV', 'src'];
        const out = {};
        keep.forEach((k) => { if (dep[k] !== undefined) out[k] = dep[k]; });
        return out;
    }

    function redrawAll() { slots.forEach((s) => draw(s)); }

    // ------------------------------------------------------------------
    // Start page: the pinned trip as a live card
    // ------------------------------------------------------------------
    let cardTimer = null;
    let lastView = null;

    function cardEl() { return document.getElementById('pinCard'); }

    async function refreshCard() {
        const el = cardEl();
        if (!el) return;
        if (!pin) { el.hidden = true; el.innerHTML = ''; lastView = null; return; }
        el.hidden = false;
        if (!lastView) drawCard(el, null);
        const ep = push() && push().endpoint();
        if (!ep) { drawCard(el, null); return; }
        try {
            const res = await push().api('/push/pin', { endpoint: ep, view: true });
            if (!res.pin) {                         // server says: no pin anymore (arrived / unpinned elsewhere)
                pin = null; store.set(null); redrawAll(); el.hidden = true; el.innerHTML = ''; return;
            }
            pin = Object.assign({}, pin, res.pin);
            store.set(pin);
            lastView = res.view || null;
            drawCard(el, lastView);
        } catch (e) {
            drawCard(el, lastView);
        }
    }

    function delayText(v) {
        if (!v) return '';
        if (v.cancelled) return 'fällt aus';
        if (v.delay == null) return 'planmäßig';
        if (v.delay > 0) return `+${v.delay} Min`;
        if (v.delay < 0) return `${v.delay} Min`;
        return 'pünktlich';
    }

    function drawCard(el, v) {
        const color = /^#[0-9a-f]{6}$/i.test(pin.color || '') ? pin.color : '#018e4a';
        const late = v && (v.cancelled || (v.delay || 0) > 0);
        const field = (label, s, cls) => `<div class="pc-stop ${cls || ''}"><small>${esc(label)}</small><strong>${esc(s ? s.name : '–')}</strong><span>${esc(s ? s.time : '')}</span></div>`;
        let mid = '';
        if (v) {
            const pct = Math.round((v.pct || 0) * 1000) / 10;
            const ticks = (v.ticks || []).map((t) => `<i style="left:${t * 100}%" class="${t * 100 <= pct + 0.1 ? 'done' : ''}"></i>`).join('');
            const remain = v.phase === 'before' ? (v.minsToDep > 0 ? `Abfahrt in ${v.minsToDep} Min` : 'Fährt ab')
                : v.phase === 'exit' ? 'Gleich da – aussteigen!' : `noch ${v.minsLeft} Min`;
            mid = `<div class="pc-stops${v.phase === 'exit' ? ' exit' : ''}">${field('Vorheriger', v.prev)}${field(v.label, v.cur, 'cur')}${field('Nächster', v.next)}</div>
              ${formationHtml(v.formation)}
              <div class="pc-bar" role="img" aria-label="Fortschritt der Fahrt: ${pct} Prozent"><div class="pc-track"><b style="width:${pct}%"></b>${ticks}<span class="pc-train" style="left:${pct}%"></span></div>
                <div class="pc-labels"><span>${esc(v.board.name)}</span><strong>${esc(remain)}</strong><span>${esc(v.exit.name)}</span></div></div>`;
        } else {
            mid = '<p class="pc-wait">Live-Daten werden geladen …</p>';
        }
        el.innerHTML = `<div class="pc-top"><span class="pc-kicker">${PIN_ICON}Angepinnt</span><span class="pc-live">in der Benachrichtigungsleiste</span></div>
          <div class="pc-main"><span class="pc-badge" style="background:${color}">${esc(pin.line)}</span>
            <div class="pc-title"><strong>${esc(pin.direction ? '→ ' + pin.direction : pin.line)}</strong><small>Ausstieg ${esc(pin.exit)}${v ? ' · ' + esc(v.exit.time) : ''}</small></div>
            ${v ? `<span class="pc-delay${late ? ' late' : ''}${v.cancelled ? ' cnl' : ''}">${esc(delayText(v))}</span>` : ''}</div>
          ${mid}
          <div class="pc-actions"><button type="button" class="pc-open">Linienverlauf</button><button type="button" class="pc-unpin">Lösen</button></div>`;
        el.querySelector('.pc-open').onclick = openPinned;
        el.querySelector('.pc-unpin').onclick = unpin;
    }

    // compact Wagenreihung (same data as in the notification picture)
    function formationHtml(fm) {
        if (!fm || !Array.isArray(fm.cars) || !fm.cars.length) return '';
        const cars = fm.cars.map((c) => {
            const cls = c.k === 'loco' || c.k === 'powercar' ? (c.c ? 'pw' : 'loco') : (c.c === '1' || c.c === '12' ? 'first' : (c.c === 'B' ? 'bistro' : 'second'));
            const lab = cls === 'loco' ? '' : (cls === 'first' ? '1' : (cls === 'bistro' ? 'B' : '2'));
            return `<span class="pc-car ${cls}${c.x ? ' closed' : ''}" style="left:${c.s}%;width:${Math.max(0.5, c.e - c.s)}%">${lab}</span>`;
        }).join('');
        const secs = (fm.sectors || []).map((s) => `<i style="left:${(s.s + s.e) / 2}%">${esc(s.n)}</i>`).join('');
        const dir = fm.direction === 'left' || fm.direction === 'right' ? `<span class="pc-dir ${fm.direction}" aria-hidden="true"></span>` : '';
        return `<div class="pc-fm" role="img" aria-label="Wagenreihung ${fm.platform ? 'Gleis ' + esc(fm.platform) : ''} in ${esc(fm.station || '')}">
            <div class="pc-pf"><strong>${fm.platform ? 'Gl. ' + esc(fm.platform) : 'Gleis'}</strong><small>${fm.where === 'exit' ? 'Ausstieg' : 'Einstieg'}</small></div>
            <div class="pc-cars"><div class="pc-secs">${secs}</div><div class="pc-row">${cars}${dir}</div></div></div>`;
    }

    function openPinned() {
        if (!pin || !pin.dep || !window.MVBApp) return;
        const dep = Object.assign({}, pin.dep);
        const wide = window.matchMedia('(min-width: 1024px)').matches;
        if (wide) window.MVBApp.switchTab('departures');
        window.MVBApp.handleItemSelection(dep);
    }

    function startCardLoop() {
        clearInterval(cardTimer);
        cardTimer = setInterval(() => {
            const el = cardEl();
            if (pin && el && el.offsetParent && document.visibilityState === 'visible') refreshCard();
        }, 30000);
    }

    // ------------------------------------------------------------------
    document.addEventListener('mvbpin:sync', (e) => {
        const srv = e.detail;
        if (!srv) { pin = null; store.set(null); }
        else pin = Object.assign({}, pin || {}, srv);
        if (pin) store.set(pin);
        redrawAll();
        refreshCard();
    });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            const d = e.data || {};
            if (d.type === 'pin-update') refreshCard();
            if (d.type === 'open-tab' && d.pin) setTimeout(openPinned, 300);
        });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pin) refreshCard(); });

    function boot() {
        refreshCard();
        startCardLoop();
        if (new URLSearchParams(location.search).get('pin') === '1' && pin) setTimeout(openPinned, 1200);
    }
    if (window.MVBApp) boot(); else document.addEventListener('mvb:app-ready', boot, { once: true });

    window.MVBPin = { render, setStops, refreshCard, get: () => pin };
})();
