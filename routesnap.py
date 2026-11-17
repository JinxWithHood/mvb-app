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
        """Insert a node at q on segment u–v (the old edge goes: a shortcut u–v next to u–m–v
        would let a search run out along the track and straight back on the same rails)."""
        if dist(q, self.pts[u]) < 1.5:
            return u
        if dist(q, self.pts[v]) < 1.5:
            return v
        m = len(self.pts)
        self.pts.append([q[0], q[1]])
        self.adj.append([])
        self.adj[u] = [(n, w) for n, w in self.adj[u] if n != v]
        self.adj[v] = [(n, w) for n, w in self.adj[v] if n != u]
        self.segs = [sg for sg in self.segs if sg not in ((u, v), (v, u))]
        self._edge(u, m)
        self._edge(m, v)
        self._index()
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


_remote = {'get': None, 'put': None, 'last': 0.0}
REMOTE_EVERY = 600          # seconds between uploads of the cache to the shared store


def init(cache_file, remote_get=None, remote_put=None):
    """remote_get/put: optional shared store (Upstash) so the cache survives server restarts."""
    _cache['file'] = cache_file
    _remote.update(get=remote_get, put=remote_put)


def pack(obj):
    import base64
    import zlib
    return base64.b64encode(zlib.compress(json.dumps(obj, separators=(',', ':')).encode(), 9)).decode()


def unpack(text):
    import base64
    import zlib
    return json.loads(zlib.decompress(base64.b64decode(text)).decode())


def _load():
    if _cache['loaded']:
        return
    _cache['loaded'] = True
    try:
        if _cache['file'] and os.path.exists(_cache['file']):
            with open(_cache['file'], 'r', encoding='utf-8') as f:
                _cache['segs'] = json.load(f).get('segs') or {}
        elif _remote['get']:
            packed = _remote['get']()
            if isinstance(packed, str) and packed:
                _cache['segs'] = unpack(packed).get('segs') or {}
                _remote['last'] = time.time()
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
    if _remote['put'] and time.time() - _remote['last'] > REMOTE_EVERY:
        _remote['last'] = time.time()
        try:
            _remote['put'](pack(data))
        except Exception as ex:
            print(f"[WARN] routesnap upload: {ex}")


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


_net_lock = threading.Lock()     # one road request at a time (gentle on the public server)


def fill_roads(shape, session=None, pause=1.1):
    """Ask the road router for every long straight piece of this shape that isn't cached yet."""
    _load()
    with _net_lock:
        runs = _osrm_runs(_missing(shape))    # inside the lock: pieces another thread just got are skipped
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


# ---------------------------------------------------------------------------
# Broken HAFAS shapes: a loop between two neighbouring stops
# ---------------------------------------------------------------------------
LOOP_FACTOR = 2.5       # shape between two stops this many times longer than their distance …
LOOP_EXTRA = 700        # … and at least this many metres longer = not the real way


def fix_detours(shape, stop_idx, kind, network=None):
    """HAFAS sometimes draws a tram from one stop to the next via a 5 km loop (e.g. line 9
    Am Katharinenturm -> Alter Markt over both Elbe bridges). Between two neighbouring stops
    such a piece is replaced by the shortest track path (tram) or a straight line (bus: the
    road snapping then routes it). stop_idx: the stops' indexes in `shape` (None = unknown)."""
    idx = [i for i in (stop_idx or []) if i is not None]
    if len(shape) < 3 or len(idx) < 2:
        return shape, 0
    g = tram_graph(network) if kind == 'tram' else None
    out, last, fixed = [], 0, 0
    for a, b in zip(idx, idx[1:]):
        if b <= a:
            continue
        piece = shape[a:b + 1]
        length = sum(dist(p, q) for p, q in zip(piece, piece[1:]))
        straight = dist(shape[a], shape[b])
        if length > max(straight * LOOP_FACTOR, straight + LOOP_EXTRA):
            repl = None
            if g is not None:
                try:
                    repl = g.path(shape[a], shape[b])
                except Exception:
                    repl = None
            if not repl:
                repl = [shape[a], shape[b]]
            out.extend(shape[last:a])
            out.append(list(shape[a]))
            out.extend([list(p) for p in repl[1:-1]])
            last = b
            fixed += 1
    if not fixed:
        return shape, 0
    out.extend(shape[last:])
    return out, fixed


# ---------------------------------------------------------------------------
# Wendeschleifen: the trip shapes end at the last stop, so the turning loop behind it was
# never drawn. Join "arrives here" with "leaves from here" along the tracks – preferring
# track the line itself does not use, so the path goes round the loop, not back over the
# junction.
# ---------------------------------------------------------------------------
LOOP_MAX_GAP = 350      # arrival end and departure start at most this far apart
LOOP_MAX_LEN = 2500     # a loop is never longer than this


def _seg_dist(p, a, b):
    kx = _m_lon(p[0])
    ax, ay = (a[1] - p[1]) * kx, (a[0] - p[0]) * M_LAT
    bx, by = (b[1] - p[1]) * kx, (b[0] - p[0]) * M_LAT
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy
    t = 0.0 if ll == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / ll))
    return math.hypot(ax + t * dx, ay + t * dy)


def _loop_path(g, e, s, own_segs):
    """Track path e -> s; edges along the line's own shapes cost 25x (so it goes round the loop)."""
    src = g.project(e, SNAP_RADIUS)
    dst = g.project(s, SNAP_RADIUS)
    if not src or not dst:
        return None

    def near_own(p):
        return any(_seg_dist(p, a, b) < 9 for a, b in own_segs)

    def cost(a, b):
        w = dist(a, b)
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        return w * (25 if near_own(mid) else 1), w

    best, heap = {}, []
    for _, (u, v, t, q) in src:
        for n in (u, v):
            c, w = cost(q, g.pts[n])
            if c < best.get(n, (math.inf,))[0]:
                best[n] = (c, None, q, w)
                heapq.heappush(heap, (c, n))
    goals = {}
    for _, (u, v, t, q) in dst:
        for n in (u, v):
            c, _ = cost(g.pts[n], q)
            if c < goals.get(n, (math.inf,))[0]:
                goals[n] = (c, q)
    found, done = None, set()
    while heap:
        c, n = heapq.heappop(heap)
        if n in done:
            continue
        done.add(n)
        real = best[n][3]
        if real > LOOP_MAX_LEN:
            continue
        if n in goals and (found is None or c + goals[n][0] < found[0]):
            found = (c + goals[n][0], n)
        if found and c > found[0]:
            break
        for nb, w in g.adj[n]:
            nc = c + cost(g.pts[n], g.pts[nb])[0]
            if nc < best.get(nb, (math.inf,))[0]:
                best[nb] = (nc, n, None, real + w)
                heapq.heappush(heap, (nc, nb))
    if not found:
        return None
    n = found[1]
    out = [goals[n][1]]
    while n is not None:
        out.append(g.pts[n])
        prev = best[n][1]
        if prev is None:
            out.append(best[n][2])
        n = prev
    out.reverse()
    return out


def _near_segs(p, segs, limit):
    return any(_seg_dist(p, a, b) < limit for a, b in segs)


def _loop_from_end(g, e, prev, own_tail, others):
    """A turning loop behind the line's end e (arriving from prev), found in the track graph
    alone: leave e forwards, never straight back over the incoming track, and come back to
    within ~60 m of e. Rejected when it is really a city block that other lines drive through."""
    hits = g.project(e, SNAP_RADIUS)
    if not hits:
        return None
    _, (u, w, t, q) = hits[0]
    kx = _m_lon(e[0])
    vx, vy = (e[1] - prev[1]) * kx, (e[0] - prev[0]) * M_LAT
    if math.hypot(vx, vy) < 1:
        return None

    def ahead_of(n):
        p = g.pts[n]
        return (p[1] - q[1]) * kx * vx + (p[0] - q[0]) * M_LAT * vy

    start = u if ahead_of(u) > ahead_of(w) else w
    if ahead_of(start) <= 0:
        return None
    if _near_segs([(q[0] + g.pts[start][0]) / 2, (q[1] + g.pts[start][1]) / 2], own_tail, 4):
        return None                                       # 'ahead' is where it came from: no loop here
    seg_ab = (g.pts[u], g.pts[w])

    def blocked(a, b):
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        if _seg_dist(mid, *seg_ab) < 1.0 and _seg_dist(a, *seg_ab) < 1.0 and _seg_dist(b, *seg_ab) < 1.0:
            return True                                   # the incoming segment itself
        return _near_segs(mid, own_tail, 4)               # straight back on the track it came in on

    best = {start: (dist(q, g.pts[start]), None)}
    heap = [(best[start][0], start)]
    done, found = set(), None
    while heap:
        c, n = heapq.heappop(heap)
        if n in done:
            continue
        done.add(n)
        if c > LOOP_SEARCH_MAX:
            break
        if c >= 120 and dist(g.pts[n], e) <= 60:
            found = n
            break
        for nb, wgt in g.adj[n]:
            if blocked(g.pts[n], g.pts[nb]):
                continue
            nc = c + wgt
            if nc < best.get(nb, (math.inf,))[0]:
                best[nb] = (nc, n)
                heapq.heappush(heap, (nc, nb))
    if found is None:
        return None
    path, n = [], found
    while n is not None:
        path.append(g.pts[n])
        n = best[n][1]
    path.append(q)
    path.reverse()
    total = sum(dist(a, b) for a, b in zip(path, path[1:]))
    if others:
        shared = sum(dist(a, b) for a, b in zip(path, path[1:])
                     if _near_segs([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], others, 9))
        if shared > 0.4 * total:
            return None                                   # a block other lines run round: not a loop
    return path


LOOP_SEARCH_MAX = 1200


def turn_loops(shapes, network, others=None):
    """Extra pieces that close the turning loops at the line's ends (trams only).
    others: shapes of the other tram lines (to tell a turning loop from a city block)."""
    g = tram_graph(network)
    shapes = [s for s in shapes or [] if len(s) >= 2]
    if g is None or not shapes:
        return []
    out = turn_loops_paired(g, shapes) if len(shapes) >= 2 else []
    # ends that the pairing didn't close (one direction only, or no partner nearby)
    closed = [p for piece in out for p in (piece[0], piece[-1])]
    other_segs = []
    for sh in others or []:
        other_segs.extend(zip(sh, sh[1:]))
    seen = []
    def back_point(pts):
        # direction of travel at the end: from a point ≥ 40 m back (the last metres are often noisy)
        for p in pts[1:]:
            if dist(p, pts[0]) >= 40:
                return p
        return pts[-1]

    for sh in shapes:
        for e, prev, tail in ((sh[-1], back_point(sh[::-1]), sh[-8:]), (sh[0], back_point(sh), sh[:8])):
            if any(dist(e, c) < 80 for c in closed) or any(dist(e, c) < 120 for c in seen):
                continue
            near_other = [(a, b) for a, b in other_segs if min(dist(a, e), dist(b, e)) < 1500]
            try:
                path = _loop_from_end(g, e, prev, list(zip(tail, tail[1:])), near_other)
            except Exception:
                path = None
            if path:
                seen.append(e)
                out.append([[round(p[0], 6), round(p[1], 6)] for p in path])
    return out


def turn_loops_paired(g, shapes):
    out, done = [], set()
    for i, a in enumerate(shapes):
        e = a[-1]
        best = None
        for j, b in enumerate(shapes):
            if i == j:
                continue
            d = dist(e, b[0])
            if d <= LOOP_MAX_GAP and (best is None or d < best[0]):
                best = (d, b[0])
        if not best:
            continue
        s = best[1]
        key = (round(e[0], 4), round(e[1], 4), round(s[0], 4), round(s[1], 4))
        if key in done:
            continue
        done.add(key)
        own = []
        for sh in shapes:
            for p, q in zip(sh, sh[1:]):
                if min(dist(p, e), dist(q, e)) < 1500:
                    own.append((p, q))
        try:
            path = _loop_path(g, e, s, own)
        except Exception:
            path = None
        if not path:
            continue
        length = sum(dist(p, q) for p, q in zip(path, path[1:]))
        if length < max(80, best[0] * 1.6):        # already joined: nothing to close
            continue
        out.append([[round(p[0], 6), round(p[1], 6)] for p in path])
    return out
