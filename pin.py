"""Magdeburg Mobil – Fahrt anpinnen.

Eine angepinnte Fahrt läuft als Live-Benachrichtigung auf dem Handy mit:
Zug + Verspätung, vorheriger / aktueller / nächster Halt und eine Leiste der Fahrt.

Dieses Modul rechnet nur (ohne Netz, ohne Flask) – das Verschicken und die
Routen stecken in backend.py:
- clean(d)                 Eingabe aus der App prüfen
- view(pin, trip, now)     Wo ist der Zug gerade? (aus einem _fetch_trip()-Ergebnis)
- decide(pin, view, now)   Muss jetzt eine Benachrichtigung raus, und soll sie vibrieren?
- message(pin, view, ...)  Inhalt der Benachrichtigung
- card_png(view)           Bild für die aufgeklappte Benachrichtigung (Android), mit Wagenreihung
- icon_png(line, color)    Liniensymbol als großes Benachrichtigungs-Icon
"""
import datetime
import hashlib
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
            # trains only: for the Wagenreihung in the notification
            'trainCat': str(d.get('trainCat') or '').upper()[:4] if re.fullmatch(r'[A-Za-z]{1,4}', str(d.get('trainCat') or '')) else None,
            'trainNum': str(d.get('trainNum')) if re.fullmatch(r'\d{1,6}', str(d.get('trainNum') or '')) else None,
            'boardEva': str(d.get('boardEva')) if re.fullmatch(r'\d{7}', str(d.get('boardEva') or '')) else None,
            'exitEva': str(d.get('exitEva')) if re.fullmatch(r'\d{7}', str(d.get('exitEva') or '')) else None,
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


def _stop(s, ep, planned_ep=None):
    return {'name': s.get('name') or '', 'time': s.get('rt') or s.get('time') or '',
            'planned': s.get('time') or '', 'epoch': ep, 'plannedEpoch': planned_ep}


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
        'board': _stop(stops[b], real[b], plan[b]),
        'exit': _stop(stops[e], real[e], plan[e]),
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
    fm = v.get('formation') or {}
    sig = f"{v['phase']}|{v['cur']['name']}|{delay}|{v['cancelled']}|{bucket}|{fm.get('where', '')}{fm.get('platform', '')}{len(fm.get('cars') or [])}"
    first = 'sent' not in st
    send = first or alert or (sig != st.get('sig') and now - st.get('sent', 0) >= MIN_GAP)
    if send:
        st['sig'], st['sent'] = sig, now
    return send, alert and not first


def delay_text(v):
    if v.get('cancelled'):
        return 'fällt aus'
    d = v.get('delay')
    if d is None:
        return 'planmäßig'
    if d > 0:
        return f'+{d} Min'
    if d < 0:
        return f'{d} Min'
    return 'pünktlich'


def _platform(v, where):
    fm = v.get('formation') or {}
    return fm.get('platform') if fm.get('where') == where else None


def message(pin, v, alert, image_url=None, icon_url=None, open_url='/?tab=home&pin=1'):
    line = v.get('line') or 'Deine Fahrt'
    head = f"{line} → {v['direction']}" if v.get('direction') else line
    title = f"{head} · {delay_text(v)}"
    ex, bo = v['exit'], v['board']
    exit_pf = _platform(v, 'exit')
    if v.get('cancelled'):
        first = 'Die Fahrt fällt (teilweise) aus – schau in den Linienverlauf.'
        tail = f"Ausstieg {ex['name']} {ex['time']}"
    elif v['phase'] == 'before':
        m = v['minsToDep']
        pf = _platform(v, 'board')
        first = (f"Einsteigen in {m} Min" if m > 0 else 'Fährt jetzt ab') + f" · {bo['name']} ab {bo['time']}" + (f" · Gl. {pf}" if pf else '')
        tail = f"Ausstieg {ex['name']} um {ex['time']}"
    elif v['phase'] == 'exit':
        first = f"Nächster Halt: {ex['name']} – bitte aussteigen"
        tail = f"Ankunft {ex['time']}" + (f" · Gl. {exit_pf}" if exit_pf else '')
    else:
        nxt = v.get('next')
        first = f"Jetzt {v['cur']['name']}" + (f" · nächster Halt {nxt['name']} {nxt['time']}" if nxt else '')
        tail = f"Ausstieg {ex['name']} {ex['time']}" + (f" · Gl. {exit_pf}" if exit_pf else '') + f" · noch {v['minsLeft']} Min"
    msg = {
        'kind': 'pin', 'tag': 'pin', 'title': title, 'body': f"{first}\n{tail}",
        'url': open_url, 'alert': bool(alert), 'pinId': pin.get('id'),
    }
    if image_url:
        msg['image'] = image_url
    if icon_url:
        msg['icon'] = icon_url
    return msg


def end_message(pin, v):
    ex = (v or {}).get('exit') or {'name': pin.get('exit'), 'time': ''}
    return {'kind': 'pin-end', 'tag': 'pin', 'title': f"Angekommen: {ex['name']}",
            'body': f"{pin.get('line', '')} · Ankunft {ex.get('time', '')} – die Fahrt ist nicht mehr angepinnt.".strip(),
            'url': '/?tab=home', 'pinId': pin.get('id')}


# ---------------------------------------------------------------------------
# Wagenreihung for the notification (compact copy of formation.normalize())
# ---------------------------------------------------------------------------
def compact_formation(fm, where, station):
    """formation.normalize() result -> the few fields the card needs."""
    if not fm or not fm.get('cars'):
        return None
    cars = [{'s': c['start'], 'e': c['end'], 'c': c.get('cls'), 'k': c.get('kind'), 'x': bool(c.get('closed')),
             'g': c.get('group', 0)} for c in fm['cars']]
    secs = [{'n': s['name'], 's': s['start'], 'e': s['end']} for s in fm.get('sectors') or []]
    return {'where': where, 'station': station, 'platform': fm.get('platform'), 'direction': fm.get('direction'),
            'cars': cars[:40], 'sectors': secs[:12]}


def card_key(v):
    """Short id of what the card shows (same picture -> same id -> phone can cache it)."""
    keep = {k: v.get(k) for k in ('phase', 'label', 'pct', 'ticks', 'delay', 'cancelled', 'minsToDep', 'minsLeft',
                                   'line', 'direction', 'color', 'formation')}
    for k in ('prev', 'cur', 'next', 'board', 'exit'):
        keep[k] = {'name': v[k]['name'], 'time': v[k]['time']} if v.get(k) else None
    raw = json.dumps(keep, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(raw.encode()).hexdigest()[:20], keep


# ---------------------------------------------------------------------------
# Card image (Android shows it when the notification is expanded)
# ---------------------------------------------------------------------------
_fonts = {}

BG = (16, 22, 19)
SURFACE = (29, 38, 33)
LINE = (54, 66, 60)
MUTED = (143, 161, 152)
TEXT = (238, 244, 240)
GREEN = (61, 220, 143)
AMBER = (245, 158, 11)
RED = (229, 72, 77)


def _font(weight, size):
    key = (weight, int(size))
    if key not in _fonts:
        from PIL import ImageFont
        path = os.path.join(FONT_DIR, f'Inter-{weight}.otf')
        try:
            _fonts[key] = ImageFont.truetype(path, int(size))
        except Exception:
            try:
                _fonts[key] = ImageFont.load_default(int(size))
            except TypeError:
                _fonts[key] = ImageFont.load_default()
    return _fonts[key]


def _fit(draw, text, font, width):
    text = str(text or '')
    if draw.textlength(text, font=font) <= width:
        return text
    while text and draw.textlength(text + '…', font=font) > width:
        text = text[:-1]
    return text.rstrip() + '…'


def _rgb(hexcolor):
    h = (hexcolor or '#018e4a').lstrip('#')
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (1, 142, 74)


def _on(color):
    r, g, b = color
    return (17, 26, 21) if (0.299 * r + 0.587 * g + 0.114 * b) > 170 else (255, 255, 255)


def _mix(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def card_png(v, scale=2.5):
    """PNG of the expanded notification: train + delay, previous / now / next stop,
    the Wagenreihung (when known) and the whole ride as a bar."""
    from PIL import Image, ImageDraw
    S = scale
    W, H = int(400 * S), int(200 * S)
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    P = 16 * S
    fm = v.get('formation')
    phase = v.get('phase')

    # ---- header: line badge + direction | delay + arrival
    color = _rgb(v.get('color'))
    f_badge = _font('Bold', 14 * S)
    line = v.get('line') or ''
    bw = d.textlength(line, font=f_badge) + 18 * S
    d.rounded_rectangle([P, P, P + bw, P + 28 * S], radius=8 * S, fill=color)
    d.text((P + bw / 2, P + 14 * S), line, font=f_badge, fill=_on(color), anchor='mm')

    dtext = delay_text(v)
    f_delay = _font('Bold', 12 * S)
    dw = d.textlength(dtext, font=f_delay) + 20 * S
    late = v.get('cancelled') or (v.get('delay') or 0) > 0
    dfill = RED if v.get('cancelled') else (AMBER if late else (24, 92, 60))
    dfg = (255, 255, 255) if v.get('cancelled') else ((26, 18, 6) if late else (200, 250, 222))
    d.rounded_rectangle([W - P - dw, P, W - P, P + 22 * S], radius=11 * S, fill=dfill)
    d.text((W - P - dw / 2, P + 11 * S), dtext, font=f_delay, fill=dfg, anchor='mm')
    ex = v.get('exit') or {}
    d.text((W - P, P + 29 * S), f"an {ex.get('time', '')}", font=_font('Medium', 9.5 * S), fill=MUTED, anchor='rm')

    left = P + bw + 10 * S
    room = (W - P - dw - 10 * S) - left
    d.text((left, P + 6 * S), 'Richtung', font=_font('Medium', 8.5 * S), fill=MUTED, anchor='lm')
    d.text((left, P + 19 * S), _fit(d, v.get('direction') or '', _font('Bold', 15 * S), room),
           font=_font('Bold', 15 * S), fill=TEXT, anchor='lm')

    # ---- previous / now / next as a little line diagram
    top = P + (44 if fm else 52) * S
    cols = [(W * 1 / 6, 'Vorher', v.get('prev'), 'prev'), (W / 2, v.get('label') or 'Jetzt', v.get('cur'), 'cur'),
            (W * 5 / 6, 'Nächster', v.get('next'), 'next')]
    ly = top + 18 * S
    d.line([cols[0][0], ly, cols[1][0], ly], fill=_mix(GREEN, BG, 0.25), width=int(3 * S))
    x = cols[1][0]
    while x < cols[2][0]:                                   # dashed: still to come
        d.line([x, ly, min(x + 6 * S, cols[2][0]), ly], fill=LINE, width=int(3 * S))
        x += 11 * S
    colw = W / 3 - 12 * S
    big = not fm
    for cx, lab, st, kind in cols:
        cur = kind == 'cur'
        hot = cur and phase == 'exit'
        d.text((cx, top + 4 * S), lab.upper(), font=_font('Bold', 8 * S), fill=GREEN if cur else MUTED, anchor='mm')
        if cur:
            d.ellipse([cx - 13 * S, ly - 13 * S, cx + 13 * S, ly + 13 * S], fill=_mix(GREEN, BG, 0.78))
            d.ellipse([cx - 8 * S, ly - 8 * S, cx + 8 * S, ly + 8 * S], fill=GREEN)
            d.ellipse([cx - 3 * S, ly - 3 * S, cx + 3 * S, ly + 3 * S], fill=BG)
        elif kind == 'prev' and st:
            d.ellipse([cx - 5 * S, ly - 5 * S, cx + 5 * S, ly + 5 * S], fill=_mix(GREEN, BG, 0.25))
        elif st:
            d.ellipse([cx - 6 * S, ly - 6 * S, cx + 6 * S, ly + 6 * S], fill=BG, outline=MUTED, width=int(2.2 * S))
        name = st['name'] if st else '–'
        f_name = _font('Bold', (14 if big else 12.5) * S) if cur else _font('SemiBold', (11.5 if big else 10.5) * S)
        ny = ly + (20 if big else 18) * S
        d.text((cx, ny), _fit(d, name, f_name, colw), font=f_name,
               fill=(GREEN if hot else TEXT) if cur else ((206, 218, 212) if kind == 'next' else MUTED), anchor='mm')
        if st and st.get('time'):
            d.text((cx, ny + (15 if big else 13) * S), st['time'], font=_font('Medium', (10.5 if big else 9.5) * S),
                   fill=(207, 218, 212) if cur else MUTED, anchor='mm')

    # ---- Wagenreihung (or how many stops are left)
    if fm:
        _draw_formation(d, fm, P, top + 60 * S, W - P, S)
    elif phase in ('before', 'ride') and v.get('stopsLeft'):
        n = v['stopsLeft']
        txt = f"Noch {n} {'Halt' if n == 1 else 'Halte'} bis {ex.get('name', '')}"
        d.text((W / 2, top + 88 * S), _fit(d, txt, _font('Medium', 10 * S), W - 2 * P), font=_font('Medium', 10 * S), fill=MUTED, anchor='mm')

    # ---- the ride as a bar
    by = H - P - 18 * S
    x0, x1 = P + 6 * S, W - P - 6 * S
    pct = float(v.get('pct') or 0)
    px = x0 + (x1 - x0) * pct
    d.rounded_rectangle([x0, by - 2.5 * S, x1, by + 2.5 * S], radius=2.5 * S, fill=LINE)
    if px > x0 + 1:
        d.rounded_rectangle([x0, by - 2.5 * S, px, by + 2.5 * S], radius=2.5 * S, fill=GREEN)
    for t in v.get('ticks') or []:
        tx = x0 + (x1 - x0) * float(t)
        done = tx <= px + 1
        r = 4.5 * S
        d.ellipse([tx - r, by - r, tx + r, by + r], fill=GREEN if done else BG,
                  outline=GREEN if (done or float(t) >= 1) else MUTED, width=int(2 * S))
    mw, mh = 30 * S, 19 * S
    mx = min(max(px, x0 + mw / 2), x1 - mw / 2)
    d.rounded_rectangle([mx - mw / 2, by - mh / 2, mx + mw / 2, by + mh / 2], radius=7 * S, fill=GREEN, outline=BG, width=int(2 * S))
    _train_glyph(d, mx, by, S)
    f_small = _font('Medium', 9 * S)
    ly2 = by + 14 * S
    third = (x1 - x0) / 3
    d.text((x0 - 4 * S, ly2), _fit(d, (v.get('board') or {}).get('name'), f_small, third), font=f_small, fill=MUTED, anchor='lm')
    d.text((x1 + 4 * S, ly2), _fit(d, ex.get('name'), f_small, third), font=f_small, fill=MUTED, anchor='rm')
    if phase == 'before':
        m = v.get('minsToDep') or 0
        mid = f'Abfahrt in {m} Min' if m > 0 else 'Fährt ab'
    elif phase == 'exit':
        mid = 'Gleich da – aussteigen!'
    else:
        mid = f"noch {v.get('minsLeft', 0)} Min"
    d.text(((x0 + x1) / 2, ly2), mid, font=_font('Bold', 9.5 * S), fill=GREEN if phase == 'exit' else TEXT, anchor='mm')

    out = io.BytesIO()
    img.save(out, 'PNG', optimize=True)
    return out.getvalue()


def _train_glyph(d, x, y, S):
    d.rounded_rectangle([x - 5 * S, y - 6.5 * S, x + 5 * S, y + 4 * S], radius=2.5 * S, outline=BG, width=int(1.7 * S))
    d.line([x - 5 * S, y - 1.5 * S, x + 5 * S, y - 1.5 * S], fill=BG, width=int(1.5 * S))
    d.line([x - 3 * S, y + 4 * S, x - 5 * S, y + 7 * S], fill=BG, width=int(1.5 * S))
    d.line([x + 3 * S, y + 4 * S, x + 5 * S, y + 7 * S], fill=BG, width=int(1.5 * S))


def _draw_formation(d, fm, x0, y0, x1, S):
    """Platform chip + cars (1st class amber) + sections underneath."""
    chip_w = 54 * S
    where = 'Ausstieg' if fm.get('where') == 'exit' else 'Einstieg'
    pf = fm.get('platform')
    d.rounded_rectangle([x0, y0, x0 + chip_w, y0 + 30 * S], radius=8 * S, fill=SURFACE)
    d.text((x0 + chip_w / 2, y0 + 11 * S), f'Gl. {pf}' if pf else 'Gleis', font=_font('Bold', 12 * S), fill=GREEN, anchor='mm')
    d.text((x0 + chip_w / 2, y0 + 23 * S), where, font=_font('Medium', 7.5 * S), fill=MUTED, anchor='mm')

    a = x0 + chip_w + 10 * S + 8 * S
    b = x1 - 8 * S
    span = b - a
    cy0, cy1 = y0 + 12 * S, y0 + 28 * S
    cars = fm.get('cars') or []
    first = cars[0]['g'] if cars else 0
    groups_end = {}
    for c in cars:
        groups_end.setdefault(c['g'], [c['s'], c['e']])
        groups_end[c['g']][0] = min(groups_end[c['g']][0], c['s'])
        groups_end[c['g']][1] = max(groups_end[c['g']][1], c['e'])
    for c in cars:
        l = a + span * c['s'] / 100 + 0.8 * S
        r = a + span * c['e'] / 100 - 0.8 * S
        if r - l < 2 * S:
            continue
        kind, cls = c.get('k'), c.get('c')
        if kind in ('loco', 'powercar') and cls is None:
            fill, outline = (70, 82, 76), (96, 110, 103)
            d.rounded_rectangle([l, cy0 + 2 * S, r, cy1], radius=2.5 * S, fill=fill, outline=outline, width=int(1.4 * S))
            continue
        elif cls in ('1', '12'):
            fill, outline = _mix(AMBER, BG, 0.72), AMBER
        elif cls == 'B':
            fill, outline = _mix(RED, BG, 0.75), (230, 110, 110)
        else:
            fill, outline = SURFACE, (120, 138, 129)
        if c.get('x'):
            fill, outline = BG, LINE
        ends = groups_end[c['g']]
        rad_l = 7 * S if abs(c['s'] - ends[0]) < 0.5 else 2.5 * S
        rad_r = 7 * S if abs(c['e'] - ends[1]) < 0.5 else 2.5 * S
        rad = max(rad_l, rad_r)
        d.rounded_rectangle([l, cy0, r, cy1], radius=min(rad, (r - l) / 2), fill=fill, outline=outline, width=int(1.4 * S))
        if r - l > 12 * S and kind not in ('loco', 'powercar'):
            lab = '1' if cls in ('1', '12') else ('B' if cls == 'B' else '2')
            d.text(((l + r) / 2, (cy0 + cy1) / 2), lab, font=_font('Bold', 8 * S),
                   fill=AMBER if cls in ('1', '12') else ((240, 140, 140) if cls == 'B' else MUTED), anchor='mm')
    # travel direction
    if cars and fm.get('direction') in ('left', 'right'):
        my = (cy0 + cy1) / 2
        if fm['direction'] == 'right':
            tip = b + 7 * S
            d.polygon([(tip, my), (tip - 6 * S, my - 5 * S), (tip - 6 * S, my + 5 * S)], fill=GREEN)
        else:
            tip = a - 7 * S
            d.polygon([(tip, my), (tip + 6 * S, my - 5 * S), (tip + 6 * S, my + 5 * S)], fill=GREEN)
    # sections
    f_sec = _font('SemiBold', 8 * S)
    for s in fm.get('sectors') or []:
        sx = a + span * (s['s'] + s['e']) / 200
        d.text((sx, y0 + 4 * S), s['n'], font=f_sec, fill=MUTED, anchor='mm')


def icon_png(line, color, size=192):
    """Large notification icon: the line badge."""
    from PIL import Image, ImageDraw
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    col = _rgb(color)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.24), fill=col)
    text = str(line or '').strip() or '•'
    fs = int(size * 0.42)
    f = _font('Bold', fs)
    while d.textlength(text, font=f) > size * 0.82 and fs > 20:
        fs -= 4
        f = _font('Bold', fs)
    d.text((size / 2, size / 2), text, font=f, fill=_on(col), anchor='mm')
    out = io.BytesIO()
    img.save(out, 'PNG', optimize=True)
    return out.getvalue()
