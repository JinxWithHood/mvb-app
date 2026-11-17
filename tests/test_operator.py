"""Who runs a line: MVB vs. regional bus companies (Bus 720 to Loburg is NJL, not MVB)."""
import unittest
from unittest import mock

import helpers  # noqa: F401
import backend as b


class OperatorTests(unittest.TestCase):
    def test_short_names(self):
        self.assertEqual(b._short_operator('Nahverkehrsgesellschaft Jerichower Land mbH'), 'NJL')
        self.assertEqual(b._short_operator('Magdeburger Verkehrsbetriebe GmbH & Co. KG'), 'MVB')
        self.assertEqual(b._short_operator('BördeBus Verkehrsgesellschaft mbH'), 'BördeBus')
        self.assertEqual(b._short_operator('DB Regio AG'), 'DB Regio')
        self.assertEqual(b._short_operator('Musterbus GmbH'), 'Musterbus')
        self.assertIsNone(b._short_operator(None))

    def test_mvb_or_not(self):
        njl = 'Nahverkehrsgesellschaft Jerichower Land mbH'
        self.assertFalse(b._is_mvb_line('bus', '720', njl, ('Allee-Center', 'Magdeburg, Allee-Center')))
        self.assertFalse(b._is_mvb_line('bus', '720', None, ('Magdeburg, Allee-Center', 'Loburg')))   # 3 digits
        self.assertTrue(b._is_mvb_line('bus', '52', None, ('Magdeburg, Alter Markt',)))
        self.assertTrue(b._is_mvb_line('tram', '9', None, ('Magdeburg, Hauptbahnhof',)))
        self.assertTrue(b._is_mvb_line('bus', '73', 'Magdeburger Verkehrsbetriebe', ()))
        self.assertFalse(b._is_mvb_line('tram', '1', None, ('Halle, Marktplatz',)))
        self.assertFalse(b._is_mvb_line('regional', 'RE 1', 'MVB', ('Magdeburg Hbf',)))


if __name__ == '__main__':
    unittest.main()


class RadarDetourTests(unittest.TestCase):
    """Tram 10 shown at the Nordbrückenzug: HAFAS places it on its own broken loop."""
    KATH, MARKT = [52.13451, 11.63806], [52.13145, 11.63647]

    def loc(self, ix):
        return {0: self.KATH, 1: self.MARKT}.get(ix)

    def test_position_on_loop_is_moved_between_the_stops(self):
        track = [[0, 52.13818, 11.64960], [5000, 52.13755, 11.65225]]     # on the loop, ~1 km east
        with mock.patch.object(b, '_snap_network', return_value=None):
            out = b._radar_fix_detour(track, [0, 5000], [40, 45], [0, 0], [1, 1], self.loc)
        self.assertIsNotNone(out)
        for t, lat, lon in out:
            self.assertTrue(11.6364 <= lon <= 11.6381 and 52.1314 <= lat <= 52.1346, (lat, lon))
        self.assertLess(out[0][1], self.KATH[0])                            # 40 % of the way south

    def test_normal_positions_untouched(self):
        track = [[0, 52.1330, 11.6372]]
        self.assertIsNone(b._radar_fix_detour(track, [0], [50], [0], [1], self.loc))
