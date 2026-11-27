"""Fahrtenschreiber: Wagennummern zu Linie und Uhrzeit eintragen."""
import datetime
import tempfile
import unittest
from unittest import mock

import helpers  # noqa: F401


class FahrtenschreiberTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import backend
        import fahrtenschreiber
        cls.b, cls.f = backend, fahrtenschreiber

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.kv = {}
        self.patches = [mock.patch.object(self.b, 'CACHE_DIR', self.tmp),
                        mock.patch.object(self.b, '_kv_get', lambda k: self.kv.get(k)),
                        mock.patch.object(self.b, '_kv_set', lambda k, v, background=True: self.kv.__setitem__(k, v))]
        for p in self.patches:
            p.start()
        self.f._months.clear()
        self.f._rate.clear()
        self.c = self.b.app.test_client()
        self.today = datetime.datetime.now(self.b.local_tz).date().isoformat()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def add(self, dev='device-aaaa1111', **kw):
        body = {'line': '4', 'vehicles': ['1309', '1310'], 'date': self.today, 'time': '07:31', 'direction': 'Cracau'} | kw
        return self.c.post('/api/fts/entries', json=body, headers={'X-Device': dev})

    def test_page_is_served(self):
        for path in ('/Fahrtenschreiber', '/fahrtenschreiber'):
            r = self.c.get(path)
            self.assertEqual(r.status_code, 200)
            self.assertIn(b'Fahrtenschreiber', r.data)
            r.close()

    def test_add_list_and_saved_per_month(self):
        r = self.add()
        self.assertEqual(r.status_code, 201)
        e = r.get_json()['entry']
        self.assertEqual((e['line'], e['vehicles'], e['type']), ('4', ['1309', '1310'], 'tram'))
        self.assertNotIn('dev', e)
        self.assertIn(f'fts:{self.today[:7]}', self.kv)
        d = self.c.get('/api/fts/entries', headers={'X-Device': 'device-aaaa1111'}).get_json()
        self.assertEqual(d['count'], 1)
        self.assertTrue(d['entries'][0]['mine'])
        other = self.c.get('/api/fts/entries', headers={'X-Device': 'device-bbbb2222'}).get_json()
        self.assertFalse(other['entries'][0]['mine'])
        # filters
        self.assertEqual(self.c.get('/api/fts/entries?vehicle=131').get_json()['count'], 1)
        self.assertEqual(self.c.get('/api/fts/entries?vehicle=99').get_json()['count'], 0)
        self.assertEqual(self.c.get('/api/fts/entries?line=5').get_json()['count'], 0)
        # a fresh process reads it back from the store
        self.f._months.clear()
        self.assertEqual(self.c.get('/api/fts/entries').get_json()['count'], 1)

    def test_validation(self):
        self.assertEqual(self.add(vehicles=[]).status_code, 400)
        self.assertEqual(self.add(vehicles=['13 09x!']).status_code, 400)
        self.assertEqual(self.add(line='').status_code, 400)
        self.assertEqual(self.add(time='25:00').status_code, 400)
        self.assertEqual(self.add(date='2020-01-01').status_code, 400)
        self.assertEqual(self.add(line='N9', vehicles=['2001']).get_json()['entry']['type'], 'night')

    def test_only_own_device_can_delete(self):
        e = self.add().get_json()['entry']
        month = e['date'][:7]
        r = self.c.delete(f"/api/fts/entries/{e['id']}?month={month}", headers={'X-Device': 'device-bbbb2222'})
        self.assertEqual(r.status_code, 403)
        r = self.c.delete(f"/api/fts/entries/{e['id']}?month={month}", headers={'X-Device': 'device-aaaa1111'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.c.get('/api/fts/entries').get_json()['count'], 0)

    def test_vehicles_and_csv(self):
        self.add()
        self.add(line='6', vehicles=['1309'], time='09:10', direction='Diesdorf')
        v = {r['vehicle']: r for r in self.c.get('/api/fts/vehicles').get_json()['vehicles']}
        self.assertEqual(v['1309']['count'], 2)
        self.assertEqual(v['1309']['last']['line'], '6')
        self.assertEqual(v['1309']['with'], ['1310'])
        csv = self.c.get('/api/fts/export.csv').data.decode('utf-8-sig')
        self.assertIn('Datum;Tagesart;Uhrzeit;Linie;Kurs;Wagen;Typ;Ort;Richtung', csv)
        self.assertIn('07:31;4;;1309+1310;NGT8D;;Cracau', csv)

    def test_day_types(self):
        f, D = self.f, datetime.date
        self.assertEqual(f.day_type(D(2026, 11, 27)), 'wt')     # Freitag
        self.assertEqual(f.day_type(D(2026, 11, 28)), 'sa')
        self.assertEqual(f.day_type(D(2026, 11, 29)), 'so')
        self.assertEqual(f.day_type(D(2026, 4, 3)), 'so')       # Karfreitag 2026
        self.assertEqual(f.day_type(D(2026, 5, 14)), 'so')      # Himmelfahrt 2026
        self.assertEqual(f.day_type(D(2026, 10, 31)), 'so')     # Reformationstag (Sachsen-Anhalt)
        self.assertEqual(f.day_type(D(2026, 1, 6)), 'so')       # Heilige Drei Könige (Sachsen-Anhalt)
        self.assertEqual(f.day_type(D(2026, 12, 24)), 'sa')
        self.assertEqual(self.c.get('/api/fts/daytype?date=2026-11-28').get_json()['label'], 'Samstag')

    def test_kurs_and_place_are_stored(self):
        e = self.add(kurs='4/03', stop='Alter Markt', start='06:12', origin='Cracau').get_json()['entry']
        self.assertEqual((e['kurs'], e['stop'], e['start']), ('4/03', 'Alter Markt', '06:12'))
        self.assertIn(e['dayType'], ('wt', 'sa', 'so'))
        self.assertEqual(self.add(kurs='!!!').status_code, 400)
        self.add(vehicles=['1412'], time='08:15', stop='Hasselbachplatz')           # no Kurs
        d = self.c.get('/api/fts/courses?line=4').get_json()
        rows = d['courses']
        self.assertEqual(rows[0]['kurs'], '4/03')
        self.assertEqual(len(d['withoutKurs']), 1)
        self.assertEqual((d['withoutKurs'][0]['time'], d['withoutKurs'][0]['type'], d['withoutKurs'][0]['stop']), ('08:15', 'Flexity', 'Hasselbachplatz'))
        self.assertEqual(rows[0]['vehicles'][0][0], '1309')
        csv = self.c.get('/api/fts/export.csv').data.decode('utf-8-sig')
        self.assertIn('Kurs', csv.splitlines()[0])
        self.assertIn(';4/03;1309+1310;NGT8D;Alter Markt;Cracau;06:12', csv)
        self.assertIn(';1412;Flexity;Hasselbachplatz;', csv)

    def test_live_guess_by_course_same_day_type_only(self):
        f, D = self.f, datetime.date
        fri, prev_fri, sat = D(2026, 11, 27), D(2026, 11, 20), D(2026, 11, 21)
        # last Friday someone noted: the 06:12 trip from Cracau is Kurs 4/03; last Saturday the same trip was Kurs 4/11
        self.f._months['2026-11'] = {'v': 1, 'entries': [
            {'id': 'a', 'date': prev_fri.isoformat(), 'time': '06:40', 'dayType': 'wt', 'line': '4', 'kurs': '4/03', 'vehicles': ['1301'],
             'direction': 'Olvenstedter Platz', 'start': '06:12', 'jid': 'old'},
            {'id': 'b', 'date': sat.isoformat(), 'time': '06:40', 'dayType': 'sa', 'line': '4', 'kurs': '4/11', 'vehicles': ['1350'],
             'direction': 'Olvenstedter Platz', 'start': '06:12', 'jid': 'old2'},
            # today: Kurs 4/03 was reported earlier with Wagen 1309+1310
            {'id': 'c', 'date': fri.isoformat(), 'time': '05:20', 'dayType': 'wt', 'line': '4', 'kurs': '4/03', 'vehicles': ['1309', '1310'],
             'direction': 'Cracau', 'stop': 'Hasselbachplatz', 'start': '05:01', 'jid': 'x'},
        ]}
        live = [{'id': 'now1', 'type': 'tram', 'short': '4', 'direction': 'Olvenstedter Platz', 'start': '06:12'},
                {'id': 'now2', 'type': 'tram', 'short': '4', 'direction': 'Cracau', 'start': '07:00'},
                {'id': 'x', 'type': 'tram', 'short': '4', 'direction': 'Cracau', 'start': '05:01'}]
        g = f.guess_live(live, fri, now_hm='06:30')
        self.assertEqual(g['now1'], {'vehicles': ['1309', '1310'], 'type': 'NGT8D', 'kurs': '4/03', 'sure': False, 'seen': '05:20', 'stop': 'Hasselbachplatz'})
        self.assertNotIn('now2', g)                                   # trip never reported → nothing guessed
        self.assertTrue(g['x']['sure'])                               # reported directly for this very trip
        # on a Saturday the same 06:12 trip is another Kurs
        g_sat = f.guess_live(live[:1], D(2026, 11, 28), now_hm='06:30')
        self.assertEqual(g_sat['now1']['kurs'], '4/11')
        self.assertEqual(g_sat['now1']['vehicles'], [])               # nobody reported 4/11 that Saturday yet

    def test_stops_in_route_order(self):
        shape = [[52.10, 11.60], [52.11, 11.60], [52.12, 11.60], [52.13, 11.60]]
        stops = {'C': [52.125, 11.6001], 'A': [52.101, 11.6], 'B': [52.112, 11.5999]}
        self.assertEqual(self.f.order_along(stops, [shape[:2], shape]), ['A', 'B', 'C'])
        self.assertEqual(self.f.order_along({'b': [0, 0], 'a': [0, 0]}, []), ['a', 'b'])
        with mock.patch.dict(self.b._line_shapes, {'loaded': True, 'lines': {'tram:4': {'stops': {'Magdeburg, C': [52.125, 11.6], 'A': [52.101, 11.6]},
                                                                                         'shapes': {'x': {'pts': shape}}}}}):
            self.assertEqual(self.c.get('/api/fts/stops?line=4').get_json()['stops'], ['A', 'C'])

    def test_vehicle_types_and_analysis(self):
        f = self.f
        self.assertEqual((f.vehicle_type('1309'), f.vehicle_type('1412'), f.vehicle_type('1201')), ('NGT8D', 'Flexity', 'andere'))
        self.assertEqual(f.composition(['1309', '1310']), 'NGT8D')
        self.assertEqual(f.composition(['1309', '1412']), 'gemischt')
        self.add(line='4', vehicles=['1309', '1310'])
        self.add(line='4', vehicles=['1412'], time='08:00')
        self.add(line='9', vehicles=['1405'], time='08:10')
        e = self.c.get('/api/fts/entries').get_json()['entries']
        self.assertIn(['Flexity'], [x['types'] for x in e])
        a = self.c.get('/api/fts/analysis').get_json()
        self.assertEqual(a['n'], 3)
        self.assertEqual((a['total']['Flexity'], a['total']['NGT8D'], a['double']), (2, 1, 1))
        l4 = next(l for l in a['lines'] if l['line'] == '4')
        self.assertEqual((l4['n'], l4['types']['Flexity'], l4['types']['NGT8D'], l4['vehicles']), (2, 1, 1, 3))
        self.assertEqual(dict(a['byType']['Flexity']), {'4': 1, '9': 1})
        self.assertEqual(a['fleet'], {'NGT8D': 2, 'Flexity': 2})
        self.assertIn('Typ', self.c.get('/api/fts/export.csv').data.decode('utf-8-sig').splitlines()[0])

    def test_rate_limit(self):
        codes = [self.add(time=f'07:{i:02d}').status_code for i in range(22)]
        self.assertIn(429, codes)


if __name__ == '__main__':
    unittest.main()
