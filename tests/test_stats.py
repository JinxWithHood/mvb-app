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

    def test_early_only_from_three_minutes(self):
        h = [0] * (stats.H_MAX - stats.H_MIN + 1)
        for d in (-2, -3, -4, 2, 3, 4, 5, 9):
            h[d - stats.H_MIN] += 1
        m = stats._metrics(h)
        # -3/-4 early · -2/+2 on time · +3/+4 slightly late · +5/+9 late
        self.assertEqual((m['early'], m['onTime'], m['slight'], m['late']), (25.0, 25.0, 25.0, 25.0))
        self.assertEqual(m['avgLate'], 5.2)                                          # (3+4+5+9)/4

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

    def test_stop_id_falls_back_to_name_search(self):
        class Loc:
            def __init__(self, i, n): self.id, self.name = i, n
        fake = mock.Mock()
        fake.nearby.side_effect = RuntimeError('nearby not answered')
        fake.locations.return_value = [Loc('1', 'Magdeburg, Alter Markt'), Loc('2', 'Magdeburg, Hasselbachplatz')]
        self.b._stop_id_cache.clear()
        with mock.patch.object(self.b, 'nasa_client', fake):
            d = self.b.app.test_client().get('/api/stop-id?name=Hasselbachplatz&lat=52.12&lon=11.63').get_json()
        self.assertEqual(d['id'], '2')
        self.assertIn('Hasselbachplatz', fake.locations.call_args[0][0])

    def test_line_keys_from_message(self):
        known = {'tram:2', 'tram:9', 'bus:52', 'tram:4'}
        f = self.b._disr_line_keys
        self.assertEqual(f({'lines': ['Linie 2', 'Linie 9']}, known), ['tram:2', 'tram:9'])
        self.assertEqual(f({'title': 'Linien 2 und 9: Umleitung', 'lines': []}, known), ['tram:2', 'tram:9'])
        self.assertEqual(f({'lines': ['Buslinie 52']}, known), ['bus:52'])
        self.assertEqual(f({'lines': ['Linie 99']}, known), ['line:99'])            # not on the map now: still named
        # night lines keep their N (and are not mixed up with tram 1 / 4)
        self.assertEqual(f({'lines': ['Linie N1', 'Linie N4']}, known | {'bus:N4'}), ['bus:N1', 'bus:N4'])
        self.assertEqual(f({'title': 'Nachtlinie N 8: Umleitung', 'lines': []}, known), ['bus:N8'])

    def test_real_message_n9_nordwest(self):
        b = self.b
        it = {'title': 'Linien 72 und N9: Umleitung wegen Bauarbeiten', 'lines': ['Linie 72', 'Linie N9'],
              'desc': 'Linien 72 und N9:Ab Montag, den 8. Juni, kommt es in Magdeburg-Nordwest aufgrund von Bauarbeiten für eine '
                      'Fernwärmeleitung zu einer Umleitung.\nDie Hugo-Junkers-Allee wird zur Einbahnstraße. Daher können die Haltestellen '
                      'Schule Nordwest, Juliusstraße, Lorenzweg, Ostrowskistraße und Boquet-Graseweg in Fahrtrichtung Olvenstedter Platz nicht bedient werden.'}
        self.assertEqual(b._disr_line_keys(it, {'bus:72', 'tram:9'}), ['bus:72', 'bus:N9'])      # N9, not tram 9
        self.assertEqual(dict(b._streets_in(it)).get('Hugo-Junkers-Allee'), 'closed')
        self.assertNotIn('Einbahnstraße', dict(b._streets_in(it)))
        stops = {n: (52.15 + i * 0.001, 11.58) for i, n in enumerate(['Schule Nordwest', 'Juliusstraße', 'Lorenzweg', 'Ostrowskistraße', 'Boquet-Graseweg'])}
        _, _, closed, named, pins = b._disruption_geometry(it, {}, {}, stops,
                                                           geocode=lambda st: [[[52.15, 11.57], [52.152, 11.575]]] if st == 'Hugo-Junkers-Allee' else None)
        self.assertEqual(len(named), 5)
        self.assertEqual(len(pins), 1)                                                           # not five
        self.assertEqual(pins[0]['label'], 'Hugo-Junkers-Allee')

    def test_kind_of_disruption(self):
        k = self.b._disruption_kind
        self.assertEqual(k({'title': 'Unfall an der Haltestelle Hasselbachplatz', 'desc': 'Die Polizei ist vor Ort.'}), 'accident')
        self.assertEqual(k({'title': 'Sperrung Maybachstraße', 'desc': 'Wegen Bauarbeiten …'}), 'construction')
        self.assertEqual(k({'title': 'Polizeieinsatz', 'desc': ''}), 'police')
        self.assertEqual(k({'title': 'Linie 4', 'desc': 'Wegen einer Fahrzeugstörung kommt es zu Verspätungen.'}), 'defect')
        self.assertEqual(k({'title': 'Hinweis', 'desc': 'Bitte beachten.'}), 'other')

    def test_one_pin_and_one_place_per_message(self):
        b = self.b
        # the same street name twice (Magdeburg and a village nearby) + five stops in the text
        here = [[52.130, 11.612], [52.130, 11.618]]
        elsewhere = [[52.050, 11.700], [52.050, 11.706]]
        stops = {f'Halt {i}': (52.13 + i * 0.001, 11.615) for i in range(5)}
        live = [[52.129, 11.600], [52.129, 11.630]]
        keys, detour, closed, named, pins = b._disruption_geometry(
            {'lines': ['Linie 2'], 'title': 'Unfall Musterweg', 'desc': 'Der Musterweg ist gesperrt. Ersatzhaltestellen: ' + ', '.join(stops) + '.'},
            {'tram:2': {'shapes': {'A': {'pts': live}}}}, {}, stops, geocode=lambda st: [here, elsewhere] if st == 'Musterweg' else None)
        self.assertEqual(len(pins), 1)
        self.assertEqual(closed['Musterweg'], [here])

    def test_diversion_geometry(self):
        b = self.b
        regular = [[[52.130, 11.600], [52.130, 11.610], [52.130, 11.620], [52.130, 11.630]]]      # straight east
        live = [[52.130, 11.600], [52.130, 11.608], [52.134, 11.610], [52.134, 11.620],             # bends north …
                [52.130, 11.622], [52.130, 11.630]]                                                  # … and back
        far = [[52.10, 11.70], [52.10, 11.71], [52.104, 11.712], [52.104, 11.72], [52.10, 11.722]]  # another bend, 5 km away
        lines = {'tram:2': {'shapes': {'A': {'pts': live}, 'B': {'pts': far}}}}
        musterweg = [[52.130, 11.612], [52.130, 11.618]]
        geo = {'Musterweg': [musterweg]}
        keys, detour, closed, named, pins = b._disruption_geometry(
            {'lines': ['Linie 2'], 'title': 'Sperrung Musterweg', 'desc': 'Wegen Bauarbeiten ist der Musterweg gesperrt, die Linie 2 wird umgeleitet. Die Haltestelle Musterplatz entfällt.'},
            lines, {'2': regular + [[[52.10, 11.70], [52.10, 11.73]]]}, {'Musterplatz': (52.13, 11.615)}, geocode=lambda st: geo.get(st))
        self.assertEqual(keys, ['tram:2'])
        self.assertEqual(list(closed), ['Musterweg'])                       # the street from the message, not a route diff
        self.assertEqual(len(detour['tram:2']), 1)                          # only the bend near the closed street
        self.assertTrue(all(p[0] > 52.1325 for p in detour['tram:2'][0]))
        self.assertEqual([n['name'] for n in named], ['Musterplatz'])
        self.assertEqual(pins[0]['label'], 'Musterweg')

    def test_no_diversion_from_an_outdated_osm_route(self):
        """Line 9 runs differently than OSM knows: without a closed street + 'Umleitung' nothing is dashed."""
        b = self.b
        live = [[52.130, 11.600], [52.134, 11.610], [52.134, 11.620], [52.130, 11.630]]
        stops = {'Lorenzweg': (52.134, 11.615)}
        _, detour, _, _, _ = b._disruption_geometry(
            {'lines': ['Linie 9'], 'title': 'Linie 9: Umleitung', 'desc': 'Die Haltestelle Lorenzweg wird nicht bedient.'},
            {'tram:9': {'shapes': {'A': {'pts': live}}}}, {'9': [[[52.130, 11.600], [52.130, 11.630]]]}, stops, geocode=lambda st: None)
        self.assertEqual(detour, {})

    def test_no_place_no_geometry(self):
        """Without a street or stop to anchor it, nothing is guessed onto the map (no red lines elsewhere)."""
        b = self.b
        live = [[52.130, 11.600], [52.134, 11.610], [52.130, 11.630]]
        keys, detour, closed, named, pins = b._disruption_geometry(
            {'lines': ['Linie 2'], 'title': 'Fahrzeugstörung', 'desc': 'Es kommt zu Verspätungen.'},
            {'tram:2': {'shapes': {'A': {'pts': live}}}}, {'2': [[[52.12, 11.60], [52.12, 11.63]]]}, {}, geocode=lambda st: None)
        self.assertEqual((detour, closed, named, pins), ({}, {}, [], []))

    def test_maybachstrasse_at_the_zob(self):
        b = self.b
        found = b._streets_in({'title': 'Sperrung Maybachstraße', 'desc': 'Wegen Bauarbeiten ist die Maybachstraße am ZOB gesperrt. '
                               'Die Linien 52 und 73 werden über die Otto-von-Guericke-Straße umgeleitet.'})
        self.assertIn(('Maybachstraße', 'closed'), found)
        self.assertIn(('Otto-von-Guericke-Straße', 'detour'), found)
        found = b._streets_in({'title': 'Bauarbeiten Halberstädter Str.', 'desc': 'Die Halberstädter Straße ist zwischen Kroatenweg und Ambrosiusplatz gesperrt.'})
        self.assertEqual(dict(found), {'Halberstädter Straße': 'closed', 'Kroatenweg': 'bound', 'Ambrosiusplatz': 'bound'})
        self.assertIn(('Breiter Weg', 'closed'), b._streets_in({'title': 'Unfall', 'desc': 'Wegen eines Unfalls im Breiten Weg ist die Strecke gesperrt.'}))

    def test_closed_part_between_two_cross_streets(self):
        b = self.b
        street = [[52.12, 11.60 + i * 0.002] for i in range(30)]           # ~4 km long
        geo = {'Langestraße': [street], 'Ostweg': [[[52.115, 11.61], [52.125, 11.61]]][0], 'Westweg': [[[52.115, 11.62], [52.125, 11.62]]][0]}
        geo = {k: (v if isinstance(v[0][0], list) else [v]) for k, v in geo.items()}
        _, _, closed, _, _ = b._disruption_geometry(
            {'lines': [], 'title': 'Sperrung', 'desc': 'Die Langestraße ist zwischen Ostweg und Westweg gesperrt.'}, {}, {}, {}, geocode=lambda st: geo.get(st))
        lons = [p[1] for run in closed['Langestraße'] for p in run]
        self.assertTrue(min(lons) >= 11.607 and max(lons) <= 11.623, (min(lons), max(lons)))


if __name__ == '__main__':
    unittest.main()
