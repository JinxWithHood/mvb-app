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
    const upstream = await fetch(`${TARGET}?${query}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'de-DE,de;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
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
