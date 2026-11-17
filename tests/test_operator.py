"""Who runs a line: MVB vs. regional bus companies (Bus 720 to Loburg is NJL, not MVB)."""
import unittest

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
