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
        self.assertIn('Datum;Uhrzeit;Linie;Wagen', csv)
        self.assertIn('07:31;4;1309+1310;Cracau', csv)

    def test_rate_limit(self):
        codes = [self.add(time=f'07:{i:02d}').status_code for i in range(22)]
        self.assertIn(429, codes)


if __name__ == '__main__':
    unittest.main()
