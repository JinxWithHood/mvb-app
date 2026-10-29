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
