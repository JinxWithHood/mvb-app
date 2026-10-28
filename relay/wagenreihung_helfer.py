"""
Magdeburg Mobil – Wagenreihungs-Helfer

bahn.de beantwortet keine Anfragen von Rechenzentren (also nicht von Render).
Dieses kleine Programm läuft bei dir zu Hause (PC, Laptop, Raspberry Pi …):
Es fragt den App-Server alle paar Sekunden nach offenen Wagenreihungs-Aufträgen,
holt sie über deinen normalen Internetanschluss bei bahn.de und schickt sie zurück.

- Kein Port muss geöffnet werden, es gehen nur Anfragen nach außen.
- Es wird ausschließlich die Wagenreihung von bahn.de abgefragt, sonst nichts.
- Nur Python 3 nötig, keine Zusatzpakete.

Start:  python wagenreihung_helfer.py
Beim ersten Start fragt es nach dem Schlüssel (derselbe wie FORMATION_AGENT_KEY bei Render)
und merkt ihn sich in helfer_schluessel.txt neben dieser Datei.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER = os.environ.get('MVB_SERVER', 'https://mvb-app.onrender.com').rstrip('/')
BAHN = os.environ.get('MVB_BAHN_BASE', 'https://www.bahn.de').rstrip('/')
KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'helfer_schluessel.txt')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
CHECKS = {
    'administrationId': r'\d{1,3}', 'category': r'[A-Z]{1,4}', 'date': r'\d{4}-\d{2}-\d{2}',
    'evaNumber': r'\d{7}', 'number': r'\d{1,6}', 'time': r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',
}
ALLOWED_PATH = '/web/api/reisebegleitung/wagenreihung/vehicle-sequence'


def load_key():
    key = os.environ.get('MVB_HELFER_KEY', '').strip()
    if key:
        return key
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding='utf-8') as fh:
            key = fh.read().strip()
    if not key:
        key = input('Schlüssel (FORMATION_AGENT_KEY von Render) eingeben: ').strip()
        with open(KEY_FILE, 'w', encoding='utf-8') as fh:
            fh.write(key)
    return key


def http(url, data=None, headers=None, timeout=20):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method='POST' if body else 'GET', headers={
        'User-Agent': UA, 'Accept': 'application/json',
        **({'Content-Type': 'application/json'} if body else {}), **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None, None


def fetch_formation(params):
    clean = {}
    for name, pattern in CHECKS.items():
        value = str(params.get(name, ''))
        if not re.fullmatch(pattern, value):
            return 400, None
        clean[name] = value
    return http(f'{BAHN}{ALLOWED_PATH}?{urllib.parse.urlencode(clean)}',
                headers={'Accept-Language': 'de-DE,de;q=0.9'}, timeout=15)


def main():
    key = load_key()
    auth = {'X-Agent-Key': key}
    print(f'Wagenreihungs-Helfer läuft · Server: {SERVER} · Beenden mit Strg+C')
    pause, done, warned = 3, 0, False
    while True:
        status, data = http(f'{SERVER}/api/formation/agent/jobs', headers=auth, timeout=30)
        if status == 403:
            print('Schlüssel falsch oder FORMATION_AGENT_KEY bei Render nicht gesetzt. '
                  f'Datei {KEY_FILE} löschen und neu starten.')
            time.sleep(60)
            continue
        if status != 200 or not isinstance(data, dict):
            if not warned:
                print('Server gerade nicht erreichbar (schläft evtl.) – versuche es weiter …')
                warned = True
            time.sleep(10)
            continue
        warned = False
        if data.get('path') and data['path'] != ALLOWED_PATH:
            time.sleep(pause)
            continue
        for job in data.get('jobs') or []:
            st, body = fetch_formation(job.get('params') or {})
            if st in (403, 452):
                print('Achtung: bahn.de blockt auch diesen Anschluss (z. B. VPN aktiv?).')
            http(f'{SERVER}/api/formation/agent/result', {'key': job.get('key'), 'status': st, 'data': body},
                 headers=auth)
            done += 1
            p = job.get('params') or {}
            print(f"  {time.strftime('%H:%M:%S')}  {p.get('category')} {p.get('number')} → {st}  ({done} erledigt)")
        time.sleep(pause)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
