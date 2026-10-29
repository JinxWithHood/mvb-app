/* ============================================================
   Magdeburg Mobil — Push-Benachrichtigungen
   Echte Web-Push-Nachrichten (kommen auch bei geschlossener App):
   - neue Störungen (alle oder nur "meine Linien", optional nur Sperrungen, Nachtruhe)
   - Abfahrts-Wecker: "Linie 9 fährt in 5 Min." inkl. Live-Verspätung
   Usage: MVBPush.init({ apiBase, toast }); MVBPush.renderReminder(el, dep, stationName)
   ============================================================ */
(function () {
    'use strict';

    const LS = { prefs: 'mvb_push_prefs', key: 'mvb_push_vapid', rem: 'mvb_push_reminders', dismissed: 'mvb_push_banner_dismissed' };
    const LINES = {
        tram: [['1', '#B22052'], ['2', '#5566A4'], ['3', '#F5D300'], ['4', '#7FC600'], ['5', '#BA832C'], ['6', '#6E3B90'],
            ['8', '#F0A500'], ['9', '#006651'], ['10', '#2796B6'], ['13', '#3A4136']],
        bus: [['51', '#5566A4'], ['52', '#F0A500'], ['53', '#F5D300'], ['54', '#7FC600'], ['55', '#BA832C'], ['56', '#E1C700'],
            ['57', '#E70097'], ['58', '#008B8B'], ['59', '#006651'], ['61', '#2796B6'], ['66', '#B13507'], ['69', '#6E3B90'],
            ['71', '#CC1F2F'], ['72', '#006EB7'], ['73', '#3A4136']],
    };

    const MVBPush = {};
    let opts = { apiBase: '/api', toast: () => {} };
    let reg = null;
    let sub = null;
    let busy = false;
    let syncTimer = null;
    let showBus = false;

    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    const ls = {
        get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    };
    let prefs = Object.assign({ disruptions: true, criticalOnly: false, lines: [], quiet: null }, ls.get(LS.prefs, {}));
    let reminders = ls.get(LS.rem, []).filter(r => r.planned > Date.now() - 30 * 60000);

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    const lum = (hex) => { const h = (hex || '').replace('#', ''); if (h.length !== 6) return 0; return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16); };

    function b64ToUint8(b64) {
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
    }

    function keyOfSub(s) {
        try {
            const k = s && s.options && s.options.applicationServerKey;
            if (!k) return null;
            return btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) { return null; }
    }

    async function api(path, body) {
        const res = await fetch(`${opts.apiBase}${path}`, body ? {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        } : undefined);
        let data = {};
        try { data = await res.json(); } catch (e) { /* ignore */ }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    async function getReg() {
        if (reg) return reg;
        reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, rej) => setTimeout(() => rej(new Error('Service Worker nicht bereit')), 8000)),
        ]);
        return reg;
    }

    // ---------------------------------------------------------
    // Subscription
    // ---------------------------------------------------------
    async function subscribeWithKey(publicKey) {
        const r = await getReg();
        return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
    }

    // make sure server and device agree (server may have restarted with new keys / lost its list)
    async function sync() {
        if (!sub) return;
        const { publicKey } = await api('/push/key');
        const current = keyOfSub(sub) || ls.get(LS.key, null);
        if (publicKey && current && current !== publicKey) {
            try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
            sub = await subscribeWithKey(publicKey);
        }
        ls.set(LS.key, publicKey);
        const res = await api('/push/subscribe', { subscription: sub.toJSON(), prefs, reminders, pin: ls.get('mvb_pin', null) });
        if (Array.isArray(res.reminders)) {
            reminders = res.reminders;
            ls.set(LS.rem, reminders);
        }
        if ('pin' in res) document.dispatchEvent(new CustomEvent('mvbpin:sync', { detail: res.pin }));
    }

    function syncSoon() {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => sync().catch(e => console.warn('Push-Sync:', e)), 600);
    }

    async function enable() {
        if (busy) return false;
        busy = true;
        render();
        try {
            if (!supported) throw new Error(isIOS && !standalone ? 'Erst die App installieren (Teilen → Zum Home-Bildschirm)' : 'Dein Browser unterstützt keine Push-Nachrichten');
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Benachrichtigungen sind blockiert' : 'Nicht erlaubt');
            const { publicKey } = await api('/push/key');
            const r = await getReg();
            sub = await r.pushManager.getSubscription();
            if (sub && keyOfSub(sub) && keyOfSub(sub) !== publicKey) { await sub.unsubscribe(); sub = null; }
            if (!sub) sub = await subscribeWithKey(publicKey);
            ls.set(LS.key, publicKey);
            await sync();
            opts.toast('Push-Benachrichtigungen aktiv! 🔔', 'success');
            return true;
        } catch (e) {
            console.warn('Push aktivieren:', e);
            opts.toast(`Push nicht aktiviert: ${e.message}`, 'warning');
            return false;
        } finally {
            busy = false;
            render();
            document.dispatchEvent(new CustomEvent('mvbpush:change'));
        }
    }

    async function disable() {
        busy = true;
        render();
        try {
            if (sub) {
                try { await api('/push/unsubscribe', { endpoint: sub.endpoint }); } catch (e) { /* server may be asleep */ }
                await sub.unsubscribe();
            }
        } catch (e) { console.warn(e); }
        sub = null;
        reminders = [];
        ls.set(LS.rem, reminders);
        document.dispatchEvent(new CustomEvent('mvbpin:sync', { detail: null }));
        busy = false;
        render();
        document.dispatchEvent(new CustomEvent('mvbpush:change'));
        opts.toast('Push-Benachrichtigungen ausgeschaltet', 'info');
    }

    async function test() {
        try {
            await sync();
            await api('/push/test', { endpoint: sub.endpoint });
            opts.toast('Test unterwegs – gleich sollte es klingeln 🔔', 'success');
        } catch (e) {
            // fallback: at least show a local notification
            try {
                const r = await getReg();
                await r.showNotification('🔔 Test (lokal)', { body: `Server-Push gerade nicht erreichbar: ${e.message}`, icon: '/assets/icon-192.png', badge: '/assets/badge-72.png' });
            } catch (e2) { /* ignore */ }
            opts.toast(`Server-Push fehlgeschlagen: ${e.message}`, 'warning');
        }
    }

    // ---------------------------------------------------------
    // Settings card (Meldungen-Tab)
    // ---------------------------------------------------------
    function state() {
        if (!supported) return isIOS && !standalone ? 'ios-install' : 'unsupported';
        if (Notification.permission === 'denied') return 'denied';
        if (sub && Notification.permission === 'granted') return 'on';
        return 'off';
    }

    function lineChips(list) {
        return list.map(([n, c]) => {
            const on = prefs.lines.includes(n);
            return `<button type="button" class="pc-line${on ? ' on' : ''}${lum(c) > 180 ? ' dark' : ''}" data-line="${n}" style="--lc:${c}" aria-pressed="${on}">${n}</button>`;
        }).join('');
    }

    function fmtTime(ms) {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function render() {
        const card = document.getElementById('alertsPushCard');
        if (!card) return;
        const st = state();
        const dismissed = ls.get(LS.dismissed, false) === true || ls.get(LS.dismissed, false) === 'true';
        card.className = `alerts-push-card pc-${st}${busy ? ' busy' : ''}`;
        card.hidden = st === 'unsupported';

        if (st === 'ios-install') {
            card.innerHTML = `<div class="pc-head"><div class="pc-icon">📲</div><div class="pc-text"><strong>Push auf dem iPhone</strong>
                <span>Apple erlaubt Push-Nachrichten nur in der installierten App: Tippe unten auf <b>Teilen</b> → <b>„Zum Home-Bildschirm“</b> und öffne Magdeburg Mobil von dort.</span></div></div>`;
            return;
        }
        if (st === 'denied') {
            card.innerHTML = `<div class="pc-head"><div class="pc-icon">🚫</div><div class="pc-text"><strong>Benachrichtigungen blockiert</strong>
                <span>Erlaube sie im Schloss-Symbol neben der Adresse (bzw. in den App-Einstellungen) und lade die Seite neu.</span></div></div>`;
            return;
        }
        if (st === 'off') {
            if (dismissed) {
                card.className += ' pc-compact';
                card.innerHTML = `<button type="button" class="pc-compact-btn" data-act="expand">🔔 Push-Benachrichtigungen einrichten <span aria-hidden="true">›</span></button>`;
                return;
            }
            card.innerHTML = `<div class="pc-head"><div class="pc-icon">🔔</div><div class="pc-text"><strong>Nie wieder von Störungen überrascht</strong>
                <span>Echte Push-Nachrichten bei Sperrungen &amp; SEV – auch wenn die App zu ist. Auf Wunsch nur für deine Linien, plus Abfahrts-Wecker.</span></div>
                <div class="pc-actions"><button type="button" class="pc-btn primary" data-act="enable"${busy ? ' disabled' : ''}>${busy ? 'Moment…' : 'Aktivieren'}</button>
                <button type="button" class="pc-x" data-act="dismiss" aria-label="Ausblenden">×</button></div></div>`;
            return;
        }
        // on
        const remHtml = reminders.length ? `<div class="pc-section"><span class="pc-label">Abfahrts-Wecker</span>
            ${reminders.map(r => `<div class="pc-rem"><span>⏰ <b>${esc(r.line)}</b> → ${esc(r.direction)} · ${esc(r.station)} · ${fmtTime(r.planned)} <small>(${r.lead} Min. vorher)</small></span>
            <button type="button" class="pc-x small" data-act="cancel-rem" data-id="${esc(r.id)}" aria-label="Wecker löschen">×</button></div>`).join('')}</div>` : '';
        const quietOn = !!prefs.quiet;
        card.innerHTML = `
            <div class="pc-head"><div class="pc-icon on">🔔</div><div class="pc-text"><strong>Push-Benachrichtigungen aktiv</strong>
                <span>${prefs.lines.length ? `Störungen für Linie ${prefs.lines.join(', ')}` : 'Alle neuen Störungen im MVB-Netz'}${prefs.criticalOnly ? ' · nur Sperrungen & Ausfälle' : ''}${quietOn ? ' · Nachtruhe 22–6 Uhr' : ''}</span></div>
                <div class="pc-actions"><button type="button" class="pc-btn" data-act="test">Test</button>
                <button type="button" class="pc-btn ghost" data-act="disable">Aus</button></div></div>
            <div class="pc-section pc-switches">
                <label class="pc-switch"><input type="checkbox" data-pref="disruptions"${prefs.disruptions ? ' checked' : ''}><span></span>Neue Störungen</label>
                <label class="pc-switch"><input type="checkbox" data-pref="criticalOnly"${prefs.criticalOnly ? ' checked' : ''}><span></span>Nur Sperrungen &amp; Ausfälle</label>
                <label class="pc-switch"><input type="checkbox" data-pref="quiet"${quietOn ? ' checked' : ''}><span></span>Nachtruhe 22–6 Uhr</label>
            </div>
            <div class="pc-section">
                <span class="pc-label">Meine Linien <small>${prefs.lines.length ? '' : '(keine Auswahl = alle)'}</small></span>
                <div class="pc-lines">${lineChips(LINES.tram)}
                    <button type="button" class="pc-more" data-act="bus">${showBus ? 'Busse ausblenden' : '+ Buslinien'}</button></div>
                ${showBus ? `<div class="pc-lines">${lineChips(LINES.bus)}</div>` : ''}
            </div>
            ${remHtml}
            <p class="pc-hint">Tipp: In jeder Abfahrt findest du den <b>⏰ Abfahrts-Wecker</b>.</p>`;
    }

    function wireCard() {
        const card = document.getElementById('alertsPushCard');
        if (!card || card._wired) return;
        card._wired = true;
        card.addEventListener('click', async (e) => {
            const line = e.target.closest('.pc-line');
            if (line) {
                const n = line.dataset.line;
                prefs.lines = prefs.lines.includes(n) ? prefs.lines.filter(x => x !== n) : [...prefs.lines, n];
                ls.set(LS.prefs, prefs);
                render();
                syncSoon();
                return;
            }
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'enable') enable();
            else if (act === 'disable') disable();
            else if (act === 'test') test();
            else if (act === 'dismiss') { ls.set(LS.dismissed, true); render(); }
            else if (act === 'expand') { ls.set(LS.dismissed, false); render(); }
            else if (act === 'bus') { showBus = !showBus; render(); }
            else if (act === 'cancel-rem') cancelReminder(btn.dataset.id);
        });
        card.addEventListener('change', (e) => {
            const input = e.target.closest('[data-pref]');
            if (!input) return;
            const k = input.dataset.pref;
            if (k === 'quiet') prefs.quiet = input.checked ? [22, 6] : null;
            else prefs[k] = input.checked;
            ls.set(LS.prefs, prefs);
            render();
            syncSoon();
        });
    }

    // ---------------------------------------------------------
    // Abfahrts-Wecker
    // ---------------------------------------------------------
    function depEpoch(dep) {
        if (!dep || !dep.time || !/^\d{1,2}:\d{2}$/.test(dep.time)) return null;
        const [h, m] = dep.time.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        d.setDate(d.getDate() + (dep.day_offset || 0));
        // a time far in the past most likely means "tomorrow" (after midnight)
        if (d.getTime() < Date.now() - 6 * 3600000) d.setDate(d.getDate() + 1);
        return d.getTime();
    }

    function remId(dep, station) {
        return `${(dep.journey_id || '').slice(-24)}|${station}|${dep.time}`.replace(/[^\w|:-]/g, '').slice(-60);
    }

    async function setReminder(dep, station, lead) {
        if (state() !== 'on') {
            const ok = await enable();
            if (!ok) return false;
        }
        const planned = depEpoch(dep);
        const id = remId(dep, station);
        try {
            const res = await api('/push/remind', {
                endpoint: sub.endpoint, id, jid: dep.journey_id, line: dep.line, direction: dep.direction,
                station, planned, lead, delay: dep.delay || 0,
            });
            reminders = res.reminders || reminders;
            ls.set(LS.rem, reminders);
            opts.toast(`⏰ Wecker gestellt: ${lead} Min. vor Abfahrt`, 'success');
            render();
            return true;
        } catch (e) {
            opts.toast(`Wecker nicht gestellt: ${e.message}`, 'warning');
            return false;
        }
    }

    async function cancelReminder(id) {
        reminders = reminders.filter(r => r.id !== id);
        ls.set(LS.rem, reminders);
        render();
        document.dispatchEvent(new CustomEvent('mvbpush:change'));
        if (sub) {
            try { await api('/push/remind', { endpoint: sub.endpoint, cancel: id }); } catch (e) { /* ignore */ }
        }
    }

    MVBPush.renderReminder = function (container, dep, station) {
        if (!container) return;
        const planned = depEpoch(dep);
        const can = supported && dep && dep.journey_id && planned && planned > Date.now() - 60000 && !dep.cancelled;
        container.hidden = !can;
        if (!can) { container.innerHTML = ''; return; }
        const draw = () => {
            const id = remId(dep, station);
            const active = reminders.find(r => r.id === id);
            container.innerHTML = active
                ? `<div class="remind-bar on"><span class="remind-ico">⏰</span><span class="remind-txt">Wecker aktiv: <b>${active.lead} Min.</b> vor Abfahrt – mit Live-Verspätung</span>
                    <button type="button" class="remind-btn ghost" data-cancel="${esc(id)}">Löschen</button></div>`
                : `<div class="remind-bar"><span class="remind-ico">⏰</span><span class="remind-txt">Abfahrts-Wecker</span>
                    ${[2, 5, 10].map(n => `<button type="button" class="remind-btn" data-lead="${n}">${n} Min.</button>`).join('')}</div>`;
        };
        draw();
        container.onclick = async (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            e.stopPropagation();
            b.disabled = true;
            if (b.dataset.cancel) await cancelReminder(b.dataset.cancel);
            else await setReminder(dep, station, parseInt(b.dataset.lead, 10));
            draw();
        };
        const onChange = () => { if (container.isConnected) draw(); else document.removeEventListener('mvbpush:change', onChange); };
        document.addEventListener('mvbpush:change', onChange);
    };

    // Local fallback (used by the in-page poller when server push isn't active)
    MVBPush.localNotify = async function (title, body, url) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        try {
            const r = await getReg();
            await r.showNotification(title, { body, icon: '/assets/icon-192.png', badge: '/assets/badge-72.png', data: { url: url || '/?tab=alerts' } });
        } catch (e) { /* ignore */ }
    };

    MVBPush.isServerPushActive = () => state() === 'on';
    // used by pin.js (Fahrt anpinnen)
    MVBPush.state = () => state();
    MVBPush.supported = supported;
    MVBPush.ensureOn = async () => (state() === 'on' ? true : enable());
    MVBPush.endpoint = () => (sub ? sub.endpoint : null);
    MVBPush.api = (path, body) => api(path, body);
    MVBPush.depEpoch = (dep) => depEpoch(dep);

    MVBPush.init = async function (o) {
        opts = Object.assign(opts, o || {});
        wireCard();
        render();
        if (!supported) return;
        try {
            const r = await getReg();
            sub = await r.pushManager.getSubscription();
            if (sub && Notification.permission === 'granted') await sync();
        } catch (e) {
            console.warn('Push-Init:', e);
        }
        render();
    };

    window.MVBPush = MVBPush;
})();
