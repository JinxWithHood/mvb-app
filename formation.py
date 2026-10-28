"""
Wagenreihung (Zugformation) von bahn.de – nur Züge und S-Bahnen.

Fragt den Wagenreihungs-Dienst ab, den auch bahn.de für die Bahnsteigansicht nutzt,
und wandelt die Antwort in ein kleines, stabiles Format für die App um:
Abschnitte, Wagen (Nummer, Klasse, Abschnitt, Position), Zugteile und Fahrtrichtung.

Alles hier ist "best effort": Gibt es keine Daten oder sperrt bahn.de den Server,
liefert die App einfach keine Wagenreihung – sonst ändert sich nichts.
"""
import datetime
import os
import random
import re
import uuid
import threading
import time

import requests

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/Berlin')
except Exception:  # pragma: no cover
    import pytz
    TZ = pytz.timezone('Europe/Berlin')

PATH = '/web/api/reisebegleitung/wagenreihung/vehicle-sequence'
HOSTS = ['https://www.bahn.de', 'https://int.bahn.de']
# bahn.de blocks datacenter IPs (Render too). A small relay on a normal connection
# (e.g. a Cloudflare Worker, see relay/) can be set in Render: FORMATION_RELAY_URL + FORMATION_RELAY_KEY
RELAY_URL = (os.environ.get('FORMATION_RELAY_URL') or '').strip()
RELAY_KEY = (os.environ.get('FORMATION_RELAY_KEY') or '').strip()
BLOCK_PAUSE = 15 * 60
OK_TTL = 120
MISS_TTL = 600

_session = requests.Session()
_session.headers.update({
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'),
    'Accept': 'application/json',
    'Accept-Language': 'de-DE,de;q=0.9',
})
_cache = {}
_lock = threading.Lock()
_blocked = {}          # host -> until


class Blocked(Exception):
    pass


# ---------------------------------------------------------------------------
# Train identity
# ---------------------------------------------------------------------------
TRAIN_CATS = ('ICE', 'ICD', 'ECE', 'EC', 'IC', 'IRE', 'RE', 'RB', 'S', 'MEX', 'FEX', 'NJ', 'EN', 'RJ', 'RJX', 'FLX', 'TGV', 'WB')
_CAT_RE = re.compile(r'^\s*(ICE|ICD|ECE|EC|IC|IRE|RE|RB|S|MEX|FEX|NJ|EN|RJX|RJ|FLX|TGV|WB)(?=[\s\d(]|$)', re.I)


def ident_from_text(*texts):
    """('ICE 1006') -> ('ICE', '1006'); ('RE 1 (73748)') -> ('RE', '73748'); unknown -> (None, None)."""
    cat, num = None, None
    for t in texts:
        t = (t or '').strip()
        if not t:
            continue
        m = _CAT_RE.match(t)
        if m and not cat:
            cat = m.group(1).upper()
        p = re.search(r'\((\d{3,6})\)', t)
        if p and not num:
            num = p.group(1)
        if cat in ('ICE', 'ICD', 'ECE', 'EC', 'IC', 'NJ', 'EN', 'RJ', 'RJX', 'FLX', 'TGV', 'WB') and not num:
            m2 = re.match(r'^\s*[A-Za-z]+\s*(\d{1,6})\s*$', t)
            if m2:
                num = m2.group(1)
    return cat, num


def eva_from_station_id(sid):
    """NASA '8010224', db 'db:A=1@…@L=8010224@…', tr 'tr:de-DELFI_de:15003:8010224' -> '8010224'."""
    s = str(sid or '')
    m = re.search(r'@L=(\d{7})@', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'\d{7}', s):
        return s if s.startswith('80') or s.startswith('81') else None
    m = re.search(r'(?<!\d)(8[01]\d{5})(?!\d)', s)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------
def _cache_get(key):
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    return None


def _cache_put(key, val, ttl):
    with _lock:
        if len(_cache) > 400:
            _cache.clear()
        _cache[key] = (time.time() + ttl, val)


# the browser headers Travel::Status::DE::DBRIS (and other open-source DB clients) send
_AGENTS = [
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.{a}.{b} Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B/DS) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.{a}.{b} Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.{a}.{b} Mobile Safari/537.36',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.{a}.{b} Safari/537.36',
]


def browser_headers(host='https://www.bahn.de'):
    return {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'Origin': host,
        'Referer': host + '/buchung/fahrplan/suche',
        'User-Agent': random.choice(_AGENTS).format(a=random.randint(0, 999), b=random.randint(0, 99)),
        'x-correlation-id': f'{uuid.uuid4()}_{uuid.uuid4()}',
    }


def sources():
    """[(name, url, headers)] in the order they are tried."""
    out = []
    if RELAY_URL.startswith('https://'):
        out.append(('relay', RELAY_URL, {'X-Relay-Key': RELAY_KEY}))
    out += [(h, h + PATH, browser_headers(h)) for h in HOSTS]
    return out


def all_blocked():
    now = time.time()
    return all(_blocked.get(name, 0) > now for name, _, _ in sources())


def cache_key(eva, cat, num, dep_local):
    return f"{eva}|{cat}|{num}|{dep_local.strftime('%Y-%m-%dT%H:%M')}"


def params_for(eva, cat, num, dep_local):
    utc = dep_local.replace(tzinfo=TZ).astimezone(datetime.timezone.utc) if hasattr(TZ, 'key') \
        else TZ.localize(dep_local).astimezone(datetime.timezone.utc)
    return {
        'administrationId': 80, 'category': cat, 'date': utc.strftime('%Y-%m-%d'),
        'evaNumber': eva, 'number': num, 'time': utc.strftime('%Y-%m-%dT%H:%M:%S.000Z'),
    }


def store(params, data, ok):
    """Result delivered by the home helper."""
    _cache_put(('helper', params['evaNumber'], params['category'], params['number'], params['time']),
               data if ok else {}, OK_TTL if ok else MISS_TTL)


def fetch(eva, cat, num, dep_local):
    """Raw bahn.de answer or None (no formation). Raises Blocked when every host refuses us."""
    key = (eva, cat, num, dep_local.strftime('%Y-%m-%dT%H:%M'))
    hit = _cache_get(key)
    if hit is not None:
        return hit or None
    params = params_for(eva, cat, num, dep_local)
    hit = _cache_get(('helper', eva, cat, num, params['time']))
    if hit is not None:
        return hit or None
    tried = False
    for name, url, headers in sources():
        if _blocked.get(name, 0) > time.time():
            continue
        tried = True
        try:
            r = _session.get(url, params=params, headers=headers, timeout=10)
        except requests.RequestException:
            continue
        if r.status_code in (401, 403, 452):
            _blocked[name] = time.time() + BLOCK_PAUSE
            continue
        if r.status_code in (204, 404) or r.status_code >= 400:
            _cache_put(key, {}, MISS_TTL if r.status_code in (204, 404) else 60)
            return None
        try:
            data = r.json()
        except ValueError:
            _cache_put(key, {}, 60)
            return None
        if not isinstance(data, dict) or not data.get('groups'):
            _cache_put(key, {}, MISS_TTL)
            return None
        _cache_put(key, data, OK_TTL)
        return data
    if not tried or all_blocked():
        raise Blocked('bahn.de blockiert diesen Server')
    return None


# ---------------------------------------------------------------------------
# Normalize
# ---------------------------------------------------------------------------
AMENITY = {
    'BISTRO': 'bistro', 'ZONE_QUIET': 'quiet', 'ZONE_FAMILY': 'family', 'WHEELCHAIR_SPACE': 'wheelchair',
    'BIKE_SPACE': 'bike', 'SEATS_BAHN_COMFORT': 'comfort', 'CABIN_INFANT': 'infant', 'TOILET_WHEELCHAIR': 'wc',
}


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def normalize(raw):
    """bahn.de vehicle-sequence -> app format (cars sorted left -> right along the platform)."""
    if not isinstance(raw, dict):
        return None
    pf = raw.get('platform') or {}
    p0, p1 = _num(pf.get('start')), _num(pf.get('end'))
    if p0 is None or p1 is None or p1 <= p0:
        return None
    span = p1 - p0
    pct = lambda v: round(max(0.0, min(100.0, (v - p0) * 100 / span)), 2)

    sectors = []
    for s in pf.get('sectors') or []:
        a, b = _num(s.get('start')), _num(s.get('end'))
        if s.get('name') and a is not None and b is not None:
            sectors.append({'name': str(s['name']), 'start': pct(a), 'end': pct(b)})
    sectors.sort(key=lambda s: s['start'])

    groups, cars, listed = [], [], []
    for gi, g in enumerate(raw.get('groups') or []):
        tr = g.get('transport') or {}
        vehicles = g.get('vehicles') or []
        cats = [((v.get('type') or {}).get('category') or '').upper() for v in vehicles]
        hauled = any(c in ('LOCOMOTIVE', 'POWERCAR') for c in cats)
        gcars = []
        for v in vehicles:
            pos = v.get('platformPosition') or {}
            a, b = _num(pos.get('start')), _num(pos.get('end'))
            if a is None or b is None:
                continue
            t = v.get('type') or {}
            cat = (t.get('category') or '').upper()
            first, second = bool(t.get('hasFirstClass')), bool(t.get('hasEconomyClass'))
            amen = []
            for am in v.get('amenities') or []:
                k = AMENITY.get((am or {}).get('type'))
                if k and k not in amen:
                    amen.append(k)
            if cat == 'LOCOMOTIVE':
                kind, cls = 'loco', None
            elif cat == 'POWERCAR':
                kind, cls = 'powercar', None
            else:
                dd = 'DOUBLEDECK' in cat
                cab = 'CONTROLCAR' in cat
                kind = ('ddcab' if cab else 'dd') if dd else ('cab' if cab else 'car')
                if 'DININGCAR' in cat and not first and not second:
                    cls = 'B'
                elif first and second:
                    cls = '12'
                elif first:
                    cls = '1'
                elif second:
                    cls = '2'
                else:
                    cls = 'B' if 'DINING' in cat else None
                if 'DININGCAR' in cat and 'bistro' not in amen:
                    amen.insert(0, 'bistro')
            car = {
                'num': str(v.get('wagonIdentificationNumber') or '').strip() or None,
                'cls': cls, 'kind': kind, 'sector': (pos.get('sector') or '') or None,
                'start': pct(min(a, b)), 'end': pct(max(a, b)),
                'closed': (v.get('status') or '').upper() == 'CLOSED',
                'amenities': amen[:4], 'group': gi, 'multipleUnit': not hauled,
            }
            gcars.append(car)
            listed.append(car)
        if not gcars:
            continue
        dest = ((tr.get('destination') or {}).get('name') or '').strip() or None
        groups.append({'index': gi, 'cat': tr.get('category'), 'num': str(tr.get('number') or '') or None,
                       'destination': dest})
        cars.extend(gcars)
    if not cars:
        return None

    # travel direction: the vehicles are listed front first (as bahn.de does it)
    direction = None
    if len(listed) > 1:
        direction = 'right' if listed[0]['start'] > listed[-1]['start'] else 'left'
    cars.sort(key=lambda c: c['start'])
    # end cars of a multiple unit get a nose facing outwards
    for gi in {c['group'] for c in cars}:
        gc = [c for c in cars if c['group'] == gi]
        if gc and ((gc[0]['multipleUnit'] and gc[0]['kind'] in ('car', 'cab')) or gc[0]['kind'] == 'powercar'):
            gc[0]['nose'] = 'left'
        if gc and ((gc[-1]['multipleUnit'] and gc[-1]['kind'] in ('car', 'cab')) or gc[-1]['kind'] == 'powercar'):
            gc[-1]['nose'] = 'right'
        for c in gc:
            if c['kind'] in ('ddcab', 'cab') and 'nose' not in c:
                c['nose'] = 'left' if c is gc[0] else 'right'
    dests = {g['destination'] for g in groups if g['destination']}
    return {
        'available': True,
        'platform': raw.get('departurePlatform') or raw.get('departurePlatformSchedule'),
        'direction': direction,
        'sectors': sectors,
        'groups': groups,
        'split': len(groups) > 1 and len(dests) > 1,
        'cars': cars,
    }
