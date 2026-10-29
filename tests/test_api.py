"""HTTP API smoke tests through Flask's test client (no network: everything external is faked)."""
import datetime
import unittest
from unittest import mock

from helpers import AGENT_KEY, FakeResponse, ic_raw
import backend
import formation

app = backend.app

DISRUPTIONS_HTML = """
<html><body>
<article><h2 class="entry-title">Sperrung Ernst-Reuter-Allee</h2>
  <div class="entry-content"><p>Wegen Bauarbeiten fahren die Linien 2 und 9 eine Umleitung.</p></div>
  <div class="kt-post-cats"><a>Linie 2</a><a>Linie 9</a></div>
  <span class="kt-post-date">29. Oktober 2026</span></article>
<article><h2 class="entry-title">Haltestelle verlegt</h2>
  <div class="entry-content"><p>Die Haltestelle Alter Markt wird verlegt.</p></div></article>
</body></html>
"""


def no_network(*args, **kwargs):
    raise ConnectionError('tests run offline')


class Base(unittest.TestCase):
    def setUp(self):
        self.c = app.test_client()
        formation._blocked.clear()
        formation._cache.clear()
        formation._probe.update(at=0.0, ok=False)

    def agent_poll(self):
        return self.c.get('/api/formation/agent/jobs', headers={'X-Agent-Key': AGENT_KEY})


class StaticFiles(Base):
    def test_index_and_service_worker(self):
        with self.c.get('/') as r:
            self.assertEqual(r.status_code, 200)
            self.assertIn(b'Magdeburg', r.data)
        for path in ('/sw.js', '/app.js', '/formation.js', '/offline.js', '/styles.css', '/manifest.json'):
            with self.c.get(path) as r:
                self.assertEqual(r.status_code, 200, path)


class FormationApi(Base):
    def q(self, **kw):
        a = {'eva': '8010224', 'cat': 'IC', 'num': '2037', 'date': '2026-11-02', 'time': '08:15'}
        a.update(kw)
        return '/api/formation?' + '&'.join(f'{k}={v}' for k, v in a.items())

    def test_rejects_bad_input(self):
        for bad in ({'eva': '123'}, {'cat': 'STR'}, {'num': 'abc'}, {'date': 'x'}):
            self.assertEqual(self.c.get(self.q(**bad)).status_code, 400, bad)

    def test_available(self):
        with mock.patch.object(formation, 'fetch', return_value=ic_raw()):
            d = self.c.get(self.q()).get_json()
        self.assertTrue(d['available'])
        self.assertEqual(len(d['cars']), 5)

    def test_no_formation(self):
        with mock.patch.object(formation, 'fetch', return_value=None):
            self.assertFalse(self.c.get(self.q()).get_json()['available'])

    def test_blocked_without_helper(self):
        backend_agent_seen(0)
        with mock.patch.object(formation, 'fetch', side_effect=formation.Blocked('x')):
            self.assertTrue(self.c.get(self.q()).get_json()['blocked'])

    def test_helper_round_trip(self):
        self.assertEqual(self.agent_poll().status_code, 200)          # helper is online now
        with mock.patch.object(formation._session, 'get', return_value=FakeResponse(403)):
            d = self.c.get(self.q()).get_json()
            self.assertTrue(d.get('pending'))
            jobs = self.agent_poll().get_json()['jobs']
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]['params']['evaNumber'], '8010224')
            r = self.c.post('/api/formation/agent/result', headers={'X-Agent-Key': AGENT_KEY},
                            json={'key': jobs[0]['key'], 'status': 200, 'data': ic_raw()})
            self.assertTrue(r.get_json()['ok'])
            d = self.c.get(self.q()).get_json()
        self.assertTrue(d['available'])

    def test_helper_long_poll_wakes_up(self):
        import threading
        import time as _t
        mod = getattr(backend, '_formation_api', None) or backend
        threading.Timer(0.3, lambda: mod._fm_enqueue('k-longpoll', {'evaNumber': '8010224'})).start()
        t0 = _t.time()
        r = self.c.get('/api/formation/agent/jobs?wait=5', headers={'X-Agent-Key': AGENT_KEY}).get_json()
        self.assertLess(_t.time() - t0, 3)
        self.assertEqual([j['key'] for j in r['jobs']], ['k-longpoll'])
        mod._fm_jobs.pop('k-longpoll', None)

    def test_agent_needs_key(self):
        self.assertEqual(self.c.get('/api/formation/agent/jobs').status_code, 403)
        self.assertEqual(self.c.get('/api/formation/agent/jobs', headers={'X-Agent-Key': 'wrong'}).status_code, 403)
        self.assertEqual(self.c.post('/api/formation/agent/result', json={}).status_code, 403)

    def test_status(self):
        backend_agent_seen(0)
        with mock.patch.object(formation, 'reachable', return_value=False):
            self.assertFalse(self.c.get('/api/formation/status').get_json()['online'])
        with mock.patch.object(formation, 'reachable', return_value=True):
            self.assertEqual(self.c.get('/api/formation/status').get_json()['via'], 'server')
        self.agent_poll()
        self.assertEqual(self.c.get('/api/formation/status').get_json()['via'], 'helper')


def backend_agent_seen(ts):
    """Pretend the helper was last seen at `ts` (0 = never)."""
    mod = getattr(backend, '_formation_api', None) or backend
    mod._agent['seen'] = ts


class DisruptionsApi(Base):
    def test_parses_verkehrsmelder(self):
        with mock.patch('requests.get', return_value=FakeResponse(200, text=DISRUPTIONS_HTML)):
            items = self.c.get('/api/disruptions').get_json()
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['title'], 'Sperrung Ernst-Reuter-Allee')
        self.assertEqual(items[0]['lines'], ['Linie 2', 'Linie 9'])
        self.assertTrue(items[0]['critical'])
        self.assertFalse(items[1]['critical'])
        self.assertRegex(items[0]['id'], r'^[0-9a-f]{8}$')

    def test_ids_match_the_check_endpoint(self):
        with mock.patch('requests.get', return_value=FakeResponse(200, text=DISRUPTIONS_HTML)):
            full = [d['id'] for d in self.c.get('/api/disruptions').get_json()]
            check = self.c.get('/api/disruptions/check').get_json()
        self.assertEqual(check['ids'], full)
        self.assertEqual(check['count'], 2)

    def test_no_invented_disruptions_when_offline(self):
        with mock.patch('requests.get', side_effect=no_network):
            r = self.c.get('/api/disruptions')
        self.assertEqual(r.status_code, 502)
        self.assertIn('error', r.get_json())


class NewsApi(Base):
    def test_news_survives_offline_source(self):
        backend_news_cache_reset()
        with mock.patch('requests.get', side_effect=no_network), mock.patch('requests.Session.get', side_effect=no_network):
            r = self.c.get('/api/news')
        self.assertIn(r.status_code, (200, 502, 503))
        self.assertIsNotNone(r.get_json())

    def test_article_fallback(self):
        with mock.patch('requests.get', side_effect=no_network), mock.patch('requests.Session.get', side_effect=no_network):
            r = self.c.get('/api/news/article?url=https://www.mvbnet.de/aktuelles/test-artikel/')
        d = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(d.get('paragraphs'))

    def test_article_rejects_foreign_hosts(self):
        with mock.patch('requests.get', side_effect=AssertionError('must not fetch')):
            r = self.c.get('/api/news/article?url=https://evil.example.com/x')
        self.assertNotEqual(r.status_code, 500)


def backend_news_cache_reset():
    mod = getattr(backend, '_news_api', None) or backend
    mod._news_cache.update(timestamp=0, data=[])


class JourneyShape(Base):
    """bahn.de/transitous trips -> /api/journey stops carry the EVA number (Gleisbelegung per stop)."""
    def test_stops_carry_eva(self):
        now = datetime.datetime.now()
        stop = lambda name, eva, mins, passed: {
            'name': name, 'eva': eva, 'time': (now + datetime.timedelta(minutes=mins)).strftime('%H:%M'),
            'arr': None, 'dep': (now + datetime.timedelta(minutes=mins)).strftime('%H:%M'), 'arrDelay': None,
            'depDelay': 0, 'arrRt': None, 'depRt': None, 'passed': passed, 'platform': '1', 'cancelled': False,
            'day_offset': 0}
        trip = {'stops': [stop('Magdeburg Hbf', '8010224', -5, True), stop('Burg', '8010060', 15, False),
                          stop('Berlin Hbf', '8011160', 90, False)],
                'line': 'RE 1', 'direction': 'Berlin Hbf', 'color': '#c00', 'type': 'regional', 'messages': []}
        d = backend._trip_to_journey_response(trip, 'Magdeburg Hbf', None, None, None, 'db')
        self.assertEqual([s['eva'] for s in d['stops']], ['8010224', '8010060', '8011160'])
        self.assertTrue(d['stops'][0]['isVehicleHere'])


if __name__ == '__main__':
    unittest.main()
