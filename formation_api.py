"""Magdeburg Mobil – Wagenreihung: HTTP-Routen.

/api/formation, /api/formation/status, /api/formation/diag und die Routen für den
Wagenreihungs-Helfer daheim (/api/formation/agent/jobs, /api/formation/agent/result).
Die eigentliche Abfrage/Aufbereitung steckt in formation.py.
"""
import datetime
import os
import re
import threading
import time

import pytz
from flask import Blueprint, current_app, jsonify, request

import formation

bp = Blueprint('formation_api', __name__)
local_tz = pytz.timezone("Europe/Berlin")
_TRAIN_TYPES = ('regional', 'express', 'sbahn')


_fm_diag = {'at': 0, 'data': None}


@bp.route('/api/formation/diag')
def api_formation_diag():
    """Read-only check: do departures carry train numbers, and does bahn.de answer this server?"""
    if _fm_diag['data'] and time.time() - _fm_diag['at'] < 120:
        return jsonify(_fm_diag['data'])
    out = {'checkedAt': datetime.datetime.now(local_tz).strftime('%H:%M:%S'), 'trains': [], 'hosts': {}}
    try:
        with current_app.test_client() as c:
            deps = c.get('/api/departures?station_id=8010224&station_name=Magdeburg%20Hbf&duration=120').get_json() or []
        if isinstance(deps, dict):
            deps = []
        trains = [d for d in deps if d.get('type') in _TRAIN_TYPES]
        out['departures'] = len(deps)
        out['trainCount'] = len(trains)
        out['trains'] = [{k: d.get(k) for k in ('line', 'time', 'type', 'trainCat', 'trainNum', 'occupancy', 'src')} for d in trains[:8]]
        probe = next((d for d in trains if d.get('trainCat') and d.get('trainNum')), None)
        if probe:
            when = datetime.datetime.combine(datetime.datetime.now(local_tz).date() + datetime.timedelta(days=probe.get('day_offset') or 0),
                                             datetime.datetime.strptime(probe['time'], '%H:%M').time())
            utc = local_tz.localize(when).astimezone(datetime.timezone.utc)
            params = {'administrationId': 80, 'category': probe['trainCat'], 'date': utc.strftime('%Y-%m-%d'),
                      'evaNumber': '8010224', 'number': probe['trainNum'], 'time': utc.strftime('%Y-%m-%dT%H:%M:%S.000Z')}
            out['probe'] = {'train': f"{probe['trainCat']} {probe['trainNum']}", 'time': probe['time']}
            out['relayConfigured'] = bool(formation.RELAY_URL)
            for host, url, headers in formation.sources():
                try:
                    r = formation._session.get(url, params=params, headers=headers, timeout=10)
                    info = {'status': r.status_code, 'bytes': len(r.content)}
                    try:
                        j = r.json()
                        info['groups'] = len(j.get('groups') or []) if isinstance(j, dict) else None
                        info['keys'] = sorted(j.keys())[:12] if isinstance(j, dict) else None
                    except ValueError:
                        info['text'] = r.text[:120]
                    out['hosts'][host] = info
                except Exception as ex:
                    out['hosts'][host] = {'error': ex.__class__.__name__}
    except Exception as ex:
        out['error'] = f'{ex.__class__.__name__}: {ex}'[:200]
    _fm_diag.update(at=time.time(), data=out)
    return jsonify(out)


# ---- Wagenreihungs-Helfer (läuft bei dir zu Hause, holt die Daten über deinen Anschluss) ----
# bahn.de sperrt Rechenzentren. Ein kleines Programm auf einem Rechner mit normalem Internet
# (relay/wagenreihung_helfer.py) fragt hier nach offenen Aufträgen, holt die Wagenreihung bei
# bahn.de und schickt sie zurück. Kein offener Port nötig. Schlüssel: FORMATION_AGENT_KEY.
# own key, or simply the same password as the Cloudflare relay (FORMATION_RELAY_KEY)
_AGENT_KEY = (os.environ.get('FORMATION_AGENT_KEY') or os.environ.get('FORMATION_RELAY_KEY') or '').strip()
_agent = {'seen': 0.0}
_fm_jobs = {}            # key -> {'params':…, 'at': ts, 'taken': ts}
_fm_jobs_lock = threading.Lock()


def _agent_ok():
    import hmac
    key = request.headers.get('X-Agent-Key', '')
    return bool(_AGENT_KEY) and hmac.compare_digest(key, _AGENT_KEY)


def _agent_online():
    return bool(_AGENT_KEY) and time.time() - _agent['seen'] < 45


def _fm_enqueue(job_key, params):
    with _fm_jobs_lock:
        now = time.time()
        for k in [k for k, j in _fm_jobs.items() if now - j['at'] > 120]:
            _fm_jobs.pop(k, None)
        if job_key not in _fm_jobs and len(_fm_jobs) < 60:
            _fm_jobs[job_key] = {'params': params, 'at': now, 'taken': 0}
    _fm_new_job.set()                          # wake a waiting helper (long poll)


_fm_new_job = threading.Event()


def _take_jobs():
    out = []
    with _fm_jobs_lock:
        now = time.time()
        for k, j in list(_fm_jobs.items()):
            if now - j['at'] > 120:
                _fm_jobs.pop(k, None)
                continue
            if now - j['taken'] > 20:          # hand out again if the helper didn't answer
                j['taken'] = now
                out.append({'key': k, 'params': j['params']})
            if len(out) >= 6:
                break
    return out


@bp.route('/api/formation/agent/jobs')
def api_formation_agent_jobs():
    if not _agent_ok():
        return jsonify({'error': 'forbidden'}), 403
    _agent['seen'] = time.time()
    # ?wait=25: keep the request open until a job arrives (saves battery on a phone helper)
    try:
        wait = max(0.0, min(25.0, float(request.args.get('wait') or 0)))
    except ValueError:
        wait = 0.0
    out = _take_jobs()
    end = time.time() + wait
    while not out and time.time() < end:
        _fm_new_job.clear()
        out = _take_jobs()
        if out:
            break
        _fm_new_job.wait(min(5.0, max(0.05, end - time.time())))
        out = _take_jobs()
    _agent['seen'] = time.time()
    return jsonify({'jobs': out, 'path': formation.PATH, 'wait': True})


@bp.route('/api/formation/agent/result', methods=['POST'])
def api_formation_agent_result():
    if not _agent_ok():
        return jsonify({'error': 'forbidden'}), 403
    _agent['seen'] = time.time()
    body = request.get_json(silent=True) or {}
    k = str(body.get('key') or '')
    with _fm_jobs_lock:
        job = _fm_jobs.pop(k, None)
    if not job:
        return jsonify({'ok': False, 'reason': 'unknown job'})
    status = body.get('status')
    data = body.get('data')
    if isinstance(data, dict) and data.get('groups') and status == 200:
        formation.store(job['params'], data, True)
    elif status in (204, 404) or (status == 200 and not (isinstance(data, dict) and data.get('groups'))):
        formation.store(job['params'], None, False)
    return jsonify({'ok': True})


@bp.route('/api/formation/status')
def api_formation_status():
    """Is any Wagenreihung source usable right now? (home helper online, or this server reaches bahn.de)"""
    if _agent_online():
        online, via = True, 'helper'
    else:
        try:
            online = formation.reachable()
        except Exception as ex:
            print(f"[WARN] formation status: {ex}")
            online = False
        via = 'server' if online else None
    resp = jsonify({'online': online, 'via': via})
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@bp.route('/api/formation')
def api_formation():
    """Wagenreihung for one train departure: eva, cat, num, date (YYYY-MM-DD), time (HH:MM, planned)."""
    a = request.args
    eva = (a.get('eva') or '').strip()
    cat = (a.get('cat') or '').strip().upper()
    num = (a.get('num') or '').strip()
    if not re.fullmatch(r'\d{7}', eva) or cat not in formation.TRAIN_CATS or not re.fullmatch(r'\d{1,6}', num):
        return jsonify({'available': False, 'reason': 'invalid'}), 400
    try:
        when = datetime.datetime.strptime(f"{a.get('date')} {a.get('time')}", '%Y-%m-%d %H:%M')
    except (TypeError, ValueError):
        return jsonify({'available': False, 'reason': 'invalid'}), 400
    try:
        raw = formation.fetch(eva, cat, num, when)
    except formation.Blocked:
        if _agent_online():
            params = formation.params_for(eva, cat, num, when)
            _fm_enqueue(formation.cache_key(eva, cat, num, when), params)
            return jsonify({'available': False, 'pending': True})
        return jsonify({'available': False, 'blocked': True})
    except Exception as ex:
        print(f"[WARN] formation: {ex}")
        return jsonify({'available': False, 'reason': 'error'})
    data = formation.normalize(raw) if raw else None
    if not data:
        return jsonify({'available': False})
    resp = jsonify(data)
    resp.headers['Cache-Control'] = 'public, max-age=60'
    return resp
