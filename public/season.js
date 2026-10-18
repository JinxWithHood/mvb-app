/* ============================================================
   Magdeburg Mobil — Saison-Skins für die Live-Karte
   Ostern, Halloween, Weihnachten, Silvester und Geburtstag (13.2. / 26.2.)
   - setzt .skin-<name> auf .map-shell (das CSS macht den Rest)
   - Effekte (Schnee, Nebel, Konfetti, Feuerwerk) in einer eigenen Ebene
   - Vorschau: ?skin=ostern|halloween|weihnachten|silvester|silvester-0|geburtstag|off
   - an/aus: Knopf in der Kartenleiste (gemerkt in localStorage)
   ============================================================ */
(function () {
    'use strict';

    const TZ = 'Europe/Berlin';
    const LS_OFF = 'mvb_season_off';
    const SS_PREVIEW = 'mvb_skin_preview';
    const NAMES = {
        ostern: 'Ostern',
        halloween: 'Halloween',
        weihnachten: 'Weihnachten',
        silvester: 'Silvester',
        geburtstag: 'Geburtstag',
    };

    // preview via URL (kept for this browser tab)
    try {
        const q = new URLSearchParams(location.search).get('skin');
        if (q) sessionStorage.setItem(SS_PREVIEW, q.toLowerCase());
    } catch (e) { /* ignore */ }

    function preview() {
        try { return sessionStorage.getItem(SS_PREVIEW); } catch (e) { return null; }
    }

    function isOff() {
        try { return localStorage.getItem(LS_OFF) === '1'; } catch (e) { return false; }
    }

    function berlinNow() {
        const f = new Intl.DateTimeFormat('en-CA', {
            timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        const p = {};
        f.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
        return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
    }

    const dayNum = (y, m, d) => Date.UTC(y, m - 1, d) / 864e5;

    // Ostersonntag (gregorianisch, Meeus/Jones/Butcher)
    function easterDay(y) {
        const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
        const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
        return dayNum(y, month, day);
    }

    function firstAdvent(y) {
        const wd = new Date(Date.UTC(y, 11, 25)).getUTCDay(); // 0 = Sonntag
        return dayNum(y, 12, 25) - (wd === 0 ? 7 : wd) - 21;
    }

    function seasonFor(t) {
        const dn = dayNum(t.y, t.m, t.d);
        if (t.m === 2 && (t.d === 13 || t.d === 26)) return 'geburtstag';
        const easter = easterDay(t.y);
        if (dn >= easter - 3 && dn <= easter + 1) return 'ostern';
        if (t.m === 10 && t.d >= 29) return 'halloween';
        if (t.m === 11 && t.d === 1 && t.h < 3) return 'halloween';
        if (t.m === 12 && t.d === 31 && t.h >= 18) return 'silvester';
        if (t.m === 1 && t.d === 1 && t.h < 3) return 'silvester';
        if (dn >= firstAdvent(t.y) && (t.m === 11 || (t.m === 12 && t.d <= 26))) return 'weihnachten';
        return null;
    }

    let current = null;      // active skin name
    let fxEl = null, bannerEl = null, btnEl = null;
    let fireworksTimer = null, tickTimer = null, bannerTimer = null;
    let lastCountdown = null, midnightDone = false;

    function shell() { return document.querySelector('.map-shell'); }

    function ensureLayers(sh) {
        if (!fxEl) {
            fxEl = document.createElement('div');
            fxEl.className = 'map-season-fx';
            fxEl.setAttribute('aria-hidden', 'true');
            sh.appendChild(fxEl);
        }
        if (!bannerEl) {
            bannerEl = document.createElement('div');
            bannerEl.className = 'map-season-banner';
            bannerEl.setAttribute('role', 'status');
            bannerEl.hidden = true;
            sh.appendChild(bannerEl);
        }
        if (!btnEl) {
            const actions = sh.querySelector('.map-actions');
            if (actions) {
                btnEl = document.createElement('button');
                btnEl.type = 'button';
                btnEl.className = 'map-icon-btn map-season-btn';
                btnEl.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/></svg>';
                btnEl.addEventListener('click', () => {
                    try { localStorage.setItem(LS_OFF, isOff() ? '0' : '1'); } catch (e) { /* ignore */ }
                    apply(true);
                });
                actions.insertBefore(btnEl, actions.firstChild);
            }
        }
    }

    function showBanner(text, ms) {
        if (!bannerEl) return;
        bannerEl.textContent = text;
        bannerEl.hidden = false;
        bannerEl.classList.remove('big');
        clearTimeout(bannerTimer);
        if (ms) bannerTimer = setTimeout(() => { bannerEl.hidden = true; }, ms);
    }

    function burst() {
        if (!fxEl) return;
        const colors = ['#fcd34d', '#f472b6', '#60a5fa', '#4ade80', '#ffffff', '#fb923c'];
        const s = document.createElement('span');
        s.className = 'fw';
        s.style.left = (8 + Math.random() * 84) + '%';
        s.style.top = (10 + Math.random() * 60) + '%';
        s.style.setProperty('--c', colors[Math.floor(Math.random() * colors.length)]);
        fxEl.appendChild(s);
        setTimeout(() => s.remove(), 1600);
    }

    function startFireworks() {
        if (fireworksTimer) return;
        fireworksTimer = setInterval(burst, 550);
        burst();
    }

    function stopFireworks() {
        clearInterval(fireworksTimer);
        fireworksTimer = null;
    }

    function midnight(sh, year) {
        if (midnightDone) return;
        midnightDone = true;
        sh.classList.add('skin-midnight');
        setTimeout(() => sh.classList.remove('skin-midnight'), 6000);
        showBanner(`Frohes neues Jahr ${year}!`, 12000);
        startFireworks();
    }

    // Silvester: Countdown 23:59:50 – 0:00, danach 15 Min. Feuerwerk
    function silvesterTick() {
        const sh = shell();
        if (!sh || current !== 'silvester') return;
        const pv = preview();
        if (pv === 'silvester-0') { midnight(sh, berlinNow().y + 1); return; }
        const t = berlinNow();
        if (t.m === 12 && t.d === 31 && t.h === 23 && t.mi === 59 && t.s >= 50) {
            const left = 60 - t.s;
            if (left !== lastCountdown) {
                lastCountdown = left;
                showBanner(String(left), 0);
                bannerEl.classList.add('big');
            }
        } else if (t.m === 1 && t.d === 1 && t.h === 0 && t.mi < 15) {
            midnight(sh, t.y);
        } else {
            stopFireworks();
        }
    }

    function apply(fromButton) {
        const sh = shell();
        if (!sh) return;
        const pv = preview();
        let skin = null;
        if (pv && pv !== 'off') skin = pv === 'silvester-0' ? 'silvester' : (NAMES[pv] ? pv : null);
        else if (pv !== 'off') skin = seasonFor(berlinNow());

        ensureLayers(sh);
        if (btnEl) {
            btnEl.hidden = !skin;
            btnEl.classList.toggle('active', !!skin && !isOff());
            btnEl.title = skin ? `${NAMES[skin]}-Deko ${isOff() ? 'einschalten' : 'ausschalten'}` : '';
            btnEl.setAttribute('aria-label', btnEl.title || 'Saison-Deko');
            btnEl.setAttribute('aria-pressed', skin && !isOff() ? 'true' : 'false');
        }
        const active = skin && !isOff() ? skin : null;

        if (active !== current) {
            Object.keys(NAMES).forEach(n => sh.classList.remove('skin-' + n));
            if (fxEl) { fxEl.className = 'map-season-fx'; fxEl.innerHTML = ''; }
            stopFireworks();
            clearInterval(tickTimer);
            tickTimer = null;
            midnightDone = false;
            lastCountdown = null;
            if (bannerEl) bannerEl.hidden = true;
            current = active;
            if (active) {
                sh.classList.add('skin-' + active);
                fxEl.classList.add('fx-' + active);
                if (active === 'geburtstag') showBanner('Happy Birthday! 🎂', 9000);
                if (active === 'silvester') tickTimer = setInterval(silvesterTick, 1000);
            }
            if (fromButton && window.MVBToast) {
                window.MVBToast(active ? `${NAMES[active]}-Deko an ✨` : 'Saison-Deko aus', 'info');
            }
        }
    }

    function start() {
        apply(false);
        setInterval(() => apply(false), 30000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.MVBSeason = { apply, seasonFor, berlinNow };
})();
