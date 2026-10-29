# 🚋 Magdeburg Mobil

Werbefreie Fahrplan-App für Bus & Bahn in Magdeburg – als Website **und** installierbare App (PWA).

- **Live-Abfahrten** mit Echtzeit-Verspätungen und Gleis-/Straßen-Zeitleiste
- **Verbindungssuche** mit Umstiegen
- **Live-Netzkarte**: alle Trams & Busse auf ihren echten Linienwegen, Linien-/Fahrt-Fokus, Linienwechsler,
  Pünktlichkeits-Farben (Verspätung gelb/rot, Verfrühung türkis → pink)
- **Push-Benachrichtigungen** bei neuen Störungen (auf Wunsch nur für „meine Linien“, Nachtruhe) und **Abfahrts-Wecker**
- Verkehrsmelder, Tickets & MVB-News
- Hell, Dunkel – und ein geheimes Theme 💣

## Ordnerstruktur

```
backend.py            Flask-Server (API + liefert die Website aus)
news_api.py           Störungsmeldungen (Verkehrsmelder) + MVB-News
formation_api.py      Wagenreihung: API-Routen + Helfer daheim
formation.py          Wagenreihung: bahn.de abfragen und aufbereiten
dbweb.py, transitous.py  Weitere Fahrplan-Quellen (bahn.de, Transitous)
admin.py              Admin-Bereich
relay/                Wagenreihungs-Helfer für zu Hause
tests/                Automatische Tests (laufen bei jedem Push, siehe tests/README.md)
requirements.txt      Python-Pakete
render.yaml           Einstellungen für Render.com
Server starten.bat    Startet die App lokal (Doppelklick) → http://127.0.0.1:5000
public/               Alles, was der Browser bekommt
  index.html, app.js, styles.css
  live-map.js         Live-Netzkarte
  push.js             Push-Benachrichtigungen & Abfahrts-Wecker
  pwa.js              App-Installation
  jinx-fx.js          🤫
  offline.js          Offline-Modus (letzte Abfahrten/Verläufe auf dem Gerät)
  formation.js        Wagenreihung / Gleisbelegung
  sw.js, manifest.json  App-/Offline-Funktionen
  assets/             Icons, Bilder, Betreiber-Logos (assets/logos)
cache/                Laufzeit-Daten des Servers (wird automatisch erzeugt, nicht im Repo)
```

## Lokal starten

Doppelklick auf **`Server starten.bat`** – Python-Pakete werden automatisch installiert, danach öffnet sich der Browser.

## Auf Render veröffentlichen

Der Dienst **mvb-app** (Python) liefert App und API zusammen aus:

- Build: `pip install -r requirements.txt`
- Start: `gunicorn backend:app --workers 1 --threads 8 --timeout 120 --bind 0.0.0.0:$PORT`

Optional (Render → Environment):

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (kostenlose Redis-Datenbank von upstash.com):
  Push-Abos, Abfahrts-Wecker, Push-Schlüssel und das Gleisnetz überstehen damit jeden Neustart.
- `VAPID_PRIVATE_KEY` als Umgebungsvariable setzen (fester Push-Schlüssel, nur nötig ohne Upstash).
- Ein kostenloser Cronjob (z. B. cron-job.org), der alle 10 Minuten `https://mvb-app.onrender.com/api/push/tick`
  aufruft, hält den Gratis-Server wach – nur dann kommen Push-Nachrichten auch nachts zuverlässig an.

Falls zusätzlich die statische Seite **magdeburg-mobil** genutzt wird: dort als *Publish Directory* `public` eintragen.

---
Inoffizielles Hobbyprojekt · Daten ohne Gewähr · Fahrplandaten: INSA/HAFAS · Karten: © OpenStreetMap-Mitwirkende, Esri
