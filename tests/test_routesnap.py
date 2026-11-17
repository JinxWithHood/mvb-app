"""Linienwege: snapping coarse HAFAS shapes onto tram tracks and roads."""
import os
import tempfile
import unittest
from unittest import mock

import helpers  # noqa: F401  (sys.path)
import routesnap as rs
from helpers import FakeResponse

# a small "L"-shaped tram network: west->east along y=52.13, then north at x=11.64,
# plus a branch track that only touches the main line (no shared vertex)
LAT0, LON0 = 52.13, 11.62
E = lambda m: m / rs._m_lon(LAT0)          # metres -> degrees east
N = lambda m: m / rs.M_LAT                 # metres -> degrees north


def pt(east_m, north_m):
    return [LAT0 + N(north_m), LON0 + E(east_m)]


TRACKS = [
    [pt(0, 0), pt(400, 0), pt(800, 0), pt(1200, 0)],          # main line east
    [pt(1200, 0), pt(1200, 400), pt(1200, 800)],              # then north
    [pt(600, 0.5), pt(600, -500)],                             # branch south (loose end on the main line)
]
NET = {'generated': 'test-net', 'tracks': TRACKS}


class TramTests(unittest.TestCase):
    def setUp(self):
        rs._graph.update(net=None, g=None)

    def test_corner_follows_the_tracks(self):
        raw = [pt(100, 0), pt(1200, 700)]                     # HAFAS: one straight diagonal
        out = rs.snap(raw, 'tram', NET)
        self.assertGreater(len(out), 2)
        self.assertEqual(out[0], raw[0])
        self.assertEqual(out[-1], raw[-1])
        # passes the corner at (1200, 0)
        self.assertTrue(any(rs.dist(p, pt(1200, 0)) < 5 for p in out))
        length = sum(rs.dist(a, b) for a, b in zip(out, out[1:]))
        self.assertAlmostEqual(length, 1100 + 700, delta=30)

    def test_branch_is_connected(self):
        out = rs.snap([pt(100, 0), pt(600, -450)], 'tram', NET)
        self.assertTrue(any(rs.dist(p, pt(600, 0)) < 5 for p in out))

    def test_off_network_stays_straight(self):
        raw = [pt(100, 300), pt(900, 300)]                    # 300 m away from any track
        self.assertEqual(rs.snap(raw, 'tram', NET), raw)

    def test_implausible_detour_stays_straight(self):
        g = rs.tram_graph(NET)
        # from the branch end to the line's far end: allowed; a 3 km detour for 100 m is not
        self.assertIsNone(g.path(pt(600, -450), pt(700, -450)))

    def test_short_pieces_untouched(self):
        raw = [pt(100, 0), pt(130, 0)]
        self.assertEqual(rs.snap(raw, 'tram', NET), raw)

    def test_no_network_no_change(self):
        raw = [pt(100, 0), pt(1200, 700)]
        self.assertEqual(rs.snap(raw, 'tram', None), raw)
        self.assertEqual(rs.snap(raw, 'regional', NET), raw)


class RoadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        rs.init(os.path.join(self.tmp, 'rs.json'))
        rs._cache.update(loaded=False, segs={}, dirty=False)

    def osrm(self, points, legs_ok=True):
        legs = []
        for a, b in zip(points, points[1:]):
            mid = [a[0], b[1]]                                 # an "L" around the block
            d = rs.dist(a, mid) + rs.dist(mid, b)
            legs.append({'distance': d if legs_ok else d * 5,
                         'steps': [{'geometry': {'coordinates': [[a[1], a[0]], [mid[1], mid[0]], [b[1], b[0]]]}}]})
        return FakeResponse(200, {'code': 'Ok', 'routes': [{'legs': legs}]})

    def test_fill_then_snap(self):
        raw = [pt(0, 0), pt(500, 300), pt(900, 300)]
        self.assertEqual(rs.snap(raw, 'bus'), raw)             # nothing cached yet: unchanged
        sess = mock.Mock()
        sess.get.side_effect = lambda url, **kw: self.osrm(raw)
        self.assertEqual(rs.fill_roads(raw, session=sess, pause=0), 1)
        out = rs.snap(raw, 'bus')
        self.assertGreater(len(out), len(raw))
        self.assertIn([round(raw[0][0], 5), round(raw[1][1], 5)], [[round(p[0], 5), round(p[1], 5)] for p in out])
        self.assertTrue(os.path.exists(os.path.join(self.tmp, 'rs.json')))
        # cached now: no second request
        rs.fill_roads(raw, session=sess, pause=0)
        self.assertEqual(sess.get.call_count, 1)

    def test_detours_are_rejected(self):
        raw = [pt(0, 0), pt(500, 300)]
        sess = mock.Mock()
        sess.get.side_effect = lambda url, **kw: self.osrm(raw, legs_ok=False)
        rs.fill_roads(raw, session=sess, pause=0)
        self.assertEqual(rs.snap(raw, 'bus'), raw)

    def test_router_down_keeps_shape(self):
        raw = [pt(0, 0), pt(500, 300)]
        sess = mock.Mock()
        sess.get.side_effect = lambda url, **kw: FakeResponse(503)
        rs.fill_roads(raw, session=sess, pause=0)
        self.assertEqual(rs.snap(raw, 'bus'), raw)

    def test_runs_group_consecutive_pieces(self):
        a, b, c, d = pt(0, 0), pt(500, 0), pt(1000, 0), pt(3000, 0)
        runs = rs._osrm_runs([(a, b), (b, c), (c, d)])
        self.assertEqual(runs, [[a, b, c, d]])


if __name__ == '__main__':
    unittest.main()


# Real NASA shape of tram 9 (direction Reform), 17 Nov 2026: from Am Katharinenturm to Alter Markt
# HAFAS draws a 5 km loop over both Elbe bridges instead of the 370 m along Breiter Weg.
LINE9 = [[52.13781, 11.63939], [52.13660, 11.63899], [52.13451, 11.63806],    # 0..2 (2 = Am Katharinenturm)
         [52.13558, 11.63864], [52.13766, 11.63941], [52.13783, 11.63962], [52.13802, 11.64017],
         [52.13771, 11.64453], [52.13788, 11.64490], [52.13839, 11.64502], [52.13855, 11.64547],
         [52.13818, 11.64960], [52.13755, 11.65225], [52.13289, 11.66380], [52.13272, 11.66407],
         [52.13241, 11.66412], [52.12949, 11.66288], [52.12920, 11.66256], [52.12846, 11.66214],
         [52.12821, 11.66094], [52.12993, 11.64061], [52.13028, 11.63951], [52.13095, 11.63672],
         [52.13115, 11.63654], [52.13143, 11.63665], [52.13145, 11.63647]]                     # 25 = Alter Markt


class LoopTests(unittest.TestCase):
    def test_line9_loop_is_cut(self):
        out, n = rs.fix_detours(LINE9, [2, 25], 'tram', None)
        self.assertEqual(n, 1)
        self.assertFalse(any(p[1] > 11.645 for p in out))          # nothing east of the old town
        self.assertEqual(out[0], LINE9[0])
        self.assertEqual(out[-1], LINE9[-1])

    def test_normal_shape_untouched(self):
        shape = [pt(0, 0), pt(200, 0), pt(400, 10), pt(600, 0)]
        out, n = rs.fix_detours(shape, [0, 3], 'tram', None)
        self.assertEqual((out, n), (shape, 0))

    def test_unknown_stops(self):
        self.assertEqual(rs.fix_detours(LINE9, [None, 2, None], 'tram', None)[1], 0)


class TurnLoopTests(unittest.TestCase):
    def setUp(self):
        rs._graph.update(net=None, g=None)

    def test_loop_behind_the_terminus_is_drawn(self):
        loop = [pt(400, 0), pt(500, -50), pt(650, -50), pt(700, 50), pt(600, 120), pt(450, 60), pt(400, 0)]
        net = {'generated': 'loop-net', 'tracks': [[pt(0, 0), pt(400, 0)], loop]}
        arrive = [pt(0, 0), pt(400, 0), pt(500, -50)]          # ends at the stop on the loop
        leave = [pt(450, 60), pt(400, 0), pt(0, 0)]             # starts further round
        pieces = rs.turn_loops([arrive, leave], net)
        self.assertEqual(len(pieces), 1)
        p = pieces[0]
        self.assertTrue(any(rs.dist(q, pt(700, 50)) < 5 for q in p))       # goes round the far end
        self.assertLess(rs.dist(p[0], pt(500, -50)), 5)
        self.assertLess(rs.dist(p[-1], pt(450, 60)), 5)

    def test_no_loop_when_ends_meet(self):
        net = {'generated': 'stub-net', 'tracks': [[pt(0, 0), pt(400, 0)]]}
        a = [pt(0, 0), pt(400, 0)]
        b = [pt(400, 0), pt(0, 0)]
        self.assertEqual(rs.turn_loops([a, b], net), [])


class TurnLoopCloseEndsTests(unittest.TestCase):
    def setUp(self):
        rs._graph.update(net=None, g=None)

    def test_ends_only_30m_apart_still_go_round(self):
        # typical terminus: arrival stop and departure stop right next to the junction
        loop = [pt(400, 0), pt(430, -30), pt(600, -60), pt(700, 50), pt(600, 140), pt(430, 30), pt(400, 0)]
        net = {'generated': 'loop-net-2', 'tracks': [[pt(0, 0), pt(400, 0)], loop]}
        arrive = [pt(0, 0), pt(400, 0), pt(430, -30)]
        leave = [pt(430, 30), pt(400, 0), pt(0, 0)]
        pieces = rs.turn_loops([arrive, leave], net)
        self.assertEqual(len(pieces), 1)
        self.assertTrue(any(rs.dist(q, pt(700, 50)) < 5 for q in pieces[0]))


class RemoteStoreTests(unittest.TestCase):
    def test_cache_survives_a_restart_via_the_shared_store(self):
        store = {}
        tmp = tempfile.mkdtemp()
        rs.init(os.path.join(tmp, 'a.json'), remote_get=lambda: store.get('v'), remote_put=lambda v: store.__setitem__('v', v))
        rs._cache.update(loaded=True, segs={'k': {'p': [[1, 2], [3, 4]], 'ts': 1}}, dirty=True)
        rs._remote['last'] = 0
        rs.save()
        self.assertIn('v', store)
        # "restart": no file, empty memory
        rs.init(os.path.join(tmp, 'b.json'), remote_get=lambda: store.get('v'), remote_put=lambda v: None)
        rs._cache.update(loaded=False, segs={}, dirty=False)
        rs._load()
        self.assertEqual(rs._cache['segs']['k']['p'], [[1, 2], [3, 4]])
        rs.init(None)


class TurnLoopSingleDirectionTests(unittest.TestCase):
    """Line 8 at Neustädter See: only one direction known so far – the loop must still be drawn."""
    def setUp(self):
        rs._graph.update(net=None, g=None)

    LOOP = [pt(400, 0), pt(430, -30), pt(600, -60), pt(700, 50), pt(600, 140), pt(430, 30), pt(400, 0)]

    def test_one_direction_gets_its_loop(self):
        net = {'generated': 'loop-net-3', 'tracks': [[pt(0, 0), pt(400, 0)], self.LOOP]}
        only = [pt(0, 0), pt(200, 0), pt(400, 0)]                 # arrives at the junction, ends
        pieces = rs.turn_loops([only], net)
        self.assertEqual(len(pieces), 1)
        self.assertTrue(any(rs.dist(q, pt(700, 50)) < 5 for q in pieces[0]))
        length = sum(rs.dist(a, b) for a, b in zip(pieces[0], pieces[0][1:]))
        self.assertGreater(length, 400)

    def test_city_block_driven_by_other_lines_is_not_a_loop(self):
        net = {'generated': 'block-net', 'tracks': [[pt(0, 0), pt(400, 0)], self.LOOP]}
        only = [pt(0, 0), pt(200, 0), pt(400, 0)]
        other_line = self.LOOP[1:-1]                               # another line runs round this "block"
        self.assertEqual(rs.turn_loops([only], net, others=[other_line]), [])

    def test_dead_end_has_no_loop(self):
        net = {'generated': 'stub-net-2', 'tracks': [[pt(0, 0), pt(400, 0)]]}
        self.assertEqual(rs.turn_loops([[pt(0, 0), pt(400, 0)]], net), [])
