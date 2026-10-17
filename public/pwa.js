/* ============================================================
   Magdeburg Mobil — App-Installation (PWA)
   - Android/Chrome/Edge: echter "Installieren"-Dialog (beforeinstallprompt)
   - iPhone/iPad: Schritt-für-Schritt-Hinweis (Teilen → Zum Home-Bildschirm)
   ============================================================ */
(function () {
    'use strict';

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let deferred = null;

    function buttons() {
        return document.querySelectorAll('[data-install-app]');
    }

    function update() {
        const can = !isStandalone() && (deferred || isIOS);
        buttons().forEach(b => { b.hidden = !can; });
        document.documentElement.classList.toggle('is-standalone', isStandalone());
    }

    function iosSheet() {
        let sheet = document.getElementById('installSheet');
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.id = 'installSheet';
            sheet.className = 'install-sheet';
            sheet.innerHTML = `
                <div class="install-card" role="dialog" aria-modal="true" aria-labelledby="installTitle">
                    <img src="assets/apple-touch-icon.png" alt="" class="install-icon">
                    <h3 id="installTitle">Magdeburg Mobil als App</h3>
                    <ol class="install-steps">
                        <li><span class="install-num">1</span>Tippe unten in Safari auf <b>Teilen</b>
                            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></li>
                        <li><span class="install-num">2</span>Wähle <b>„Zum Home-Bildschirm“</b></li>
                        <li><span class="install-num">3</span>Tippe auf <b>Hinzufügen</b> – fertig! Danach klappen auch Push-Nachrichten.</li>
                    </ol>
                    <button type="button" class="install-close">Alles klar</button>
                </div>`;
            document.body.appendChild(sheet);
            sheet.addEventListener('click', (e) => {
                if (e.target === sheet || e.target.closest('.install-close')) sheet.classList.remove('open');
            });
        }
        requestAnimationFrame(() => sheet.classList.add('open'));
    }

    async function install() {
        if (deferred) {
            deferred.prompt();
            try {
                const choice = await deferred.userChoice;
                if (choice && choice.outcome === 'accepted' && window.MVBToast) window.MVBToast('App wird installiert… 🎉', 'success');
            } catch (e) { /* ignore */ }
            deferred = null;
            update();
        } else if (isIOS) {
            iosSheet();
        }
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferred = e;
        update();
    });

    window.addEventListener('appinstalled', () => {
        deferred = null;
        update();
        if (window.MVBToast) window.MVBToast('Magdeburg Mobil ist jetzt als App installiert! 🚋', 'success');
    });

    document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-install-app]');
        if (b) { e.preventDefault(); install(); }
    });

    document.addEventListener('DOMContentLoaded', update);
    update();
    window.MVBInstall = { install, update };
})();
