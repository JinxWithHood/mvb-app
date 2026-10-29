"""Magdeburg Mobil – Fahrt anpinnen.

Eine angepinnte Fahrt läuft als Live-Benachrichtigung auf dem Handy mit:
Zug + Verspätung, vorheriger / aktueller / nächster Halt und eine Leiste der Fahrt.

Dieses Modul rechnet nur (ohne Netz, ohne Flask) – das Verschicken und die
Routen stecken in backend.py:
- clean(d)                 Eingabe aus der App prüfen
- view(pin, trip, now)     Wo ist der Zug gerade? (aus einem _fetch_trip()-Ergebnis)
- decide(pin, view, now)   Muss jetzt eine Benachrichtigung raus, und soll sie vibrieren?
- message(pin, view, ...)  Inhalt der Benachrichtigung
- card_png(view)           Bild für die aufgeklappte Benachrichtigung (Android)
"""
import base64
import datetime
import hashlib
import hmac
import io
import json
import math
import os
import re

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/Berlin')
except Exception:  # pragma: no cover  (old Windows Python without tzdata)
    import pytz
    TZ = pytz.timezone('Europe/Berlin')

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
MAX_AGE = 8 * 3600          # a pin older than this (after its departure) is dropped
MIN_GAP = 55                # seconds between two silent updates

_HEX = re.compile(r'^#[0-9a-fA-F]{6}$')


def norm(name):
    n = (name or '').lower()
    n = re.sub(r'^magdeburg,\s*', '', n)
    n = re.sub(r',\s*magdeburg$', '', n)
    n = re.sub(r'\s*\((tram|bus|tram/bus)\)', '', n)
    return re.sub(r'[^a-z0-9äöüß]', '', n)


def clean(d):
    """App input -> stored pin, or None."""
    if not isinstance(d, dict):
        return None
    try:
        pin = {
            'id': str(d.get('id') or '')[:80],
            'jid': str(d['jid'])[:400],
            'line': str(d.get('line') or '')[:24].strip(),
            'direction': str(d.get('direction') or '')[:80].strip(),
            'color': str(d.get('color') or '#018e4a') if _HEX.match(str(d.get('color') or '')) else '#018e4a',
            'board': str(d['board'])[:100].strip(),
            'exit': str(d['exit'])[:100].strip(),
            'planned': int(d['planned']),
            'boardIdx': int(d.get('boardIdx', -1)),
            'exitIdx': int(d.get('exitIdx', -1)),
        }
    except (KeyError, TypeError, ValueError):
        return None
    if not pin['jid'] or not pin['board'] or not pin['exit'] or pin['planned'] <= 0:
        return None
    if not pin['id']:
        pin['id'] = hashlib.sha1(f"{pin['jid']}|{pin['board']}|{pin['planned']}".encode()).hexdigest()[:16]
    return pin


# ---------------------------------------------------------------------------
# Where is the train?
# ---------------------------------------------------------------------------
def _to_epoch(hhmm, ref):
    """'HH:MM' -> epoch closest to ref (handles midnight)."""
    m = re.match(r'^\s*(\d{1,2}):(\d{2})', str(hhmm or ''))
    if not m:
        return None
    base = datetime.datetime.fromtimestamp(ref, TZ)
    best = None
    for day in (-1, 0, 1):
        d = (base + datetime.timedelta(days=day)).date()
        cand = datetime.datetime(d.year, d.month, d.day, int(m.group(1)), int(m.group(2)))
        cand = cand.replace(tzinfo=TZ) if hasattr(TZ, 'key') else TZ.localize(cand)
        ep = cand.timestamp()
        if best is None or abs(ep - ref) < abs(best - ref):
            best = ep
    return best


def locate(pin, stops):
    """Indexes of boarding and exit stop in the trip (name match, the app's indexes as hints)."""
    names = [norm(s.get('name')) for s in stops]

    def match(target, start, hint):
        t = norm(target)
        if not t:
            return None
        same = lambda n: bool(n) and (n == t or t in n or n in t)
        if start <= hint < len(stops) and same(names[hint]):
            return hint
        for i in range(start, len(stops)):
            if names[i] == t:
                return i
        for i in range(start, len(stops)):
            if same(names[i]):
                return i
        return None

    b = match(pin['board'], 0, pin.get('boardIdx', -1))
    if b is None:
        return None, None
    e = match(pin['exit'], b + 1, pin.get('exitIdx', -1))
    return b, e


def _stop(s, ep):
    return {'name': s.get('name') or '', 'time': s.get('rt') or s.get('time') or '',
            'planned': s.get('time') or '', 'epoch': ep}


def view(pin, trip, now):
    """Live state of a pinned trip, or None when the stops can't be found."""
    stops = (trip or {}).get('stops') or []
    b, e = locate(pin, stops)
    if b is None or e is None:
        return None
    n = len(stops)
    plan = [None] * n
    ref = pin['planned'] / 1000.0
    for i in range(b, n):                      # forwards from the boarding stop
        plan[i] = _to_epoch(stops[i].get('time'), ref) or ref
        ref = plan[i]
    ref = plan[b]
    for i in range(b - 1, -1, -1):             # and backwards
        plan[i] = _to_epoch(stops[i].get('time'), ref) or ref
        ref = plan[i]
    real = [(_to_epoch(s.get('rt'), plan[i]) if s.get('rt') else plan[i]) for i, s in enumerate(stops)]

    passed = -1
    for i in range(n):
        if real[i] <= now:
            passed = i
    if real[e] + 60 <= now:
        phase = 'done'
    elif passed < b:
        phase = 'before'
    elif passed >= e - 1:
        phase = 'exit'
    else:
        phase = 'ride'

    if phase == 'before':
        cur, label = b, 'Einstieg'
    elif phase in ('exit', 'done'):
        cur, label = e, 'Ausstieg'
    else:
        cur, label = passed, 'Aktuell'
    prev_i, next_i = cur - 1, cur + 1

    if phase == 'before':
        pct = 0.0
    elif phase == 'done':
        pct = 1.0
    else:
        seg = min(max(passed, b), e - 1)
        t0, t1 = real[seg], real[seg + 1]
        f = 1.0 if t1 <= t0 else min(1.0, max(0.0, (now - t0) / (t1 - t0)))
        pct = min(1.0, max(0.0, (seg - b + f) / (e - b)))

    ref_delay = stops[b] if phase == 'before' else stops[min(max(passed + 1, b), e)]
    delay = ref_delay.get('delay')
    ride = stops[b:e + 1]
    return {
        'phase': phase,
        'label': label,
        'prev': _stop(stops[prev_i], real[prev_i]) if prev_i >= 0 else None,
        'cur': _stop(stops[cur], real[cur]),
        'next': _stop(stops[next_i], real[next_i]) if next_i < n else None,
        'board': _stop(stops[b], real[b]),
        'exit': _stop(stops[e], real[e]),
        'stopsTotal': e - b,
        'stopsLeft': max(0, e - max(passed, b)) if phase != 'before' else e - b,
        'ticks': [round((i - b) / (e - b), 4) for i in range(b, e + 1)],
        'pct': round(pct, 4),
        'delay': delay,
        'cancelled': any(s.get('cancelled') for s in ride),
        'minsToDep': int(math.ceil((real[b] - now) / 60)),
        'minsLeft': max(0, int(math.ceil((real[e] - now) / 60))),
        'line': pin.get('line') or '',
        'direction': pin.get('direction') or '',
        'color': pin.get('color') or '#018e4a',
    }


# ---------------------------------------------------------------------------
# When to notify
# ---------------------------------------------------------------------------
def decide(pin, v, now):
    """(send, alert) – and remembers what was sent in pin['st']."""
    st = pin.setdefault('st', {})
    alert = False
    delay = v['delay'] or 0
    if 'aDelay' not in st:
        st['aDelay'] = delay
    elif abs(delay - st['aDelay']) >= 2:
        alert, st['aDelay'] = True, delay
    if v['phase'] == 'before' and v['minsToDep'] <= 4 and not st.get('aDep'):
        alert = st['aDep'] = True
    if v['cancelled'] and not st.get('aCnl'):
        alert = st['aCnl'] = True
    if v['phase'] == 'exit' and not st.get('aExit'):
        alert = st['aExit'] = True

    if v['phase'] == 'before':
        m = v['minsToDep']
        bucket = m if m <= 10 else (m // 5 if m <= 60 else m // 15)
    else:
        bucket = int(v['pct'] * 20)          # the bar moves in 5 % steps
    sig = f"{v['phase']}|{v['cur']['name']}|{delay}|{v['cancelled']}|{bucket}"
    first = 'sent' not in st
    send = first or alert or (sig != st.get('sig') and now - st.get('sent', 0) >= MIN_GAP)
    if send:
        st['sig'], st['sent'] = sig, now
    return send, alert and not first


def delay_text(v):
    if v['cancelled']:
        return 'fällt aus'
    d = v['delay']
    if d is None:
        return 'planmäßig'
    if d > 0:
        return f'+{d} Min'
    if d < 0:
        return f'{d} Min'
    return 'pünktlich'


def message(pin, v, alert, image_url=None, open_url='/?tab=home&pin=1'):
    line = v['line'] or 'Deine Fahrt'
    title = f"{line} → {v['direction']} · {delay_text(v)}" if v['direction'] else f"{line} · {delay_text(v)}"
    ex = v['exit']
    tail = f"Ausstieg {ex['name']} {ex['time']}"
    if v['phase'] == 'before':
        m = v['minsToDep']
        first = (f"Einsteigen in {m} Min" if m > 0 else 'Fährt jetzt ab') + f" · {v['board']['name']} ab {v['board']['time']}"
    elif v['phase'] == 'exit':
        first = f"Nächster Halt: {ex['name']} – aussteigen!"
        tail = f"Ankunft {ex['time']}"
    else:
        parts = [p['name'] for p in (v['prev'], v['cur'], v['next']) if p]
        first = ' › '.join(parts)
        tail += f" · noch {v['minsLeft']} Min"
    msg = {
        'kind': 'pin', 'tag': 'pin', 'title': title, 'body': f"{first}\n{tail}",
        'url': open_url, 'alert': bool(alert), 'pinId': pin.get('id'),
    }
    if image_url:
        msg['image'] = image_url
    return msg


def end_message(pin, v):
    ex = (v or {}).get('exit') or {'name': pin.get('exit'), 'time': ''}
    return {'kind': 'pin-end', 'tag': 'pin', 'title': f"Angekommen: {ex['name']}",
            'body': f"{pin.get('line', '')} · Ankunft {ex.get('time', '')} – die Fahrt ist nicht mehr angepinnt.".strip(),
            'url': '/?tab=home', 'pinId': pin.get('id')}


# ---------------------------------------------------------------------------
# Signed image links (only our server can make card images)
# ---------------------------------------------------------------------------
def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _unb64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def image_token(v, secret):
    keep = {k: v[k] for k in ('phase', 'label', 'prev', 'cur', 'next', 'board', 'exit', 'ticks', 'pct',
                               'delay', 'cancelled', 'minsToDep', 'minsLeft', 'line', 'direction', 'color')}
    for k in ('prev', 'cur', 'next', 'board', 'exit'):
        if keep[k]:
            keep[k] = {'name': keep[k]['name'], 'time': keep[k]['time']}
    data = _b64(json.dumps(keep, ensure_ascii=False, separators=(',', ':')).encode())
    sig = hmac.new(secret, data.encode(), hashlib.sha256).hexdigest()[:20]
    return data, sig


def read_token(data, sig, secret):
    good = hmac.new(secret, str(data).encode(), hashlib.sha256).hexdigest()[:20]
    if not hmac.compare_digest(good, str(sig or '')):
        return None
    try:
        return json.loads(_unb64(str(data)))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Card image (Android shows it when the notification is expanded)
# ---------------------------------------------------------------------------
_fonts = {}


def _font(weight, size):
    key = (weight, size)
    if key not in _fonts:
        from PIL import ImageFont
        path = os.path.join(FONT_DIR, f'Inter-{weight}.otf')
        try:
            _fonts[key] = ImageFont.truetype(path, size)
        except Exception:
            _fonts[key] = ImageFont.load_default(size) if hasattr(ImageFont, 'load_default') else ImageFont.load_default()
    return _fonts[key]


def _fit(draw, text, font, width):
    text = str(text or '')
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + '…', font=font) > width:
        text = text[:-1]
    return text.rstrip() + '…'


def _rgb(hexcolor):
    h = hexcolor.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def card_png(v, scale=2):
    """PNG bytes of the card: train + delay, previous / current / next stop, progress bar."""
    from PIL import Image, ImageDraw
    S = scale
    W, H = 360 * S, 180 * S
    bg, panel, muted, text, green = (22, 30, 26), (35, 45, 40), (150, 168, 158), (238, 244, 240), (61, 220, 143)
    img = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(img)
    pad = 14 * S

    # --- top: train left, delay right
    f_badge = _font('Bold', 13 * S)
    line = v.get('line') or ''
    bw = int(d.textlength(line, font=f_badge)) + 16 * S
    d.rounded_rectangle([pad, pad, pad + bw, pad + 26 * S], radius=7 * S, fill=_rgb(v.get('color') or '#018e4a'))
    d.text((pad + bw / 2, pad + 13 * S), line, font=f_badge, fill=(255, 255, 255), anchor='mm')

    delay = v.get('delay')
    late = v.get('cancelled') or (delay or 0) > 0
    dtext = delay_text(v)
    f_delay = _font('Bold', 12 * S)
    dw = int(d.textlength(dtext, font=f_delay)) + 18 * S
    dfill = (229, 72, 77) if v.get('cancelled') else ((245, 158, 11) if late else (31, 107, 69))
    dfg = (255, 255, 255) if v.get('cancelled') else ((26, 18, 6) if late else (217, 251, 232))
    d.rounded_rectangle([W - pad - dw, pad + 2 * S, W - pad, pad + 24 * S], radius=11 * S, fill=dfill)
    d.text((W - pad - dw / 2, pad + 13 * S), dtext, font=f_delay, fill=dfg, anchor='mm')

    f_dir = _font('SemiBold', 13 * S)
    room = W - pad - dw - 10 * S - (pad + bw + 10 * S)
    d.text((pad + bw + 10 * S, pad + 13 * S), _fit(d, '→ ' + (v.get('direction') or ''), f_dir, room),
           font=f_dir, fill=text, anchor='lm')

    # --- middle: previous / current / next stop
    top, gap = pad + 38 * S, 6 * S
    bwid = (W - 2 * pad - 2 * gap) / 3
    labels = [('Vorheriger', v.get('prev')), (v.get('label') or 'Aktuell', v.get('cur')), ('Nächster', v.get('next'))]
    f_lab, f_name, f_time = _font('Bold', 8 * S), _font('SemiBold', 11 * S), _font('Medium', 10 * S)
    for i, (lab, st) in enumerate(labels):
        x0 = pad + i * (bwid + gap)
        mid = i == 1
        fill = (20, 83, 45) if (mid and v.get('phase') == 'exit') else ((31, 58, 44) if mid else panel)
        d.rounded_rectangle([x0, top, x0 + bwid, top + 50 * S], radius=10 * S, fill=fill,
                            outline=(47, 92, 68) if mid else None, width=S if mid else 0)
        tx = x0 + 8 * S
        d.text((tx, top + 7 * S), lab.upper(), font=f_lab, fill=green if mid else muted)
        name = st['name'] if st else '–'
        d.text((tx, top + 19 * S), _fit(d, name, f_name, bwid - 14 * S), font=f_name,
               fill=(255, 255, 255) if mid else ((206, 218, 212) if i == 2 else muted))
        if st and st.get('time'):
            d.text((tx, top + 34 * S), st['time'], font=f_time, fill=(207, 218, 212) if mid else muted)

    # --- bottom: the ride as a bar
    y = top + 50 * S + 22 * S
    x0, x1 = pad + 8 * S, W - pad - 8 * S
    d.rounded_rectangle([x0, y - 2 * S, x1, y + 2 * S], radius=2 * S, fill=(52, 64, 58))
    px = x0 + (x1 - x0) * float(v.get('pct') or 0)
    if px > x0:
        d.rounded_rectangle([x0, y - 2 * S, px, y + 2 * S], radius=2 * S, fill=green)
    for t in v.get('ticks') or []:
        tx = x0 + (x1 - x0) * float(t)
        done = tx <= px + 1
        r = 4 * S
        d.ellipse([tx - r, y - r, tx + r, y + r], fill=green if done else bg, outline=green if (done or t == 1) else (91, 107, 98), width=2 * S)
    mw, mh = 26 * S, 18 * S
    d.rounded_rectangle([px - mw / 2, y - mh / 2, px + mw / 2, y + mh / 2], radius=6 * S, fill=green)
    # tiny train
    tx, ty = px, y
    d.rounded_rectangle([tx - 5 * S, ty - 6 * S, tx + 5 * S, ty + 4 * S], radius=2 * S, outline=bg, width=int(1.6 * S))
    d.line([tx - 5 * S, ty - 1 * S, tx + 5 * S, ty - 1 * S], fill=bg, width=int(1.4 * S))

    f_small = _font('Medium', 9 * S)
    ly = y + 14 * S
    bname = (v.get('board') or {}).get('name') or ''
    ename = (v.get('exit') or {}).get('name') or ''
    third = (x1 - x0) / 3
    d.text((x0 - 6 * S, ly), _fit(d, bname, f_small, third), font=f_small, fill=muted, anchor='lm')
    d.text((x1 + 6 * S, ly), _fit(d, ename, f_small, third), font=f_small, fill=muted, anchor='rm')
    if v.get('phase') == 'before':
        m = v.get('minsToDep') or 0
        mid_text = f'Abfahrt in {m} Min' if m > 0 else 'Fährt ab'
    elif v.get('phase') == 'exit':
        mid_text = 'Gleich da – aussteigen!'
    else:
        mid_text = f"noch {v.get('minsLeft', 0)} Min"
    d.text(((x0 + x1) / 2, ly), mid_text, font=_font('SemiBold', 9 * S), fill=text, anchor='mm')

    out = io.BytesIO()
    img.save(out, 'PNG', optimize=True)
    return out.getvalue()
