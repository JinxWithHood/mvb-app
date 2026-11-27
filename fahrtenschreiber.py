"""
Magdeburg Mobil – Fahrtenschreiber
Unter /Fahrtenschreiber trägt man ein, welcher Wagen (Wagennummer, auch Doppeltraktion) zu welcher
Uhrzeit auf welcher Linie unterwegs war. HAFAS kennt keine Wagennummern – das hier ist Handarbeit.

Ein Eintrag: Linie, Datum/Uhrzeit, Ort (Haltestelle), Kurs, Wagennummer(n), Richtung, Notiz.
Am Wochenende und an Feiertagen fährt ein anderer Takt mit anderen Kursen – deshalb bekommt jeder
Eintrag eine Tagesart (Werktag / Samstag / Sonn- & Feiertag) und gelernt wird nur innerhalb derselben:
  Fahrt (Linie + Richtung + Abfahrt am Starthalt) -> Kurs   (gilt jeden Tag derselben Tagesart)
  Kurs heute -> Wagen                                     (ein Wagen bleibt meist den ganzen Tag auf seinem Kurs)
So zeigt die Live-Karte bei einer Bahn „Wagen 1309 · Kurs 4/03“, sobald heute irgendwer den Kurs gemeldet hat.

Speicher: ein Dokument pro Monat (KV-Schlüssel fts:JJJJ-MM, dazu eine lokale Kopie).
Löschen darf nur das Gerät, das den Eintrag angelegt hat, oder der Admin.
"""
import csv
import datetime
import io
import json
import os
import re
import threading
import time
import uuid

from flask import Response, jsonify, request, send_from_directory

B = None                    # backend module (set in init)
_months = {}                # 'YYYY-MM' -> {'v': 1, 'entries': [...]}
_lock = threading.RLock()
_rate = {}                  # ip -> [timestamps]
KEEP_MONTHS = 24
MAX_PER_MINUTE = 20
VEHICLE_RE = re.compile(r'^[0-9]{2,5}[A-Za-z]?$')
KURS_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z/ .-]{0,9}$')
DAY_TYPES = {'wt': 'Werktag', 'sa': 'Samstag', 'so': 'Sonn- & Feiertag'}
# Fahrzeugtyp aus der Wagennummer (Bereich von–bis). Neue Baureihen hier ergänzen – alte Einträge
# werden automatisch mit eingeordnet, weil der Typ erst beim Auswerten bestimmt wird.
VEHICLE_TYPES = [
    (1301, 1399, 'NGT8D'),
    (1401, 1499, 'Flexity'),
]
OTHER_TYPE = 'andere'


def vehicle_type(num):
    m = re.match(r'^(\d+)', str(num or ''))
    if m:
        n = int(m.group(1))
        for lo, hi, name in VEHICLE_TYPES:
            if lo <= n <= hi:
                return name
    return OTHER_TYPE


def composition(vehicles):
    """'Flexity', 'NGT8D' – or 'gemischt' when a coupled set has different types."""
    types = {vehicle_type(v) for v in vehicles or []}
    return types.pop() if len(types) == 1 else ('gemischt' if types else OTHER_TYPE)
_live_cache = {'ts': 0.0, 'data': None}


def _easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    day = (h + l_ - 7 * m + 114) % 31 + 1
    return datetime.date(y, month, day)


def holidays(y):
    """Gesetzliche Feiertage in Sachsen-Anhalt."""
    e = _easter(y)
    td = datetime.timedelta
    return {datetime.date(y, 1, 1), datetime.date(y, 1, 6), e - td(days=2), e + td(days=1), datetime.date(y, 5, 1),
            e + td(days=39), e + td(days=50), datetime.date(y, 10, 3), datetime.date(y, 10, 31),
            datetime.date(y, 12, 25), datetime.date(y, 12, 26)}


def day_type(d):
    """wt (Mo–Fr) · sa (Samstag, auch 24./31.12.) · so (Sonntag und Feiertag)."""
    if d.weekday() == 6 or d in holidays(d.year):
        return 'so'
    if d.weekday() == 5 or (d.month == 12 and d.day in (24, 31)):
        return 'sa'
    return 'wt'


def _norm_kurs(k):
    k = re.sub(r'\s+', ' ', str(k or '')).strip()
    return k if KURS_RE.match(k) else ''


def _norm_dir(x):
    return re.sub(r'^magdeburg,?\s*', '', re.sub(r'\s+', ' ', str(x or '')).strip().lower())
LINE_RE = re.compile(r'^(?:N ?)?[0-9]{1,3}[A-Za-z]?$|^SEV ?[0-9A-Za-z]{0,4}$', re.I)


def _dir():
    d = os.path.join(B.CACHE_DIR, 'fahrtenschreiber')
    os.makedirs(d, exist_ok=True)
    return d


def _month(name, create=False):
    with _lock:
        doc = _months.get(name)
        if doc is None:
            doc = B._kv_get(f'fts:{name}')
            if not doc:
                path = os.path.join(_dir(), f'{name}.json')
                if os.path.exists(path):
                    try:
                        with open(path, 'r', encoding='utf-8') as f:
                            doc = json.load(f)
                    except Exception:
                        doc = None
            if not isinstance(doc, dict) or not isinstance(doc.get('entries'), list):
                doc = {'v': 1, 'entries': []} if create else None
            if doc is not None:
                _months[name] = doc
        return doc


def _save(name):
    doc = _months.get(name)
    if doc is None:
        return
    path = os.path.join(_dir(), f'{name}.json')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, path)
    B._kv_set(f'fts:{name}', doc)


def _months_between(d_from, d_to):
    y, m = d_from.year, d_from.month
    while (y, m) <= (d_to.year, d_to.month):
        yield f'{y:04d}-{m:02d}'
        m += 1
        if m > 12:
            y, m = y + 1, 1


def _today():
    return datetime.datetime.now(B.local_tz).date()


def _norm_line(x):
    x = re.sub(r'\s+', '', str(x or '')).upper()
    x = re.sub(r'^(STR|TRAM|BUS|LINIE)', '', x)
    return x


def _line_type(line):
    if line.startswith('N'):
        return 'night'
    if line.startswith('SEV'):
        return 'sev'
    n = int(re.sub(r'\D', '', line) or 0)
    return 'tram' if 1 <= n <= 39 else 'bus'


def _rate_ok(ip):
    now = time.time()
    hits = [t for t in _rate.get(ip, []) if now - t < 60]
    if len(hits) >= MAX_PER_MINUTE:
        _rate[ip] = hits
        return False
    hits.append(now)
    _rate[ip] = hits
    return True


def _device():
    d = (request.headers.get('X-Device') or '').strip()
    return d if re.fullmatch(r'[A-Za-z0-9_-]{8,64}', d) else ''


def _public(e, device, admin):
    out = {k: v for k, v in e.items() if k != 'dev'}
    out['types'] = [vehicle_type(v) for v in e.get('vehicles') or []]
    out['mine'] = bool(admin or (device and e.get('dev') == device))
    return out


def _entries(d_from, d_to):
    out = []
    for name in _months_between(d_from, d_to):
        doc = _month(name)
        if not doc:
            continue
        for e in doc['entries']:
            day = e.get('date') or ''
            if d_from.isoformat() <= day <= d_to.isoformat():
                out.append(e)
    out.sort(key=lambda e: (e.get('date', ''), e.get('time', '')), reverse=True)
    return out


def _parse_day(s, default):
    try:
        return datetime.date.fromisoformat(s) if s else default
    except ValueError:
        return None


def order_along(stops, shapes):
    """Stop names sorted by their position along the longest shape (one direction of the line)."""
    def d2(a, b):
        return (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * 0.615) ** 2
    if not shapes:
        return sorted(stops, key=str.lower)
    main = max(shapes, key=len)
    cum = [0.0]
    for a, b in zip(main, main[1:]):
        cum.append(cum[-1] + d2(a, b) ** 0.5)
    pos = {}
    for nm, ll in stops.items():
        try:
            i = min(range(len(main)), key=lambda k: d2(main[k], ll))
            pos[nm] = cum[i]
        except (TypeError, IndexError):
            pos[nm] = float('inf')
    return sorted(stops, key=lambda n: (pos[n], n.lower()))


def guess_live(vehicles, today, now_hm=None):
    """{vehicle id: {'vehicles': [...], 'kurs': str, 'sure': bool, 'seen': 'HH:MM', 'stop': str}}"""
    dt = day_type(today)
    now_hm = now_hm or datetime.datetime.now(B.local_tz).strftime('%H:%M')
    recent = _entries(today - datetime.timedelta(days=180), today)
    today_list = [e for e in recent if e['date'] == today.isoformat() and e['time'] <= now_hm]   # newest first
    # timetable trip -> Kurs, learned from earlier reports of the same day type
    trip_kurs = {}
    for e in recent:
        if e.get('kurs') and e.get('start') and (e.get('dayType') or day_type(datetime.date.fromisoformat(e['date']))) == dt:
            sig = (e['line'], _norm_dir(e.get('direction')), e['start'])
            c = trip_kurs.setdefault(sig, {})
            c[e['kurs']] = c.get(e['kurs'], 0) + 1
    out = {}
    for v in vehicles:
        if v.get('type') not in ('tram', 'bus', 'sev') or not v.get('id'):
            continue
        line = _norm_line(v.get('short') or v.get('line'))
        direct = next((e for e in today_list if e.get('jid') and e['jid'] == v['id']), None)
        kurs = direct.get('kurs') if direct else ''
        if not kurs and v.get('start'):
            c = trip_kurs.get((line, _norm_dir(v.get('direction')), v['start']))
            if c:
                kurs = max(c.items(), key=lambda kv: kv[1])[0]
        if direct:
            out[v['id']] = {'vehicles': direct['vehicles'], 'type': composition(direct['vehicles']), 'kurs': kurs, 'sure': True,
                            'seen': direct['time'], 'stop': direct.get('stop', '')}
            continue
        if kurs:
            same = next((e for e in today_list if e['line'] == line and e.get('kurs') == kurs), None)
            out[v['id']] = {'vehicles': same['vehicles'] if same else [], 'type': composition(same['vehicles']) if same else '',
                            'kurs': kurs, 'sure': False,
                            'seen': same['time'] if same else '', 'stop': same.get('stop', '') if same else ''}
    return out


def init(app, backend_module):
    global B
    B = backend_module
    try:
        import admin as _admin
        is_admin = _admin.is_admin
    except Exception:            # pragma: no cover
        def is_admin():
            return False

    @app.route('/Fahrtenschreiber')
    @app.route('/fahrtenschreiber')
    @app.route('/FAHRTENSCHREIBER')
    def fts_page():
        resp = send_from_directory(B.PUBLIC_DIR, 'fahrtenschreiber.html')
        resp.headers['Cache-Control'] = 'no-cache'
        return resp

    @app.route('/api/fts/meta')
    def fts_meta():
        lines = []
        for k, c in B.LINE_COLORS.items():
            if re.fullmatch(r'N?\d{1,3}', k):
                lines.append({'line': k, 'color': c, 'type': _line_type(k)})
        lines.sort(key=lambda l: ({'tram': 0, 'night': 1, 'bus': 2, 'sev': 3}[l['type']], int(re.sub(r'\D', '', l['line']) or 0)))
        today = _today()
        return jsonify({'lines': lines, 'today': today.isoformat(), 'dayType': day_type(today), 'dayTypes': DAY_TYPES,
                        'admin': bool(is_admin())})

    @app.route('/api/fts/daytype')
    def fts_daytype():
        d = _parse_day(request.args.get('date'), _today())
        if not d:
            return jsonify({'error': 'Datum ungültig'}), 400
        t = day_type(d)
        return jsonify({'date': d.isoformat(), 'dayType': t, 'label': DAY_TYPES[t], 'holiday': d in holidays(d.year)})

    @app.route('/api/fts/stops')
    def fts_stops():
        """Halte einer Linie in Fahrtreihenfolge (entlang ihres längsten Linienwegs) für die Ort-Suche."""
        line = _norm_line(request.args.get('line'))
        if not line:
            return jsonify({'line': '', 'stops': []})
        stops, shapes = {}, []
        try:
            B._load_line_shapes()
            for key, e in list(B._line_shapes['lines'].items()):
                if key.split(':', 1)[-1].upper() == line:
                    for nm, ll in (e.get('stops') or {}).items():
                        stops.setdefault(re.sub(r'^Magdeburg,\s*', '', str(nm)), ll)
                    shapes += [s_.get('pts') for s_ in (e.get('shapes') or {}).values() if s_.get('pts')]
        except Exception:
            pass
        return jsonify({'line': line, 'stops': order_along(stops, shapes)})

    @app.route('/api/fts/courses')
    def fts_courses():
        """Kurse einer Linie je Tagesart: welche Fahrten gehören dazu, welche Wagen fuhren ihn."""
        line = _norm_line(request.args.get('line'))
        dt = request.args.get('dayType') or ''
        today = _today()
        d_to = _parse_day(request.args.get('to'), today) or today
        d_from = _parse_day(request.args.get('from'), d_to - datetime.timedelta(days=365)) or d_to - datetime.timedelta(days=365)
        d_from = max(d_from, d_to - datetime.timedelta(days=370))
        items = [e for e in _entries(d_from, d_to) if e.get('kurs')]
        if line:
            items = [e for e in items if e.get('line') == line]
        if dt in DAY_TYPES:
            items = [e for e in items if e.get('dayType') == dt]
        out = {}
        for e in reversed(items):
            k = (e['line'], e.get('dayType') or 'wt', e['kurs'])
            r = out.setdefault(k, {'line': k[0], 'dayType': k[1], 'kurs': k[2], 'count': 0, 'vehicles': {}, 'trips': {}, 'times': [],
                                   'last': None})
            r['count'] += 1
            for v in e.get('vehicles') or []:
                r['vehicles'][v] = r['vehicles'].get(v, 0) + 1
            r.setdefault('types', {})
            comp = composition(e.get('vehicles'))
            r['types'][comp] = r['types'].get(comp, 0) + 1
            if e.get('start'):
                sig = f"{e['start']} {e.get('origin') or ''} → {e.get('direction') or ''}".strip()
                r['trips'][sig] = r['trips'].get(sig, 0) + 1
            r['times'].append(e['time'])
            r['last'] = {'date': e['date'], 'time': e['time'], 'vehicles': e.get('vehicles') or [], 'stop': e.get('stop', '')}
        rows = []
        for r in out.values():
            ts = sorted(r.pop('times'))
            r['span'] = [ts[0], ts[-1]] if ts else None
            r['vehicles'] = [[v, n, vehicle_type(v)] for v, n in sorted(r['vehicles'].items(), key=lambda kv: -kv[1])[:6]]
            r['types'] = sorted((r.get('types') or {}).items(), key=lambda kv: -kv[1])
            r['trips'] = sorted(r['trips'].items())[:40]
            rows.append(r)
        rows.sort(key=lambda r: (r['line'].zfill(4), r['dayType'], r['kurs'].zfill(8)))
        return jsonify({'courses': rows, 'from': d_from.isoformat(), 'to': d_to.isoformat(), 'dayTypes': DAY_TYPES})

    @app.route('/api/fts/live')
    def fts_live():
        """Für die Live-Karte: Wagen/Kurs der Fahrzeuge, die gerade unterwegs sind (soweit gemeldet)."""
        now = time.time()
        if _live_cache['data'] is not None and now - _live_cache['ts'] < 45:
            return jsonify(_live_cache['data'])
        try:
            with app.test_request_context('/api/radar'):
                resp = B.get_radar()
            radar = resp.get_json() if not isinstance(resp, tuple) else {}
        except Exception:
            radar = {}
        data = {'vehicles': guess_live((radar or {}).get('vehicles') or [], _today()), 'ts': int(now * 1000)}
        _live_cache.update(ts=now, data=data)
        return jsonify(data)

    @app.route('/api/fts/entries', methods=['GET'])
    def fts_list():
        today = _today()
        d_to = _parse_day(request.args.get('to'), today)
        d_from = _parse_day(request.args.get('from'), (d_to or today) - datetime.timedelta(days=6))
        if not d_from or not d_to:
            return jsonify({'error': 'Datum ungültig (JJJJ-MM-TT)'}), 400
        if d_from > d_to:
            d_from, d_to = d_to, d_from
        d_from = max(d_from, d_to - datetime.timedelta(days=370))
        line = _norm_line(request.args.get('line'))
        veh = re.sub(r'\s+', '', request.args.get('vehicle') or '')
        items = _entries(d_from, d_to)
        if line:
            items = [e for e in items if e.get('line') == line]
        if veh:
            items = [e for e in items if any(v.startswith(veh) for v in e.get('vehicles') or [])]
        dev, adm = _device(), bool(is_admin())
        resp = jsonify({'from': d_from.isoformat(), 'to': d_to.isoformat(), 'count': len(items),
                        'entries': [_public(e, dev, adm) for e in items[:2000]]})
        resp.headers['Cache-Control'] = 'no-store'
        return resp

    @app.route('/api/fts/entries', methods=['POST'])
    def fts_add():
        ip = (request.headers.get('X-Forwarded-For') or request.remote_addr or '').split(',')[0].strip()
        if not _rate_ok(ip):
            return jsonify({'error': 'Zu viele Einträge auf einmal – kurz warten.'}), 429
        data = request.get_json(silent=True) or {}
        line = _norm_line(data.get('line'))
        if not LINE_RE.match(line):
            return jsonify({'error': 'Linie fehlt oder ist ungültig.'}), 400
        vehicles = []
        for v in data.get('vehicles') or []:
            v = re.sub(r'\s+', '', str(v))
            if not v:
                continue
            if not VEHICLE_RE.match(v):
                return jsonify({'error': f'Wagennummer „{v[:12]}“ sieht nicht richtig aus (nur Ziffern, z. B. 1309).'}), 400
            if v not in vehicles:
                vehicles.append(v)
        if not vehicles:
            return jsonify({'error': 'Mindestens eine Wagennummer eintragen.'}), 400
        if len(vehicles) > 4:
            return jsonify({'error': 'Höchstens 4 Wagen pro Fahrt.'}), 400
        day = _parse_day(data.get('date'), None)
        tm = str(data.get('time') or '')
        if not day or not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', tm):
            return jsonify({'error': 'Datum oder Uhrzeit fehlt.'}), 400
        today = _today()
        if day > today + datetime.timedelta(days=1) or day < today - datetime.timedelta(days=366):
            return jsonify({'error': 'Datum liegt außerhalb des letzten Jahres.'}), 400
        clip = lambda x, n: re.sub(r'\s+', ' ', str(x or '')).strip()[:n]
        kurs_raw = clip(data.get('kurs'), 12)
        kurs = _norm_kurs(kurs_raw)
        if kurs_raw and not kurs:
            return jsonify({'error': 'Kurs sieht nicht richtig aus (z. B. 403 oder 4/03).'}), 400
        start = str(data.get('start') or '')
        start = start if re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', start) else ''
        entry = {
            'id': uuid.uuid4().hex[:12],
            'date': day.isoformat(),
            'time': tm,
            'dayType': day_type(day),
            'line': line,
            'type': _line_type(line),
            'kurs': kurs,
            'vehicles': vehicles,
            'direction': clip(data.get('direction'), 80),
            'stop': clip(data.get('stop'), 80),
            'note': clip(data.get('note'), 240),
            'delay': data.get('delay') if isinstance(data.get('delay'), int) and -60 < data.get('delay') < 300 else None,
            'jid': clip(data.get('jid'), 120),
            'start': start,
            'origin': clip(data.get('origin'), 80),
            'created': int(time.time()),
            'dev': _device(),
        }
        name = day.strftime('%Y-%m')
        with _lock:
            doc = _month(name, create=True)
            doc['entries'].append(entry)
            _save(name)
        return jsonify({'ok': True, 'entry': _public(entry, entry['dev'], False)}), 201

    @app.route('/api/fts/entries/<eid>', methods=['DELETE'])
    def fts_delete(eid):
        month = request.args.get('month') or ''
        if not re.fullmatch(r'\d{4}-\d{2}', month):
            return jsonify({'error': 'Monat fehlt.'}), 400
        dev, adm = _device(), bool(is_admin())
        with _lock:
            doc = _month(month)
            if not doc:
                return jsonify({'error': 'Eintrag nicht gefunden.'}), 404
            for i, e in enumerate(doc['entries']):
                if e.get('id') == eid:
                    if not (adm or (dev and e.get('dev') == dev)):
                        return jsonify({'error': 'Nur auf dem Gerät löschbar, auf dem der Eintrag gemacht wurde.'}), 403
                    del doc['entries'][i]
                    _save(month)
                    return jsonify({'ok': True})
        return jsonify({'error': 'Eintrag nicht gefunden.'}), 404

    @app.route('/api/fts/vehicles')
    def fts_vehicles():
        """Per Wagen: wie oft gesehen, zuletzt wo, auf welchen Linien."""
        today = _today()
        days = 365 if request.args.get('range') == 'year' else 90
        items = _entries(today - datetime.timedelta(days=days), today)
        out = {}
        for e in reversed(items):                       # oldest first, so "last" ends up newest
            for v in e.get('vehicles') or []:
                r = out.setdefault(v, {'vehicle': v, 'type': vehicle_type(v), 'count': 0, 'lines': {}, 'first': e['date'], 'last': None, 'with': {}})
                r['count'] += 1
                r['lines'][e['line']] = r['lines'].get(e['line'], 0) + 1
                r['last'] = {'date': e['date'], 'time': e['time'], 'line': e['line'], 'direction': e.get('direction', ''),
                             'kurs': e.get('kurs', ''), 'stop': e.get('stop', '')}
                for o in e.get('vehicles') or []:
                    if o != v:
                        r['with'][o] = r['with'].get(o, 0) + 1
        rows = sorted(out.values(), key=lambda r: (r['last']['date'], r['last']['time']), reverse=True)
        for r in rows:
            r['lines'] = sorted(r['lines'].items(), key=lambda kv: -kv[1])
            r['with'] = [k for k, _ in sorted(r['with'].items(), key=lambda kv: -kv[1])[:3]]
        return jsonify({'days': days, 'vehicles': rows})

    @app.route('/api/fts/analysis')
    def fts_analysis():
        """Wo fährt was: Fahrzeugtypen je Linie (Anteil der gemeldeten Fahrten), Doppeltraktionen, Tagesarten."""
        today = _today()
        days = {'30': 30, '90': 90, 'year': 365}.get(request.args.get('range') or '90', 90)
        dt = request.args.get('dayType') or ''
        items = _entries(today - datetime.timedelta(days=days - 1), today)
        if dt in DAY_TYPES:
            items = [e for e in items if (e.get('dayType') or day_type(datetime.date.fromisoformat(e['date']))) == dt]
        names = [t[2] for t in VEHICLE_TYPES] + ['gemischt', OTHER_TYPE]
        total = {n: 0 for n in names}
        lines, by_type, hours = {}, {n: {} for n in names}, {n: [0] * 24 for n in names}
        doubles = 0
        for e in items:
            comp = composition(e.get('vehicles'))
            total[comp] += 1
            dbl = len(e.get('vehicles') or []) > 1
            doubles += dbl
            r = lines.setdefault(e['line'], {'line': e['line'], 'type': e.get('type') or _line_type(e['line']), 'n': 0,
                                             'types': {n: 0 for n in names}, 'double': 0, 'vehicles': set()})
            r['n'] += 1
            r['types'][comp] += 1
            r['double'] += dbl
            r['vehicles'].update(e.get('vehicles') or [])
            by_type[comp][e['line']] = by_type[comp].get(e['line'], 0) + 1
            try:
                hours[comp][int(e['time'][:2])] += 1
            except (ValueError, KeyError):
                pass
        rows = []
        for r in lines.values():
            r['vehicles'] = len(r['vehicles'])
            rows.append(r)
        rows.sort(key=lambda r: ({'tram': 0, 'night': 1, 'sev': 2, 'bus': 3}.get(r['type'], 4), int(re.sub(r'\D', '', r['line']) or 0)))
        fleet = {}
        for e in items:
            for v in e.get('vehicles') or []:
                fleet.setdefault(vehicle_type(v), set()).add(v)
        return jsonify({'days': days, 'dayType': dt if dt in DAY_TYPES else '', 'n': len(items), 'double': doubles,
                        'types': names, 'ranges': [{'from': lo, 'to': hi, 'type': t} for lo, hi, t in VEHICLE_TYPES],
                        'total': total, 'lines': rows,
                        'byType': {n: sorted(v.items(), key=lambda kv: -kv[1]) for n, v in by_type.items()},
                        'hours': hours, 'fleet': {k: len(v) for k, v in fleet.items()}})

    @app.route('/api/fts/export.csv')
    def fts_export():
        today = _today()
        d_to = _parse_day(request.args.get('to'), today) or today
        d_from = _parse_day(request.args.get('from'), today - datetime.timedelta(days=365)) or today - datetime.timedelta(days=365)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=';')
        w.writerow(['Datum', 'Tagesart', 'Uhrzeit', 'Linie', 'Kurs', 'Wagen', 'Typ', 'Ort', 'Richtung', 'Start der Fahrt',
                    'Verspätung (Min)', 'Notiz'])
        for e in sorted(_entries(d_from, d_to), key=lambda e: (e['date'], e['time'])):
            dt = e.get('dayType') or day_type(datetime.date.fromisoformat(e['date']))
            w.writerow([e['date'], DAY_TYPES.get(dt, dt), e['time'], e['line'], e.get('kurs', ''), '+'.join(e.get('vehicles') or []),
                        composition(e.get('vehicles')),
                        e.get('stop', ''), e.get('direction', ''), f"{e.get('start', '')} {e.get('origin', '')}".strip(),
                        '' if e.get('delay') is None else e['delay'], e.get('note', '')])
        data = '﻿' + buf.getvalue()                 # BOM: Excel opens umlauts correctly
        return Response(data, mimetype='text/csv; charset=utf-8',
                        headers={'Content-Disposition': f'attachment; filename="fahrtenschreiber-{d_from}-{d_to}.csv"'})
