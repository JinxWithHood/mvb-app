"""Magdeburg Mobil – Linienwege an Gleise und Straßen anlegen.

HAFAS liefert Fahrtverläufe oft nur grob: Haltestelle zu Haltestelle mit geraden Linien,
teils fast einen Kilometer lang. Auf der Karte schneiden Bahnen und Busse dann quer durch
Häuserblocks. Dieses Modul legt jeden langen geraden Abschnitt auf den echten Weg:

- Straßenbahn: kürzester Weg im Gleisnetz aus OpenStreetMap (liegt schon als /api/network vor).
- Bus (und SEV): Straßen-Route vom OSRM-Server der FOSSGIS (routing.openstreetmap.de).
  Jeder Abschnitt wird nur einmal abgefragt und dann gespeichert (Datei-Cache),
  im Hintergrund und höchstens etwa eine Anfrage pro Sekunde.

Ein Abschnitt bleibt gerade, wenn der gefundene Weg nicht plausibel ist (z. B. viel länger als
die Luftlinie – dann ist die Linie vermutlich umgeleitet oder fährt über eine reine Busspur).
"""
import heapq
import json
import math
import os
import threading
import time

import requests

MIN_SEG = 60            # metres: shorter straight pieces are fine as they are
MAX_DETOUR = 2.0        # a found path may be at most this times the straight line …
MAX_EXTRA = 450         # … or this many metres longer (whichever is larger)
SNAP_RADIUS = 30        # metres: a shape point must be this close to a tram track
OSRM_URL = os.environ.get('ROUTESNAP_OSRM', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/')
UA = 'MagdeburgMobil/1 (private hobby project, github.com/JinxWithHood/mvb-app)'

M_LAT = 111_320.0


def _m_lon(lat):
    return 111_320.0 * math.cos(math.radians(lat))


def dist(a, b):
    """Metres between two [lat, lon] points (good enough for a city)."""
    ky = M_LAT
    kx = _m_lon((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * ky, (a[1] - b[1]) * kx)


def _key(a, b):
    return f"{a[0]:.5f},{a[1]:.5f}>{b[0]:.5f},{b[1]:.5f}"


def _allowed(path_len, straight):
    return path_len <= max(straight * MAX_DETOUR, straight + MAX_EXTRA)


# ---------------------------------------------------------------------------
# Tram: shortest path in the OSM track network
# ---------------------------------------------------------------------------
class TrackGraph:
    CELL = 0.0005           # degrees (~55 m north-south)

    def __init__(self, tracks):
        self.pts = []                    # node id -> [lat, lon]
        self.adj = []                    # node id -> [(nb, metres)]
        self.segs = []                   # (u, v)
        self.grid = {}
        ids = {}

        def node(p):
            k = (round(p[0], 6), round(p[1], 6))
            if k not in ids:
                ids[k] = len(self.pts)
                self.pts.append([p[0], p[1]])
                self.adj.append([])
            return ids[k]

        for line in tracks or []:
            prev = None
            for p in line:
                n = node(p)
                if prev is not None and prev != n:
                    self._edge(prev, n)
                prev = n
        # ways that end on another way without a shared vertex (simplified geometry):
        # connect each loose end to the nearest track within a few metres
        self._index()
        deg = [len(a) for a in self.adj]
        for n, d in enumerate(deg):
            if d == 1:
                hit = self.project(self.pts[n], 6, exclude=n)
                if hit:
                    _, (u, v, t, q) = hit[0]
                    m = self._split(u, v, q)
                    if m != n:
                        self._edge(n, m)
        self._index()

    def _edge(self, u, v):
        w = dist(self.pts[u], self.pts[v])
        self.adj[u].append((v, w))
        self.adj[v].append((u, w))
        self.segs.append((u, v))

    def _split(self, u, v, q):
        """Insert a node at q on segment u–v (keeps the old edge, cheap and good enough)."""
        if dist(q, self.pts[u]) < 1.5:
            return u
        if dist(q, self.pts[v]) < 1.5:
            return v
        m = len(self.pts)
        self.pts.append([q[0], q[1]])
        self.adj.append([])
        self._edge(u, m)
        self._edge(m, v)
        return m

    def _cells(self, lat, lon):
        return int(lat // self.CELL), int(lon // self.CELL)

    def _index(self):
        self.grid = {}
        for i, (u, v) in enumerate(self.segs):
            a, b = self.pts[u], self.pts[v]
            la0, lo0 = self._cells(min(a[0], b[0]), min(a[1], b[1]))
            la1, lo1 = self._cells(max(a[0], b[0]), max(a[1], b[1]))
            for x in range(la0, la1 + 1):
                for y in range(lo0, lo1 + 1):
                    self.grid.setdefault((x, y), []).append(i)

    def project(self, p, radius, exclude=None, limit=4):
        """Nearby track segments: [(metres, (u, v, t, point)), …] closest first, one per segment."""
        cx, cy = self._cells(p[0], p[1])
        r = int(math.ceil(radius / 50.0)) + 1
        seen, out = set(), []
        kx = _m_lon(p[0])
        for x in range(cx - r, cx + r + 1):
            for y in range(cy - r, cy + r + 1):
                for i in self.grid.get((x, y), ()):
                    if i in seen:
                        continue
                    seen.add(i)
                    u, v = self.segs[i]
                    if exclude is not None and exclude in (u, v):
                        continue
                    a, b = self.pts[u], self.pts[v]
                    ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * M_LAT
                    bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * M_LAT
                    dx, dy = bx - ax, by - ay
                    ll = dx * dx + dy * dy
                    t = 0.0 if ll == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / ll))
                    d = math.hypot(ax + t * dx, ay + t * dy)
                    if d <= radius:
                        q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
                        out.append((d, (u, v, t, q)))
        out.sort(key=lambda h: h[0])
        return out[:limit]

    def path(self, a, b):
        """Track path from point a to point b, or None."""
        straight = dist(a, b)
        limit = max(straight * MAX_DETOUR, straight + MAX_EXTRA)
        src = self.project(a, SNAP_RADIUS)
        dst = self.project(b, SNAP_RADIUS)
        if not src or not dst:
            return None
        # virtual start/end nodes on the projected positions
        best = {}
        heap = []
        for _, (u, v, t, q) in src:
            for n, end in ((u, self.pts[u]), (v, self.pts[v])):
                c = dist(q, end)
                if c < best.get(n, (math.inf,))[0]:
                    best[n] = (c, None, q)
                    heapq.heappush(heap, (c, n))
        goals = {}
        for _, (u, v, t, q) in dst:
            for n in (u, v):
                c = dist(self.pts[n], q)
                if c < goals.get(n, (math.inf,))[0]:
                    goals[n] = (c, q)
        # same segment for start and end: straight along the track
        for _, (u1, v1, t1, q1) in src:
            for _, (u2, v2, t2, q2) in dst:
                if {u1, v1} == {u2, v2}:
                    return [q1, q2]
        done = set()
        found = None
        while heap:
            c, n = heapq.heappop(heap)
            if n in done:
                continue
            done.add(n)
            if c > limit:
                break
            if n in goals:
                total = c + goals[n][0]
                if found is None or total < found[0]:
                    found = (total, n)
            if found and c > found[0]:
                break
            for nb, w in self.adj[n]:
                nc = c + w
                if nc < best.get(nb, (math.inf,))[0]:
                    best[nb] = (nc, n, None)
                    heapq.heappush(heap, (nc, nb))
        if not found or not _allowed(found[0], straight):
            return None
        n = found[1]
        out = [goals[n][1]]
        while n is not None:
            out.append(self.pts[n])
            prev = best[n][1]
            if prev is None:
                out.append(best[n][2])
            n = prev
        out.reverse()
        return out


_graph = {'net': None, 'g': None}


def tram_graph(network):
    """The track graph for a /api/network result (built once per network version)."""
    if not network or not network.get('tracks'):
        return None
    if _graph['g'] is None or _graph['net'] != network.get('generated'):
        _graph['g'] = TrackGraph(network['tracks'])
        _graph['net'] = network.get('generated')
    return _graph['g']


# ---------------------------------------------------------------------------
# Bus: road route between shape points (cached, filled in the background)
# ---------------------------------------------------------------------------
_cache = {'loaded': False, 'segs': {}, 'dirty': False, 'file': None}
_lock = threading.Lock()
_queue = []
_worker = {'running': False}
CACHE_MAX = 40000
RETRY_FAILED = 7 * 86400


def init(cache_file):
    _cache['file'] = cache_file


def _load():
    if _cache['loaded']:
        return
    _cache['loaded'] = True
    try:
        if _cache['file'] and os.path.exists(_cache['file']):
            with open(_cache['file'], 'r', encoding='utf-8') as f:
                _cache['segs'] = json.load(f).get('segs') or {}
    except Exception as ex:
        print(f"[WARN] routesnap cache: {ex}")


def save():
    with _lock:
        if not _cache['dirty'] or not _cache['file']:
            return
        segs = _cache['segs']
        if len(segs) > CACHE_MAX:
            for k in sorted(segs, key=lambda k: segs[k].get('ts', 0))[:len(segs) - CACHE_MAX]:
                segs.pop(k, None)
        data = {'segs': segs}
        _cache['dirty'] = False
    try:
        tmp = _cache['file'] + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'))
        os.replace(tmp, _cache['file'])
    except Exception as ex:
        print(f"[WARN] routesnap save: {ex}")


def _cached(a, b):
    hit = _cache['segs'].get(_key(a, b))
    if hit is None:
        return None, False
    if hit.get('p') is None and time.time() - hit.get('ts', 0) > RETRY_FAILED:
        return None, False
    return hit.get('p'), True


def _missing(shape):
    out = []
    for a, b in zip(shape, shape[1:]):
        if dist(a, b) >= MIN_SEG and not _cached(a, b)[1]:
            out.append((a, b))
    return out


def _osrm_runs(pairs):
    """Group missing pairs into runs of consecutive points (one OSRM request each, ≤ 60 points)."""
    runs, cur = [], []
    for a, b in pairs:
        if cur and cur[-1] == a and len(cur) < 60:
            cur.append(b)
        else:
            if len(cur) >= 2:
                runs.append(cur)
            cur = [a, b]
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def _route_run(points, session=None):
    """One OSRM request through all points; stores one cache entry per leg."""
    coords = ';'.join(f"{p[1]:.6f},{p[0]:.6f}" for p in points)
    url = f"{OSRM_URL}{coords}?overview=false&steps=true&geometries=geojson&continue_straight=false"
    get = (session or requests).get
    resp = get(url, timeout=20, headers={'User-Agent': UA})
    if resp.status_code != 200:
        raise RuntimeError(f"OSRM HTTP {resp.status_code}")
    data = resp.json()
    if data.get('code') != 'Ok' or not data.get('routes'):
        raise RuntimeError(f"OSRM {data.get('code')}")
    legs = data['routes'][0].get('legs') or []
    now = time.time()
    with _lock:
        for i, leg in enumerate(legs):
            if i + 1 >= len(points):
                break
            a, b = points[i], points[i + 1]
            geo = []
            for st in leg.get('steps') or []:
                for lon, lat in (st.get('geometry') or {}).get('coordinates') or []:
                    q = [round(lat, 5), round(lon, 5)]
                    if not geo or geo[-1] != q:
                        geo.append(q)
            ok = len(geo) >= 2 and _allowed(float(leg.get('distance') or 0), dist(a, b))
            _cache['segs'][_key(a, b)] = {'p': geo if ok else None, 'ts': now}
        _cache['dirty'] = True


def fill_roads(shape, session=None, pause=1.1):
    """Ask the road router for every long straight piece of this shape that isn't cached yet."""
    _load()
    runs = _osrm_runs(_missing(shape))
    for i, run in enumerate(runs):
        try:
            _route_run(run, session)
        except Exception as ex:
            print(f"[WARN] routesnap: {ex}")
            break
        if i + 1 < len(runs):
            time.sleep(pause)
    save()
    return len(runs)


def queue_roads(shape):
    """Fill this shape's road pieces in the background (one worker, gentle on the server)."""
    _load()
    if not _missing(shape):
        return
    with _lock:
        if len(_queue) < 200:
            _queue.append(shape)
        if _worker['running']:
            return
        _worker['running'] = True
    threading.Thread(target=_work, daemon=True).start()


def _work():
    try:
        while True:
            with _lock:
                if not _queue:
                    break
                shape = _queue.pop(0)
            fill_roads(shape)
            time.sleep(1.1)
    finally:
        _worker['running'] = False


# ---------------------------------------------------------------------------
def snap(shape, kind, network=None):
    """Shape with long straight pieces replaced by the real way (tram: tracks, bus: roads)."""
    if not shape or len(shape) < 2 or kind not in ('tram', 'bus', 'sev'):
        return shape
    g = tram_graph(network) if kind == 'tram' else None
    if kind == 'tram' and g is None:
        return shape
    if kind != 'tram':
        _load()
    out = [list(shape[0])]
    for a, b in zip(shape, shape[1:]):
        piece = None
        if dist(a, b) >= MIN_SEG:
            if g is not None:
                try:
                    piece = g.path(a, b)
                except Exception:
                    piece = None
            else:
                piece = _cached(a, b)[0]
        if piece and len(piece) >= 2:
            # keep HAFAS's own point at both ends so stops stay where they were
            for q in piece[1:-1]:
                if dist(q, out[-1]) > 0.5:
                    out.append([round(q[0], 6), round(q[1], 6)])
        out.append(list(b))
    return out
