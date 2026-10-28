/**
 * Magdeburg Mobil – Wagenreihungs-Weiterleitung (Cloudflare Worker)
 *
 * bahn.de beantwortet keine Anfragen von Rechenzentren (Render). Dieser Worker fragt
 * nur die Wagenreihung bei bahn.de ab und gibt die Antwort an den App-Server weiter.
 * Er ist KEIN offener Proxy: nur dieser eine bahn.de-Pfad, nur geprüfte Parameter,
 * nur mit dem geheimen Schlüssel (Secret RELAY_KEY im Worker = FORMATION_RELAY_KEY bei Render).
 */
const TARGET = 'https://www.bahn.de/web/api/reisebegleitung/wagenreihung/vehicle-sequence';
const CHECKS = {
  administrationId: /^\d{1,3}$/,
  category: /^[A-Z]{1,4}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  evaNumber: /^\d{7}$/,
  number: /^\d{1,6}$/,
  time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
};

const AGENTS = [
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.XXXX.YYY Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B/DS) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.XXXX.YYY Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.XXXX.YYY Mobile Safari/537.36',
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.XXXX.YYY Safari/537.36',
];

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (!env.RELAY_KEY || request.headers.get('x-relay-key') !== env.RELAY_KEY) {
      return new Response('forbidden', { status: 401 });
    }
    const url = new URL(request.url);
    const query = new URLSearchParams();
    for (const [name, pattern] of Object.entries(CHECKS)) {
      const value = url.searchParams.get(name) || '';
      if (!pattern.test(value)) return new Response('bad request', { status: 400 });
      query.set(name, value);
    }
    // same browser headers as the open-source DB clients (Travel::Status::DE::DBRIS, BetterBahn)
    const rnd = (n) => Math.floor(Math.random() * n);
    const agent = AGENTS[rnd(AGENTS.length)].replace('XXXX', String(rnd(1000))).replace('YYY', String(rnd(100)));
    const upstream = await fetch(`${TARGET}?${query}`, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'Origin': 'https://www.bahn.de',
        'Referer': 'https://www.bahn.de/buchung/fahrplan/suche',
        'User-Agent': agent,
        'x-correlation-id': `${crypto.randomUUID()}_${crypto.randomUUID()}`,
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'max-age=60',
      },
    });
  },
};
