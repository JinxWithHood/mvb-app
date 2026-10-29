"""Shared test helpers: environment for an offline backend and fake bahn.de data."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# the backend reads these at import time
os.environ.setdefault('FORMATION_AGENT_KEY', 'test-agent-key')
os.environ.pop('FORMATION_RELAY_URL', None)

AGENT_KEY = os.environ['FORMATION_AGENT_KEY']


def veh(num, cat, sector, start, first=False, second=True, length=26.4, status='OPEN', amenities=()):
    return {'wagonIdentificationNumber': num, 'status': status,
            'platformPosition': {'start': start, 'end': start + length, 'sector': sector},
            'type': {'category': cat, 'hasFirstClass': first, 'hasEconomyClass': second},
            'amenities': [{'type': a} for a in amenities]}


def platform(names='ABCDEF', width=60, descending=False):
    secs = [{'name': n, 'start': i * width, 'end': i * width + width} for i, n in enumerate(names)]
    if descending:      # some stations number the sections the other way round
        secs = [{'name': n, 'start': i * width, 'end': i * width + width} for i, n in enumerate(reversed(names))]
    return {'start': 0, 'end': len(names) * width, 'sectors': secs}


def ic_raw(descending=False):
    """IC with a locomotive at the platform start, 4 coaches, listed front (loco) first."""
    vehicles = [veh(None, 'LOCOMOTIVE', None, 5, False, False, length=19)]
    for i in range(4):
        first = i == 0
        vehicles.append(veh(10 + i, 'PASSENGERCARRIAGE_FIRST_CLASS' if first else 'PASSENGERCARRIAGE_ECONOMY_CLASS',
                            None, 26 + i * 27, first, not first, amenities=['BIKE_SPACE'] if i == 3 else ()))
    pf = platform(descending=descending)
    for v in vehicles:   # sector = the one under the middle of the car
        mid = v['platformPosition']['start'] + 10
        v['platformPosition']['sector'] = next(s['name'] for s in pf['sectors'] if s['start'] <= mid < s['end'])
    return {'departurePlatform': '3', 'platform': pf,
            'groups': [{'name': 'IC2037', 'transport': {'category': 'IC', 'number': 2037, 'destination': {'name': 'Leipzig Hbf'}},
                        'vehicles': vehicles}]}


class FakeResponse:
    def __init__(self, status=200, json_data=None, text=''):
        self.status_code = status
        self._json = json_data
        self.text = text
        self.content = (text or '').encode()
        self.encoding = 'utf-8'

    def json(self):
        if self._json is None:
            raise ValueError('no json')
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')


class FakeSession:
    """Stand-in for requests.Session: answers every GET with the given status/json."""
    def __init__(self, status=200, json_data=None):
        self.status, self.json_data, self.calls = status, json_data, []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params))
        return FakeResponse(self.status, self.json_data)
