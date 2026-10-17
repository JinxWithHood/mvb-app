/* ============================================================
   Jinx Secret — escalating glitch → countdown → BOOM sequence
   Usage: JinxFX.play({ app, onBoom, onDone })
   ============================================================ */
(function () {
    'use strict';

    const JinxFX = {};
    let running = false;

    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const NEON = ['#ff007f', '#00f0ff', '#ff3399', '#9900ff', '#e0aaff', '#ffffff'];
    const GLYPHS = '!<>-_\\/[]{}—=+*^?#░▒▓█ΔΣΞ01';

    // -------------------------------------------------------------
    // Audio (synthesized, no files needed)
    // -------------------------------------------------------------
    let actx = null;
    function audio() {
        try {
            actx = actx || new (window.AudioContext || window.webkitAudioContext)();
            if (actx.state === 'suspended') actx.resume();
            return actx;
        } catch (e) {
            return null;
        }
    }

    function blip(freq, dur, type = 'square', vol = 0.035, when = 0) {
        const a = audio();
        if (!a) return;
        const t = a.currentTime + when;
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * rand(0.4, 1.8)), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(a.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
    }

    function noise(dur, vol, lp = 1600, when = 0) {
        const a = audio();
        if (!a) return;
        const len = Math.floor(a.sampleRate * dur);
        const buf = a.createBuffer(1, len, a.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
        const src = a.createBufferSource();
        src.buffer = buf;
        const f = a.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lp;
        const g = a.createGain();
        g.gain.value = vol;
        src.connect(f).connect(g).connect(a.destination);
        src.start(a.currentTime + when);
    }

    function boomSound() {
        const a = audio();
        if (!a) return;
        noise(2.2, 0.55, 380);
        noise(0.35, 0.35, 4000);
        const t = a.currentTime;
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
        g.gain.setValueAtTime(0.6, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        o.connect(g).connect(a.destination);
        o.start(t);
        o.stop(t + 1.7);
    }

    // -------------------------------------------------------------
    // DOM helpers
    // -------------------------------------------------------------
    function el(tag, cls, parent) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (parent) parent.appendChild(n);
        return n;
    }

    function scrambleText(str, amount) {
        let out = '';
        for (const ch of str) {
            out += (ch !== ' ' && Math.random() < amount) ? pick(GLYPHS) : ch;
        }
        return out;
    }

    // -------------------------------------------------------------
    // Main sequence
    // -------------------------------------------------------------
    JinxFX.play = function ({ app, onBoom, onDone } = {}) {
        if (running) return false;

        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion) {
            if (onBoom) onBoom();
            if (onDone) onDone();
            return true;
        }

        running = true;
        app = app || document.getElementById('app');
        const timers = [];
        const at = (ms, fn) => timers.push(setTimeout(fn, ms));
        let level = 0;

        // Stage
        const stage = el('div', 'jfx-stage', document.body);
        el('div', 'jfx-scanlines', stage);
        el('div', 'jfx-rgb', stage);
        const tint = el('div', 'jfx-tint', stage);
        const barsLayer = el('div', 'jfx-bars', stage);
        const vignette = el('div', 'jfx-vignette', stage);
        const textLayer = el('div', 'jfx-text', stage);
        const canvas = el('canvas', 'jfx-canvas', stage);
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const W = window.innerWidth;
        const H = window.innerHeight;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.scale(dpr, dpr);

        // Text scramble targets
        const scrambleTargets = [...document.querySelectorAll(
            '.hero-title, .hero-eyebrow, .hero-sub, .logo-text, .board-title, .section-heading h2, .section-heading p, ' +
            '.home-card-content h4, .home-card-content p, .news-header-title, .status-indicator-title, .placeholder-title, ' +
            '.nav-link span:not(.badge), .tab-label, .tickets-intro h2, .field-label'
        )].filter(n => n.offsetParent !== null).slice(0, 16).map(n => ({ n, html: n.innerHTML, text: n.textContent }));

        const restoreTexts = () => scrambleTargets.forEach(t => {
            if (t.n.isConnected) t.n.innerHTML = t.html;
        });

        // Glitch message
        const showMsg = (txt, cls = '') => {
            textLayer.innerHTML = '';
            const m = el('div', `jfx-msg ${cls}`, textLayer);
            m.textContent = txt;
            m.setAttribute('data-text', txt);
        };

        // Glitch bars (invert / shift strips of the real page)
        const spawnBar = () => {
            if (barsLayer.childElementCount >= 7) return;
            const b = el('div', 'jfx-bar', barsLayer);
            const h = level >= 3 ? rand(4, 90) : level === 2 ? rand(3, 50) : rand(2, 18);
            b.style.top = `${rand(0, 100)}%`;
            b.style.height = `${h}px`;
            b.style.transform = `translateX(${rand(-40, 40) * level}px)`;
            const mode = Math.random();
            if (mode < 0.2) {
                b.classList.add('invert');
            } else if (mode < 0.3) {
                b.classList.add('hue');
            } else {
                b.style.background = pick(NEON);
                b.style.opacity = rand(0.35, 0.9);
            }
            setTimeout(() => b.remove(), rand(50, 160));
        };

        // Tick loop for glitches
        let tick = 0;
        const glitchLoop = setInterval(() => {
            tick++;
            const barsPerTick = level === 1 ? (Math.random() < 0.5 ? 1 : 0) : level === 2 ? 2 : 3;
            for (let i = 0; i < barsPerTick; i++) spawnBar();

            const amount = level === 1 ? 0.12 : level === 2 ? 0.35 : 0.7;
            if (tick % 2 === 0) scrambleTargets.forEach(t => {
                if (!t.n.isConnected) return;
                if (Math.random() < 0.18 * level) t.n.textContent = scrambleText(t.text, amount);
                else if (Math.random() < 0.3) t.n.innerHTML = t.html;
            });

            tint.style.opacity = Math.random() < 0.12 * level ? rand(0.08, 0.3) : 0;
            tint.style.background = pick(['#ff007f', '#00f0ff', '#9900ff', '#ffffff']);

            if (Math.random() < 0.25 * level) blip(rand(180, 1800), rand(0.03, 0.09), pick(['square', 'sawtooth']), 0.02 + 0.012 * level);
            if (level >= 2 && Math.random() < 0.15) noise(0.08, 0.06 * level, rand(800, 5000));
        }, 60);

        const setLevel = (n) => {
            level = n;
            app.classList.remove('jfx-glitch-1', 'jfx-glitch-2', 'jfx-glitch-3');
            if (n > 0) app.classList.add(`jfx-glitch-${n}`);
            stage.setAttribute('data-level', n);
        };

        // ---- Phase 1: Signal disturbance
        setLevel(1);
        showMsg('▓ SIGNAL GESTÖRT ▓', 'small');
        if ('vibrate' in navigator) { try { navigator.vibrate([20, 60, 20, 120, 30]); } catch (e) {} }

        // ---- Phase 2: Takeover
        at(900, () => {
            setLevel(2);
            showMsg('ZAUN-PROTOKOLL AKTIV', 'medium');
            noise(0.25, 0.12, 2500);
        });
        at(1500, () => showMsg('JINX HAT DIE KONTROLLE', 'medium'));

        // ---- Phase 3: Countdown with live bomb
        at(2100, () => {
            setLevel(3);
            showMsg('3', 'count');
            blip(440, 0.15, 'square', 0.06);
            const bomb = el('div', 'jfx-bomb', stage);
            bomb.innerHTML = '<span class="jfx-bomb-body">💣</span><span class="jfx-fuse"></span>';
        });
        at(2600, () => { showMsg('2', 'count'); blip(520, 0.15, 'square', 0.07); });
        at(3100, () => { showMsg('1', 'count'); blip(660, 0.25, 'square', 0.08); });

        // ---- BOOM
        at(3600, () => {
            clearInterval(glitchLoop);
            restoreTexts();
            setLevel(0);
            barsLayer.innerHTML = '';
            tint.style.opacity = 0;
            const bomb = stage.querySelector('.jfx-bomb');
            if (bomb) bomb.remove();

            boomSound();
            if ('vibrate' in navigator) { try { navigator.vibrate([400, 60, 200, 60, 120]); } catch (e) {} }

            if (onBoom) onBoom();

            // Screen shake (heavy)
            app.classList.remove('jfx-boom-shake');
            void app.offsetWidth;
            app.classList.add('jfx-boom-shake');
            setTimeout(() => app.classList.remove('jfx-boom-shake'), 1300);

            // Flashes + shockwaves
            el('div', 'jfx-flash', stage);
            for (let i = 0; i < 4; i++) {
                const ring = el('div', 'jfx-ring', stage);
                ring.style.animationDelay = `${i * 110}ms`;
                ring.style.borderColor = i % 2 ? '#00f0ff' : '#ff007f';
            }

            textLayer.innerHTML = '';
            const boomTxt = el('div', 'jfx-boom-text', textLayer);
            boomTxt.textContent = 'BOOM!';

            // Paint splats
            for (let i = 0; i < 9; i++) {
                setTimeout(() => spawnSplat(stage), i * 70);
            }

            // Graffiti tag
            setTimeout(() => {
                const tag = el('div', 'jfx-tag', stage);
                tag.innerHTML = 'Jinx war hier! <span>♥</span>';
            }, 650);

            explode(ctx, W, H, () => {});
        });

        // ---- Cleanup
        at(7600, () => {
            stage.classList.add('jfx-fade');
        });
        at(8400, () => {
            stage.remove();
            running = false;
            if (onDone) onDone();
        });

        // Safety: clean everything if the tab gets hidden mid-sequence
        const onHide = () => {
            if (!document.hidden) return;
            timers.forEach(clearTimeout);
            clearInterval(glitchLoop);
            restoreTexts();
            setLevel(0);
            stage.remove();
            running = false;
            if (onBoom) onBoom();
            document.removeEventListener('visibilitychange', onHide);
        };
        document.addEventListener('visibilitychange', onHide);

        return true;
    };

    // -------------------------------------------------------------
    // Paint splat (SVG blob with drips)
    // -------------------------------------------------------------
    function spawnSplat(stage) {
        const size = rand(140, 340);
        const color = pick(['#ff007f', '#00f0ff', '#9900ff', '#ff3399']);
        const cx = 100, cy = 100;
        let shapes = `<circle cx="${cx}" cy="${cy}" r="${rand(38, 52)}" fill="${color}"/>`;
        const blobs = 14;
        for (let i = 0; i < blobs; i++) {
            const a = (i / blobs) * Math.PI * 2 + rand(-0.2, 0.2);
            const d = rand(30, 62);
            shapes += `<circle cx="${cx + Math.cos(a) * d}" cy="${cy + Math.sin(a) * d}" r="${rand(6, 20)}" fill="${color}"/>`;
            if (Math.random() < 0.5) {
                const d2 = d + rand(14, 34);
                shapes += `<circle cx="${cx + Math.cos(a) * d2}" cy="${cy + Math.sin(a) * d2}" r="${rand(2, 6)}" fill="${color}"/>`;
            }
        }
        for (let i = 0; i < 4; i++) {
            const x = cx + rand(-36, 36);
            const len = rand(30, 80);
            shapes += `<rect class="jfx-drip" x="${x - 3}" y="${cy}" width="${rand(4, 8)}" height="${len}" rx="4" fill="${color}" style="animation-delay:${rand(0.1, 0.6)}s"/>`;
        }
        const s = document.createElement('div');
        s.className = 'jfx-splat';
        s.style.width = `${size}px`;
        s.style.height = `${size}px`;
        s.style.left = `${rand(-5, 90)}%`;
        s.style.top = `${rand(-5, 85)}%`;
        s.style.setProperty('--rot', `${rand(0, 360)}deg`);
        s.innerHTML = `<svg viewBox="0 0 200 300" width="100%" height="150%" overflow="visible">${shapes}</svg>`;
        stage.appendChild(s);
    }

    // -------------------------------------------------------------
    // Canvas explosion: sparks, debris emoji, smoke
    // -------------------------------------------------------------
    // Pre-rendered sprites (much cheaper than shadowBlur / per-frame gradients)
    const spriteCache = {};
    function glowSprite(color, size) {
        const key = `g${color}${size}`;
        if (spriteCache[key]) return spriteCache[key];
        const c = document.createElement('canvas');
        c.width = c.height = size * 2;
        const g = c.getContext('2d');
        const grd = g.createRadialGradient(size, size, 0, size, size, size);
        grd.addColorStop(0, '#ffffff');
        grd.addColorStop(0.25, color);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, size * 2, size * 2);
        return (spriteCache[key] = c);
    }
    function smokeSprite(rgb) {
        const key = `s${rgb}`;
        if (spriteCache[key]) return spriteCache[key];
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grd.addColorStop(0, `rgba(${rgb},0.9)`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 128);
        return (spriteCache[key] = c);
    }
    function emojiSprite(ch) {
        const key = `e${ch}`;
        if (spriteCache[key]) return spriteCache[key];
        const c = document.createElement('canvas');
        c.width = c.height = 72;
        const g = c.getContext('2d');
        g.font = '56px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(ch, 36, 40);
        return (spriteCache[key] = c);
    }

    function explode(ctx, W, H, done) {
        const cx = W / 2;
        const cy = H / 2;
        const parts = [];
        const small = W < 600;
        const sparkCount = small ? 120 : 200;

        for (let i = 0; i < sparkCount; i++) {
            const a = rand(0, Math.PI * 2);
            const sp = rand(4, 22);
            const color = pick(NEON);
            parts.push({
                kind: 'spark', x: cx, y: cy,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(0, 4),
                life: rand(45, 95), max: 95, size: rand(1.5, 3.5), color,
                glow: glowSprite(color, 12)
            });
        }
        const emojis = ['💥', '✨', '💣', '⚡', '🩷', '💜', '🔥', '🐒'];
        for (let i = 0; i < (small ? 18 : 30); i++) {
            const a = rand(0, Math.PI * 2);
            const sp = rand(5, 17);
            parts.push({
                kind: 'emoji', x: cx, y: cy, img: emojiSprite(pick(emojis)),
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(2, 7),
                life: rand(80, 130), max: 130, size: rand(26, 54), rot: rand(0, 6), vr: rand(-0.25, 0.25)
            });
        }
        for (let i = 0; i < (small ? 10 : 16); i++) {
            const a = rand(0, Math.PI * 2);
            parts.push({
                kind: 'smoke', x: cx + rand(-30, 30), y: cy + rand(-30, 30),
                vx: Math.cos(a) * rand(0.5, 3), vy: Math.sin(a) * rand(0.5, 3) - 0.6,
                life: rand(80, 130), max: 130, size: rand(50, 120),
                img: smokeSprite(pick(['255,0,127', '0,240,255', '153,0,255']))
            });
        }
        const core = glowSprite('#ff007f', 128);

        let frame = 0;
        function step() {
            ctx.clearRect(0, 0, W, H);
            frame++;

            if (frame < 24) {
                const r = frame * 30;
                ctx.globalAlpha = Math.max(0, 1 - frame / 24);
                ctx.drawImage(core, cx - r, cy - r, r * 2, r * 2);
                ctx.globalAlpha = 1;
            }

            let alive = 0;
            ctx.globalCompositeOperation = 'source-over';
            // smoke first (behind)
            for (const p of parts) {
                if (p.kind !== 'smoke' || p.life <= 0) continue;
                alive++;
                p.life--;
                p.x += p.vx; p.y += p.vy;
                p.vx *= 0.97; p.vy *= 0.97;
                p.size += 1.4;
                ctx.globalAlpha = 0.25 * (p.life / p.max);
                ctx.drawImage(p.img, p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
            }

            ctx.globalCompositeOperation = 'lighter';
            for (const p of parts) {
                if (p.kind !== 'spark' || p.life <= 0) continue;
                alive++;
                p.life--;
                p.x += p.vx; p.y += p.vy;
                p.vx *= 0.96;
                p.vy = p.vy * 0.96 + 0.25;
                const k = Math.min(1, (p.life / p.max) * 1.6);
                ctx.globalAlpha = k;
                ctx.strokeStyle = p.color;
                ctx.lineWidth = p.size;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
                ctx.stroke();
                ctx.globalAlpha = k * 0.7;
                ctx.drawImage(p.glow, p.x - 12, p.y - 12);
            }

            ctx.globalCompositeOperation = 'source-over';
            for (const p of parts) {
                if (p.kind !== 'emoji' || p.life <= 0) continue;
                alive++;
                p.life--;
                p.x += p.vx; p.y += p.vy;
                p.vx *= 0.985;
                p.vy += 0.32;
                p.rot += p.vr;
                ctx.globalAlpha = Math.min(1, (p.life / p.max) * 2);
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.drawImage(p.img, -p.size / 2, -p.size / 2, p.size, p.size);
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            ctx.lineCap = 'round';

            if (alive > 0 && ctx.canvas.isConnected) {
                requestAnimationFrame(step);
            } else {
                ctx.clearRect(0, 0, W, H);
                done();
            }
        }
        ctx.lineCap = 'round';
        requestAnimationFrame(step);
    }

    JinxFX.isRunning = () => running;
    window.JinxFX = JinxFX;
})();
