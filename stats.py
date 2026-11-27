"""Magdeburg Mobil – Pünktlichkeits-Statistik.

Der Server schaut jede Minute auf alle Bahnen und Busse der Live-Karte (dieselben Daten wie
/api/radar). Fährt ein Fahrzeug an einem Halt vorbei (sein „nächster Halt“ wechselt), zählt
seine Verspätung an diesem Halt als eine Messung. Daraus entsteht pro Linie und Tag ein
Histogramm der Verspätungen; dazu kommen die Meldungen des Verkehrsmelders des Tages.

Gespeichert wird je Monat ein Dokument (Upstash-Schlüssel ``stats:YYYY-MM``), aufgehoben
wird ein Jahr. Dieses Modul rechnet nur; Laden/Speichern bekommt es von außen.
"""
import datetime
import threading
import time

H_MIN, H_MAX = -5, 15          # histogram: delay in whole minutes, clipped to this range
ON_TIME = (-2, 2)              # punctual: -2 … +2 min; early from 3 min early on
SLIGHT_MAX = 4                 # +3 / +4: slightly late; late from +5
KEEP_DAYS = 366
TYPES = ('tram', 'bus', 'sev')


def _bin(delay):
    return max(H_MIN, min(H_MAX, int(delay))) - H_MIN


HN = H_MAX - H_MIN + 1           # delay buckets; then two more slots:
X_CANCEL, X_NONE = HN, HN + 1    # Ausfall (stop not served) · keine Wertung (no realtime)


def _empty_hist():
    return [0] * (HN + 2)


def line_key(v):
    """Key of a radar vehicle: 'tram:4', 'bus:52' (same idea as the line shapes)."""
    vt = v.get('type')
    if vt not in TYPES:
        return None
    short = str(v.get('short') or '').strip()
    if not short:
        return None
    return f"{'tram' if vt == 'tram' else 'bus'}:{short}"


class Stats:
    """Collects arrivals at stops and Verkehrsmelder messages, per month document."""

    def __init__(self, tz, load_month=None, save_month=None):
        self.tz = tz
        self.load_month = load_month or (lambda name: None)
        self.save_month = save_month or (lambda name, doc: None)
        self.months = {}        # 'YYYY-MM' -> doc
        self.loaded_at = {}     # 'YYYY-MM' -> ts (past months: forever; current: live)
        self.track = {}         # jid -> {'key', 'stop', 'delay', 'seen', 'meta'}
        self.lock = threading.RLock()
        self.dirty = set()
        self.missing = {}       # 'YYYY-MM' -> ts of a lookup that found nothing

    # ---------------- documents ----------------
    def _day(self, ts):
        d = datetime.datetime.fromtimestamp(ts, self.tz)
        return d.strftime('%Y-%m'), d.strftime('%d')

    def month(self, name, create=False):
        with self.lock:
            doc = self.months.get(name)
            if doc is None and not create and time.time() - self.missing.get(name, 0) < 3600:
                return None
            if doc is None:
                try:
                    doc = self.load_month(name)
                except Exception:
                    doc = None
                if not isinstance(doc, dict) or doc.get('v') != 1:
                    doc = {'v': 1, 'days': {}} if create else None
                if doc is not None:
                    self.months[name] = doc
                    self.missing.pop(name, None)
                else:
                    self.missing[name] = time.time()
            return doc

    def _daydoc(self, ts):
        m, d = self._day(ts)
        doc = self.month(m, create=True)
        day = doc['days'].setdefault(d, {'lines': {}, 'disr': {}})
        self.dirty.add(m)
        return day

    # ---------------- observing ----------------
    def _record(self, key, meta, delay, ts, slot=None):
        """delay in minutes – or slot=X_CANCEL / X_NONE."""
        day = self._daydoc(ts)
        ln = day['lines'].get(key)
        if ln is None:
            ln = day['lines'][key] = {'s': meta.get('short'), 't': meta.get('type'), 'c': meta.get('color'), 'h': _empty_hist()}
        h = ln['h']
        if len(h) < HN + 2:                          # days stored before the two extra slots existed
            h.extend([0] * (HN + 2 - len(h)))
        h[_bin(delay) if slot is None else slot] += 1

    def observe(self, vehicles, now=None):
        """One look at all vehicles. A stop counts when the vehicle's next stop changes."""
        now = now or time.time()
        with self.lock:
            seen = set()
            for v in vehicles or []:
                jid, key = v.get('id'), line_key(v)
                if not jid or not key:
                    continue
                seen.add(jid)
                stop = v.get('nextStop') or ''
                delay = v.get('delay')
                ok = delay is not None and v.get('rtState', 'ok') == 'ok'
                prev = self.track.get(jid)
                meta = {'short': v.get('short'), 'type': 'tram' if v.get('type') == 'tram' else 'bus', 'color': v.get('color')}
                if prev and prev['stop'] and stop != prev['stop']:
                    if prev['delay'] is not None:
                        self._record(prev['key'], prev['meta'], prev['delay'], now)
                    else:                               # passed a stop without realtime: no rating
                        self._record(prev['key'], prev['meta'], None, now, X_NONE)
                done = set(prev['cx']) if prev else set()
                for name in v.get('cancelled') or []:   # each cancelled stop of a trip counts once
                    if name not in done:
                        done.add(name)
                        self._record(key, meta, None, now, X_CANCEL)
                self.track[jid] = {'key': key, 'stop': stop, 'delay': delay if ok else None, 'seen': now, 'meta': meta, 'cx': sorted(done)}
            # vehicles that vanished: their last stop (the terminus) counts too
            for jid, prev in list(self.track.items()):
                if jid in seen:
                    continue
                if now - prev['seen'] > 600:
                    if prev['stop'] and prev['stop'] not in (prev.get('cx') or []):
                        if prev['delay'] is not None:
                            self._record(prev['key'], prev['meta'], prev['delay'], prev['seen'])
                        else:
                            self._record(prev['key'], prev['meta'], None, prev['seen'], X_NONE)
                    del self.track[jid]

    def observe_disruptions(self, items, now=None):
        """Verkehrsmelder messages seen right now (list of dicts with id/title/lines/…)."""
        now = now or time.time()
        with self.lock:
            day = self._daydoc(now)
            current = set()
            for it in items or []:
                i = str(it.get('id') or '')[:40]
                if not i:
                    continue
                current.add(i)
                rec = day['disr'].get(i)
                text = ' '.join(str(it.get('desc') or it.get('text') or '').split())[:400]
                done = _looks_done(it)
                if rec is None:
                    rec = day['disr'][i] = {'title': str(it.get('title') or '')[:160], 'lines': list(it.get('lines') or [])[:20],
                                            'first': int(now), 'critical': bool(it.get('critical'))}
                rec.update(last=int(now), text=text, done=done, gone=False)
            for i, rec in day['disr'].items():
                if i not in current:
                    rec['gone'] = True

    # ---------------- persistence ----------------
    def flush(self):
        with self.lock:
            names, self.dirty = list(self.dirty), set()
            docs = {n: self.months.get(n) for n in names}
        for n, doc in docs.items():
            if doc is not None:
                try:
                    self.save_month(n, doc)
                except Exception as ex:
                    print(f"[WARN] stats save {n}: {ex}")
        return names

    # ---------------- reading ----------------
    def summary(self, day_from, day_to, today=None):
        """Totals and per-line numbers for the dates [day_from, day_to] (datetime.date)."""
        lines, total, trend, disr = {}, _empty_hist(), [], {}
        d = day_from
        while d <= day_to:
            doc = self.month(d.strftime('%Y-%m'))
            day = (doc or {}).get('days', {}).get(d.strftime('%d')) or {}
            day_hist = _empty_hist()
            for key, ln in (day.get('lines') or {}).items():
                acc = lines.get(key)
                if acc is None:
                    acc = lines[key] = {'key': key, 'short': ln.get('s'), 'type': ln.get('t'), 'color': ln.get('c'), 'h': _empty_hist()}
                for i, n in enumerate(ln.get('h') or []):
                    if i < len(acc['h']):
                        acc['h'][i] += n
                        day_hist[i] += n
            for i, n in enumerate(day_hist):
                total[i] += n
            trend.append({'date': d.isoformat(), **_metrics(day_hist)})
            for i, rec in (day.get('disr') or {}).items():
                acc = disr.get(i)
                if acc is None:
                    disr[i] = dict(rec, days=[d.isoformat()])
                else:
                    acc['days'].append(d.isoformat())
                    acc['last'] = max(acc.get('last', 0), rec.get('last', 0))
                    acc['done'] = rec.get('done', acc.get('done'))
                    acc['gone'] = rec.get('gone', acc.get('gone'))
            d += datetime.timedelta(days=1)
        out_lines = []
        for acc in lines.values():
            m = _metrics(acc['h'])
            if m['n']:
                out_lines.append({k: acc[k] for k in ('key', 'short', 'type', 'color')} | m | {'hist': acc['h']})
        out_lines.sort(key=lambda l: (0 if l['type'] == 'tram' else 1, _num(l['short']), str(l['short'])))
        dl = sorted(disr.values(), key=lambda r: -(r.get('first') or 0))
        return {'lines': out_lines, 'total': _metrics(total) | {'hist': total}, 'trend': trend, 'disruptions': dl,
                'histRange': [H_MIN, H_MAX], 'onTime': list(ON_TIME), 'slightMax': SLIGHT_MAX}

    def first_day(self):
        """Oldest date with data (searches the stored months of the last year)."""
        today = datetime.datetime.now(self.tz).date()
        for back in range(12, -1, -1):
            y, m = today.year, today.month - back
            while m <= 0:
                m += 12
                y -= 1
            doc = self.month(f"{y:04d}-{m:02d}")
            if doc and doc.get('days'):
                return datetime.date(y, m, int(min(doc['days'])))
        return None


def _num(s):
    digits = ''.join(ch for ch in str(s or '') if ch.isdigit())
    return int(digits) if digits else 9999


def _metrics(h):
    """Shares of all observed stops: zu früh · pünktlich · +3/+4 · ab +5 · Ausfall · keine Wertung (sum 100).
    Average and maximum only from the stops with realtime."""
    x = h[X_CANCEL] if len(h) > X_CANCEL else 0
    u = h[X_NONE] if len(h) > X_NONE else 0
    rated = sum(h[:HN])
    n = rated + x + u
    if not n:
        return {'n': 0, 'rated': 0, 'onTime': None, 'slight': None, 'late': None, 'early': None, 'cancelled': None,
                'unrated': None, 'avg': None, 'avgLate': None, 'max': None}
    on = slight = late = early = 0
    s = late_sum = 0
    mx = None
    for i, c in enumerate(h[:HN]):
        if not c:
            continue
        dmin = i + H_MIN
        s += dmin * c
        if dmin < ON_TIME[0]:
            early += c
        elif dmin > SLIGHT_MAX:
            late += c
            late_sum += dmin * c
        elif dmin > ON_TIME[1]:
            slight += c
            late_sum += dmin * c
        else:
            on += c
        mx = dmin if mx is None or dmin > mx else mx
    delayed = slight + late
    pct = lambda c: round(100 * c / n, 1)
    return {'n': n, 'rated': rated, 'onTime': pct(on), 'slight': pct(slight), 'late': pct(late), 'early': pct(early),
            'cancelled': pct(x), 'unrated': pct(u), 'avg': round(s / rated, 2) if rated else None,
            'avgLate': round(late_sum / delayed, 1) if delayed else None, 'max': mx}


def _looks_done(it):
    """Verkehrsmelder posts are edited to say 'erledigt' / 'aufgehoben' when they are over."""
    txt = f"{it.get('title') or ''} {it.get('desc') or it.get('text') or ''}".lower()
    return any(w in txt for w in ('erledigt', 'aufgehoben', 'beendet', 'wieder planmäßig', 'wieder regulär',
                                  'verkehrt wieder', 'fahren wieder', 'fährt wieder', 'behoben'))
