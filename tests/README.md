# Tests

Laufen automatisch bei jedem Push auf GitHub (Reiter **Actions**, Workflow „Tests“).
Ein grüner Haken am Commit = alles heil, ein rotes Kreuz = irgendwas ist kaputt.

Lokal ausführen (im Projektordner):

```
python -m unittest discover -s tests -v      # Backend: Wagenreihung, API, Störungen, News
node tests/e2e/smoke.js                      # Browser: braucht  npm i playwright  und  npx playwright install chromium
```

Alles läuft ohne Internet: bahn.de, Verkehrsmelder und MVB-Seiten werden in den Tests nachgestellt.
