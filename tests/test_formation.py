"""Wagenreihung core (formation.py): parsing, normalising and fetching without network."""
import datetime
import unittest

from helpers import FakeSession, ic_raw  # noqa: F401  (sets up sys.path)
import formation


def reset():
    formation._blocked.clear()
    formation._cache.clear()
    formation._probe.update(at=0.0, ok=False)


class IdentTests(unittest.TestCase):
    def test_long_distance_number_from_name(self):
        self.assertEqual(formation.ident_from_text('ICE 1006'), ('ICE', '1006'))
        self.assertEqual(formation.ident_from_text('IC 2037'), ('IC', '2037'))

    def test_regional_number_in_brackets(self):
        self.assertEqual(formation.ident_from_text('RE 1 (73748)'), ('RE', '73748'))
        self.assertEqual(formation.ident_from_text('S1 (39033)'), ('S', '39033'))

    def test_regional_line_number_is_not_a_train_number(self):
        self.assertEqual(formation.ident_from_text('RE 1'), ('RE', None))

    def test_trams_and_buses_are_not_trains(self):
        self.assertEqual(formation.ident_from_text('STR 2'), (None, None))
        self.assertEqual(formation.ident_from_text('Bus 73'), (None, None))
        self.assertEqual(formation.ident_from_text(None, ''), (None, None))

    def test_eva_from_station_ids(self):
        self.assertEqual(formation.eva_from_station_id('8010224'), '8010224')
        self.assertEqual(formation.eva_from_station_id('A=1@O=Magdeburg Hbf@X=1@L=8010224@'), '8010224')
        self.assertEqual(formation.eva_from_station_id('tr:de-DELFI_de:15003:8010224'), '8010224')
        self.assertIsNone(formation.eva_from_station_id('7393'))          # tram stop
        self.assertIsNone(formation.eva_from_station_id('9530330'))       # 7 digits but not a DB station
        self.assertIsNone(formation.eva_from_station_id(None))


class ParamsTests(unittest.TestCase):
    def test_winter_time_is_utc_plus_one(self):
        p = formation.params_for('8010224', 'ICE', '1006', datetime.datetime(2026, 11, 2, 8, 15))
        self.assertEqual(p['time'], '2026-11-02T07:15:00.000Z')
        self.assertEqual(p['date'], '2026-11-02')
        self.assertEqual(p['evaNumber'], '8010224')

    def test_summer_time_is_utc_plus_two(self):
        p = formation.params_for('8010224', 'IC', '2037', datetime.datetime(2026, 7, 1, 0, 30))
        self.assertEqual(p['time'], '2026-06-30T22:30:00.000Z')
        self.assertEqual(p['date'], '2026-06-30')     # bahn.de wants the UTC date


class NormalizeTests(unittest.TestCase):
    def test_basic_shape(self):
        d = formation.normalize(ic_raw())
        self.assertTrue(d['available'])
        self.assertEqual(d['platform'], '3')
        self.assertEqual(len(d['cars']), 5)
        kinds = [c['kind'] for c in d['cars']]
        self.assertEqual(kinds.count('loco'), 1)
        classes = [c['cls'] for c in d['cars'] if c['kind'] != 'loco']
        self.assertEqual(sorted(classes), ['1', '2', '2', '2'])
        self.assertIn('bike', [a for c in d['cars'] for a in c['amenities']])
        self.assertFalse(d['split'])

    def test_cars_are_ordered_left_to_right(self):
        d = formation.normalize(ic_raw())
        starts = [c['start'] for c in d['cars']]
        self.assertEqual(starts, sorted(starts))

    def test_section_a_is_always_on_the_left(self):
        for descending in (False, True):
            d = formation.normalize(ic_raw(descending=descending))
            secs = [s['name'] for s in d['sectors']]
            self.assertEqual(secs[0], 'A', f'descending={descending}')
            self.assertEqual(secs, sorted(secs))
            car_secs = [c['sector'] for c in d['cars'] if c['sector']]
            self.assertEqual(car_secs, sorted(car_secs), f'descending={descending}')

    def test_direction_follows_the_mirroring(self):
        a = formation.normalize(ic_raw())['direction']
        b = formation.normalize(ic_raw(descending=True))['direction']
        self.assertIn(a, ('left', 'right'))
        self.assertNotEqual(a, b)

    def test_garbage_gives_none(self):
        self.assertIsNone(formation.normalize(None))
        self.assertIsNone(formation.normalize({}))
        self.assertIsNone(formation.normalize({'platform': {'start': 0, 'end': 100}, 'groups': []}))


class FetchTests(unittest.TestCase):
    def setUp(self):
        reset()
        self._session = formation._session

    def tearDown(self):
        formation._session = self._session
        reset()

    def when(self):
        return datetime.datetime(2026, 11, 2, 8, 15)

    def test_success(self):
        formation._session = FakeSession(200, ic_raw())
        raw = formation.fetch('8010224', 'IC', '2037', self.when())
        self.assertEqual(raw['groups'][0]['transport']['number'], 2037)

    def test_success_is_cached(self):
        s = formation._session = FakeSession(200, ic_raw())
        formation.fetch('8010224', 'IC', '2037', self.when())
        formation.fetch('8010224', 'IC', '2037', self.when())
        self.assertEqual(len(s.calls), 1)

    def test_not_found_is_none(self):
        formation._session = FakeSession(404)
        self.assertIsNone(formation.fetch('8010224', 'IC', '2037', self.when()))

    def test_datacenter_block_raises(self):
        formation._session = FakeSession(403, {'code': 'OPS_BLOCKED'})
        with self.assertRaises(formation.Blocked):
            formation.fetch('8010224', 'IC', '2037', self.when())
        self.assertTrue(formation.all_blocked())

    def test_helper_result_is_used_when_blocked(self):
        formation._session = FakeSession(403)
        params = formation.params_for('8010224', 'IC', '2037', self.when())
        formation.store(params, ic_raw(), True)
        raw = formation.fetch('8010224', 'IC', '2037', self.when())
        self.assertTrue(raw['groups'])

    def test_reachable(self):
        formation._session = FakeSession(404)
        self.assertTrue(formation.reachable())
        reset()
        formation._session = FakeSession(403)
        self.assertFalse(formation.reachable())


if __name__ == '__main__':
    unittest.main()
