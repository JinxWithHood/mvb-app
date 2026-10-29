"""Test server for the browser smoke test: the real app, but bahn.de is faked.

FM_ONLINE=1 -> a Wagenreihung source is online (tabs visible), 0 -> none (no tabs).
Usage: python tests/e2e/serve.py <port>
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.dirname(HERE)]
from helpers import ic_raw  # noqa: E402  (also puts the repo root on sys.path)
import backend  # noqa: E402
import formation  # noqa: E402


def fake_fetch(eva, cat, num, when):
    if eva == '8000001':                 # a stop without formation data
        return None
    raw = ic_raw()
    raw['departurePlatform'] = str(int(eva) % 17)
    return raw


formation.fetch = fake_fetch
formation.reachable = lambda: os.environ.get('FM_ONLINE', '1') == '1'
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5099
backend.app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
