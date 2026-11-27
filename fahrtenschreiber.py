"""
Magdeburg Mobil – Fahrtenschreiber
Unter /Fahrtenschreiber trägt man ein, welcher Wagen (Wagennummer, auch Doppeltraktion) zu welcher
Uhrzeit auf welcher Linie unterwegs war. HAFAS kennt keine Wagennummern – das hier ist Handarbeit.

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
        return jsonify({'lines': lines, 'today': _today().isoformat(), 'admin': bool(is_admin())})

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
        entry = {
            'id': uuid.uuid4().hex[:12],
            'date': day.isoformat(),
            'time': tm,
            'line': line,
            'type': _line_type(line),
            'vehicles': vehicles,
            'direction': clip(data.get('direction'), 80),
            'stop': clip(data.get('stop'), 80),
            'note': clip(data.get('note'), 240),
            'delay': data.get('delay') if isinstance(data.get('delay'), int) and -60 < data.get('delay') < 300 else None,
            'jid': clip(data.get('jid'), 120),
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
                r = out.setdefault(v, {'vehicle': v, 'count': 0, 'lines': {}, 'first': e['date'], 'last': None, 'with': {}})
                r['count'] += 1
                r['lines'][e['line']] = r['lines'].get(e['line'], 0) + 1
                r['last'] = {'date': e['date'], 'time': e['time'], 'line': e['line'], 'direction': e.get('direction', '')}
                for o in e.get('vehicles') or []:
                    if o != v:
                        r['with'][o] = r['with'].get(o, 0) + 1
        rows = sorted(out.values(), key=lambda r: (r['last']['date'], r['last']['time']), reverse=True)
        for r in rows:
            r['lines'] = sorted(r['lines'].items(), key=lambda kv: -kv[1])
            r['with'] = [k for k, _ in sorted(r['with'].items(), key=lambda kv: -kv[1])[:3]]
        return jsonify({'days': days, 'vehicles': rows})

    @app.route('/api/fts/export.csv')
    def fts_export():
        today = _today()
        d_to = _parse_day(request.args.get('to'), today) or today
        d_from = _parse_day(request.args.get('from'), today - datetime.timedelta(days=365)) or today - datetime.timedelta(days=365)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=';')
        w.writerow(['Datum', 'Uhrzeit', 'Linie', 'Wagen', 'Richtung', 'Halt', 'Verspätung (Min)', 'Notiz'])
        for e in sorted(_entries(d_from, d_to), key=lambda e: (e['date'], e['time'])):
            w.writerow([e['date'], e['time'], e['line'], '+'.join(e.get('vehicles') or []), e.get('direction', ''),
                        e.get('stop', ''), '' if e.get('delay') is None else e['delay'], e.get('note', '')])
        data = '﻿' + buf.getvalue()                 # BOM: Excel opens umlauts correctly
        return Response(data, mimetype='text/csv; charset=utf-8',
                        headers={'Content-Disposition': f'attachment; filename="fahrtenschreiber-{d_from}-{d_to}.csv"'})
