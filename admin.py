"""
Magdeburg Mobil – Admin-Bereich
- Login unter einer geheimen Adresse (Benutzer + Passwort aus Render-Umgebungsvariablen)
- Push-Nachrichten an alle / Linien / einzelne Geräte
- Wartungsmodus (Hinweis-Banner oder komplette Sperre) mit Auto-Ende
- Übersicht: Geräte, Laufzeit, Wachhalter, Speicher

Umgebungsvariablen (bei Render → Environment):
  ADMIN_PASSWORD   Pflicht – ohne Passwort ist der Login gesperrt
  ADMIN_USER       optional, Standard "melvinjwh"
  ADMIN_SECRET     optional, Schlüssel für das Sitzungs-Cookie (sonst aus dem Passwort abgeleitet)
"""
import datetime
import hashlib
import hmac
import os
import secrets
import threading
import time
import uuid

from flask import abort, jsonify, redirect, request, send_file, session

LOGIN_PATH = '/admin/panel/login/22102626022006-2000'
PANEL_PATH = '/admin/panel'
HERE = os.path.dirname(os.path.abspath(__file__))
SESSION_HOURS = 12
MAX_FAILS = 5
LOCK_MINUTES = 15

B = None  # backend module (set in init)
_state = {'loaded': False, 'maintenance': None, 'history': []}
_lock = threading.RLock()
_fails = {}          # ip -> {'n': int, 'first': ts, 'until': ts}
_last_broadcast = {'ts': 0.0}


# ---------------------------------------------------------------------------
# credentials & session
# ---------------------------------------------------------------------------
def _admin_user():
    return (os.environ.get('ADMIN_USER') or 'melvinjwh').strip()


def _admin_password():
    return (os.environ.get('ADMIN_PASSWORD') or os.environ.get('ADMIN_TOKEN') or '').strip()


def _secret_key():
    explicit = (os.environ.get('ADMIN_SECRET') or '').strip()
    if explicit:
        return explicit
    pw = _admin_password()
    if pw:
        # stable across restarts, changes automatically when the password changes
        return hmac.new(pw.encode(), b'mvb-admin-session-v1', hashlib.sha256).hexdigest()
    return secrets.token_hex(32)


def _client_ip():
    fwd = request.headers.get('X-Forwarded-For', '')
    return (fwd.split(',')[0].strip() if fwd else request.remote_addr) or '?'


def is_admin():
    try:
        if not session.get('admin'):
            return False
        if time.time() - float(session.get('since', 0)) > SESSION_HOURS * 3600:
            session.clear()
            return False
        # a password change invalidates old sessions
        return session.get('pwv') == _pw_version()
    except Exception:
        return False


def _pw_version():
    return hashlib.sha256(('v1:' + _admin_password()).encode()).hexdigest()[:12]


def _require_admin(json_api=True):
    if not is_admin():
        if json_api:
            return jsonify({'error': 'Nicht angemeldet'}), 401
        abort(404)
    if request.method == 'POST':
        sent = request.headers.get('X-CSRF-Token', '')
        if not sent or not hmac.compare_digest(sent, session.get('csrf', '')):
            return jsonify({'error': 'Sitzung abgelaufen – bitte neu laden'}), 403
    return None


# ---------------------------------------------------------------------------
# persistent state (maintenance + history), stored like the push data
# ---------------------------------------------------------------------------
def _state_file():
    return os.path.join(B.CACHE_DIR, 'admin_state.json')


def _load_state():
    with _lock:
        if _state['loaded']:
            return
        data = B._load_json_file(_state_file(), {}) or {}
        _state['maintenance'] = data.get('maintenance') or {'mode': 'off'}
        _state['history'] = data.get('history') or []
        _state['loaded'] = True


def _save_state():
    B._save_json_file(_state_file(), {'maintenance': _state['maintenance'], 'history': _state['history'][-30:]})


def maintenance():
    _load_state()
    m = dict(_state['maintenance'] or {'mode': 'off'})
    ends = m.get('endsAt')
    if m.get('mode') in ('banner', 'lock') and ends and time.time() >= float(ends):
        with _lock:
            _state['maintenance'] = {'mode': 'off', 'endedAt': time.time(), 'auto': True}
            _save_state()
        m = dict(_state['maintenance'])
    return m


# ---------------------------------------------------------------------------
# push broadcast
# ---------------------------------------------------------------------------
def _norm_line(x):
    import re
    m = re.search(r'\d{1,3}', str(x or ''))
    return m.group(0) if m else None


def _targets(target, lines, device_key, endpoint):
    subs = B._subs()
    if target == 'device':
        if endpoint:
            key = B._sub_key(endpoint)
            return [(key, subs[key])] if key in subs else []
        if device_key and device_key in subs:
            return [(device_key, subs[device_key])]
        return []
    if target == 'lines':
        want = {l for l in (_norm_line(x) for x in lines or []) if l}
        out = []
        for k, s in subs.items():
            fav = set((s.get('prefs') or {}).get('lines') or [])
            if want & fav:
                out.append((k, s))
        return out
    return list(subs.items())


def _broadcast(payload, targets, urgent):
    res = {'sent': 0, 'failed': 0, 'removed': 0, 'quiet': 0}
    gone = []
    for key, sub in targets:
        if not urgent and B._in_quiet_hours(sub.get('prefs') or {}):
            res['quiet'] += 1
            continue
        ok = B._send_push(sub, payload, ttl=6 * 3600 if not urgent else 24 * 3600,
                          urgency='high' if urgent else 'normal')
        if ok is None:
            gone.append(key)
            res['removed'] += 1
        elif ok:
            res['sent'] += 1
        else:
            res['failed'] += 1
    for key in gone:
        B._drop_sub(key)
    return res


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
def init(app, backend_module):
    global B
    B = backend_module
    app.secret_key = app.secret_key or _secret_key()
    on_render = bool(os.environ.get('RENDER') or os.environ.get('RENDER_SERVICE_ID'))
    app.config.update(
        SESSION_COOKIE_NAME='mvb_admin',
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict',
        SESSION_COOKIE_SECURE=on_render,
        PERMANENT_SESSION_LIFETIME=datetime.timedelta(hours=SESSION_HOURS),
    )
    B._KV_NAMES[_state_file()] = 'admin_state'

    @app.after_request
    def _admin_headers(resp):
        if request.path.startswith('/admin'):
            resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
            resp.headers['X-Frame-Options'] = 'DENY'
            resp.headers['Referrer-Policy'] = 'no-referrer'
            resp.headers['Cache-Control'] = 'no-store'
        return resp

    # ---- login ----
    @app.route(LOGIN_PATH, methods=['GET'])
    def admin_login_page():
        if is_admin():
            return redirect(PANEL_PATH)
        return send_file(os.path.join(HERE, 'admin_login.html'), mimetype='text/html', max_age=0)

    @app.route(LOGIN_PATH, methods=['POST'])
    def admin_login():
        ip = _client_ip()
        now = time.time()
        f = _fails.get(ip)
        if f and f.get('until', 0) > now:
            mins = int((f['until'] - now) // 60) + 1
            return jsonify({'error': f'Zu viele Fehlversuche. Bitte in {mins} Min. nochmal.'}), 429
        pw = _admin_password()
        if not pw:
            return jsonify({'error': 'Admin-Passwort ist noch nicht gesetzt (ADMIN_PASSWORD bei Render eintragen).'}), 503
        data = request.get_json(silent=True) or {}
        user_ok = hmac.compare_digest(str(data.get('user', '')).strip().encode(), _admin_user().encode())
        pw_ok = hmac.compare_digest(str(data.get('password', '')).encode(), pw.encode())
        if not (user_ok and pw_ok):
            if not f or now - f.get('first', 0) > LOCK_MINUTES * 60:
                f = {'n': 0, 'first': now}
            f['n'] += 1
            if f['n'] >= MAX_FAILS:
                f['until'] = now + LOCK_MINUTES * 60
            _fails[ip] = f
            if len(_fails) > 500:
                for k in [k for k, v in _fails.items() if now - v.get('first', 0) > 3600][:300]:
                    _fails.pop(k, None)
            time.sleep(0.6)
            left = max(0, MAX_FAILS - f['n'])
            return jsonify({'error': 'Benutzername oder Passwort falsch.' + (f' Noch {left} Versuche.' if left else '')}), 401
        _fails.pop(ip, None)
        session.clear()
        session.permanent = True
        session['admin'] = True
        session['since'] = now
        session['pwv'] = _pw_version()
        session['csrf'] = secrets.token_urlsafe(24)
        return jsonify({'ok': True, 'next': PANEL_PATH})

    @app.route(PANEL_PATH + '/logout', methods=['POST'])
    def admin_logout():
        session.clear()
        return jsonify({'ok': True})

    # ---- panel ----
    @app.route(PANEL_PATH, methods=['GET'])
    @app.route(PANEL_PATH + '/', methods=['GET'])
    def admin_panel():
        if not is_admin():
            abort(404)
        return send_file(os.path.join(HERE, 'admin_panel.html'), mimetype='text/html', max_age=0)

    @app.route('/api/admin/overview')
    def admin_overview():
        err = _require_admin()
        if err:
            return err
        subs = B._subs()
        now = time.time()
        devices = []
        for k, s in subs.items():
            prefs = s.get('prefs') or {}
            devices.append({
                'key': k, 'ua': _short_ua(s.get('ua', '')),
                'created': s.get('created'), 'seen': s.get('seen'),
                'lines': prefs.get('lines') or [], 'quiet': prefs.get('quiet'),
                'disruptions': prefs.get('disruptions', True),
                'reminders': len(s.get('reminders') or []),
            })
        devices.sort(key=lambda d: d.get('seen') or 0, reverse=True)
        ticks = list(B._tick_log)
        return jsonify({
            'csrf': session.get('csrf'),
            'user': _admin_user(),
            'server': {
                'uptimeMin': round((now - B._BOOT_TS) / 60, 1),
                'storage': 'upstash' if B._kv_enabled() else 'temporär',
                'lastPingMinAgo': round((now - ticks[-1][0]) / 60, 1) if ticks else None,
                'pings': len(ticks),
                'pushAvailable': bool(B.PUSH_AVAILABLE),
            },
            'devices': devices,
            'maintenance': maintenance(),
            'history': list(reversed(_state['history'][-20:])),
            'cooldown': max(0, int(60 - (now - _last_broadcast['ts']))),
        })

    @app.route('/api/admin/push', methods=['POST'])
    def admin_push():
        err = _require_admin()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        title = str(data.get('title', '')).strip()[:80]
        body = str(data.get('body', '')).strip()[:300]
        if not title or not body:
            return jsonify({'error': 'Titel und Text fehlen'}), 400
        url = str(data.get('url') or '/').strip()[:200]
        if not url.startswith('/'):
            url = '/'
        target = data.get('target') if data.get('target') in ('all', 'lines', 'device') else 'all'
        urgent = bool(data.get('urgent'))
        now = time.time()
        if target != 'device' and now - _last_broadcast['ts'] < 60:
            return jsonify({'error': f"Kurz durchatmen 😄 Nächste Rundnachricht in {int(60 - (now - _last_broadcast['ts']))} s."}), 429
        targets = _targets(target, data.get('lines') or [], data.get('deviceKey'), data.get('endpoint'))
        if not targets:
            return jsonify({'error': 'Kein passendes Gerät gefunden'}), 404
        payload = {'title': title, 'body': body, 'url': url, 'tag': 'admin-' + uuid.uuid4().hex[:6],
                   'kind': 'admin', 'requireInteraction': urgent}
        res = _broadcast(payload, targets, urgent)
        if target != 'device':
            _last_broadcast['ts'] = now
        _load_state()
        with _lock:
            _state['history'].append({'ts': now, 'title': title, 'body': body, 'url': url, 'target': target,
                                      'lines': data.get('lines') or [], 'urgent': urgent, **res})
            _state['history'] = _state['history'][-30:]
            _save_state()
        return jsonify({'ok': True, **res, 'total': len(targets)})

    @app.route('/api/admin/maintenance', methods=['POST'])
    def admin_maintenance():
        err = _require_admin()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        mode = data.get('mode') if data.get('mode') in ('off', 'banner', 'lock') else 'off'
        _load_state()
        m = {'mode': mode, 'since': time.time()}
        if mode != 'off':
            m['message'] = str(data.get('message') or '').strip()[:240] or \
                ('Wir schrauben kurz an der App.' if mode == 'lock' else 'Heute kann es kurz ruckeln – wir warten die App.')
            until = str(data.get('until') or '').strip()
            if until and len(until) == 5 and until[2] == ':':
                m['until'] = until
            try:
                auto = int(data.get('autoOffMinutes') or 0)
            except (TypeError, ValueError):
                auto = 0
            if 0 < auto <= 24 * 60:
                m['endsAt'] = time.time() + auto * 60
        with _lock:
            _state['maintenance'] = m
            _save_state()
        return jsonify({'ok': True, 'maintenance': maintenance()})

    # ---- public status for the app ----
    @app.route('/api/status')
    def app_status():
        m = maintenance()
        out = {'maintenance': {k: m.get(k) for k in ('mode', 'message', 'until', 'endsAt')}, 'admin': is_admin()}
        return jsonify(out)


def _short_ua(ua):
    ua = ua or ''
    os_name = 'Android' if 'Android' in ua else 'iPhone' if 'iPhone' in ua else 'iPad' if 'iPad' in ua else \
        'Windows' if 'Windows' in ua else 'Mac' if 'Mac OS' in ua else 'Linux' if 'Linux' in ua else 'Gerät'
    br = 'Edge' if 'Edg/' in ua else 'Firefox' if 'Firefox' in ua else 'Samsung' if 'SamsungBrowser' in ua else \
        'Chrome' if 'Chrome' in ua else 'Safari' if 'Safari' in ua else ''
    return f'{os_name} · {br}' if br else os_name
