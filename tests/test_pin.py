"""Fahrt anpinnen: live state, notification decisions, card image and the API."""
import time
import unittest
from unittest import mock

import helpers  # noqa: F401  (sys.path)
import pin

NOW = 1_800_000_000.0     # fixed "now" for the pure logic tests


def hm(offset_min):
    import datetime
    return datetime.datetime.fromtimestamp(NOW + offset_min * 60, pin.TZ).strftime('%H:%M')


def trip(delay=3, cancelled_at=None):
    plan = [('Hannover Hbf', -70), ('Magdeburg Hbf', -30), ('Burg (b Magdeburg)', -15), ('Genthin', -3),
            ('Brandenburg Hbf', 16), ('Potsdam Hbf', 40), ('Berlin-Wannsee', 47)]
    return {'stops': [{'name': n, 'time': hm(m), 'rt': hm(m + delay), 'delay': delay,
                       'cancelled': n == cancelled_at} for n, m in plan]}


def a_pin(**kw):
    d = {'jid': 'J1', 'line': 'RE 1', 'direction': 'Berlin Hbf', 'color': '#a3242c',
         'board': 'Magdeburg Hbf', 'exit': 'Potsdam Hbf', 'planned': int((NOW - 30 * 60) * 1000)}
    d.update(kw)
    return pin.clean(d)


class CleanTests(unittest.TestCase):
    def test_valid(self):
        p = a_pin()
        self.assertEqual(p['line'], 'RE 1')
        self.assertTrue(p['id'])

    def test_rejects_missing_fields_and_bad_color(self):
        self.assertIsNone(pin.clean({'jid': 'x'}))
        self.assertIsNone(pin.clean(None))
        self.assertEqual(a_pin(color='red;evil')['color'], '#018e4a')


class ViewTests(unittest.TestCase):
    def test_before_departure(self):
        v = pin.view(a_pin(), trip(), NOW - 40 * 60)
        self.assertEqual(v['phase'], 'before')
        self.assertEqual((v['prev']['name'], v['cur']['name'], v['next']['name']), ('Hannover Hbf', 'Magdeburg Hbf', 'Burg (b Magdeburg)'))
        self.assertEqual(v['label'], 'Einstieg')
        self.assertEqual(v['pct'], 0)
        self.assertEqual(v['minsToDep'], 13)

    def test_riding(self):
        v = pin.view(a_pin(), trip(), NOW + 30)
        self.assertEqual(v['phase'], 'ride')
        self.assertEqual((v['prev']['name'], v['cur']['name'], v['next']['name']), ('Burg (b Magdeburg)', 'Genthin', 'Brandenburg Hbf'))
        self.assertEqual(v['delay'], 3)
        self.assertTrue(0.4 < v['pct'] < 0.6)
        self.assertEqual(len(v['ticks']), 5)
        self.assertEqual(v['cur']['time'], hm(0))          # real-time departure

    def test_exit_next(self):
        v = pin.view(a_pin(), trip(), NOW + 40 * 60)
        self.assertEqual(v['phase'], 'exit')
        self.assertEqual(v['cur']['name'], 'Potsdam Hbf')
        self.assertEqual(v['label'], 'Ausstieg')

    def test_done_after_arrival(self):
        self.assertEqual(pin.view(a_pin(), trip(), NOW + 46 * 60)['phase'], 'done')

    def test_unknown_exit(self):
        self.assertIsNone(pin.view(a_pin(exit='Hamburg Hbf'), trip(), NOW))

    def test_names_match_with_city_prefix(self):
        t = trip()
        t['stops'][1]['name'] = 'Magdeburg, Magdeburg Hbf'
        self.assertIsNotNone(pin.view(a_pin(), t, NOW))

    def test_cancelled(self):
        v = pin.view(a_pin(), trip(cancelled_at='Brandenburg Hbf'), NOW)
        self.assertTrue(v['cancelled'])
        self.assertEqual(pin.delay_text(v), 'fällt aus')


class DecideTests(unittest.TestCase):
    def test_first_update_is_quiet_then_rate_limited(self):
        p = a_pin()
        v = pin.view(p, trip(), NOW + 30)
        self.assertEqual(pin.decide(p, v, NOW + 30), (True, False))
        self.assertEqual(pin.decide(p, v, NOW + 40), (False, False))

    def test_delay_jump_alerts(self):
        p = a_pin()
        pin.decide(p, pin.view(p, trip(delay=3), NOW), NOW)
        send, alert = pin.decide(p, pin.view(p, trip(delay=6), NOW + 5), NOW + 5)
        self.assertTrue(send and alert)

    def test_exit_alerts_once(self):
        p = a_pin()
        pin.decide(p, pin.view(p, trip(), NOW), NOW)
        v = pin.view(p, trip(), NOW + 40 * 60)
        self.assertEqual(pin.decide(p, v, NOW + 40 * 60), (True, True))
        self.assertFalse(pin.decide(p, v, NOW + 40 * 60 + 70)[1])

    def test_departure_soon_alerts(self):
        p = a_pin()
        pin.decide(p, pin.view(p, trip(), NOW - 40 * 60), NOW - 40 * 60)
        t = NOW - 30.5 * 60                               # 3–4 min before the (delayed) departure
        self.assertEqual(pin.decide(p, pin.view(p, trip(), t), t), (True, True))


class MessageTests(unittest.TestCase):
    def test_texts(self):
        p = a_pin()
        m = pin.message(p, pin.view(p, trip(), NOW + 30), False, image_url='https://x/card.png')
        self.assertEqual(m['title'], 'RE 1 → Berlin Hbf · +3 Min')
        self.assertIn('Burg (b Magdeburg) › Genthin › Brandenburg Hbf', m['body'])
        self.assertEqual(m['tag'], 'pin')
        self.assertEqual(m['image'], 'https://x/card.png')
        m = pin.message(p, pin.view(p, trip(), NOW + 40 * 60), True)
        self.assertIn('aussteigen', m['body'])
        self.assertTrue(m['alert'])


class CardTests(unittest.TestCase):
    def test_token_round_trip_and_tamper(self):
        v = pin.view(a_pin(), trip(), NOW + 30)
        data, sig = pin.image_token(v, b'secret')
        back = pin.read_token(data, sig, b'secret')
        self.assertEqual(back['cur']['name'], 'Genthin')
        self.assertIsNone(pin.read_token(data, sig, b'other'))
        self.assertIsNone(pin.read_token(data[:-2] + 'xx', sig, b'secret'))

    def test_png(self):
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest('Pillow fehlt')
        for t in (NOW - 40 * 60, NOW + 30, NOW + 40 * 60):
            png = pin.card_png(pin.view(a_pin(), trip(), t))
            self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')


class PinApi(unittest.TestCase):
    """/api/push/pin with a fake device, a fake trip and push sending captured."""

    @classmethod
    def setUpClass(cls):
        import backend
        cls.b = backend

    def setUp(self):
        b = self.b
        self.c = b.app.test_client()
        self.endpoint = 'https://push.example/test-device'
        self.key = b._sub_key(self.endpoint)
        self.sent = []
        self.real_now = time.time()
        self.p_sub = mock.patch.dict(b._subs(), {self.key: {'endpoint': self.endpoint, 'keys': {'p256dh': 'x', 'auth': 'y'},
                                                            'reminders': [], 'prefs': {}}})
        self.p_sub.start()
        self.p_send = mock.patch.object(b, '_send_push', side_effect=lambda sub, msg, **kw: self.sent.append(msg) or True)
        self.p_send.start()
        self.p_save = mock.patch.object(b, '_save_json_file')
        self.p_save.start()
        global NOW
        self._now = NOW
        NOW = self.real_now
        self.p_trip = mock.patch.object(b, '_fetch_trip', side_effect=lambda jid: trip())
        self.p_trip.start()

    def tearDown(self):
        global NOW
        NOW = self._now
        for p in (self.p_sub, self.p_send, self.p_save, self.p_trip):
            p.stop()

    def post(self, body):
        return self.c.post('/api/push/pin', json=dict(body, endpoint=self.endpoint))

    def pin_body(self):
        return {'jid': 'J1', 'line': 'RE 1', 'direction': 'Berlin Hbf', 'color': '#a3242c', 'board': 'Magdeburg Hbf',
                'exit': 'Potsdam Hbf', 'planned': int((NOW - 30 * 60) * 1000), 'boardIdx': 1, 'exitIdx': 5}

    def test_unknown_device(self):
        r = self.c.post('/api/push/pin', json={'endpoint': 'https://nope', 'view': True})
        self.assertEqual(r.status_code, 404)

    def test_pin_view_cancel(self):
        r = self.post({'pin': self.pin_body()})
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()['view']['cur']['name'], 'Genthin')
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]['kind'], 'pin')
        self.assertIn(self.key, self.b._subs())
        self.assertEqual(self.b._subs()[self.key]['pin']['exit'], 'Potsdam Hbf')
        v = self.post({'view': True}).get_json()
        self.assertEqual(v['pin']['exit'], 'Potsdam Hbf')
        self.assertEqual(self.post({'cancel': True}).get_json()['pin'], None)
        self.assertNotIn('pin', self.b._subs()[self.key])
        self.assertEqual(self.sent[-1]['kind'], 'pin-end')

    def test_rejects_unknown_exit(self):
        body = self.pin_body()
        body['exit'] = 'Hamburg Hbf'
        self.assertEqual(self.post({'pin': body}).status_code, 400)

    def test_watcher_updates_and_ends(self):
        self.post({'pin': self.pin_body()})
        n = len(self.sent)
        self.b._check_pins()                           # nothing new right away
        self.assertEqual(len(self.sent), n)
        with mock.patch.object(self.b, '_fetch_trip', side_effect=lambda jid: trip(delay=8)):
            self.b._check_pins()                       # +5 min more delay -> alert
        self.assertTrue(self.sent[-1]['alert'])
        with mock.patch('time.time', return_value=NOW + 50 * 60):
            self.b._check_pins()                       # arrived
        self.assertEqual(self.sent[-1]['kind'], 'pin-end')
        self.assertNotIn('pin', self.b._subs()[self.key])

    def test_card_image_route(self):
        v = pin.view(pin.clean(self.pin_body()), trip(), NOW)
        data, sig = pin.image_token(v, self.b._pin_secret())
        r = self.c.get(f'/api/pin/card.png?d={data}&s={sig}')
        try:
            import PIL  # noqa: F401
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.mimetype, 'image/png')
        except ImportError:
            self.assertEqual(r.status_code, 500)
        r.close()
        self.assertEqual(self.c.get(f'/api/pin/card.png?d={data}&s=deadbeef').status_code, 403)


if __name__ == '__main__':
    unittest.main()
