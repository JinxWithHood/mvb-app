/* Magdeburg Mobil — Pünktlichkeits-Statistik (unter der Live-Karte)
   Daten: /api/stats?range=day|week|month|year&date=YYYY-MM-DD (der Server misst jede Minute
   an jedem Halt; zu früh ab 3 Min, verspätet ab 4 Min). */
(function () {
    'use strict';

    const RANGES = [['day', 'Tag'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr']];
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n, d = 1) => (n == null ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const sign = (n) => (n == null ? '–' : (n > 0 ? '+' : (n < 0 ? '−' : '±')) + fmt(Math.abs(n)));
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
    const deDate = (s, opts) => parse(s).toLocaleDateString('de-DE', opts || { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    const lum = (hex) => { const h = (hex || '#888888').replace('#', ''); const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return 0.299 * r + 0.587 * g + 0.114 * b; };

    const state = { range: 'day', date: iso(new Date()), group: 'all', data: null, loading: false, timer: null, open: new Set() };
    let root = null;

    function apiBase() {
        return (window.MVBApp && window.MVBApp.apiBase) || '/api';
    }

    function shell() {
        root.innerHTML = `
          <header class="st-head">
            <div>
              <h2 id="statsTitle">Pünktlichkeit der Linien</h2>
              <p class="st-sub">Gemessen an jedem Halt · pünktlich ±2 Min · leicht verspätet +3/+4 · verspätet ab +5 · zu früh ab 3 Min vor Plan · Ausfall / keine Wertung = ohne Echtzeit, nicht bewertbar</p>
            </div>
          </header>
          <div class="st-controls">
            <div class="st-seg" role="group" aria-label="Zeitraum">
              ${RANGES.map(([k, l]) => `<button type="button" data-range="${k}" aria-pressed="${k === state.range}">${l}</button>`).join('')}
            </div>
            <div class="st-date">
              <button type="button" class="st-step" data-step="-1" aria-label="Früher">‹</button>
              <input type="date" id="statsDate" aria-label="Datum">
              <button type="button" class="st-step" data-step="1" aria-label="Später">›</button>
              <button type="button" class="st-today">Heute</button>
            </div>
          </div>
          <div class="st-body" aria-live="polite"></div>`;
        root.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
            state.range = b.dataset.range;
            root.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            load();
        }));
        const input = root.querySelector('#statsDate');
        input.addEventListener('change', () => { if (input.value) { state.date = input.value; load(); } });
        root.querySelectorAll('.st-step').forEach((b) => b.addEventListener('click', () => {
            const step = { day: 1, week: 7, month: 30, year: 365 }[state.range] * Number(b.dataset.step);
            const d = parse(state.date);
            d.setDate(d.getDate() + step);
            state.date = iso(d);
            load();
        }));
        root.querySelector('.st-today').addEventListener('click', () => { state.date = iso(new Date()); load(); });
        root.addEventListener('click', (e) => {
            const g = e.target.closest('[data-group]');
            if (g) { state.group = g.dataset.group; render(); return; }
            if (e.target.closest('a')) return;
            const li = e.target.closest('li.st-line');
            if (li) toggleLine(li);
        });
        root.addEventListener('keydown', (e) => {
            const li = e.target.closest && e.target.closest('li.st-line');
            if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleLine(li); }
        });
    }

    async function load() {
        if (!root) return;
        state.loading = true;
        const body = root.querySelector('.st-body');
        if (!state.data) body.innerHTML = '<p class="st-empty">Statistik wird geladen …</p>';
        root.classList.add('st-busy');
        try {
            const res = await fetch(`${apiBase()}/stats?range=${state.range}&date=${state.date}`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok || data.error || !data.to) throw new Error(data.error || 'Fehler');
            state.data = data;
            state.date = data.to;
            render();
        } catch (e) {
            body.innerHTML = '<p class="st-empty">Die Statistik ist gerade nicht erreichbar.</p>';
        } finally {
            state.loading = false;
            root.classList.remove('st-busy');
        }
    }

    function tile(label, value, sub, cls) {
        return `<div class="st-tile ${cls || ''}"><span class="st-tile-l">${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    }

    // Ausfall and keine Wertung are one field: in both cases there was no realtime to judge by
    const nw = (m) => (m.cancelled == null && m.unrated == null ? null : Math.round(((m.cancelled || 0) + (m.unrated || 0)) * 10) / 10);

    function bar(m) {
        const seg = (cls, pct, label) => (pct > 0
            ? `<span class="st-seg-${cls}" style="flex-basis:${pct}%" title="${esc(label)}: ${fmt(pct)} %"></span>` : '');
        return `<div class="st-bar" role="img" aria-label="${fmt(m.early)} % zu früh, ${fmt(m.onTime)} % pünktlich, ${fmt(m.slight)} % leicht verspätet, ${fmt(m.late)} % verspätet, ${fmt(nw(m))} % Ausfall oder keine Wertung">`
            + seg('early', m.early, 'Zu früh (ab 3 Min)') + seg('on', m.onTime, 'Pünktlich (±2 Min)')
            + seg('slight', m.slight, 'Leicht verspätet (+3/+4)') + seg('late', m.late, 'Verspätet (ab +5)')
            + seg('none', nw(m), 'Ausfall / keine Wertung') + '</div>';
    }

    function trendSvg(trend) {
        const pts = trend.filter((t) => t.n > 0);
        if (pts.length < 2) return '';
        // drawn at the real width (no stretched text or oval dots)
        const W = Math.max(260, Math.round((root.querySelector('.st-body') || root).clientWidth || 640)), H = 120, P = 8, n = trend.length;
        const low = Math.min(50, Math.floor((Math.min(...pts.map((t) => t.onTime)) - 5) / 10) * 10);
        const x = (i) => P + (W - 2 * P - 34) * (n === 1 ? 0.5 : i / (n - 1));
        const y = (v) => P + (H - 2 * P) * (1 - (v - low) / (100 - low));
        let path = '', open = false;
        trend.forEach((t, i) => {
            if (!t.n) { open = false; return; }
            path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(t.onTime).toFixed(1)} `;
            open = true;
        });
        const grid = [100, Math.round((100 + low) / 2), low].map((v) => `<line x1="${P}" x2="${W - P - 34}" y1="${y(v)}" y2="${y(v)}" class="st-grid"/><text x="${W - P}" y="${y(v) + 4}" class="st-axis" text-anchor="end">${v} %</text>`).join('');
        const dots = trend.map((t, i) => (t.n ? `<circle cx="${x(i).toFixed(1)}" cy="${y(t.onTime).toFixed(1)}" r="${n > 60 ? 0 : 3}" class="st-dot"/>` : '')).join('');
        return `<figure class="st-trend">
            <figcaption>Pünktlich pro Tag</figcaption>
            <div class="st-trend-wrap">
              <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Verlauf der Pünktlichkeit pro Tag">${grid}<path d="${path}" class="st-line"/>${dots}</svg>
              <div class="st-tip" hidden></div>
              <div class="st-hit" data-n="${n}"></div>
            </div>
            <div class="st-trend-x"><span>${esc(deDate(trend[0].date, { day: '2-digit', month: '2-digit' }))}</span><span>${esc(deDate(trend[n - 1].date, { day: '2-digit', month: '2-digit' }))}</span></div>
          </figure>`;
    }

    function bindTrend(trend) {
        const hit = root.querySelector('.st-hit');
        if (!hit) return;
        const tip = root.querySelector('.st-tip');
        const show = (clientX) => {
            const r = hit.getBoundingClientRect();
            const i = Math.max(0, Math.min(trend.length - 1, Math.round(((clientX - r.left - 8) / (r.width - 50)) * (trend.length - 1))));
            const t = trend[i];
            tip.hidden = false;
            tip.style.left = `${Math.min(r.width - 150, Math.max(0, clientX - r.left - 75))}px`;
            tip.innerHTML = `<strong>${esc(deDate(t.date))}</strong>${t.n ? `${fmt(t.onTime)} % pünktlich · Ø ${sign(t.avg)} Min<br>${t.n.toLocaleString('de-DE')} Halte gemessen` : 'keine Messung'}`;
        };
        hit.addEventListener('pointermove', (e) => show(e.clientX));
        hit.addEventListener('pointerdown', (e) => show(e.clientX));
        hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    }

    function badge(l) {
        const c = /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#64748b';
        return `<span class="st-badge${l.type === 'bus' ? ' bus' : ''}${lum(c) > 170 ? ' dark' : ''}" style="--lc:${c}">${esc(l.short)}</span>`;
    }

    function time(ts) {
        return ts ? new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    }

    function disruptionsHtml(list, d) {
        const head = d.range === 'day' ? 'Störungen an diesem Tag' : 'Störungen im Zeitraum';
        if (!list.length) return `<h3 class="st-h3">${head}</h3><p class="st-empty">Keine Meldungen vom Verkehrsmelder.</p>`;
        return `<h3 class="st-h3">${head} <span class="st-count">${list.length}</span></h3><ul class="st-disr">` + list.map((r) => {
            const status = r.done ? ['done', 'erledigt'] : (r.gone ? ['gone', 'beendet'] : ['live', 'aktiv']);
            const when = r.days && r.days.length > 1
                ? `${deDate(r.days[0], { day: '2-digit', month: '2-digit' })} – ${deDate(r.days[r.days.length - 1], { day: '2-digit', month: '2-digit' })}`
                : `${time(r.first)}${r.last && r.last - r.first > 300 ? '–' + time(r.last) : ''} Uhr`;
            return `<li class="st-dis ${status[0]}${r.critical ? ' crit' : ''}">
                <details><summary><span class="st-dis-st">${status[1]}</span><strong>${esc(r.title)}</strong>
                  <small>${esc(when)}${(r.lines || []).length ? ' · ' + esc(r.lines.join(', ')) : ''}</small></summary>
                  ${r.text ? `<p>${esc(r.text)}</p>` : ''}</details></li>`;
        }).join('') + '</ul>';
    }

    function render() {
        const d = state.data;
        if (!d) return;
        const input = root.querySelector('#statsDate');
        input.value = d.to;
        input.min = d.earliest;
        input.max = d.today;
        root.querySelector('[data-step="1"]').disabled = d.to >= d.today;
        root.querySelector('[data-step="-1"]').disabled = d.from <= d.earliest;
        const body = root.querySelector('.st-body');
        const t = d.total || {};
        const period = d.range === 'day' ? deDate(d.to, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
            : `${deDate(d.from, { day: '2-digit', month: '2-digit', year: 'numeric' })} – ${deDate(d.to, { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
        const lines = (d.lines || []).filter((l) => state.group === 'all' || l.type === state.group);
        const since = d.first ? `Gemessen wird seit ${deDate(d.first, { day: 'numeric', month: 'long', year: 'numeric' })}.` : 'Die Messung hat gerade erst begonnen.';
        let html = `<p class="st-period">${esc(period)}</p>`;
        if (!t.n) {
            html += `<p class="st-empty">Für diesen Zeitraum gibt es noch keine Messungen. ${esc(since)}</p>`;
        } else {
            html += `<div class="st-tiles">
                ${tile('Pünktlich', `${fmt(t.onTime)} %`, null, 'on')}
                ${tile('Ø Abweichung', `${sign(t.avg)} Min`, t.avgLate != null ? `verspätete Halte (ab +3): Ø +${fmt(t.avgLate)} Min` : null)}
                ${tile('Leicht verspätet', `${fmt(t.slight)} %`, '+3 bis +4 Min', 'slight')}
                ${tile('Verspätet', `${fmt(t.late)} %`, 'ab +5 Min', 'late')}
                ${tile('Zu früh', `${fmt(t.early)} %`, '3 Min oder mehr', 'early')}
                ${tile('Ausfall / k. Wertung', `${fmt(nw(t))} %`, 'ohne Echtzeit', 'cnl')}
                ${tile('Halte gemessen', t.n.toLocaleString('de-DE'), since)}
              </div>`;
            if (d.range !== 'day') html += trendSvg(d.trend || []);
            html += `<div class="st-row">
                <div class="st-filter" role="group" aria-label="Verkehrsmittel">
                  ${[['all', 'Alle'], ['tram', 'Straßenbahn'], ['bus', 'Bus']].map(([k, l]) => `<button type="button" data-group="${k}" aria-pressed="${state.group === k}">${l}</button>`).join('')}
                </div>
                <div class="st-legend" aria-hidden="true"><span><i class="st-seg-early"></i>zu früh</span><span><i class="st-seg-on"></i>pünktlich</span><span><i class="st-seg-slight"></i>+3/+4</span><span><i class="st-seg-late"></i>ab +5</span><span><i class="st-seg-none"></i>Ausfall / k. Wertung</span></div>
              </div>
              <ol class="st-lines">${lines.map((l) => `<li class="st-line" data-line="${esc(l.short)}" tabindex="0" role="button" aria-expanded="${state.open.has(l.short)}" title="Kurse der Linie ${esc(l.short)} anzeigen">
                  ${badge(l)}
                  ${bar(l)}
                  <span class="st-pct"><strong>${fmt(l.onTime, 0)} %</strong><small>pünktlich</small></span>
                  <span class="st-avg"><strong>${sign(l.avg)}</strong><small>Ø Min</small></span>
                  <span class="st-max"><strong>${l.max != null ? (l.max > 0 ? '+' : '') + l.max : '–'}</strong><small>max.</small></span>
                </li>${state.open.has(l.short) ? `<li class="st-kurse" data-for="${esc(l.short)}"><p class="st-empty">Kurse werden geladen …</p></li>` : ''}`).join('') || '<li class="st-empty">Keine Linien in dieser Auswahl.</li>'}</ol>
              <details class="st-table"><summary>Als Tabelle</summary>
                <table><thead><tr><th>Linie</th><th>Halte</th><th>pünktlich</th><th>+3/+4</th><th>ab +5</th><th>zu früh</th><th>Ausfall / k. W.</th><th>Ø Min</th><th>max.</th></tr></thead>
                <tbody>${lines.map((l) => `<tr><td>${esc(l.short)}</td><td>${l.n.toLocaleString('de-DE')}</td><td>${fmt(l.onTime)} %</td><td>${fmt(l.slight)} %</td><td>${fmt(l.late)} %</td><td>${fmt(l.early)} %</td><td>${fmt(nw(l))} %</td><td>${sign(l.avg)}</td><td>${l.max ?? '–'}</td></tr>`).join('')}</tbody></table>
              </details>`;
        }
        html += disruptionsHtml(d.disruptions || [], d);
        body.innerHTML = html;
        if (d.range !== 'day') bindTrend(d.trend || []);
        body.querySelectorAll('.st-kurse').forEach((li) => loadCourses(li, li.dataset.for));
    }

    // ---- Kurse einer Linie (aus dem Fahrtenschreiber): tap on a line row ----
    const DT = { wt: 'Werktag', sa: 'Samstag', so: 'Sonn- & Feiertag' };
    function toggleLine(li) {
        const line = li.dataset.line;
        const next = li.nextElementSibling;
        if (state.open.has(line)) {
            state.open.delete(line);
            li.setAttribute('aria-expanded', 'false');
            if (next && next.classList.contains('st-kurse')) next.remove();
            return;
        }
        state.open.add(line);
        li.setAttribute('aria-expanded', 'true');
        const box = document.createElement('li');
        box.className = 'st-kurse';
        box.dataset.for = line;
        box.innerHTML = '<p class="st-empty">Kurse werden geladen …</p>';
        li.after(box);
        loadCourses(box, line);
    }
    const vtag = (t) => (t && t !== 'andere' ? `<span class="st-vt st-vt-${esc(t)}">${esc(t)}</span>` : '');
    async function loadCourses(box, line) {
        const d = state.data;
        try {
            const res = await fetch(`${apiBase()}/fts/courses?line=${encodeURIComponent(line)}&from=${d.from}&to=${d.to}`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Fehler');
            const link = `<a class="st-fts" href="/Fahrtenschreiber?line=${encodeURIComponent(line)}">Im Fahrtenschreiber eintragen →</a>`;
            const loose = data.withoutKurs || [];
            if (!data.courses.length && !loose.length) {
                box.innerHTML = `<p class="st-empty">Für Linie ${esc(line)} wurde in diesem Zeitraum noch nichts gemeldet. ${link}</p>`;
                return;
            }
            const groups = {}, free = {};
            data.courses.forEach((c) => { (groups[c.dayType] = groups[c.dayType] || []).push(c); });
            loose.forEach((r) => { (free[r.dayType] = free[r.dayType] || []).push(r); });
            const oneDay = d.from === d.to;
            const looseRow = (r) => `<tr class="st-nokurs">
                    <td class="st-kn st-muted">ohne Kurs</td>
                    <td>${oneDay ? '' : esc(deDate(r.date, { day: '2-digit', month: '2-digit' })) + ' '}${esc(r.time)}${r.stop ? `<small>📍 ${esc(r.stop)}</small>` : ''}</td>
                    <td>${r.vehicles.map(([v]) => `<span class="st-wg">${esc(v)}</span>`).join(' ')} ${vtag(r.type)}</td>
                    <td class="st-hide-s">${r.start ? esc(`${r.start} ${r.origin || ''}`.trim()) + ' → ' : (r.direction ? '→ ' : '')}${esc(r.direction || '')}${!r.start && !r.direction ? '–' : ''}</td></tr>`;
            box.innerHTML = Object.keys(DT).filter((k) => groups[k] || free[k]).map((k) => `
                <div class="st-kg"><h4>${esc(DT[k])} <small>${[(groups[k] || []).length ? `${groups[k].length} ${groups[k].length === 1 ? 'Kurs' : 'Kurse'}` : '',
                    (free[k] || []).length ? `${free[k].length} ohne Kurs` : ''].filter(Boolean).join(' · ')}</small></h4>
                <table class="st-ktab"><thead><tr><th>Kurs</th><th>unterwegs</th><th>Wagen</th><th class="st-hide-s">Fahrten (Start)</th></tr></thead><tbody>
                ${(groups[k] || []).map((c) => `<tr>
                    <td class="st-kn">${esc(c.kurs)}</td>
                    <td>${c.span ? esc(c.span[0]) + (c.span[1] !== c.span[0] ? '–' + esc(c.span[1]) : '') : ''}<small>${c.count}× gemeldet</small></td>
                    <td>${c.vehicles.map(([v, n, t]) => `<span class="st-wg">${esc(v)}${n > 1 ? `<i>×${n}</i>` : ''}</span>`).join(' ')} ${vtag(c.types.length === 1 ? c.types[0][0] : (c.types.length ? 'gemischt' : ''))}</td>
                    <td class="st-hide-s">${(c.trips || []).map(([t]) => esc(t)).join('<br>') || '–'}</td></tr>`).join('')}
                ${(free[k] || []).map(looseRow).join('')}
                </tbody></table></div>`).join('') + `<p class="st-kfoot">${link}</p>`;
        } catch (e) {
            box.innerHTML = '<p class="st-empty">Kurse gerade nicht abrufbar.</p>';
        }
    }

    function start() {
        root = document.getElementById('lineStats');
        if (!root) return;
        shell();
        const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                if (!state.data) load();
                clearInterval(state.timer);
                state.timer = setInterval(() => { if (document.visibilityState === 'visible' && root.offsetParent && state.date === iso(new Date())) load(); }, 300000);
            }
        }) : null;
        if (io) io.observe(root); else load();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    let rz = null;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.data && state.data.range !== 'day' && root && root.offsetParent) render(); }, 200); });
    window.MVBStats = { reload: load };
})();
