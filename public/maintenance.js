/* ============================================================
   Magdeburg Mobil — Wartungsmodus
   Fragt beim Start und danach alle 90 s /api/status ab.
   - "banner": Hinweis oben in der App (wegklickbar)
   - "lock":   Wartungsbildschirm über der ganzen App
   Admins (angemeldet im Admin-Bereich) sehen die App trotzdem.
   ============================================================ */
(function () {
    'use strict';

    function apiBase() {
        try {
            const custom = localStorage.getItem('custom_api_url') || new URLSearchParams(location.search).get('api');
            if (custom) return custom;
        } catch (e) { /* ignore */ }
        const h = location.hostname;
        const local = location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1' || h === '' ||
            h.startsWith('192.168.') || h.startsWith('10.');
        if (local) return 'http://127.0.0.1:5000/api';
        if (h.includes('magdeburg-mobil.onrender.com')) return 'https://mvb-app.onrender.com/api';
        return '/api';
    }

    const STYLE = `
    .mvb-maint-lock{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(900px 500px at 20% -10%,#0e3a24 0%,transparent 60%),#070b09;color:#eef4f0;font-family:Inter,system-ui,sans-serif;text-align:center}
    .mvb-maint-box{max-width:440px;display:flex;flex-direction:column;align-items:center;gap:14px}
    .mvb-maint-icon{font-size:56px;line-height:1;animation:mvbWrench 2.4s ease-in-out infinite}
    @keyframes mvbWrench{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(14deg)}}
    .mvb-maint-box h1{margin:0;font-size:28px;letter-spacing:-.02em}
    .mvb-maint-box p{margin:0;color:#b7c6be;font-size:16px;line-height:1.5;white-space:pre-wrap}
    .mvb-maint-until{padding:8px 14px;border-radius:999px;background:rgba(18,179,102,.14);color:#7ff0b0;font-weight:800;font-size:14px}
    .mvb-maint-btn{margin-top:6px;height:46px;padding:0 20px;border-radius:14px;border:0;background:linear-gradient(180deg,#12b366,#018e4a);color:#fff;font:800 15px Inter,system-ui,sans-serif;cursor:pointer}
    .mvb-maint-banner{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147482000;width:min(640px,calc(100% - 24px));display:flex;align-items:center;gap:10px;padding:11px 12px 11px 16px;border-radius:16px;background:#2a2108;border:1px solid rgba(251,191,36,.5);color:#fde68a;font:600 14px Inter,system-ui,sans-serif;box-shadow:0 18px 40px rgba(0,0,0,.45)}
    .mvb-maint-banner.admin{background:#2a0d0d;border-color:rgba(255,107,107,.5);color:#fecaca}
    .mvb-maint-banner span{flex:1;line-height:1.35}
    .mvb-maint-banner button{flex:none;width:32px;height:32px;border-radius:50%;border:0;background:rgba(255,255,255,.1);color:inherit;font-size:16px;cursor:pointer}
    `;

    let lockEl = null, bannerEl = null, lastMode = null;

    function ensureStyle() {
        if (document.getElementById('mvb-maint-style')) return;
        const s = document.createElement('style');
        s.id = 'mvb-maint-style';
        s.textContent = STYLE;
        document.head.appendChild(s);
    }

    function untilText(m) {
        if (m.until) return `Voraussichtlich zurück um ${m.until} Uhr`;
        if (m.endsAt) {
            const t = new Date(m.endsAt * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            return `Voraussichtlich zurück um ${t} Uhr`;
        }
        return '';
    }

    function showLock(m) {
        ensureStyle();
        if (!lockEl) {
            lockEl = document.createElement('div');
            lockEl.className = 'mvb-maint-lock';
            lockEl.setAttribute('role', 'alertdialog');
            lockEl.setAttribute('aria-modal', 'true');
            document.body.appendChild(lockEl);
            document.documentElement.style.overflow = 'hidden';
            const loader = document.getElementById('app-loading-screen');
            if (loader) loader.style.display = 'none';
        }
        const until = untilText(m);
        lockEl.innerHTML = `<div class="mvb-maint-box">
            <div class="mvb-maint-icon" aria-hidden="true">🛠️</div>
            <h1>Kurze Wartungspause</h1>
            <p></p>
            ${until ? `<div class="mvb-maint-until">${until}</div>` : ''}
            <button type="button" class="mvb-maint-btn">Nochmal prüfen</button>
        </div>`;
        lockEl.querySelector('p').textContent = m.message || 'Wir schrauben kurz an der App. Gleich geht’s weiter!';
        lockEl.querySelector('button').addEventListener('click', () => check(true));
    }

    function hideLock() {
        if (!lockEl) return;
        lockEl.remove();
        lockEl = null;
        document.documentElement.style.overflow = '';
    }

    function showBanner(text, admin) {
        ensureStyle();
        const key = 'mvb_maint_dismissed';
        if (!admin) {
            try { if (sessionStorage.getItem(key) === text) return; } catch (e) { /* ignore */ }
        }
        if (!bannerEl) {
            bannerEl = document.createElement('div');
            bannerEl.setAttribute('role', 'status');
            document.body.appendChild(bannerEl);
        }
        bannerEl.className = 'mvb-maint-banner' + (admin ? ' admin' : '');
        bannerEl.innerHTML = '<span></span><button type="button" aria-label="Hinweis schließen">×</button>';
        bannerEl.querySelector('span').textContent = text;
        bannerEl.querySelector('button').addEventListener('click', () => {
            try { sessionStorage.setItem(key, text); } catch (e) { /* ignore */ }
            hideBanner();
        });
    }

    function hideBanner() {
        if (!bannerEl) return;
        bannerEl.remove();
        bannerEl = null;
    }

    async function check(manual) {
        let data;
        try {
            const ctrl = 'AbortController' in window ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
            const res = await fetch(`${apiBase()}/status?_=${Date.now()}`, { credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined });
            if (timer) clearTimeout(timer);
            if (!res.ok) return;
            data = await res.json();
        } catch (e) {
            return; // server unreachable: the app handles that itself
        }
        const m = (data && data.maintenance) || { mode: 'off' };
        const admin = !!(data && data.admin);
        if (m.mode === 'lock' && !admin) {
            hideBanner();
            showLock(m);
        } else {
            const wasLocked = !!lockEl;
            hideLock();
            if (wasLocked && lastMode === 'lock') { location.reload(); return; }
            if (m.mode === 'lock' && admin) showBanner('🔒 Wartungsmodus aktiv – nur du als Admin siehst die App.', true);
            else if (m.mode === 'banner') {
                const until = untilText(m);
                showBanner(`🛠️ ${m.message || 'Wartungsarbeiten'}${until ? ' · ' + until : ''}`, false);
            } else hideBanner();
        }
        if (manual && m.mode === 'lock' && !admin) {
            const btn = lockEl && lockEl.querySelector('button');
            if (btn) { btn.textContent = 'Noch in Wartung …'; setTimeout(() => { if (btn) btn.textContent = 'Nochmal prüfen'; }, 2000); }
        }
        lastMode = admin ? 'off' : m.mode;
    }

    function start() {
        check(false);
        setInterval(() => { if (!document.hidden) check(false); }, 90000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
