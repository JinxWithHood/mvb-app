// Magdeburg Mobil - 24-Stunden Persistenz & Linienarchiv Engine
// Regel: Fahrten werden erst archiviert, wenn sie an der Endstelle sind oder >= 10 Min Verspätung / Ausfall haben!
// Im "JETZT"-Modus werden archivierte/abgefahrene Fahrten nicht in der Live-Abfahrtsliste angezeigt.
(function(root) {
  const STORAGE_KEY_DEPS = 'mvb_departures_24h_v1';
  const STORAGE_KEY_JOURNEYS = 'mvb_journeys_24h_v1';
  const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 Stunden

  function getStorageData(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch(e) {
      console.warn("Storage read error", e);
      return {};
    }
  }

  function setStorageData(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch(e) {
      console.warn("Storage write error (quota?)", e);
    }
  }

  // Bereinigt Einträge, die älter als 24 Stunden sind
  function pruneOldEntries(store) {
    const now = Date.now();
    const cleaned = {};
    for (const id in store) {
      const items = store[id];
      if (Array.isArray(items)) {
        const validItems = items.filter(item => {
          const itemTime = item._savedAt || item._depTimestamp || 0;
          return (now - itemTime) < RETENTION_MS;
        });
        if (validItems.length > 0) {
          cleaned[id] = validItems;
        }
      } else if (items && items._savedAt) {
        if ((now - items._savedAt) < RETENTION_MS) {
          cleaned[id] = items;
        }
      }
    }
    return cleaned;
  }

  // Prüft, ob eine Fahrt für die 24h-Archivierung qualifiziert ist:
  // Regel: Erst archivieren, wenn Fahrzeug an der Endstelle ist oder >= 10 Min Verspätung oder Ausfall hat!
  function qualifiesForArchive(dep, now) {
    if (!dep) return false;
    
    // 1. Mindestens 10 Minuten Verspätung
    if (typeof dep.delay === 'number' && dep.delay >= 10) return true;
    
    // 2. Fahrt ist ausgefallen
    if (dep.cancelled) return true;
    
    // 3. Fahrt ist an der Endstelle / Fahrtverlauf beendet
    if (dep.isAtDestination || dep.isFinished) return true;
    
    // Prüfe, ob die Fahrt zeitlich deutlich in der Vergangenheit liegt (z. B. > 45 Min nach Abfahrt = an Endstelle)
    if (dep._depTimestamp) {
      const diffMinutes = (now - dep._depTimestamp) / 60000;
      if (diffMinutes > 40) {
        return true;
      }
    }
    
    return false;
  }

  // Speichert qualifizierte Fahrten im 24h-Archiv
  function saveDepartures(stationId, stationName, liveDeps) {
    if (!stationId || !Array.isArray(liveDeps)) return;
    
    const now = Date.now();
    let store = getStorageData(STORAGE_KEY_DEPS);
    store = pruneOldEntries(store);

    const stationKey = String(stationId);
    const existing = store[stationKey] || [];

    liveDeps.forEach(dep => {
      const [h, m] = (dep.time || '00:00').split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (dep.day_offset) d.setDate(d.getDate() + dep.day_offset);

      const depUniqueId = `${dep.line}_${dep.time}_${dep.direction}_${dep.day_offset || 0}`;
      const depTimestamp = d.getTime();

      const tempDep = { ...dep, _depTimestamp: depTimestamp };

      // Speichere oder aktualisiere qualifizierte Fahrten (>= 10 Min Verspätung, Ausfall oder an Endstelle)
      if (qualifiesForArchive(tempDep, now)) {
        const existingIdx = existing.findIndex(e => e._uniqueId === depUniqueId);
        const record = {
          ...dep,
          stationId: stationId,
          stationName: stationName,
          _uniqueId: depUniqueId,
          _savedAt: now,
          _depTimestamp: depTimestamp,
          isArchived: true
        };

        if (existingIdx >= 0) {
          existing[existingIdx] = { ...existing[existingIdx], ...record, _savedAt: now };
        } else {
          existing.push(record);
        }
      }
    });

    store[stationKey] = existing;
    setStorageData(STORAGE_KEY_DEPS, store);
  }

  // Liefert Abfahrten: Wenn "JETZT" aktiv ist, werden KEINE archivierten Fahrten in die Liste gemischt!
  function getMergedDepartures(stationId, stationName, liveDeps, isNowMode = true) {
    const now = Date.now();
    let store = getStorageData(STORAGE_KEY_DEPS);
    store = pruneOldEntries(store);
    setStorageData(STORAGE_KEY_DEPS, store);

    // WENN "JETZT" AKTIV IST: Nur echte Live-Abfahrten anzeigen! Keine archivierten Fahrten in JETZT!
    if (isNowMode) {
      return liveDeps.filter(dep => {
        const [h, m] = (dep.time || '00:00').split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        if (dep.day_offset) d.setDate(d.getDate() + dep.day_offset);
        const actualTime = d.getTime() + (dep.delay || 0) * 60000;
        return (actualTime - now) >= -30000; // Nur zukünftige oder gerade abfahrende
      });
    }

    // Wenn nicht im "JETZT"-Modus (z. B. vergangene Zeit gewählt): Archivierte Fahrten der letzten 24h einbinden
    const stationKey = String(stationId);
    const archived = store[stationKey] || [];

    const liveMap = new Map();
    liveDeps.forEach(dep => {
      const depUniqueId = `${dep.line}_${dep.time}_${dep.direction}_${dep.day_offset || 0}`;
      liveMap.set(depUniqueId, dep);
    });

    const merged = [...liveDeps];

    archived.forEach(arch => {
      const depUniqueId = arch._uniqueId || `${arch.line}_${arch.time}_${arch.direction}_${arch.day_offset || 0}`;
      if (!liveMap.has(depUniqueId)) {
        merged.push({
          ...arch,
          isArchived: true,
          archivedLabel: "Archiviert"
        });
      }
    });

    return merged;
  }

  // Speichert den vollständigen Fahrtverlauf (Journey) für 24 Stunden
  function saveJourney(journeyId, journeyData) {
    if (!journeyId || !journeyData) return;
    let store = getStorageData(STORAGE_KEY_JOURNEYS);
    store = pruneOldEntries(store);
    
    store[String(journeyId)] = {
      ...journeyData,
      _savedAt: Date.now()
    };
    setStorageData(STORAGE_KEY_JOURNEYS, store);
  }

  function getJourney(journeyId) {
    if (!journeyId) return null;
    const store = getStorageData(STORAGE_KEY_JOURNEYS);
    return store[String(journeyId)] || null;
  }

  root.Archive24hEngine = {
    saveDepartures: saveDepartures,
    getMergedDepartures: getMergedDepartures,
    saveJourney: saveJourney,
    getJourney: getJourney,
    qualifiesForArchive: qualifiesForArchive
  };
})(typeof window !== 'undefined' ? window : this);
