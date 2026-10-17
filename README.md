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
requirements.txt      Python-Pakete
render.yaml           Einstellungen für Render.com
Server starten.bat    Startet die App lokal (Doppelklick) → http://127.0.0.1:5000
public/               Alles, was der Browser bekommt
  index.html, app.js, styles.css
  live-map.js         Live-Netzkarte
  push.js             Push-Benachrichtigungen & Abfahrts-Wecker
  pwa.js              App-Installation
  jinx-fx.js          🤫
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

Optional:

- `VAPID_PRIVATE_KEY` als Umgebungsvariable setzen (fester Push-Schlüssel).
- Ein kostenloser Cronjob (z. B. cron-job.org), der alle 10 Minuten `https://mvb-app.onrender.com/api/push/tick`
  aufruft, hält den Gratis-Server wach – nur dann kommen Push-Nachrichten auch nachts zuverlässig an.

Falls zusätzlich die statische Seite **magdeburg-mobil** genutzt wird: dort als *Publish Directory* `public` eintragen.

---
Inoffizielles Hobbyprojekt · Daten ohne Gewähr · Fahrplandaten: INSA/HAFAS · Karten: © OpenStreetMap-Mitwirkende, Esri
