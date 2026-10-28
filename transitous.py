"""
Transitous (MOTIS) – offene, bundesweite Fahrplandaten inkl. Echtzeit.
https://transitous.org – Community-Projekt, frei nutzbar bei fairer Nutzung.

Wird genutzt, wenn bahn.de den Server sperrt: Haltestellensuche, Abfahrten,
Verbindungen und Fahrtverläufe für ganz Deutschland (U-Bahn Berlin, Tram, Bus …).
"""
import datetime
import json
import threading
import time

import requests

BASE = 'https://api.transitous.org/api/v1'
try:  # Windows has no built-in time zone data -> pip package tzdata, else pytz
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/Berlin')
except Exception:
    import pytz
    TZ = pytz.timezone('Europe/Berlin')


def _localize(naive):
    return TZ.localize(naive) if hasattr(TZ, 'localize') else naive.replace(tzinfo=TZ)

# app modes -> MOTIS transit modes
MODE_MAP = {
    'tram': ['TRAM'],
    'bus': ['BUS', 'COACH'],
    'sbahn': ['SUBURBAN', 'METRO'],
    'ubahn': ['SUBWAY'],
    'regional': ['REGIONAL_RAIL', 'REGIONAL_FAST_RAIL'],
    'express': ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'NIGHT_RAIL'],
    'ferry': ['FERRY'],
}
TYPE_OF = {
    'TRAM': 'tram', 'SUBWAY': 'ubahn', 'METRO': 'sbahn', 'SUBURBAN': 'sbahn',
    'BUS': 'bus', 'COACH': 'bus', 'ODM': 'bus', 'REGIONAL_RAIL': 'regional', 'REGIONAL_FAST_RAIL': 'regional',
    'RAIL': 'regional', 'HIGHSPEED_RAIL': 'express', 'LONG_DISTANCE': 'express', 'NIGHT_RAIL': 'express',
    'FERRY': 'ferry', 'FUNICULAR': 'tram', 'AERIAL_LIFT': 'tram', 'CABLE_CAR': 'tram',
}

_session = requests.Session()
_session.headers.update({
    'User-Agent': 'MagdeburgMobil/1.0 (+https://mvb-app.onrender.com; inoffizielle Nahverkehrs-App)',
    'Accept': 'application/json',
})
_cache = {}
_lock = threading.Lock()
STOP_INFO = {}   # stopId -> {'name', 'lat', 'lon'} (filled by searches)


class TransitousError(Exception):
    pass


def _get(path, params, ttl=0, timeout=12):
    key = (path, json.dumps(params, sort_keys=True))
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    last = None
    for attempt in range(2):
        try:
            r = _session.get(BASE + path, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                last = TransitousError(f'Transitous antwortet mit {r.status_code}')
                time.sleep(0.5 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise TransitousError(f'Transitous antwortet mit {r.status_code}')
            data = r.json()
            if ttl:
                with _lock:
                    if len(_cache) > 500:
                        _cache.clear()
                    _cache[key] = (time.time() + ttl, data)
            return data
        except TransitousError:
            raise
        except (requests.RequestException, ValueError) as ex:
            last = TransitousError(f'Transitous nicht erreichbar: {ex.__class__.__name__}')
            time.sleep(0.4)
    raise last or TransitousError('Transitous nicht erreichbar')


def parse(ts):
    """'2026-10-22T18:48:00Z' -> naive local datetime."""
    if not ts:
        return None
    try:
        return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(TZ).replace(tzinfo=None)
    except ValueError:
        return None


def iso_utc(local_naive):
    return _localize(local_naive).astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def stop_id(app_id):
    s = (app_id or '').strip()
    return s[3:] if s.startswith('tr:') else s


def geocode(text, limit=10):
    data = _get('/geocode', {'text': text, 'language': 'de', 'type': 'STOP'}, ttl=3600) or []
    out = []
    for g in data:
        if g.get('type') != 'STOP' or not g.get('id'):
            continue
        STOP_INFO[g['id']] = {'name': g.get('name'), 'lat': g.get('lat'), 'lon': g.get('lon')}
        out.append({'id': 'tr:' + g['id'], 'name': g.get('name'), 'lat': g.get('lat'), 'lon': g.get('lon'),
                    'modes': g.get('modes') or []})
        if len(out) >= limit:
            break
    return out


def resolve(name):
    """Best stop for a free-text name (prefers matching city before the comma)."""
    if not name:
        return None
    cands = geocode(name, limit=8)
    if not cands:
        return None
    low = name.lower()
    for c in cands:
        if c['name'] and c['name'].lower() == low:
            return c
    city = name.split(',')[0].strip().lower() if ',' in name else None
    if city:
        for c in cands:
            if city in (c['name'] or '').lower():
                return c
    return cands[0]


def stoptimes(sid, when, duration_min=60, modes=None, max_pages=3):
    end = when + datetime.timedelta(minutes=duration_min)
    params = {'stopId': sid, 'time': iso_utc(when), 'n': 60}
    if modes:
        params['mode'] = ','.join(modes)
    out, seen = [], set()
    for _ in range(max_pages):
        data = _get('/stoptimes', params, ttl=20) or {}
        page = data.get('stopTimes') or []
        last = None
        for s in page:
            p = s.get('place') or {}
            planned = parse(p.get('scheduledDeparture') or p.get('departure'))
            key = (s.get('tripId'), p.get('scheduledDeparture'))
            if key in seen or planned is None:
                continue
            seen.add(key)
            last = planned
            if planned > end:
                continue
            out.append(s)
        if not page or last is None or last >= end or not data.get('nextPageCursor'):
            break
        params = {'stopId': sid, 'n': 60, 'pageCursor': data['nextPageCursor']}
        if modes:
            params['mode'] = ','.join(modes)
    return out


def plan(from_place, to_place, when, arrive=False, modes=None, max_transfers=None, min_transfer=None, cursor=None):
    params = {'fromPlace': from_place, 'toPlace': to_place, 'numItineraries': 6,
              'time': iso_utc(when), 'arriveBy': 'true' if arrive else 'false'}
    if modes:
        params['transitModes'] = ','.join(modes)
    if max_transfers is not None and max_transfers >= 0:
        params['maxTransfers'] = int(max_transfers)
    if min_transfer:
        params['additionalTransferTime'] = int(min_transfer)
    if cursor:
        params['pageCursor'] = cursor
    return _get('/plan', params, ttl=20, timeout=20)


def trip(trip_id):
    return _get('/trip', {'tripId': trip_id}, ttl=15)


def modes_for(app_modes):
    if not app_modes:
        return None
    out = []
    for m in app_modes:
        for x in MODE_MAP.get(m, []):
            if x not in out:
                out.append(x)
    return out or None


def label(obj):
    """Line label: 'U5', 'S7', '13', 'RE4', 'ICE 550'."""
    sn = (obj.get('routeShortName') or '').strip()
    if ' (' in sn:
        sn = sn.split(' (')[0].strip()       # 'RE1 (73748)' -> 'RE1'
    tn = (obj.get('tripShortName') or '').strip()
    dn = (obj.get('displayName') or '').strip()
    if sn and sn.isalpha() and tn and sn.upper() in ('ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'FLX', 'TGV', 'ES'):
        return f'{sn} {tn}'
    return sn or (dn.split(' (')[0] if dn else '') or tn or '?'


def color(obj):
    c = (obj.get('routeColor') or '').strip().lstrip('#')
    if len(c) == 6 and c.lower() not in ('ffffff', '000000'):
        return '#' + c
    return None
