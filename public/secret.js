/* Magdeburg Mobil — kleines Geheimnis 🚋💚
   Wer das richtige Wort tippt (Tastatur oder in ein beliebiges Eingabefeld),
   bekommt ein Foto und die Seite färbt sich langsam grün-bläulich.
   Das Wort steht hier nur als SHA-256-Hash – kein Spoiler im Quelltext. */
(function () {
    'use strict';

    const HASH = '4dfcdb46e07f11685bf52d6121ea893f8ab84dc1e089b1dfcae3161b2d416143';
    const LEN = 16;
    const IMG = 'assets/secret-1404.jpg';
    let buffer = '';
    let busy = false;
    let active = false;

    async function sha256(text) {
        if (!window.crypto || !crypto.subtle) return '';
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function matches(text) {
        if (!text || text.length < LEN) return false;
        return (await sha256(text.slice(-LEN))) === HASH;
    }

    function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html) e.innerHTML = html;
        return e;
    }

    function fire() {
        if (busy) return;
        busy = true;
        buffer = '';
        if (navigator.vibrate) { try { navigator.vibrate([60, 40, 60, 40, 160]); } catch (e) { /* ignore */ } }

        // 1) page slowly turns green-blue
        let tint = document.querySelector('.sx-tint');
        if (!tint) { tint = el('div', 'sx-tint'); document.body.appendChild(tint); }
        requestAnimationFrame(() => requestAnimationFrame(() => tint.classList.add('on')));
        active = true;

        // 2) the photo
        const photo = el('div', 'sx-photo', `
            <figure class="sx-card" role="dialog" aria-label="Geheimnis gefunden">
              <img src="${IMG}" alt="MVB-Straßenbahn 1404 in einer Wendeschleife" decoding="async">
              <figcaption class="sx-cap">
                <div>Du hast das Geheimnis gefunden 💚<small>Magdeburg fährt grün. Antippen zum Schließen.</small></div>
                <span class="sx-num">1404</span>
              </figcaption>
            </figure>`);
        const close = () => {
            photo.classList.remove('on');
            setTimeout(() => photo.remove(), 800);
            document.removeEventListener('keydown', onEsc, true);
            busy = false;
            showReset();
        };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        photo.addEventListener('click', close);
        document.addEventListener('keydown', onEsc, true);
        const img = photo.querySelector('img');
        const show = () => { document.body.appendChild(photo); requestAnimationFrame(() => requestAnimationFrame(() => photo.classList.add('on'))); };
        if (img.complete) show(); else { img.onload = show; img.onerror = show; }
        setTimeout(() => { if (photo.isConnected && photo.classList.contains('on')) close(); }, 9000);
    }

    function showReset() {
        if (document.querySelector('.sx-reset')) return;
        const btn = el('button', 'sx-reset', 'Zurück zu normal');
        btn.type = 'button';
        btn.addEventListener('click', () => {
            const tint = document.querySelector('.sx-tint');
            if (tint) { tint.style.transition = 'opacity 1.5s ease'; tint.classList.remove('on'); setTimeout(() => tint.remove(), 1600); }
            btn.classList.remove('on');
            setTimeout(() => btn.remove(), 500);
            active = false;
        });
        document.body.appendChild(btn);
        requestAnimationFrame(() => requestAnimationFrame(() => btn.classList.add('on')));
    }

    // physical keyboard, anywhere on the page
    document.addEventListener('keydown', async (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || !e.key || e.key.length !== 1) return;
        buffer = (buffer + e.key.toLowerCase()).slice(-LEN);
        if (!active && await matches(buffer)) fire();
    }, true);

    // on-screen keyboards (phone/tablet) don't send usable key events: watch the input fields
    document.addEventListener('input', async (e) => {
        const t = e.target;
        if (!t || !('value' in t) || typeof t.value !== 'string' || t.type === 'password') return;
        const v = t.value.trim().toLowerCase();
        if (active || !(await matches(v))) return;
        // remove the word again so no search runs for it
        t.value = t.value.trim().slice(0, -LEN);
        t.dispatchEvent(new Event('input', { bubbles: true }));
        t.blur();
        fire();
    }, true);
})();
