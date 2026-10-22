"""
bahn.de web API (DB Vendo) – bundesweite Fahrplandaten.

Liefert Haltestellensuche, Abfahrten, Verbindungen und Fahrtverläufe für ganz
Deutschland (Tram, Bus, U-Bahn, S-Bahn, Regio, Fernverkehr, Fähre) inklusive
Echtzeit. Dieses Modul spricht nur mit bahn.de und wandelt die Antworten in
einfache Python-Dicts um; Farben und App-spezifische Felder setzt backend.py.
"""
import datetime
import json
import re
import threading
import time

import requests

BASE = 'https://www.bahn.de/web/api'
ALL_PRODUCTS = ['ICE', 'EC_IC', 'IR', 'REGIONAL', 'SBAHN', 'BUS', 'SCHIFF', 'UBAHN', 'TRAM', 'ANRUFPFLICHTIG']

# App-Verkehrsmittel -> bahn.de Produktgattungen
MODE_PRODUCTS = {
    'express': ['ICE', 'EC_IC', 'IR'],
    'regional': ['REGIONAL'],
    'sbahn': ['SBAHN'],
    'ubahn': ['UBAHN'],
    'tram': ['TRAM'],
    'bus': ['BUS', 'ANRUFPFLICHTIG'],
    'ferry': ['SCHIFF'],
}
PRODUCT_TYPE = {
    'ICE': 'express', 'EC_IC': 'express', 'IR': 'express', 'REGIONAL': 'regional',
    'SBAHN': 'sbahn', 'UBAHN': 'ubahn', 'TRAM': 'tram', 'BUS': 'bus',
    'ANRUFPFLICHTIG': 'bus', 'SCHIFF': 'ferry',
}

_session = requests.Session()
_session.headers.update({
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'),
    'Accept': 'application/json',
    'Accept-Language': 'de-DE,de;q=0.9',
})

_cache = {}
_cache_lock = threading.Lock()


class DbWebError(Exception):
    pass


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    return None


def _cache_put(key, value, ttl):
    if ttl <= 0:
        return
    with _cache_lock:
        if len(_cache) > 600:
            now = time.time()
            for k in [k for k, v in _cache.items() if v[0] <= now]:
                _cache.pop(k, None)
            if len(_cache) > 600:
                _cache.clear()
        _cache[key] = (time.time() + ttl, value)


def _request(method, path, params=None, body=None, ttl=0, timeout=12):
    key = (method, path, json.dumps(params, sort_keys=True, default=str),
           json.dumps(body, sort_keys=True, default=str))
    cached = _cache_get(key)
    if cached is not None:
        return cached
    last = None
    for attempt in range(2):
        try:
            if method == 'GET':
                r = _session.get(BASE + path, params=params, timeout=timeout)
            else:
                r = _session.post(BASE + path, json=body, timeout=timeout,
                                  headers={'Content-Type': 'application/json'})
            if r.status_code in (429, 500, 502, 503, 504):
                last = DbWebError(f'bahn.de antwortet mit {r.status_code}')
                time.sleep(0.6 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise DbWebError(f'bahn.de antwortet mit {r.status_code}')
            data = r.json()
            _cache_put(key, data, ttl)
            return data
        except DbWebError:
            raise
        except (requests.RequestException, ValueError) as ex:
            last = DbWebError(f'bahn.de nicht erreichbar: {ex.__class__.__name__}')
            time.sleep(0.4)
    raise last or DbWebError('bahn.de nicht erreichbar')


# ---------------------------------------------------------------------------
# IDs and times
# ---------------------------------------------------------------------------
def lid_from_id(station_id):
    """'db:A=1@…' / 'db:8010224' / '8010224' -> HAFAS location id string."""
    s = (station_id or '').strip()
    if s.startswith('db:'):
        s = s[3:]
    if s.startswith('A='):
        return s
    if s.isdigit():
        return f'A=1@L={s}@'
    return None


def ext_from_lid(lid):
    m = re.search(r'@L=(\d+)@', lid or '')
    return m.group(1) if m else None


def name_from_lid(lid):
    m = re.search(r'@O=([^@]+)@', lid or '')
    return m.group(1) if m else None


def parse_dt(value):
    """'2026-10-22T19:40:00' -> naive local datetime (bahn.de liefert Ortszeit)."""
    if not value:
        return None
    try:
        return datetime.datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def products_for(modes):
    """modes: iterable of app mode keys (or None = all)."""
    if not modes:
        return list(ALL_PRODUCTS)
    out = []
    for m in modes:
        for p in MODE_PRODUCTS.get(m, []):
            if p not in out:
                out.append(p)
    return out or list(ALL_PRODUCTS)


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------
def locations(query, limit=10):
    data = _request('GET', '/reiseloesung/orte',
                    params={'suchbegriff': query, 'typ': 'ALL', 'limit': limit}, ttl=3600)
    out = []
    for loc in data or []:
        lid = loc.get('id')
        if not lid or not loc.get('name'):
            continue
        out.append({
            'id': 'db:' + lid,
            'name': loc['name'],
            'type': loc.get('type'),           # ST = Haltestelle, ADR = Adresse, POI
            'extId': loc.get('extId'),
            'lat': loc.get('lat'),
            'lon': loc.get('lon'),
            'products': loc.get('products') or [],
        })
    return out


def resolve_station(name):
    """Best bahn.de stop for a free-text station name (cached via locations())."""
    if not name:
        return None
    cands = locations(name, limit=8)
    stops = [c for c in cands if c.get('type') == 'ST'] or cands
    if not stops:
        return None
    wanted_city = None
    if ',' in name:
        first = name.split(',')[0].strip().lower()
        if first and len(first) > 2:
            wanted_city = first
    if wanted_city:
        for c in stops:
            if wanted_city in c['name'].lower():
                return c
    return stops[0]


def departures_raw(lid, when, duration_min=60, products=None, arrivals=False, max_pages=3):
    """Abfahrten (oder Ankünfte) ab `when` (naive Ortszeit) für `duration_min` Minuten."""
    ext = ext_from_lid(lid)
    if not ext:
        raise DbWebError('Ungültige Haltestelle')
    end = when + datetime.timedelta(minutes=duration_min)
    path = '/reiseloesung/ankuenfte' if arrivals else '/reiseloesung/abfahrten'
    entries, seen, cursor = [], set(), when
    for _ in range(max_pages):
        params = [('datum', cursor.strftime('%Y-%m-%d')), ('zeit', cursor.strftime('%H:%M:00')),
                  ('ortExtId', ext), ('ortId', lid), ('mitVias', 'true'), ('maxVias', '8')]
        for p in (products or ALL_PRODUCTS):
            params.append(('verkehrsmittel[]', p))
        data = _request('GET', path, params=params, ttl=25)
        page = (data or {}).get('entries') or []
        new = 0
        last_dt = None
        for e in page:
            key = (e.get('journeyId'), e.get('zeit'))
            if key in seen:
                continue
            seen.add(key)
            dt = parse_dt(e.get('zeit'))
            if dt is None:
                continue
            last_dt = dt
            if dt > end:
                continue
            entries.append(e)
            new += 1
        if not page or last_dt is None or last_dt >= end or new == 0:
            break
        cursor = last_dt
    return entries


def journeys_raw(from_lid, to_lid, when, arrive=False, products=None, max_changes=None,
                 min_change=None, d_ticket=False, bike=False, paging=None):
    body = {
        'abfahrtsHalt': from_lid,
        'ankunftsHalt': to_lid,
        'anfrageZeitpunkt': when.strftime('%Y-%m-%dT%H:%M:00'),
        'ankunftSuche': 'ANKUNFT' if arrive else 'ABFAHRT',
        'klasse': 'KLASSE_2',
        'produktgattungen': products or list(ALL_PRODUCTS),
        'reisende': [{'typ': 'ERWACHSENER',
                      'ermaessigungen': [{'art': 'KEINE_ERMAESSIGUNG', 'klasse': 'KLASSENLOS'}],
                      'alter': [], 'anzahl': 1}],
        'schnelleVerbindungen': True,
        'sitzplatzOnly': False,
        'bikeCarriage': bool(bike),
        'reservierungsKontingenteVorhanden': False,
        'nurDeutschlandTicketVerbindungen': bool(d_ticket),
        'deutschlandTicketVorhanden': False,
    }
    if max_changes is not None and max_changes >= 0:
        body['maxUmstiege'] = int(max_changes)
    if min_change:
        body['minUmstiegszeit'] = int(min_change)
    if paging:
        body['pagingReference'] = paging
    return _request('POST', '/angebote/fahrplan', body=body, ttl=20, timeout=15)


def trip_raw(journey_id):
    return _request('GET', '/reiseloesung/fahrt',
                    params={'journeyId': journey_id, 'poly': 'false'}, ttl=15)


# ---------------------------------------------------------------------------
# Normalisation helpers (used by backend.py)
# ---------------------------------------------------------------------------
def minutes_between(a, b):
    if not a or not b:
        return None
    return int(round((b - a).total_seconds() / 60))


def delay_of(planned, realtime):
    if planned is None or realtime is None:
        return None
    return minutes_between(planned, realtime)


def operator_of(vm):
    for a in (vm or {}).get('zugattribute') or []:
        if a.get('key') == 'BEF' or a.get('kategorie') == 'BEFÖRDERER':
            return a.get('value')
    return None


def attributes_of(vm, wanted=('FAHRRADMITNAHME', 'BARRIEREFREI')):
    out = []
    for a in (vm or {}).get('zugattribute') or []:
        if a.get('kategorie') in wanted and a.get('value') and a['value'] not in out:
            out.append(a['value'])
    return out[:4]


def line_label(vm):
    """Kurzer Linienname wie in der App: '13', 'N4', 'S7', 'RE1', 'ICE 550', 'U2'."""
    vm = vm or {}
    gattung = vm.get('produktGattung')
    num = (vm.get('linienNummer') or '').strip()
    name = (vm.get('name') or '').strip()
    mittel = (vm.get('mittelText') or '').strip()
    if gattung in ('TRAM', 'BUS', 'ANRUFPFLICHTIG', 'SCHIFF', 'UBAHN', 'SBAHN') and num:
        return num
    if gattung == 'REGIONAL':
        if mittel and not mittel.isdigit():
            return mittel
        return num or name
    if gattung in ('ICE', 'EC_IC', 'IR'):
        return name or mittel
    if num:
        return num
    return re.sub(r'^(STR|Bus|Tram)\s+', '', mittel or name, flags=re.I)


def notes_of(section):
    texts = []
    for n in section.get('priorisierteMeldungen') or []:
        t = (n.get('text') or '').strip()
        if t and t not in texts:
            texts.append(t)
    for n in section.get('risNotizen') or []:
        t = (n.get('value') or '').strip()
        if t and t not in texts:
            texts.append(t)
    for n in section.get('himMeldungen') or []:
        t = ((n.get('ueberschrift') or '') + ' ' + (n.get('text') or '')).strip()
        if t and t not in texts:
            texts.append(t)
    return texts[:4]


def is_cancelled_text(texts):
    blob = ' '.join(texts or []).lower()
    return any(k in blob for k in ('fällt aus', 'ausfall', 'entfällt', 'halt entfällt', 'fahrt fällt'))
