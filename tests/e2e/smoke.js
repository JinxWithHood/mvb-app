// Browser smoke test: starts the app (tests/e2e/serve.py) and clicks through the key flows.
// Usage: node tests/e2e/smoke.js            (needs: npm i playwright && npx playwright install chromium)
// Exit code 0 = all good, 1 = something broke (details printed).
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PY = process.env.PYTHON || 'python3';
const pad = (n) => String(n).padStart(2, '0');
const at = (m) => { const d = new Date(Date.now() + m * 60000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const off = (m) => { const a = new Date(Date.now() + m * 60000); a.setHours(0, 0, 0, 0); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((a - t) / 864e5); };

const DEPARTURES = [
  { line: 'IC 2037', type: 'express', direction: 'Leipzig Hbf', time: at(12), delay: 0, lineColor: '#ec0016', journey_id: 'j_ic', day_offset: off(12), platform: '3', trainCat: 'IC', trainNum: '2037', occupancy: { 1: 1, 2: 2 } },
  { line: '2', type: 'tram', direction: 'Westerhüsen', time: at(4), delay: 1, lineColor: '#e30613', journey_id: 'j_tram', day_offset: off(4) },
];
const st = (name, eva, m) => ({ name, eva, time: at(m), depTime: at(m), arrTime: at(m - 1), day_offset: off(m), delay: 0, platform: '', passed: m < 0, cancelled: false });
const JOURNEYS = {
  j_ic: { line: 'IC 2037', direction: 'Leipzig Hbf', lineColor: '#ec0016', type: 'express', vehiclePosition: 0, totalStops: 4, messages: [], operator: 'DB',
    stops: [st('Hannover Hbf', '8000152', -60), st('Magdeburg Hbf', '8010224', 12), st('Genthin', '8000001', 40), st('Leipzig Hbf', '8010205', 80)] },
  j_tram: { line: '2', direction: 'Westerhüsen', lineColor: '#e30613', type: 'tram', vehiclePosition: 0, totalStops: 2, messages: [], operator: 'MVB',
    stops: [{ name: 'Hauptbahnhof', time: at(4), day_offset: 0, delay: 1 }, { name: 'Westerhüsen', time: at(25), day_offset: 0, delay: 0 }] },
};

const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) failures.push(what); };

function startServer(port, online) {
  const proc = spawn(PY, [path.join(__dirname, 'serve.py'), String(port)], { env: { ...process.env, FM_ONLINE: online ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = async () => {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/formation/status`); if (r.ok) return resolve(proc); } catch (e) { /* not yet */ }
      if (Date.now() - t0 > 60000) { proc.kill(); return reject(new Error('server did not start:\n' + log.slice(-2000))); }
      setTimeout(poll, 500);
    };
    poll();
  });
}

async function openApp(browser, port, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.desktop ? { width: 1366, height: 900 } : { width: 390, height: 900 }, isMobile: !opts.desktop, hasTouch: !opts.desktop });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state = { down: false };
  await ctx.route('**/api/**', (r) => {
    const u = r.request().url();
    if (state.down && !u.includes('/api/formation')) return r.abort('internetdisconnected');
    if (u.includes('/api/departures')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(DEPARTURES) });
    if (u.includes('/api/journey?')) {
      const id = Object.keys(JOURNEYS).find((k) => u.includes(k));
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify(JOURNEYS[id] || JOURNEYS.j_tram) });
    }
    return r.continue();
  });
  // external hosts (fonts, map tiles, news) are not needed for this test
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${port}/?api=http://127.0.0.1:${port}/api`);
  await page.waitForFunction(() => window.MVBApp && !document.getElementById('app-loading-screen'), null, { timeout: 30000 });
  await page.evaluate(() => { MVBApp.switchTab('departures'); MVBApp.setPlanView('board'); });
  await page.waitForSelector('#departuresList .departure-card', { timeout: 15000 });
  return { ctx, page, errors, state };
}

const visible = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent).length, sel);
async function openCard(page, i) {
  await page.evaluate(() => { const b = document.querySelector('.modal-close, #closeJourneyModal'); if (b && b.offsetParent) b.click(); });
  const cards = await page.$$('#departuresList .departure-card .line-badge');
  await cards[i].click();
  await page.waitForTimeout(1800);
}

(async () => {
  const browser = await chromium.launch();
  const servers = [];
  try {
    // ---- 1. helper online: Gleisbelegung per stop, never for trams
    servers.push(await startServer(5099, true));
    for (const desktop of [false, true]) {
      const tag = desktop ? '[desktop]' : '[phone]';
      const { ctx, page, errors, state } = await openApp(browser, 5099, { desktop });
      check((await page.$$('#departuresList .departure-card')).length === 2, `${tag} departures render`);
      await openCard(page, 0);
      check(await visible(page, '.fm-tabs') === 1, `${tag} train shows Echtzeit/Gleisbelegung tabs`);
      await page.evaluate(() => [...document.querySelectorAll('.fm-tabs button[data-v=track]')].find((b) => b.offsetParent).click());
      await page.waitForTimeout(1500);
      const panel = () => page.evaluate(() => {
        const p = [...document.querySelectorAll('.fm-panel')].find((x) => x.offsetParent);
        return p && { stops: p.querySelectorAll('.fm-stop').length, sel: p.querySelector('.fm-stop[aria-selected=true] strong')?.textContent,
          cars: p.querySelectorAll('.fm-car').length, msg: p.querySelector('.fm-msg')?.textContent || '' };
      });
      let p = await panel();
      check(p && p.stops === 4, `${tag} stop picker lists every stop`);
      check(p && p.sel === 'Magdeburg Hbf' && p.cars === 5, `${tag} boarding stop is preselected with its formation`);
      await page.evaluate(() => [...document.querySelectorAll('.fm-stop')].find((b) => b.offsetParent && b.textContent.includes('Genthin')).click());
      await page.waitForTimeout(1500);
      p = await panel();
      check(p && p.cars === 0 && /keine Wagenreihung/.test(p.msg), `${tag} stop without data shows a message`);
      await page.evaluate(() => [...document.querySelectorAll('.fm-tabs button[data-v=live]')].find((b) => b.offsetParent).click());
      check(await visible(page, '.fm-panel') === 0, `${tag} back to Echtzeit hides the formation`);
      await openCard(page, 1);
      check(await page.evaluate(() => document.querySelectorAll('.fm-tabs, .fm-panel').length) === 0, `${tag} tram has no Gleisbelegung tab`);

      // ---- 3. offline mode: saved departures with a "Stand" banner
      state.down = true;
      await page.evaluate(() => MVBApp.fetchDepartures());
      await page.waitForTimeout(1200);
      const off = await page.evaluate(() => ({ cards: document.querySelectorAll('#departuresList .departure-card').length,
        banner: document.querySelector('#departuresList .offline-note')?.textContent || '', meta: document.getElementById('boardMeta')?.textContent || '' }));
      check(off.cards >= 1 && /Stand/.test(off.banner) && /Offline/.test(off.meta), `${tag} offline: saved departures with banner`);
      state.down = false;
      await page.evaluate(() => MVBApp.fetchDepartures());
      await page.waitForTimeout(1200);
      check(await page.evaluate(() => !document.querySelector('#departuresList .offline-note')), `${tag} online again: banner gone`);
      check(errors.length === 0, `${tag} no JavaScript errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }

    // ---- 2. no Wagenreihung source: no tabs, no strips
    servers.push(await startServer(5098, false));
    const { ctx, page, errors } = await openApp(browser, 5098);
    await page.waitForTimeout(1500);
    await openCard(page, 0);
    check(await page.evaluate(() => document.querySelectorAll('.fm-tabs, .fm-panel, .fm-car').length) === 0, 'helper offline: no tabs, no formation strips');
    check(errors.length === 0, `helper offline: no JavaScript errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await ctx.close();

    // ---- 4. Fahrt anpinnen: bar in the Linienverlauf, exit picker, card on the start page
    {
      const { ctx, page, errors } = await openApp(browser, 5099);
      let stored = null;
      const view = { phase: 'ride', label: 'Aktuell', pct: 0.5, ticks: [0, 1], delay: 2, cancelled: false, minsToDep: -3, minsLeft: 19,
        prev: { name: 'Hauptbahnhof', time: at(-3) }, cur: { name: 'Hauptbahnhof', time: at(-3) }, next: { name: 'Westerhüsen', time: at(19) },
        board: { name: 'Hauptbahnhof', time: at(-3) }, exit: { name: 'Westerhüsen', time: at(19) } };
      await ctx.route('**/api/push/pin', (r) => {
        const body = JSON.parse(r.request().postData() || '{}');
        if (body.pin) stored = body.pin;
        if (body.cancel) stored = null;
        r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pin: stored, view: stored ? view : null }) });
      });
      // no real push service in a test browser: pretend push is switched on
      await page.evaluate(() => { MVBPush.ensureOn = async () => true; MVBPush.endpoint = () => 'https://push.example/test'; });
      await openCard(page, 1);                                   // tram line 2
      check(await visible(page, '.pin-slot .pin-bar') === 1, '[pin] "Fahrt anpinnen" shows in the Linienverlauf');
      await page.evaluate(() => [...document.querySelectorAll('.pin-slot [data-act=pick]')].find((b) => b.offsetParent).click());
      await page.waitForTimeout(400);
      check(await visible(page, '.pin-stop') >= 1, '[pin] exit stops can be picked');
      await page.evaluate(() => [...document.querySelectorAll('.pin-slot [data-act=go]')].find((b) => b.offsetParent).click());
      await page.waitForTimeout(800);
      check(!!stored && stored.exit === 'Westerhüsen' && stored.board === 'Hauptbahnhof', '[pin] pin request carries boarding and exit stop');
      check(await visible(page, '.pin-bar.on') === 1, '[pin] bar switches to "Angepinnt"');
      await page.evaluate(() => { const b = document.querySelector('#closeModal'); if (b && b.offsetParent) b.click(); MVBApp.switchTab('home'); });
      await page.waitForTimeout(800);
      const card = await page.evaluate(() => { const c = document.getElementById('pinCard'); return c && !c.hidden && { cur: c.querySelector('.pc-stop.cur strong')?.textContent, delay: c.querySelector('.pc-delay')?.textContent }; });
      check(card && card.cur === 'Hauptbahnhof' && card.delay === '+2 Min', '[pin] start page shows the pinned trip');
      await page.evaluate(() => document.querySelector('#pinCard .pc-unpin').click());
      await page.waitForTimeout(600);
      check(stored === null && await page.evaluate(() => document.getElementById('pinCard').hidden), '[pin] "Lösen" unpins');
      check(errors.length === 0, `[pin] no JavaScript errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }

    // ---- 5. Statistik unter der Karte: Kacheln, Linien, Störungen des Tages, Zeitraum wechseln
    {
      const { ctx, page, errors } = await openApp(browser, 5099, { desktop: true });
      const today = new Date().toISOString().slice(0, 10);
      const asked = [];
      const line = (key, short, type, color, n, e, o, l, avg, max) => ({ key, short, type, color, n, early: e, onTime: o - 8, slight: 6, late: l, cancelled: 1, unrated: 1, avg, avgLate: 5.2, max, hist: [] });
      await ctx.route('**/api/stats?*', (r) => {
        const u = new URL(r.request().url());
        asked.push(u.searchParams.get('range'));
        const range = u.searchParams.get('range');
        const trend = Array.from({ length: { day: 1, week: 7, month: 30, year: 365 }[range] }, (_, i) => ({ date: today, n: i % 3 ? 120 : 0, onTime: 80 + (i % 7), avg: 1.1 }));
        r.fulfill({ contentType: 'application/json', body: JSON.stringify({
          from: today, to: today, today, earliest: '2025-11-26', first: today, range,
          total: { n: 1834, early: 4.2, onTime: 73.5, slight: 6, late: 14.3, cancelled: 1.2, unrated: 0.8, avg: 1.4, avgLate: 5.6 },
          lines: [line('tram:1', '1', 'tram', '#e30613', 402, 3.1, 86.2, 10.7, 0.9, 9), line('tram:9', '9', 'tram', '#f6a500', 377, 6, 70, 24, 2.6, 14),
                  line('bus:52', '52', 'bus', '#00718f', 210, 2, 90, 8, 0.4, 7)],
          trend, disruptions: [{ id: 'a', title: 'Bauarbeiten Breiter Weg', lines: ['Linie 9'], first: Date.now() / 1000 - 7200, last: Date.now() / 1000, text: 'Die Linie 9 fährt eine Umleitung.', done: false, gone: false, critical: false, days: [today] },
                               { id: 'b', title: 'Unfall Olvenstedter Graseweg', lines: ['Linie 1'], first: Date.now() / 1000 - 3600, last: Date.now() / 1000 - 1800, text: 'Erledigt.', done: true, gone: false, critical: true, days: [today] }] }) });
      });
      await page.evaluate(() => { try { MVBApp.switchTab('map'); } catch (e) { /* Leaflet not loaded offline */ } document.getElementById('lineStats').scrollIntoView(); });
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => ({ tiles: document.querySelectorAll('#lineStats .st-tile').length, lines: document.querySelectorAll('#lineStats .st-lines > li').length,
        disr: document.querySelectorAll('#lineStats .st-dis').length, done: document.querySelector('#lineStats .st-dis.done .st-dis-st')?.textContent }));
      check(st.tiles === 7 && st.lines === 3, '[stats] tiles and one row per line');
      check(st.disr === 2 && st.done === 'erledigt', '[stats] disruptions of the day with status');
      await page.evaluate(() => document.querySelector('#lineStats [data-group=bus]').click());
      check(await page.evaluate(() => document.querySelectorAll('#lineStats .st-lines > li').length) === 1, '[stats] bus filter');
      await page.evaluate(() => document.querySelector('#lineStats [data-range=month]').click());
      await page.waitForTimeout(800);
      check(asked.includes('month') && await page.evaluate(() => !!document.querySelector('#lineStats .st-trend path.st-line')), '[stats] month view with trend line');
      // tap a line → its Kurse from the Fahrtenschreiber
      await ctx.route('**/api/fts/courses?*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ courses: [
        { line: '52', dayType: 'wt', kurs: '52/03', count: 3, span: ['06:10', '09:40'], vehicles: [['2104', 2, 'andere'], ['2111', 1, 'andere']], types: [['andere', 3]], trips: [['06:10 Neustädter See → Lemsdorf', 1]] },
        { line: '52', dayType: 'sa', kurs: '52/11', count: 1, span: ['08:00', '08:00'], vehicles: [['2104', 1, 'andere']], types: [['andere', 1]], trips: [] }],
        withoutKurs: [{ line: '52', dayType: 'wt', date: '2026-11-27', time: '07:12', vehicles: [['2120', 'andere']], type: 'andere', stop: 'ZOB', direction: 'Lemsdorf', start: '', origin: '' }] }) }));
      await page.evaluate(() => document.querySelector('#lineStats li.st-line').click());
      await page.waitForTimeout(600);
      const kurse = await page.evaluate(() => ({ groups: document.querySelectorAll('#lineStats .st-kurse .st-kg').length, rows: document.querySelectorAll('#lineStats .st-ktab tbody tr').length,
        expanded: document.querySelector('#lineStats li.st-line').getAttribute('aria-expanded') }));
      check(kurse.groups === 2 && kurse.rows === 3 && kurse.expanded === 'true', '[stats] line row opens its Kurse per day type');
      if (process.env.SHOT) await page.locator('#lineStats').screenshot({ path: process.env.SHOT });
      check(errors.filter((e) => !/Leaflet|L is not defined/.test(e)).length === 0, `[stats] no JavaScript errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
      await ctx.close();
    }
  } catch (e) {
    failures.push(String(e && e.stack || e));
    console.error(e);
  } finally {
    await browser.close();
    servers.forEach((s) => s.kill());
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall browser checks passed');
  process.exit(failures.length ? 1 : 0);
})();
