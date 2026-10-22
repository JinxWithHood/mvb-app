/* ============================================================
   Magdeburg Mobil — Einstellungen
   Verkehrsmittel, Umstiege, Umstiegszeit, D-Ticket, Fahrrad,
   Zeitraum der Abfahrtstafel, Start-Haltestelle, Design, Saison-Deko.
   Gespeichert in localStorage (nur auf diesem Gerät).
   ============================================================ */
(function () {
    'use strict';

    const KEY = 'mvb_settings_v1';
    const MODES = [
        ['tram', 'Tram'], ['bus', 'Bus'], ['sbahn', 'S-Bahn'], ['ubahn', 'U-Bahn'],
        ['regional', 'Regio'], ['express', 'Fernverkehr'], ['ferry', 'Fähre'],
    ];
    const DEFAULTS = {
        modes: { tram: true, bus: true, sbahn: true, ubahn: true, regional: true, express: true, ferry: true },
        maxChanges: -1,
        minChange: 0,
        dticket: false,
        bike: false,
        boardDuration: 60,
        homeStation: null,
    };

    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function load() {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
        const s = Object.assign(clone(DEFAULTS), saved);
        s.modes = Object.assign(clone(DEFAULTS.modes), saved.modes || {});
        if (!Object.values(s.modes).some(Boolean)) s.modes = clone(DEFAULTS.modes);
        return s;
    }

    let settings = load();

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
        updateBadge();
        document.dispatchEvent(new CustomEvent('mvb:settings', { detail: get() }));
    }

    function get() { return clone(settings); }

    function set(patch) {
        settings = Object.assign(settings, patch);
        save();
    }

    /** How many connection options differ from the defaults (badge on the "Optionen" button). */
    function routeOptionCount() {
        let n = 0;
        if (MODES.some(([k]) => !settings.modes[k])) n++;
        if (settings.maxChanges >= 0) n++;
        if (settings.minChange > 0) n++;
        if (settings.dticket) n++;
        if (settings.bike) n++;
        return n;
    }

    function updateBadge() {
        const b = document.getElementById('planOptionsCount');
        if (!b) return;
        const n = routeOptionCount();
        b.textContent = String(n);
        b.hidden = n === 0;
    }

    // ------------------------------------------------------------------
    // Sheet UI
    // ------------------------------------------------------------------
    let overlay = null, lastFocus = null;

    function seg(name, options, value) {
        return `<div class="set-seg" role="group" data-seg="${name}">` + options.map(([v, label]) =>
            `<button type="button" class="set-seg-btn${String(v) === String(value) ? ' active' : ''}" data-value="${v}" aria-pressed="${String(v) === String(value)}">${label}</button>`
        ).join('') + '</div>';
    }

    function toggle(name, title, sub, on) {
        return `<label class="set-row set-toggle">
            <span class="set-row-text"><span class="set-row-title">${title}</span>${sub ? `<span class="set-row-sub">${sub}</span>` : ''}</span>
            <input type="checkbox" class="set-switch" data-toggle="${name}" ${on ? 'checked' : ''}>
        </label>`;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    }

    function currentTheme() {
        const t = (document.body.getAttribute('data-theme') || '').toLowerCase();
        return t === 'jinx' ? 'jinx' : (t === 'dark' ? 'dark' : 'light');
    }

    function seasonOn() {
        try { return localStorage.getItem('mvb_season_off') !== '1'; } catch (e) { return true; }
    }

    function render() {
        const s = settings;
        const app = window.MVBApp;
        const cur = app && app.getCurrentStation ? app.getCurrentStation() : null;
        const home = s.homeStation;
        const theme = currentTheme();
        overlay.querySelector('.settings-body').innerHTML = `
            <section class="set-section">
                <h3 class="set-heading">Verkehrsmittel</h3>
                <div class="set-chips">
                    ${MODES.map(([k, label]) => `<button type="button" class="set-chip${s.modes[k] ? ' on' : ''}" data-mode="${k}" aria-pressed="${!!s.modes[k]}">${label}</button>`).join('')}
                </div>
                <p class="set-note">Gilt für die Verbindungssuche. Die Abfahrtstafel filterst du direkt über ihre Knöpfe.</p>
            </section>

            <section class="set-section">
                <h3 class="set-heading">Verbindungen</h3>
                <div class="set-card">
                    <div class="set-row set-stack">
                        <span class="set-row-title">Max. Umstiege</span>
                        ${seg('maxChanges', [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [-1, 'egal']], s.maxChanges)}
                    </div>
                    <div class="set-row set-stack">
                        <span class="set-row-title">Zeit zum Umsteigen</span>
                        ${seg('minChange', [[0, 'Normal'], [5, '+5 Min'], [10, '+10 Min']], s.minChange)}
                    </div>
                    ${toggle('dticket', 'Nur Deutschlandticket', 'Ohne ICE, IC und EC', s.dticket)}
                    ${toggle('bike', 'Fahrrad dabei', 'Nur Fahrten mit Fahrradmitnahme', s.bike)}
                </div>
            </section>

            <section class="set-section">
                <h3 class="set-heading">Abfahrten &amp; App</h3>
                <div class="set-card">
                    <div class="set-row set-stack">
                        <span class="set-row-title">Zeitraum der Abfahrtstafel</span>
                        ${seg('boardDuration', [[30, '30 Min'], [60, '1 Std'], [120, '2 Std'], [240, '4 Std']], s.boardDuration)}
                    </div>
                    <div class="set-row set-stack">
                        <span class="set-row-title">Start-Haltestelle beim Öffnen</span>
                        <span class="set-row-sub">${home ? esc(home.name) : 'Magdeburg Hauptbahnhof (Standard)'}</span>
                        <div class="set-actions">
                            ${cur && (!home || String(home.id) !== String(cur.id)) && cur.kind !== 'address' ? `<button type="button" class="set-btn" data-action="home-set">„${esc(cur.name.replace(/^Magdeburg,\s*/, ''))}“ übernehmen</button>` : ''}
                            ${home ? '<button type="button" class="set-btn ghost" data-action="home-clear">Zurück auf Standard</button>' : ''}
                        </div>
                    </div>
                    ${theme === 'jinx' ? '' : `<div class="set-row set-stack">
                        <span class="set-row-title">Design</span>
                        ${seg('theme', [['light', 'Hell'], ['dark', 'Dunkel']], theme)}
                    </div>`}
                    ${toggle('season', 'Saison-Deko auf der Karte', 'Ostern, Halloween, Weihnachten …', seasonOn())}
                </div>
            </section>

            <button type="button" class="set-reset" data-action="reset">Auf Standard zurücksetzen</button>
            <p class="set-note center">Einstellungen bleiben nur auf diesem Gerät.</p>
        `;
    }

    function onClick(e) {
        const t = e.target.closest('button, input');
        if (!t) return;
        if (t.dataset.mode) {
            const k = t.dataset.mode;
            const next = Object.assign({}, settings.modes, { [k]: !settings.modes[k] });
            if (!Object.values(next).some(Boolean)) {
                if (window.MVBApp) window.MVBApp.showToast('Mindestens ein Verkehrsmittel muss an bleiben', 'warning');
                return;
            }
            set({ modes: next });
            render();
            return;
        }
        const segEl = t.closest('.set-seg');
        if (segEl && t.dataset.value !== undefined) {
            const name = segEl.dataset.seg;
            const raw = t.dataset.value;
            if (name === 'theme') {
                if (window.MVBApp) window.MVBApp.applyTheme(raw);
            } else {
                const val = parseInt(raw, 10);
                set({ [name]: val });
                if (name === 'boardDuration' && window.MVBApp) {
                    window.MVBApp.setDuration(val);
                    window.MVBApp.fetchDepartures(true);
                }
            }
            render();
            return;
        }
        const act = t.dataset.action;
        if (act === 'home-set' && window.MVBApp) {
            const cur = window.MVBApp.getCurrentStation();
            if (cur) set({ homeStation: { id: cur.id, name: cur.name, kind: cur.kind } });
            render();
        } else if (act === 'home-clear') {
            set({ homeStation: null });
            render();
        } else if (act === 'reset') {
            const home = null;
            settings = clone(DEFAULTS);
            settings.homeStation = home;
            save();
            if (window.MVBApp) { window.MVBApp.setDuration(60); }
            render();
            if (window.MVBApp) window.MVBApp.showToast('Einstellungen zurückgesetzt', 'info');
        } else if (act === 'close') {
            close();
        }
    }

    function onChange(e) {
        const t = e.target;
        if (!t.dataset || !t.dataset.toggle) return;
        if (t.dataset.toggle === 'season') {
            try { localStorage.setItem('mvb_season_off', t.checked ? '0' : '1'); } catch (err) { /* ignore */ }
            if (window.MVBSeason) window.MVBSeason.apply(false);
            return;
        }
        set({ [t.dataset.toggle]: t.checked });
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'settings-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" tabindex="-1">
                <div class="settings-handle" aria-hidden="true"></div>
                <div class="settings-head">
                    <h2 id="settingsTitle">Einstellungen</h2>
                    <button type="button" class="settings-done" data-action="close">Fertig</button>
                </div>
                <div class="settings-body"></div>
            </div>`;
        (document.getElementById('app') || document.body).appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { close(); return; }
            onClick(e);
        });
        overlay.addEventListener('change', onChange);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
        });
    }

    function open() {
        if (!overlay) build();
        lastFocus = document.activeElement;
        render();
        overlay.hidden = false;
        document.body.classList.add('settings-open');
        requestAnimationFrame(() => overlay.classList.add('show'));
        const sheet = overlay.querySelector('.settings-sheet');
        if (sheet) sheet.focus();
    }

    function close() {
        if (!overlay || overlay.hidden) return;
        overlay.classList.remove('show');
        document.body.classList.remove('settings-open');
        setTimeout(() => { overlay.hidden = true; }, 180);
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function wire() {
        ['settingsBtn', 'planOptionsBtn'].forEach(id => {
            const b = document.getElementById(id);
            if (b) b.addEventListener('click', open);
        });
        updateBadge();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.MVBSettings = { get, set, open, close, routeOptionCount, KEY, DEFAULTS: clone(DEFAULTS) };
})();
