/* Magdeburg Mobil — Offline-Modus
   Merkt sich die zuletzt geladenen Abfahrten (pro Haltestelle) und Linienverläufe
   auf diesem Gerät. Fällt das Netz weg (Funkloch, Server schläft), zeigt die App
   diese Daten mit einem Hinweis "Stand HH:MM" statt einer Fehlermeldung. */
(function () {
    'use strict';

    const PREFIX = 'mvb_off_';
    const MAX_AGE = 24 * 60 * 60 * 1000;     // older data is useless for a timetable
    const LIMITS = { dep: 8, jr: 12 };        // entries kept per kind

    function read(name) {
        try { return JSON.parse(localStorage.getItem(PREFIX + name) || 'null'); } catch (e) { return null; }
    }
    function write(name, value) {
        try { localStorage.setItem(PREFIX + name, JSON.stringify(value)); return true; } catch (e) { return false; }
    }

    // index per kind: [{ key, at }] newest first
    function save(kind, key, data, meta) {
        if (!key || data == null) return;
        const at = Date.now();
        const id = `${kind}_${hash(String(key))}`;
        if (!write(id, { key: String(key), at, data, meta: meta || null })) {
            // storage full: drop the oldest of this kind and try once more
            const idx = (read(`idx_${kind}`) || []);
            const old = idx.pop();
            if (old) { try { localStorage.removeItem(PREFIX + `${kind}_${hash(old.key)}`); } catch (e) { /* ignore */ } }
            write(`idx_${kind}`, idx);
            if (!write(id, { key: String(key), at, data, meta: meta || null })) return;
        }
        let idx = (read(`idx_${kind}`) || []).filter((e) => e && e.key !== String(key));
        idx.unshift({ key: String(key), at });
        const drop = idx.slice(LIMITS[kind] || 10);
        idx = idx.slice(0, LIMITS[kind] || 10);
        drop.forEach((e) => { try { localStorage.removeItem(PREFIX + `${kind}_${hash(e.key)}`); } catch (er) { /* ignore */ } });
        write(`idx_${kind}`, idx);
    }

    function load(kind, key) {
        const hit = read(`${kind}_${hash(String(key))}`);
        if (!hit || hit.key !== String(key) || !hit.at || Date.now() - hit.at > MAX_AGE) return null;
        return hit;
    }

    function hash(s) {
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    function stamp(at) {
        const d = new Date(at);
        const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const today = new Date().toDateString() === d.toDateString();
        return today ? `${hm} Uhr` : `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}, ${hm} Uhr`;
    }

    // small banner at the top of `host`
    function banner(host, at, what) {
        if (!host) return null;
        let el = host.querySelector(':scope > .offline-note');
        if (!el) {
            el = document.createElement('div');
            el.className = 'offline-note';
            el.setAttribute('role', 'status');
            host.insertBefore(el, host.firstChild);
        }
        const net = navigator.onLine === false ? 'Du bist offline' : 'Keine Verbindung zum Server';
        el.innerHTML = `<span class="offline-ico" aria-hidden="true">📡</span><span><strong>${net}</strong>`
            + `<small>${what || 'Gespeicherte Daten'} · Stand ${stamp(at)} · Verspätungen nicht aktuell</small></span>`;
        return el;
    }

    function clearBanner(host) {
        if (host) host.querySelectorAll(':scope > .offline-note').forEach((el) => el.remove());
    }

    window.MVBOffline = { save, load, banner, clearBanner, stamp };
})();
