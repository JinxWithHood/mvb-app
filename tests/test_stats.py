"""Pünktlichkeits-Statistik und Störungen auf der Karte."""
import datetime
import unittest
from unittest import mock

import helpers  # noqa: F401
import stats
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Europe/Berlin')
T0 = datetime.datetime(2026, 11, 26, 8, 0, tzinfo=TZ).timestamp()


def veh(jid, short, stop, delay, typ='tram', rt='ok'):
    return {'id': jid, 'short': short, 'type': typ, 'nextStop': stop, 'delay': delay, 'rtState': rt, 'color': '#123456'}


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.store = {}
        self.s = stats.Stats(TZ, self.store.get, self.store.__setitem__)

    def run_trip(self):
        s = self.s
        s.observe([veh('a', '4', 'Alter Markt', 1), veh('b', '52', 'ZOB', 6, 'bus')], T0)
        s.observe([veh('a', '4', 'Alter Markt', 2), veh('b', '52', 'ZOB', 7, 'bus')], T0 + 60)
        s.observe([veh('a', '4', 'Hasselbachplatz', 2), veh('b', '52', 'Hbf', 7, 'bus')], T0 + 120)   # both passed a stop
        s.observe([veh('a', '4', 'Hasselbachplatz', -3)], T0 + 180)                                   # b vanished
        s.observe([], T0 + 180 + 700)                                                                  # a and b gone > 10 min

    def test_counts_one_value_per_stop(self):
        self.run_trip()
        out = self.s.summary(datetime.date(2026, 11, 26), datetime.date(2026, 11, 26))
        lines = {l['key']: l for l in out['lines']}
        self.assertEqual(lines['tram:4']['n'], 2)          # Alter Markt (+2) and the last stop (-3)
        self.assertEqual(lines['tram:4']['early'], 50.0)
        self.assertEqual(lines['tram:4']['onTime'], 50.0)
        self.assertEqual(lines['bus:52']['n'], 2)          # ZOB (+7) and Hbf (+7)
        self.assertEqual(lines['bus:52']['late'], 100.0)
        self.assertEqual(lines['bus:52']['avgLate'], 7.0)
        self.assertEqual(out['total']['n'], 4)
        self.assertEqual([l['key'] for l in out['lines']], ['tram:4', 'bus:52'])   # trams first

    def test_unverified_realtime_is_not_counted(self):
        self.s.observe([veh('a', '4', 'A', 30, rt='unverified')], T0)
        self.s.observe([veh('a', '4', 'B', 0)], T0 + 60)
        out = self.s.summary(datetime.date(2026, 11, 26), datetime.date(2026, 11, 26))
        self.assertEqual(out['total']['n'], 0)

    def test_saved_per_month_and_reloaded(self):
        self.run_trip()
        self.assertEqual(self.s.flush(), ['2026-11'])
        fresh = stats.Stats(TZ, self.store.get, self.store.__setitem__)
        out = fresh.summary(datetime.date(2026, 11, 20), datetime.date(2026, 11, 26))
        self.assertEqual(out['total']['n'], 4)
        self.assertEqual(len(out['trend']), 7)
        self.assertEqual(fresh.first_day(), datetime.date(2026, 11, 26)) if datetime.date.today().year == 2026 else None

    def test_disruptions_of_the_day(self):
        s = self.s
        s.observe_disruptions([{'id': 'x1', 'title': 'Sperrung Breiter Weg', 'desc': 'Linie 9 fährt eine Umleitung.', 'lines': ['Linie 9']}], T0)
        s.observe_disruptions([{'id': 'x1', 'title': 'Sperrung Breiter Weg', 'desc': 'Erledigt – die Linie 9 fährt wieder regulär.', 'lines': ['Linie 9']}], T0 + 600)
        out = s.summary(datetime.date(2026, 11, 26), datetime.date(2026, 11, 26))
        self.assertEqual(len(out['disruptions']), 1)
        d = out['disruptions'][0]
        self.assertTrue(d['done'])
        self.assertEqual(d['days'], ['2026-11-26'])

    def test_done_words(self):
        self.assertTrue(stats._looks_done({'title': 'ERLEDIGT: Störung Linie 1'}))
        self.assertFalse(stats._looks_done({'title': 'Störung Linie 1', 'desc': 'Die Bahnen fahren eine Umleitung.'}))


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import backend
        cls.b = backend

    def test_stats_endpoint(self):
        store = {}
        s = stats.Stats(self.b.local_tz, store.get, store.__setitem__)
        now = datetime.datetime.now(self.b.local_tz).timestamp()
        s.observe([veh('a', '9', 'A', 1)], now - 120)
        s.observe([veh('a', '9', 'B', 1)], now - 60)
        with mock.patch.object(self.b, '_stats', s):
            c = self.b.app.test_client()
            d = c.get('/api/stats').get_json()
            self.assertEqual(d['range'], 'day')
            self.assertEqual(d['lines'][0]['key'], 'tram:9')
            self.assertEqual(d['lines'][0]['onTime'], 100.0)
            w = c.get('/api/stats?range=week').get_json()
            self.assertEqual(len(w['trend']), 7)
            old = c.get('/api/stats?date=2020-01-01').get_json()
            self.assertEqual(old['to'], old['earliest'])                   # clamped to one year back
            self.assertEqual(c.get('/api/stats?date=gestern').status_code, 400)
            self.assertEqual(c.get('/api/stats?range=decade').status_code, 400)

    def test_line_keys_from_message(self):
        known = {'tram:2', 'tram:9', 'bus:52', 'tram:4'}
        f = self.b._disr_line_keys
        self.assertEqual(f({'lines': ['Linie 2', 'Linie 9']}, known), ['tram:2', 'tram:9'])
        self.assertEqual(f({'title': 'Linien 2 und 9: Umleitung', 'lines': []}, known), ['tram:2', 'tram:9'])
        self.assertEqual(f({'lines': ['Buslinie 52']}, known), ['bus:52'])
        self.assertEqual(f({'lines': ['Linie 99']}, known), [])

    def test_diversion_geometry(self):
        b = self.b
        regular = [[[52.130, 11.600], [52.130, 11.610], [52.130, 11.620], [52.130, 11.630]]]      # straight east
        live = [[52.130, 11.600], [52.130, 11.608], [52.134, 11.610], [52.134, 11.620],             # bends north …
                [52.130, 11.622], [52.130, 11.630]]                                                  # … and back
        lines = {'tram:2': {'shapes': {'A': {'pts': live}}}}
        keys, detour, closed, named = b._disruption_geometry(
            {'lines': ['Linie 2'], 'title': 'Sperrung', 'desc': 'Die Haltestelle Musterplatz entfällt.'},
            lines, {'2': regular}, {'Musterplatz': (52.13, 11.615)})
        self.assertEqual(keys, ['tram:2'])
        self.assertTrue(detour['tram:2'] and all(p[0] > 52.1325 for p in detour['tram:2'][0]))
        self.assertTrue(closed['tram:2'])
        self.assertEqual([n['name'] for n in named], ['Musterplatz'])


if __name__ == '__main__':
    unittest.main()
