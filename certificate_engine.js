// Magdeburg Mobil - Offizieller Fahrt- & Verspätungsnachweis Generator
// Dynamische Farbanpassung an das Verkehrsunternehmen (MVB, HAVAG, DB, ODEG, BördeBus, etc.)
// Vollständige Anzeige ALLER Haltestellen im Streckenverlauf (keine Auslassungen)
// Inklusive offiziellem Straßenbahn-Bild (App-Symbol)
// Garantiert HÖCHSTENS EINE DIN-A4-SEITE (kein Überlauf auf Seite 2).
(function(root) {

  // Exakte Verkehrsunternehmens-Erkennung inklusive offizieller Farbpalette
  function getOperatorDetails(opName, lineName, direction, stationName) {
    const opLower = (opName || '').toLowerCase().trim();
    const lineLower = (lineName || '').toLowerCase().replace(/\s+/g, '').trim();
    const dirLower = (direction || '').toLowerCase().trim();
    const statLower = (stationName || '').toLowerCase().trim();

    // S-Bahn Identifikation (z. B. "S 1", "S1", "S 2", "S-Bahn", etc.)
    const isSBahn = /^s\d+/i.test(lineLower) || lineLower.startsWith('s-bahn') || lineLower.startsWith('sbahn') || opLower.includes('s-bahn');
    const isTrain = /^(re|rb|ic|ice|ec|ece|erx|hex|mrb)\d*/i.test(lineLower);

    // Ziffern aus Linienbezeichnung extrahieren (z. B. "Bus 61" -> 61, "603" -> 603)
    const digitsMatch = (lineName || '').match(/\d+/);
    const lineNum = digitsMatch ? parseInt(digitsMatch[0], 10) : null;
    const isPureNum = /^\d+$/.test(lineLower);

    const isBus = lineLower.includes('bus') || (lineNum !== null && lineNum >= 40 && !isSBahn && !isTrain);
    const isTram = (lineLower.includes('str') || lineLower.includes('tram') || (isPureNum && lineNum !== null && lineNum >= 1 && lineNum <= 15)) && !isSBahn && !isTrain;

    // 1. S-Bahn (S1 Magdeburg, S-Bahn Mitteldeutschland S1-S9, etc.) -> STRENG DB Regio AG!
    if (isSBahn) {
      return {
        id: 'db',
        name: 'DB Regio AG',
        shortName: 'DB REGIO',
        legalName: 'DB Regio AG - Region Südost',
        address: 'Willy-Brandt-Platz 1, 39104 Magdeburg',
        logo: 'logo_db.png',
        primaryColor: '#ec0016',
        secondaryColor: '#a2000c',
        accentColor: '#282d37',
        lightBg: '#fff1f2',
        isDB: true
      };
    }

    // 2. Erfurter Bahn (EB) - STRENG KEIN DB! (z. B. RB 13, RB 21, RB 22, RE 12 Leipzig - Gera - Saalfeld/Hof/Erfurt)
    // Logo bewusst weglassen (logo: null) und korrektes Unternehmen ausweisen
    const isEB = opLower.includes('erfurter bahn') || opLower === 'eb' || opLower.includes('elster-saale') ||
      ['rb13', 'rb21', 'rb22', 're12'].includes(lineLower);
    if (isEB) {
      return {
        id: 'eb',
        name: 'Erfurter Bahn GmbH',
        shortName: 'ERFURTER BAHN',
        legalName: 'Erfurter Bahn GmbH',
        address: 'Am Rasenweg 8, 99086 Erfurt',
        logo: null, // Logo bewusst weglassen!
        primaryColor: '#005b82',
        secondaryColor: '#003a54',
        accentColor: '#f59e0b',
        lightBg: '#f0f7fa',
        isDB: false
      };
    }

    // 3. vogtlandbahn (Die Länderbahn GmbH DLB) - z. B. RB 4 (Gera - Greiz - Weischlitz)
    const isVogtland = opLower.includes('vogtland') || opLower.includes('länderbahn') || opLower.includes('laenderbahn') || opLower.includes('dlb') ||
      lineLower === 'rb4';
    if (isVogtland) {
      return {
        id: 'vogtlandbahn',
        name: 'vogtlandbahn - Die Länderbahn GmbH DLB',
        shortName: 'VOGTLANDBAHN',
        legalName: 'Die Länderbahn GmbH DLB',
        address: 'Bahnhofstraße 2, 08491 Netzschkau',
        logo: null, // Logo bewusst weglassen!
        primaryColor: '#005a36',
        secondaryColor: '#003d24',
        accentColor: '#fab900',
        lightBg: '#f0f7f4',
        isDB: false
      };
    }

    // 4. Abellio Rail Mitteldeutschland - z. B. RE 8, RE 9, RE 16, RB 20, RB 25
    const isAbellio = opLower.includes('abellio') || ['re8', 're9', 're16', 'rb20', 'rb25'].includes(lineLower);
    if (isAbellio) {
      return {
        id: 'abellio',
        name: 'Abellio Rail Mitteldeutschland GmbH',
        shortName: 'ABELLIO',
        legalName: 'Abellio Rail Mitteldeutschland GmbH',
        address: 'Magdeburger Straße 51, 06112 Halle (Saale)',
        logo: null, // Logo bewusst weglassen!
        primaryColor: '#d6006e',
        secondaryColor: '#96004d',
        accentColor: '#ffd500',
        lightBg: '#fdf2f7',
        isDB: false
      };
    }

    // 2. RE 1 Differenzierung:
    // Thüringen RE 1 (Göttingen - Erfurt - Weimar - Jena - Gera - Glauchau) -> DB Regio AG!
    // Berlin / Brandenburg RE 1 (Magdeburg - Burg - Brandenburg - Potsdam - Berlin - FFO) -> ODEG!
    if (lineLower === 're1' || lineLower.startsWith('re1')) {
      const thurKeywords = ['gera', 'erfurt', 'göttingen', 'goettingen', 'weimar', 'jena', 'gotha', 'mühlhausen', 'muehlhausen', 'glauchau', 'schmölln', 'schmoelln', 'stadtroda', 'hermsdorf', 'leinefelde', 'gößnitz', 'goessnitz', 'zwickau', 'ronneburg'];
      const odegKeywords = ['berlin', 'potsdam', 'brandenburg', 'frankfurt', 'burg', 'genthin', 'magdeburg', 'werder', 'erkner', 'fürstenwalde', 'fuerstenwalde', 'eisenhüttenstadt'];

      if (opLower.includes('db') || opLower.includes('regio') || opLower.includes('südost') || thurKeywords.some(k => dirLower.includes(k) || statLower.includes(k))) {
        return {
          id: 'db',
          name: 'DB Regio AG',
          shortName: 'DB REGIO',
          legalName: 'DB Regio AG - Region Südost',
          address: 'Willy-Brandt-Platz 1, 39104 Magdeburg',
          logo: 'logo_db.png',
          primaryColor: '#ec0016',
          secondaryColor: '#a2000c',
          accentColor: '#282d37',
          lightBg: '#fff1f2',
          isDB: true
        };
      }
      if (opLower.includes('odeg') || odegKeywords.some(k => dirLower.includes(k) || statLower.includes(k))) {
        return {
          id: 'odeg',
          name: 'ODEG Ostdeutsche Eisenbahn',
          shortName: 'ODEG',
          legalName: 'Ostdeutsche Eisenbahn GmbH',
          address: 'Bahnhofskeller 1, 19370 Parchim',
          logo: 'logo_odeg.png',
          primaryColor: '#005028',
          secondaryColor: '#00381c',
          accentColor: '#ffd400',
          lightBg: '#f2faf5',
          isDB: false
        };
      }
    }

    // 3. ODEG (falls op ODEG oder Ostdeutsche)
    if (opLower.includes('odeg') || opLower.includes('ostdeutsch')) {
      return {
        id: 'odeg',
        name: 'ODEG Ostdeutsche Eisenbahn',
        shortName: 'ODEG',
        legalName: 'Ostdeutsche Eisenbahn GmbH',
        address: 'Bahnhofskeller 1, 19370 Parchim',
        logo: 'logo_odeg.png',
        primaryColor: '#005028',
        secondaryColor: '#00381c',
        accentColor: '#ffd400',
        lightBg: '#f2faf5',
        isDB: false
      };
    }

    // 4. Deutsche Bahn / DB Regio (Züge: RE, RB, IC, ICE, DB-Busse)
    if (opLower === 'db' || opLower.includes('deutsche bahn') || opLower.includes('db regio') || opLower.includes('db fernverkehr') || opLower.includes('dostgo') || opLower.includes('db start') ||
        isTrain) {
      return {
        id: 'db',
        name: 'DB Regio AG',
        shortName: 'DB REGIO',
        legalName: 'DB Regio AG - Region Südost',
        address: 'Willy-Brandt-Platz 1, 39104 Magdeburg',
        logo: 'logo_db.png',
        primaryColor: '#ec0016',
        secondaryColor: '#a2000c',
        accentColor: '#282d37',
        lightBg: '#fff1f2',
        isDB: true
      };
    }

    // 5. HAVAG (Halle (Saale) - Straßenbahnen & Stadtbusse)
    if (opLower.includes('havag') ||
        ((dirLower.includes('halle') || statLower.includes('halle') || dirLower.includes('göttinger bogen') || dirLower.includes('goettinger bogen') || dirLower.includes('frohe zukunft') || dirLower.includes('kröllwitz') || dirLower.includes('kroellwitz') || dirLower.includes('ammendorf') || dirLower.includes('beesen') || dirLower.includes('trotha') || dirLower.includes('böllberg') || dirLower.includes('boellberg') || dirLower.includes('südstadt')) &&
         !isTrain && !isSBahn)) {
      return {
        id: 'havag',
        name: 'Hallesche Verkehrs-AG (HAVAG)',
        shortName: 'HAVAG',
        legalName: 'Hallesche Verkehrs-AG',
        address: 'Freiimfelder Straße 74, 06112 Halle (Saale)',
        logo: 'logo_havag.png',
        primaryColor: '#d0002b',
        secondaryColor: '#9b001f',
        accentColor: '#f39200',
        lightBg: '#feecee',
        isDB: false
      };
    }

    // 6. Magdeburger Verkehrsbetriebe (MVB)
    // Alle Magdeburger Straßenbahnen (Str 1-15, Tram 1-15, oder rein numerisch 1-15), alle Stadtbusse (< 100) & Nachtbusse (N1-N9)
    if (opLower.includes('mvb') || opLower.includes('magdeburg') ||
        (isTram && !dirLower.includes('halle') && !statLower.includes('halle')) ||
        (isBus && lineNum !== null && lineNum < 100) ||
        (lineLower.startsWith('n') && lineNum !== null && lineNum < 20)) {
      return {
        id: 'mvb',
        name: 'Magdeburger Verkehrsbetriebe (MVB)',
        shortName: 'MVB',
        legalName: 'Magdeburger Verkehrsbetriebe GmbH & Co. KG',
        address: 'Otto-von-Guericke-Straße 25, 39104 Magdeburg',
        logo: 'logo_mvb.png',
        primaryColor: '#018e4a',
        secondaryColor: '#006837',
        accentColor: '#ffcc00',
        lightBg: '#e8f7f0',
        isDB: false
      };
    }

    // 7. BördeBus - STRENG Regionalbusse 600–699 (z. B. 601, 603, 614)
    if (opLower.includes('börde') || opLower.includes('boerde') ||
        (isBus && lineNum !== null && lineNum >= 600 && lineNum <= 699)) {
      return {
        id: 'boerdebus',
        name: 'BördeBus Verkehrsgesellschaft',
        shortName: 'BÖRDEBUS',
        legalName: 'BördeBus Verkehrsgesellschaft mbH',
        address: 'Alte Dorfstraße 26, 39387 Oschersleben',
        logo: 'logo_boerdebus.png',
        primaryColor: '#007a3d',
        secondaryColor: '#005229',
        accentColor: '#f58220',
        lightBg: '#f0faf4',
        isDB: false
      };
    }

    // 8. NJL - STRENG Regionalbusse 700–799 (z. B. 702, 704, 720)
    if (opLower.includes('njl') || opLower.includes('jerichow') ||
        (isBus && lineNum !== null && lineNum >= 700 && lineNum <= 799)) {
      return {
        id: 'njl',
        name: 'Nahverkehrsgesellschaft Jerichower Land',
        shortName: 'NJL',
        legalName: 'Nahverkehrsgesellschaft Jerichower Land mbH',
        address: 'Genthiner Straße 16, 39288 Burg',
        logo: 'logo_njl.png',
        primaryColor: '#004b93',
        secondaryColor: '#002d59',
        accentColor: '#e30613',
        lightBg: '#edf5fc',
        isDB: false
      };
    }

    // 9. KVG Salzland (Busse 130-180)
    if (opLower.includes('kvg') || opLower.includes('salzland') ||
        (isBus && lineNum !== null && (lineNum === 160 || lineNum === 161 || (lineNum >= 130 && lineNum <= 180)))) {
      return {
        id: 'kvg',
        name: 'Kreisverkehrsgesellschaft Salzland',
        shortName: 'KVG SALZLAND',
        legalName: 'KVG Salzland mbH',
        address: 'Kastanienallee 2, 06406 Bernburg',
        logo: 'logo_kvg.png',
        primaryColor: '#003d7c',
        secondaryColor: '#002750',
        accentColor: '#fab900',
        lightBg: '#edf4fa',
        isDB: false
      };
    }

    // 10. metronom
    if (opLower.includes('metronom')) {
      return {
        id: 'metronom',
        name: 'metronom Eisenbahngesellschaft',
        shortName: 'METRONOM',
        legalName: 'metronom Eisenbahngesellschaft mbH',
        address: 'St.-Viti-Straße 15, 29525 Uelzen',
        logo: 'logo_metronom.png',
        primaryColor: '#003b7a',
        secondaryColor: '#00244c',
        accentColor: '#fecd06',
        lightBg: '#eff6fc',
        isDB: false
      };
    }

    // 11. FlixBus
    if (opLower.includes('flix')) {
      return {
        id: 'flixbus',
        name: 'FlixBus DACH GmbH',
        shortName: 'FLIXBUS',
        legalName: 'Flix SE',
        address: 'Friedenheimer Brücke 16, 80639 München',
        logo: 'logo_flixbus.png',
        primaryColor: '#73d300',
        secondaryColor: '#549b00',
        accentColor: '#ff6600',
        lightBg: '#f4fbe8',
        isDB: false
      };
    }

    // 12. PVGS Altmarkkreis Salzwedel
    if (opLower.includes('pvgs') || opLower.includes('salzwedel')) {
      return {
        id: 'pvgs',
        name: 'Personenverkehrsgesellschaft Altmarkkreis Salzwedel',
        shortName: 'PVGS',
        legalName: 'PVGS mbH',
        address: 'Südlicher Rundweg 4, 29410 Salzwedel',
        logo: 'logo_pvgs.png',
        primaryColor: '#00407a',
        secondaryColor: '#002a50',
        accentColor: '#e2001a',
        lightBg: '#edf5fb',
        isDB: false
      };
    }

    // 13. Erfasstes / bekanntes anderes Verkehrsunternehmen OHNE Logo (z. B. Abellio, Erfurter Bahn, DigaBus, Vetter)
    // "Lass wenn das Verkehrsunternehmen Logo nicht erfasst ist es weg"
    if (opName && opName.trim().length > 0) {
      return {
        id: 'other',
        name: opName.trim(),
        shortName: opName.trim().split(' ')[0].toUpperCase(),
        legalName: opName.trim(),
        address: 'Öffentlicher Personenverkehr',
        logo: null, // KEIN Logo vorhanden -> Bild bleibt bewusst weg!
        primaryColor: '#1e293b',
        secondaryColor: '#0f172a',
        accentColor: '#0284c7',
        lightBg: '#f8fafc',
        isDB: false
      };
    }

    // Standardfall: MVB wenn in Magdeburg, sonst neutral
    if (statLower.includes('magdeburg') || dirLower.includes('magdeburg') || !opName) {
      return {
        id: 'mvb',
        name: 'Magdeburger Verkehrsbetriebe (MVB)',
        shortName: 'MVB',
        legalName: 'Magdeburger Verkehrsbetriebe GmbH & Co. KG',
        address: 'Otto-von-Guericke-Straße 25, 39104 Magdeburg',
        logo: 'logo_mvb.png',
        primaryColor: '#018e4a',
        secondaryColor: '#006837',
        accentColor: '#ffcc00',
        lightBg: '#e8f7f0',
        isDB: false
      };
    }

    return {
      id: 'general',
      name: opName || 'Verkehrsunternehmen',
      shortName: (opName || 'TRANSIT').slice(0, 8).toUpperCase(),
      legalName: opName || 'Öffentlicher Personennahverkehr',
      address: 'Öffentlicher Personenverkehr',
      logo: null,
      primaryColor: '#334155',
      secondaryColor: '#1e293b',
      accentColor: '#0284c7',
      lightBg: '#f8fafc',
      isDB: false
    };
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // Prüft, ob ein Text eine ECHTE Betriebsstörung / Verspätungsursache ist
  // Schließt reine Ausstattungsmerkmale (z. B. "Fahrzeug mit niederflurigem Einstieg geplant", "Klimaanlage", etc.) strikt aus!
  function isActualDisruption(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.toLowerCase().trim();

    // 1. Reine Fahrzeugmerkmale & Servicehinweise (KEINE Störungen!)
    const equipmentNotes = [
      'niederflur', 'fahrrad', 'rollstuhl', 'klima', 'wlan', 'wifi', 'steckdose',
      'bistro', 'restaurant', 'ruhebereich', 'familienbereich', '2. klasse', '1. klasse',
      'reservierung', 'einstiegshilfe', 'mehrzweckabteil', 'verkehrt ab hier als',
      'verkehrt weiter als', 'weiter als', 'anrufbus', 'rufbus', 'anmeldung',
      'bedarfshalt', 'halt bei bedarf'
    ];

    if (equipmentNotes.some(eq => t.includes(eq))) {
      // Nur zulassen, wenn explizit ein Störungswort enthalten ist (z. B. "Niederflurfahrzeug defekt")
      const hasDefect = ['störung', 'defekt', 'gesperrt', 'sperrung', 'ausfall', 'unfall', 'schaden', 'verzögerung', 'verspätung'].some(kw => t.includes(kw));
      if (!hasDefect) {
        return false;
      }
    }

    // 2. Muss betriebliche Störungsmerkmale aufweisen
    const disruptionIndicators = [
      'störung', 'betriebsstörung', 'signalstörung', 'weichenstörung', 'oberleitungsstörung', 'fahrzeugstörung',
      'defekt', 'fahrzeugdefekt', 'reparatur', 'technische störung', 'technischer defekt',
      'verspätung', 'verzögerung', 'wartezeit', 'folgeverspätung', 'fahrplanabweichung',
      'ausfall', 'teilausfall', 'entfällt', 'entfallen', 'fällt aus',
      'sperrung', 'gesperrt', 'streckensperrung', 'gleissperrung', 'vollsperrung',
      'bauarbeiten', 'baustelle', 'gleisbau', 'brückenarbeiten',
      'ersatzverkehr', 'schienenersatzverkehr', 'notverkehr', 'sev',
      'umleitung', 'umgeleitet',
      'unfall', 'polizeieinsatz', 'notarzteinsatz', 'feuerwehreinsatz', 'behördliche', 'personen im gleis',
      'unwetter', 'sturm', 'hochwasser', 'witterungsbedingt', 'schnee', 'glätte',
      'personalmangel', 'streik', 'arbeitskampf',
      'überholung', 'warten auf anschluss', 'zugfolge'
    ];

    return disruptionIndicators.some(kw => t.includes(kw));
  }

  // ---------------------------------------------------------------------------
  // 1. EINZELFAHRT-NACHWEIS (Vollständige Haltestellenliste, Straßenbahn & Farben)
  // ---------------------------------------------------------------------------
  function buildCertificateHTML(journeyData, departureInfo) {
    const dep = departureInfo || {};
    const jny = journeyData || {};

    const lineName = jny.line || dep.line || 'Linie';
    const direction = jny.direction || dep.direction || 'Unbekannt';
    const stationName = dep.stationName || (jny.stops && jny.stops[0] ? jny.stops[0].name : '');
    const op = getOperatorDetails(jny.operator || dep.operator, lineName, direction, stationName);

    const isCancelled = !!(dep.cancelled || jny.cancelled);
    const delayMin = (typeof dep.delay === 'number') ? dep.delay : (typeof jny.delay === 'number' ? jny.delay : 0);

    const now = new Date();
    const formattedDate = now.toLocaleDateString('de-DE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const dateStr = now.toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('de-DE', {
      hour: '2-digit', minute: '2-digit'
    });

    // ECHTE Betriebsstörungen sammeln (Filtert reine Ausstattungsmerkmale wie "Niederflurfahrzeug geplant" aus!)
    const allMsgs = [];
    const rawMsgs = [];
    if (jny.messages && Array.isArray(jny.messages)) {
      jny.messages.forEach(m => {
        const txt = typeof m === 'string' ? m : (m ? (m.title ? `${m.title}: ${m.text || ''}` : m.text) : '');
        if (txt && !rawMsgs.includes(txt)) rawMsgs.push(txt);
      });
    }
    if (dep.messages && Array.isArray(dep.messages)) {
      dep.messages.forEach(m => {
        const txt = typeof m === 'string' ? m : (m ? m.text : '');
        if (txt && !rawMsgs.includes(txt)) rawMsgs.push(txt);
      });
    }

    // Nur tatsächliche Störungen / Verspätungsursachen übernehmen
    rawMsgs.forEach(txt => {
      if (isActualDisruption(txt) && !allMsgs.includes(txt)) {
        allMsgs.push(txt);
      }
    });

    // Verspätungsgrund ermitteln - STRENG betrieblich, NIEMALS Ausstattungsmerkmale!
    let primaryReason = '';
    if (allMsgs.length > 0) {
      primaryReason = allMsgs[0];
    } else if (isCancelled) {
      primaryReason = 'Fahrtausfall (keine gesonderte Störungsmeldung im System hinterlegt)';
    } else if (delayMin > 0) {
      primaryReason = 'Keine gesonderte Störungsmeldung im System hinterlegt (Fahrplanabweichung im Betriebsablauf)';
    } else {
      primaryReason = 'Planmäßige Durchführung (keine Verspätung)';
    }

    let messagesHtml = '';
    if (allMsgs.length > 0) {
      messagesHtml = `
        <div style="background:#fffbeb; border:1px solid #f59e0b; border-radius:5px; padding:4px 10px; margin:4px 0; font-size:9.5px; color:#92400e; line-height:1.25;">
          <strong style="display:block; font-size:9.5px; color:#b45309; text-transform:uppercase; margin-bottom:1px;">⚠️ Gemeldete Betriebsstörungen:</strong>
          ${allMsgs.map(m => `<div>• ${escapeHtml(m)}</div>`).join('')}
        </div>
      `;
    }

    // Deutsche Bahn Link & QR-Code falls DB-Zug - optimierte Zugsuche & direkte Verlinkung
    let dbSectionHtml = '';
    if (op.isDB) {
      const trainNum = jny.trip_num || dep.trip_num || (lineName.match(/\b\d{4,6}\b/) ? lineName.match(/\b\d{4,6}\b/)[0] : null);
      const dateISO = now.toISOString().slice(0, 10);
      const trainQuery = trainNum || lineName;
      const bahnExpertUrl = `https://bahn.expert/details/${encodeURIComponent(trainQuery)}?date=${dateISO}`;
      const bahnDeUrl = `https://www.bahn.de/buchung/fahrplan/suche`;
      const qrSvg = (root.QRCodeUtil && typeof root.QRCodeUtil.createSVG === 'function') 
        ? root.QRCodeUtil.createSVG(bahnExpertUrl, 44) 
        : '';

      dbSectionHtml = `
        <div style="background:#fef2f2; border:1.5px solid #fca5a5; border-radius:5px; padding:4px 8px; margin:4px 0; display:flex; align-items:center; gap:8px;">
          <div style="flex-shrink:0; background:#ffffff; padding:2px; border:1px solid #e2e8f0; border-radius:4px; line-height:0;">
            ${qrSvg}
          </div>
          <div style="flex:1; font-size:8.5px; color:#334155; line-height:1.25;">
            <div style="display:flex; align-items:center; gap:5px;">
              <strong style="color:#b91c1c; text-transform:uppercase; font-size:9px;">🚆 Deutsche Bahn Live-Verifikation:</strong>
              <span style="background:#ec0016; color:#ffffff; font-size:8px; font-weight:800; padding:0.5px 4px; border-radius:2px;">
                ${escapeHtml(lineName)}${trainNum ? ` #${escapeHtml(trainNum)}` : ''}
              </span>
            </div>
            <div style="margin-top:2px;">
              Live-Zugverfolgung &amp; Wagenreihung: <a href="${bahnExpertUrl}" target="_blank" rel="noopener noreferrer" style="color:#0284c7; font-weight:700; text-decoration:underline;">bahn.expert (${escapeHtml(trainQuery)}) ↗</a>
              &nbsp;•&nbsp;
              Reiseportal: <a href="${bahnDeUrl}" target="_blank" rel="noopener noreferrer" style="color:#0284c7; font-weight:600; text-decoration:underline;">bahn.de ↗</a>
            </div>
          </div>
        </div>
      `;
    }

    // VOLLSTÄNDIGE HALTESTELLENLISTE (ALLE HALTE WERDEN ANGEZEIGT)
    const rawStops = jny.stops || [];
    let stopsSectionHtml = '';

    if (rawStops.length > 0) {
      const totalStops = rawStops.length;
      // <= 12: 1 Spalte; 13-34: 2 Spalten; > 34: 3 Spalten (damit alles auf 1 Seite passt)
      const cols = (totalStops <= 12) ? 1 : ((totalStops <= 34) ? 2 : 3);

      function renderStopsSubTable(subStops, startIdx) {
        let rows = '';
        subStops.forEach((stop, i) => {
          const globalIdx = startIdx + i;
          const isStart = globalIdx === 0;
          const isEnd = globalIdx === totalStops - 1;
          const stopName = stop.name ? stop.name.replace('Magdeburg, ', '').replace('Halle (Saale), ', '') : 'Haltestelle';
          const stopCancelled = !!stop.cancelled;
          const stopDelay = (stop.depDelay !== null && stop.depDelay !== undefined) ? stop.depDelay : ((stop.delay !== null && stop.delay !== undefined) ? stop.delay : 0);

          let delayTag = '<span style="color:#16a34a; font-weight:700;">pünktl.</span>';
          let actTime = stop.depTime || stop.arrTime || stop.time || '–';

          if (stopCancelled) {
            delayTag = '<span style="background:#ef4444; color:#ffffff; padding:0 3px; border-radius:2px; font-size:7.5px; font-weight:700;">Ausfall</span>';
            actTime = `<span style="text-decoration:line-through; color:#dc2626;">${actTime}</span>`;
          } else if (stopDelay >= 10) {
            delayTag = `<span style="color:#dc2626; font-weight:800;">+${stopDelay}m ⚠️</span>`;
            if (actTime.includes(':')) {
              const [h, m] = actTime.split(':').map(Number);
              const d = new Date(); d.setHours(h, m + stopDelay, 0);
              actTime = `<strong style="color:#dc2626;">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</strong>`;
            }
          } else if (stopDelay > 0) {
            delayTag = `<span style="color:#d97706; font-weight:700;">+${stopDelay}m</span>`;
            if (actTime.includes(':')) {
              const [h, m] = actTime.split(':').map(Number);
              const d = new Date(); d.setHours(h, m + stopDelay, 0);
              actTime = `<span style="color:#d97706;">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
            }
          }

          let transitionHtml = '';
          if (stop.transitionLine) {
            transitionHtml = `<div style="font-size:7px; color:${op.primaryColor}; font-weight:800; background:rgba(0,0,0,0.05); padding:0 3px; border-radius:2px; display:inline-block; margin-top:1px;">↳ wird ${escapeHtml(stop.transitionLine)}</div>`;
          }

          let bg = (i % 2 === 0) ? '#ffffff' : '#f8fafc';
          if (isStart) bg = '#f0fdf4';
          if (isEnd) bg = '#fef2f2';

          rows += `
            <tr style="border-bottom:1px solid #e2e8f0; background:${bg}; font-size:8.5px; line-height:1.15;">
              <td style="padding:1px 3px; color:#0f172a; max-width:125px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <strong style="${(isStart || isEnd) ? 'color:#0f172a;' : 'font-weight:600;'}">${escapeHtml(stopName)}</strong>
                ${transitionHtml}
              </td>
              <td style="padding:1px 2px; font-size:7.5px; color:#64748b; text-align:center;">${stop.platform ? escapeHtml(stop.platform) : ''}</td>
              <td style="padding:1px 2px; font-size:8px; color:#475569; text-align:center; font-family:monospace;">${stop.depTime || stop.arrTime || stop.time || '–'}</td>
              <td style="padding:1px 2px; font-size:8px; text-align:center; font-family:monospace;">${actTime}</td>
              <td style="padding:1px 2px; font-size:7.5px; text-align:center;">${delayTag}</td>
            </tr>
          `;
        });

        return `
          <table style="width:100%; border-collapse:collapse; font-size:8.5px; border:1px solid #cbd5e1; border-radius:4px; overflow:hidden;">
            <thead>
              <tr style="background:${op.primaryColor}; color:#ffffff; font-size:7.5px; text-transform:uppercase; letter-spacing:0.3px;">
                <th style="padding:2px 3px; text-align:left;">Halt (${subStops.length})</th>
                <th style="padding:2px 2px; text-align:center; width:20px;">Gl.</th>
                <th style="padding:2px 2px; text-align:center; width:30px;">Plan</th>
                <th style="padding:2px 2px; text-align:center; width:30px;">Ist</th>
                <th style="padding:2px 2px; text-align:center; width:40px;">Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        `;
      }

      if (cols === 1) {
        stopsSectionHtml = `<div style="width:100%; margin:3px 0;">${renderStopsSubTable(rawStops, 0)}</div>`;
      } else if (cols === 2) {
        const mid = Math.ceil(totalStops / 2);
        const col1 = rawStops.slice(0, mid);
        const col2 = rawStops.slice(mid);
        stopsSectionHtml = `
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; width:100%; margin:3px 0;">
            <div>${renderStopsSubTable(col1, 0)}</div>
            <div>${renderStopsSubTable(col2, mid)}</div>
          </div>
        `;
      } else {
        const chunk = Math.ceil(totalStops / 3);
        const col1 = rawStops.slice(0, chunk);
        const col2 = rawStops.slice(chunk, chunk * 2);
        const col3 = rawStops.slice(chunk * 2);
        stopsSectionHtml = `
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; width:100%; margin:3px 0;">
            <div>${renderStopsSubTable(col1, 0)}</div>
            <div>${renderStopsSubTable(col2, chunk)}</div>
            <div>${renderStopsSubTable(col3, chunk * 2)}</div>
          </div>
        `;
      }
    } else {
      const fallbackStation = dep.stationName || (direction.toLowerCase().includes('halle') ? 'Halle (Saale)' : 'Magdeburg');
      stopsSectionHtml = `
        <table style="width:100%; border-collapse:collapse; font-size:9.5px; border:1px solid #cbd5e1; border-radius:4px; overflow:hidden; margin:3px 0;">
          <thead>
            <tr style="background:${op.primaryColor}; color:#ffffff; font-size:8.5px; text-transform:uppercase;">
              <th style="padding:3px 6px; text-align:left;">Station</th>
              <th style="padding:3px 6px; text-align:center; width:50px;">Gleis</th>
              <th style="padding:3px 6px; text-align:center; width:60px;">Planmäßig</th>
              <th style="padding:3px 6px; text-align:center; width:60px;">Tatsächlich</th>
              <th style="padding:3px 6px; text-align:center; width:70px;">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid #e2e8f0; background:#ffffff;">
              <td style="padding:3px 6px; font-weight:700;">${escapeHtml(fallbackStation)}</td>
              <td style="padding:3px 6px; text-align:center;">${dep.platform ? escapeHtml(dep.platform) : '–'}</td>
              <td style="padding:3px 6px; text-align:center; font-family:monospace;">${dep.time || '–'}</td>
              <td style="padding:3px 6px; text-align:center; font-family:monospace;">${dep.estimatedTime || dep.time || '–'}</td>
              <td style="padding:3px 6px; text-align:center;">${isCancelled ? '<span style="color:#dc2626; font-weight:800;">Ausfall</span>' : (delayMin > 0 ? `<span style="color:#d97706; font-weight:700;">+${delayMin}m</span>` : '<span style="color:#16a34a; font-weight:700;">pünktl.</span>')}</td>
            </tr>
          </tbody>
        </table>
      `;
    }

    // Status Banner (angepasst)
    let statusBannerHtml = '';
    if (isCancelled) {
      statusBannerHtml = `
        <div style="background:#450a0a; border:1.5px solid #ef4444; color:#ffffff; padding:5px 10px; border-radius:5px; font-size:11px; font-weight:800; text-align:center; letter-spacing:0.4px; margin-bottom:5px;">
          ❌ BESTÄTIGUNG ÜBER FAHRTAUSFALL IM LINIENBETRIEB
        </div>
      `;
    } else if (delayMin >= 10) {
      statusBannerHtml = `
        <div style="background:#fef2f2; border:1.5px solid #ef4444; color:#b91c1c; padding:5px 10px; border-radius:5px; font-size:10.5px; font-weight:800; text-align:center; margin-bottom:5px;">
          ⚠️ BESTÄTIGUNG ÜBER FAHRTVERSPÄTUNG: +${delayMin} MINUTEN ABWEICHUNG
        </div>
      `;
    } else if (delayMin > 0) {
      statusBannerHtml = `
        <div style="background:#fffbeb; border:1px solid #f59e0b; color:#b45309; padding:4px 10px; border-radius:5px; font-size:10px; font-weight:700; text-align:center; margin-bottom:5px;">
          BESTÄTIGUNG ÜBER BETRIEBLICHE FAHRPLANABWEICHUNG: +${delayMin} MINUTEN
        </div>
      `;
    } else {
      statusBannerHtml = `
        <div style="background:#f0fdf4; border:1px solid #86efac; color:#15803d; padding:4px 10px; border-radius:5px; font-size:10px; font-weight:700; text-align:center; margin-bottom:5px;">
          ✓ BESTÄTIGUNG ÜBER PLANMÄSSIGE DURCHFÜHRUNG (PÜNKTLICH)
        </div>
      `;
    }

    return `
      <div class="certificate-paper" style="background:#ffffff; color:#0f172a; border-radius:6px; padding:14px 18px; max-width:800px; max-height:282mm; height:100%; box-sizing:border-box; margin:0 auto; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display:flex; flex-direction:column; justify-content:space-between; line-height:1.25; overflow:hidden;">
        
        <div>
          <!-- Header mit Straßenbahn-Bild & dynamischen Unternehmens-Farben -->
          <div style="display:flex; justify-content:space-between; align-items:center; padding-bottom:5px; border-bottom:3px solid ${op.primaryColor}; margin-bottom:5px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <img src="tram_mvb.png" alt="Magdeburg Mobil Straßenbahn" style="height:36px; max-width:75px; object-fit:contain; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.15));" />
              <div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-size:16px; font-weight:900; color:${op.primaryColor}; letter-spacing:-0.5px; line-height:1;">MAGDEBURG</span>
                  <span style="background:${op.primaryColor}; color:#ffffff; font-size:10.5px; font-weight:900; padding:2px 6px; border-radius:3px; letter-spacing:0.5px; line-height:1;">MOBIL</span>
                </div>
                <div style="font-size:9px; font-weight:700; color:#475569; margin-top:2px; text-transform:uppercase; letter-spacing:0.5px;">
                  Offizielles Fahrgast- &amp; Verspätungsnachweisportal
                </div>
                <div style="font-size:7.5px; color:#64748b;">
                  Überregionales Fahrgast- &amp; Verspätungsnachweisportal (ÖPNV / SPNV)
                </div>
              </div>
            </div>
            <div style="text-align:right;">
              ${op.logo ? `<img src="${op.logo}" alt="${escapeHtml(op.name)}" style="max-height:34px; max-width:125px; object-fit:contain; display:block; margin-left:auto;" onerror="this.remove()" />` : ''}
              <div style="font-size:8.5px; font-weight:700; color:${op.primaryColor}; margin-top:2px;">${escapeHtml(op.legalName || op.name)}</div>
            </div>
          </div>

          <!-- Titel -->
          <div style="text-align:center; margin-bottom:5px;">
            <h1 style="font-size:13.5px; font-weight:800; color:#0f172a; margin:0 0 1px 0; text-transform:uppercase; letter-spacing:0.5px;">
              Fahrt- &amp; Verspätungsbescheinigung
            </h1>
            <p style="font-size:9.5px; color:#475569; margin:0;">
              Nachweis zur Vorlage bei Arbeitgeber, Ausbildungsstätte, Schule oder Universität
            </p>
          </div>

          ${statusBannerHtml}

          <!-- Fahrtdaten Grid (farblich akzentuiert) -->
          <div style="background:${op.lightBg}; border:1.5px solid ${op.primaryColor}33; border-radius:5px; padding:5px 10px; margin-bottom:5px; display:grid; grid-template-columns:1fr 1fr; gap:3px 12px; font-size:10.5px;">
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Linie &amp; Richtung:</span>
              <div style="display:flex; align-items:center; gap:4px; margin-top:1px;">
                <span style="background:${op.primaryColor}; color:#ffffff; padding:1px 5px; border-radius:2px; font-weight:800; font-size:10.5px;">
                  ${escapeHtml(lineName)}
                </span>
                <strong style="color:#0f172a;">${escapeHtml(direction)}</strong>
              </div>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Verkehrsunternehmen:</span>
              <strong style="color:${op.primaryColor}; font-size:10.5px;">${escapeHtml(op.name)}</strong>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Datum &amp; Planabfahrt:</span>
              <span style="color:#0f172a;">${formattedDate}, Plan: ${dep.time || '–'} Uhr</span>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Festgestellte Abweichung:</span>
              <strong style="${delayMin >= 10 || isCancelled ? 'color:#dc2626;' : 'color:#0f172a;'}">
                ${isCancelled ? '❌ FAHRTAUSFALL' : (delayMin > 0 ? `+${delayMin} Min. Differenz` : 'Planmäßig pünktlich')}
              </strong>
            </div>
            <div style="grid-column: span 2; border-top:1px dashed ${op.primaryColor}33; padding-top:2px; margin-top:2px;">
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Verspätungsursache / Störungshinweis:</span>
              <span style="font-weight:600; ${isCancelled || delayMin >= 10 ? 'color:#b91c1c;' : 'color:#0f172a;'}">
                ${escapeHtml(primaryReason)}
              </span>
            </div>
          </div>

          ${messagesHtml}
          ${dbSectionHtml}

          <!-- Vollständige Haltestellenliste -->
          <div style="margin-bottom:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
              <span style="font-size:9px; font-weight:800; color:#334155; text-transform:uppercase; letter-spacing:0.3px;">
                Vollständiger Fahrtverlauf &amp; Haltestellenplan (${rawStops.length} Halte):
              </span>
              <span style="font-size:8px; color:#64748b;">(Verifizierte Echtzeit-Fahrplandaten)</span>
            </div>
            ${stopsSectionHtml}
          </div>
        </div>

        <!-- Bestätigungsvermerk & Magdeburg Mobil Kennzeichnung -->
        <div style="border-top:1.5px solid #e2e8f0; padding-top:4px; margin-top:3px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div style="font-size:8.5px; color:#475569; line-height:1.25; flex:1;">
            <strong style="color:#0f172a; display:block; margin-bottom:1px;">Bestätigungsvermerk:</strong>
            Hiermit wird bescheinigt, dass die oben genannten Fahrplandaten und Verzögerungen aus den offiziellen HAFAS-Echtzeitsystemen sowie der 24h-Betriebsspeicherung erfasst wurden. Das Dokument ist ohne Unterschrift gültig.
            <div style="font-size:8px; font-weight:600; color:#1e293b; margin-top:3px; padding-top:2px; border-top:1px dashed #cbd5e1;">
              Elektronisch erstellt am ${dateStr} um ${timeStr} Uhr mithilfe der Magdeburg Mobil App für ${escapeHtml(op.name)}. Dieses Dokument dient zur Nachweispflicht von Verspätung bzw. Ausfällen.
            </div>
          </div>
          <div style="flex-shrink:0; text-align:right; font-weight:900; line-height:1.05; color:#000000; padding-left:12px;">
            <div style="font-size:13.5px; letter-spacing:0.5px; font-weight:900; color:#000000;">MAGDEBURG</div>
            <div style="font-size:13.5px; letter-spacing:0.5px; font-weight:900; color:#000000;">MOBIL</div>
          </div>
        </div>

      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // 2. VERBINDUNGS-NACHWEIS (Reisekette mit allen Linien, Straßenbahn & Farben)
  // ---------------------------------------------------------------------------
  function buildConnectionCertificateHTML(conn, origin, destination) {
    const c = conn || {};
    const legs = c.legs || [];
    const transitLegs = legs.filter(l => l.type !== 'walk');
    const firstLeg = legs[0] || {};
    const lastLeg = legs[legs.length - 1] || {};

    const startStation = origin || firstLeg.origin || 'Start';
    const endStation = destination || lastLeg.destination || 'Ziel';

    const now = new Date();
    const formattedDate = now.toLocaleDateString('de-DE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const dateStr = now.toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('de-DE', {
      hour: '2-digit', minute: '2-digit'
    });

    const isMissed = !!(c.missed_connection);
    const brokenStation = c.broken_transfer_station || '';

    // Alle beteiligten Verkehrsunternehmen sammeln
    const operators = [];
    const seenOpIds = new Set();
    transitLegs.forEach(leg => {
      const op = getOperatorDetails(leg.operator, leg.line, leg.destination, leg.origin);
      if (!seenOpIds.has(op.id)) {
        seenOpIds.add(op.id);
        operators.push(op);
      }
    });
    if (operators.length === 0) {
      operators.push(getOperatorDetails('MVB', 'Tram'));
    }

    // Primäres Design-Thema für das Gesamtdokument
    const primaryOp = operators[0] || getOperatorDetails('MVB', 'Tram');

    // Header Logos aller beteiligten Unternehmen
    const logosHtml = operators.map(op => `
      <div style="display:inline-block; margin-left:8px; text-align:right;">
        <img src="${op.logo}" alt="${escapeHtml(op.name)}" style="max-height:28px; max-width:85px; object-fit:contain; display:block; margin-left:auto;" />
        <span style="font-size:7.5px; font-weight:700; color:${op.primaryColor};">${escapeHtml(op.shortName)}</span>
      </div>
    `).join('');

    // Linienübersicht
    const lineBadgesHtml = transitLegs.map(l => {
      const legOp = getOperatorDetails(l.operator, l.line, l.destination, l.origin);
      return `
        <span style="background:${legOp.primaryColor}; color:#ffffff; padding:1px 5px; border-radius:2px; font-weight:800; font-size:10px; margin:0 2px;">
          ${escapeHtml(l.line)}
        </span>
      `;
    }).join('<span style="color:#64748b; font-size:9.5px;"> ➔ </span>');

    // Status Banner (kompakt)
    let statusBannerHtml = '';
    if (isMissed) {
      statusBannerHtml = `
        <div style="background:#450a0a; border:1.5px solid #ef4444; color:#ffffff; padding:5px 10px; border-radius:5px; font-size:11px; font-weight:800; text-align:center; letter-spacing:0.4px; margin-bottom:5px;">
          ❌ BESTÄTIGUNG ÜBER ANSCHLUSSVERLUST: ANSCHLUSS KANN VSL. NICHT ERREICHT WERDEN
          ${brokenStation ? `<div style="font-size:9.5px; font-weight:600; margin-top:2px; color:#fca5a5;">Betroffener Umsteigepunkt: ${escapeHtml(brokenStation)}</div>` : ''}
        </div>
      `;
    } else {
      statusBannerHtml = `
        <div style="background:#f0fdf4; border:1px solid #86efac; color:#15803d; padding:4px 10px; border-radius:5px; font-size:10.5px; font-weight:700; text-align:center; margin-bottom:5px;">
          ✓ BESTÄTIGUNG ÜBER REISEVERBINDUNG (PLANMÄSSIG ERREICHBAR)
        </div>
      `;
    }

    // Deutsche Bahn Link falls DB-Zug beteiligt
    let dbSectionHtml = '';
    const dbLeg = transitLegs.find(l => getOperatorDetails(l.operator, l.line, l.destination, l.origin).isDB);
    if (dbLeg) {
      const trainId = dbLeg.line;
      const dbUrl = `https://bahn.expert/details/${encodeURIComponent(trainId)}?date=${now.toISOString().slice(0,10)}`;
      const qrSvg = (root.QRCodeUtil && typeof root.QRCodeUtil.createSVG === 'function') 
        ? root.QRCodeUtil.createSVG(dbUrl, 44) 
        : '';

      dbSectionHtml = `
        <div style="background:#fef2f2; border:1px solid #fca5a5; border-radius:5px; padding:3px 8px; margin:3px 0; display:flex; align-items:center; gap:8px;">
          <div style="flex-shrink:0; background:#ffffff; padding:2px; border:1px solid #e2e8f0; border-radius:4px; line-height:0;">
            ${qrSvg}
          </div>
          <div style="flex:1; font-size:9px; color:#334155; line-height:1.25;">
            <strong style="color:#b91c1c; text-transform:uppercase;">🚆 Deutsche Bahn Live-Verifikation (${escapeHtml(dbLeg.line)}):</strong>
            Prüfung unter <a href="${dbUrl}" target="_blank" rel="noopener noreferrer" style="color:#0284c7; word-break:break-all;">${dbUrl}</a>
          </div>
        </div>
      `;
    }

    // Teilstreckentabelle mit allen Linien
    let legsRowsHtml = '';
    legs.forEach((leg, idx) => {
      const isWalk = leg.type === 'walk';
      const legOp = getOperatorDetails(leg.operator, leg.line, leg.destination, leg.origin);
      const depDelay = leg.departure_delay || 0;
      const arrDelay = leg.arrival_delay || 0;

      let depAct = leg.departure_time || '–';
      if (depDelay > 0 && depAct.includes(':')) {
        const [h, m] = depAct.split(':').map(Number);
        const d = new Date(); d.setHours(h, m + depDelay, 0);
        depAct = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }

      let arrAct = leg.arrival_time || '–';
      if (arrDelay > 0 && arrAct.includes(':')) {
        const [h, m] = arrAct.split(':').map(Number);
        const d = new Date(); d.setHours(h, m + arrDelay, 0);
        arrAct = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }

      let statusHtml = '<span style="color:#16a34a; font-weight:700;">pünktlich</span>';
      if (leg.cancelled) {
        statusHtml = '<span style="background:#ef4444; color:#ffffff; padding:1px 3px; border-radius:2px; font-size:8px; font-weight:700;">Ausfall</span>';
      } else if (depDelay > 0 || arrDelay > 0) {
        const maxD = Math.max(depDelay, arrDelay);
        statusHtml = `<span style="color:${maxD >= 10 ? '#dc2626' : '#d97706'}; font-weight:700;">+${maxD} Min</span>`;
      }

      legsRowsHtml += `
        <tr style="border-bottom:1px solid #e2e8f0; background:${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
          <td style="padding:3.5px 5px; font-size:9.5px; color:#0f172a;">
            ${isWalk 
              ? `<span style="color:#64748b; font-weight:600;">🚶 Fußweg</span>` 
              : `<span style="display:inline-block; background:${legOp.primaryColor}; color:#ffffff; font-size:9px; font-weight:800; padding:1px 4px; border-radius:2px; margin-right:3px;">${escapeHtml(leg.line)}</span>
                 <span style="font-size:8.5px; color:${legOp.primaryColor}; font-weight:700;">${escapeHtml(legOp.shortName)}</span>`
            }
          </td>
          <td style="padding:3.5px 5px; font-size:9.5px; color:#0f172a;">
            <strong>${escapeHtml(leg.origin)}</strong> ➔ ${escapeHtml(leg.destination)}
          </td>
          <td style="padding:3.5px 5px; font-size:9.5px; color:#475569; text-align:center;">
            ${leg.platform ? escapeHtml(leg.platform) : '–'}
          </td>
          <td style="padding:3.5px 5px; font-size:9.5px; text-align:center; font-family:monospace; color:#0f172a;">
            ${leg.departure_time || '–'} - ${leg.arrival_time || '–'}
          </td>
          <td style="padding:3.5px 5px; font-size:9.5px; text-align:center; font-family:monospace; color:${(depDelay > 0 || arrDelay > 0) ? '#dc2626' : '#0f172a'};">
            ${depAct} - ${arrAct}
          </td>
          <td style="padding:3.5px 5px; font-size:9.5px; text-align:center;">
            ${statusHtml}
          </td>
        </tr>
      `;

      // Umstiegs-Zwischenzeile
      if (idx < legs.length - 1) {
        const transInfo = leg.transfer_to_next;
        const isBroken = (transInfo && transInfo.is_broken) || (c.missed_connection && (c.broken_transfer_station === leg.destination || !c.broken_transfer_station));
        const bufferMins = transInfo ? transInfo.buffer_mins : null;
        const station = (transInfo && transInfo.station) || leg.destination;

        if (isBroken) {
          legsRowsHtml += `
            <tr style="background:#fef2f2; border-top:1px solid #f87171; border-bottom:1px solid #f87171;">
              <td colspan="6" style="padding:3.5px 7px; font-size:9px; color:#991b1b; font-weight:700;">
                ⚠️ Umstieg in <strong>${escapeHtml(station)}</strong>: <span style="background:#dc2626; color:#ffffff; padding:1px 4px; border-radius:2px; margin-left:3px;">Anschluss kann vsl. nicht erreicht werden</span>
                <span style="font-size:8.5px; font-weight:600; color:#b91c1c; margin-left:5px;">(Kalkulierter Puffer: ${bufferMins !== null ? bufferMins + ' Min.' : 'nicht ausreichend'})</span>
              </td>
            </tr>
          `;
        } else {
          legsRowsHtml += `
            <tr style="background:#f1f5f9; border-top:1px dashed #cbd5e1; border-bottom:1px dashed #cbd5e1;">
              <td colspan="6" style="padding:2px 7px; font-size:8.5px; color:#475569;">
                🔄 Umstieg in <strong>${escapeHtml(station)}</strong> ${bufferMins !== null ? `(Pufferzeit: ca. ${bufferMins} Min.)` : ''}
              </td>
            </tr>
          `;
        }
      }
    });

    return `
      <div class="certificate-paper" style="background:#ffffff; color:#0f172a; border-radius:6px; padding:14px 18px; max-width:800px; max-height:282mm; height:100%; box-sizing:border-box; margin:0 auto; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; display:flex; flex-direction:column; justify-content:space-between; line-height:1.25; overflow:hidden;">
        
        <div>
          <!-- Header mit Straßenbahn-Bild & Verkehrsunternehmens-Logo & Styling -->
          <div style="display:flex; justify-content:space-between; align-items:center; padding-bottom:5px; border-bottom:3px solid ${primaryOp.primaryColor}; margin-bottom:5px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <img src="tram_mvb.png" alt="Magdeburg Mobil Straßenbahn" style="height:36px; max-width:75px; object-fit:contain; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.15));" />
              <div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="font-size:16px; font-weight:900; color:${primaryOp.primaryColor}; letter-spacing:-0.5px; line-height:1;">MAGDEBURG</span>
                  <span style="background:${primaryOp.primaryColor}; color:#ffffff; font-size:10.5px; font-weight:900; padding:2px 6px; border-radius:3px; letter-spacing:0.5px; line-height:1;">MOBIL</span>
                </div>
                <div style="font-size:9px; font-weight:700; color:#475569; margin-top:2px; text-transform:uppercase; letter-spacing:0.5px;">Offizielles Fahrgast- &amp; Anschlussnachweis-Portal</div>
                <div style="font-size:7.5px; color:#64748b;">Überregionales Fahrgast- &amp; Reiseketten-Nachweisportal (ÖPNV / SPNV)</div>
              </div>
            </div>
            <div style="display:flex; align-items:center;">
              ${logosHtml}
            </div>
          </div>

          <!-- Titel -->
          <div style="text-align:center; margin-bottom:5px;">
            <h1 style="font-size:13.5px; font-weight:800; color:#0f172a; margin:0 0 1px 0; text-transform:uppercase; letter-spacing:0.5px;">
              Fahrt- &amp; Anschlussbruchbescheinigung
            </h1>
            <p style="font-size:9.5px; color:#475569; margin:0;">
              Nachweis für die Gesamtverbindung zur Vorlage bei Arbeitgeber, Schule, Universität oder Bahn
            </p>
          </div>

          ${statusBannerHtml}

          <!-- Fahrtdaten Grid -->
          <div style="background:${primaryOp.lightBg}; border:1.5px solid ${primaryOp.primaryColor}33; border-radius:5px; padding:5px 10px; margin-bottom:5px; display:grid; grid-template-columns:1fr 1fr; gap:3px 12px; font-size:10.5px;">
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Gesamtreiseweg:</span>
              <strong style="color:#0f172a;">${escapeHtml(startStation)} ➔ ${escapeHtml(endStation)}</strong>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Genutzte Linien:</span>
              <div style="margin-top:1px;">${lineBadgesHtml}</div>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Datum der Reise:</span>
              <span style="color:#0f172a;">${formattedDate}</span>
            </div>
            <div>
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Reisezeit &amp; Umstiege:</span>
              <span style="color:#0f172a;">${c.duration || 0} Min. (${c.transfers === 0 ? 'Direktfahrt' : c.transfers + ' Umstiege'})</span>
            </div>
            <div style="grid-column: span 2; border-top:1px dashed ${primaryOp.primaryColor}33; padding-top:2px; margin-top:2px;">
              <span style="display:block; font-size:8.5px; font-weight:700; color:#64748b; text-transform:uppercase;">Anschlussstatus &amp; Erreichbarkeit:</span>
              <strong style="${isMissed ? 'color:#dc2626;' : 'color:#15803d;'}">
                ${isMissed ? '❌ ANSCHLUSS KANN VSL. NICHT ERREICHT WERDEN (ANSCHLUSSVERLUST VERIFIZIERT)' : '✓ Alle Umstiege und Anschlüsse planmäßig erreichbar'}
              </strong>
            </div>
          </div>

          ${dbSectionHtml}

          <!-- Ausgeschilderte Linien- & Teilstreckentabelle -->
          <div style="margin-bottom:4px;">
            <div style="font-size:9px; font-weight:800; color:#334155; text-transform:uppercase; margin-bottom:2px; letter-spacing:0.3px;">
              Ausgeschilderte Teilstrecken &amp; Umstiege der Verbindung:
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:9.5px; border:1px solid #cbd5e1; border-radius:4px; overflow:hidden;">
              <thead>
                <tr style="background:${primaryOp.primaryColor}; color:#ffffff; font-size:8px; text-transform:uppercase; font-weight:800;">
                  <th style="padding:2.5px 5px; text-align:left; width:90px;">Linie / Träger</th>
                  <th style="padding:2.5px 5px; text-align:left;">Streckenabschnitt</th>
                  <th style="padding:2.5px 5px; text-align:center; width:45px;">Gleis</th>
                  <th style="padding:2.5px 5px; text-align:center; width:70px;">Planmäßig</th>
                  <th style="padding:2.5px 5px; text-align:center; width:70px;">Tatsächlich</th>
                  <th style="padding:2.5px 5px; text-align:center; width:65px;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${legsRowsHtml}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Bestätigungsvermerk & Magdeburg Mobil Kennzeichnung -->
        <div style="border-top:1.5px solid #e2e8f0; padding-top:4px; margin-top:3px; display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div style="font-size:8.5px; color:#475569; line-height:1.25; flex:1;">
            <strong style="color:#0f172a; display:block; margin-bottom:1px;">Bestätigungsvermerk:</strong>
            Hiermit wird bescheinigt, dass für die vorstehende Reisekette die betrieblichen Fahrplandaten und Verzögerungen aus den offiziellen HAFAS-Echtzeitsystemen erfasst wurden. ${isMissed ? 'Der Anschlussverlust wurde durch verspäteten Zubringer bzw. Ausfall verifiziert.' : 'Die Fahrt wurde im System dokumentiert.'}
            <div style="font-size:8px; font-weight:600; color:#1e293b; margin-top:3px; padding-top:2px; border-top:1px dashed #cbd5e1;">
              Elektronisch erstellt am ${dateStr} um ${timeStr} Uhr mithilfe der Magdeburg Mobil App. Dieses Dokument dient zur Nachweispflicht von Verspätung bzw. Ausfällen.
            </div>
          </div>
          <div style="flex-shrink:0; text-align:right; font-weight:900; line-height:1.05; color:#000000; padding-left:12px;">
            <div style="font-size:13.5px; letter-spacing:0.5px; font-weight:900; color:#000000;">MAGDEBURG</div>
            <div style="font-size:13.5px; letter-spacing:0.5px; font-weight:900; color:#000000;">MOBIL</div>
          </div>
        </div>

      </div>
    `;
  }

  // Gibt reines Standalone-CSS für das Drucken zurück (isoliert im Druck-Iframe)
  // Sperrt den Ausdruck physikalisch auf GENAU EINE A4-SEITE
  function getCertificatePrintCSS() {
    return `
      @page {
        size: A4 portrait;
        margin: 6mm 8mm;
      }
      *, *::before, *::after {
        box-sizing: border-box !important;
      }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        height: 100% !important;
        max-height: 284mm !important;
        overflow: hidden !important;
        background: #ffffff !important;
        color: #0f172a !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .no-print {
        display: none !important;
      }
      .certificate-paper {
        box-shadow: none !important;
        border: none !important;
        padding: 3mm 5mm !important;
        max-height: 284mm !important;
        height: 284mm !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
        overflow: hidden !important;
        page-break-inside: avoid !important;
        page-break-after: avoid !important;
        page-break-before: avoid !important;
      }
      table {
        page-break-inside: avoid !important;
      }
      tr {
        page-break-inside: avoid !important;
      }
    `;
  }

  // Öffnet das Modal für Einzelfahrt
  function openCertificateModal(journeyData, departureInfo) {
    const modal = document.getElementById('certificateModal');
    const container = document.getElementById('certificateModalContainer');
    
    if (!modal || !container) {
      console.error("Certificate modal elements not found in DOM");
      return;
    }

    const htmlContent = buildCertificateHTML(journeyData, departureInfo);
    container.innerHTML = htmlContent;
    modal._currentCertHTML = htmlContent;

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  // Öffnet das Modal für Gesamtverbindung
  function openConnectionCertificateModal(connection, origin, destination) {
    const modal = document.getElementById('certificateModal');
    const container = document.getElementById('certificateModalContainer');
    
    if (!modal || !container) {
      console.error("Certificate modal elements not found in DOM");
      return;
    }

    const htmlContent = buildConnectionCertificateHTML(connection, origin, destination);
    container.innerHTML = htmlContent;
    modal._currentCertHTML = htmlContent;

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }

  function closeCertificateModal() {
    const modal = document.getElementById('certificateModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
  }

  // DIE ZUVERLÄSSIGE DRUCKFUNKTION:
  // Verwendet ein isoliertes Iframe – dadurch wird die Seite NIEMALS weiß oder leer!
  function printCertificate(mode) {
    const modal = document.getElementById('certificateModal');
    const certHtml = (modal && modal._currentCertHTML) 
      ? modal._currentCertHTML 
      : (document.getElementById('certificateModalContainer') ? document.getElementById('certificateModalContainer').innerHTML : '');

    if (!certHtml) {
      alert("Kein Dokument geladen.");
      return;
    }

    let printFrame = document.getElementById('cert-isolated-print-frame');
    if (!printFrame) {
      printFrame = document.createElement('iframe');
      printFrame.id = 'cert-isolated-print-frame';
      printFrame.style.position = 'fixed';
      printFrame.style.right = '0';
      printFrame.style.bottom = '0';
      printFrame.style.width = '10px';
      printFrame.style.height = '10px';
      printFrame.style.border = '0';
      printFrame.style.opacity = '0.01';
      printFrame.style.pointerEvents = 'none';
      document.body.appendChild(printFrame);
    }

    const isPdf = mode === 'pdf';
    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '-');
    const pageTitle = isPdf 
      ? `Fahrtnachweis_MagdeburgMobil_${dateStr}` 
      : `Magdeburg Mobil - Fahrt- & Verspätungsbescheinigung`;

    const frameDoc = printFrame.contentDocument || printFrame.contentWindow.document;
    frameDoc.open();
    frameDoc.write(`<!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <title>${pageTitle}</title>
      <style>
        ${getCertificatePrintCSS()}
      </style>
    </head>
    <body>
      ${certHtml}
    </body>
    </html>`);
    frameDoc.close();

    setTimeout(() => {
      try {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
      } catch (err) {
        console.warn("Iframe print fallback to window.open", err);
        openPrintWindow(certHtml, pageTitle);
      }
    }, 250);
  }

  // Ermittelt die korrekte URL für die PDF-Generierungs-API (funktioniert auf file://, localhost, und deployed)
  function getPdfApiUrl() {
    if (typeof window !== 'undefined') {
      if (window.API_BASE) {
        return window.API_BASE.replace(/\/api\/?$/, '') + '/api/generate-pdf';
      }
      if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:5000/api/generate-pdf';
      }
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return 'http://127.0.0.1:5000/api/generate-pdf';
      }
    }
    return '/api/generate-pdf';
  }

  // PDF-Speicherfunktion: ECHTER Datei-Download als .pdf (kein Weiterleiten zur Druckseite!)
  async function saveAsPdf() {
    const modal = document.getElementById('certificateModal');
    const container = document.getElementById('certificateModalContainer');
    const certHtml = (modal && modal._currentCertHTML) 
      ? modal._currentCertHTML 
      : (container ? container.innerHTML : '');

    if (!certHtml) {
      if (typeof window.showToast === 'function') {
        window.showToast("Kein Dokument geladen.", "error");
      }
      return;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '-');
    const filename = `Fahrtnachweis_MagdeburgMobil_${dateStr}.pdf`;

    // Button-Feedback: Lädt...
    const btnPdfList = document.querySelectorAll('.btn-cert-pdf');
    btnPdfList.forEach(btn => {
      btn._origText = btn.innerHTML;
      btn.innerHTML = '⏳ PDF wird erstellt...';
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.75';
    });

    try {
      // 1. Primär: Echte Vektor-PDF über Backend-API generieren und direkt herunterladen
      const apiUrl = getPdfApiUrl();
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          html: certHtml,
          filename: filename
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.style.display = 'none';
      downloadLink.href = blobUrl;
      downloadLink.download = filename;
      document.body.appendChild(downloadLink);
      downloadLink.click();

      setTimeout(() => {
        window.URL.revokeObjectURL(blobUrl);
        if (downloadLink.parentNode) {
          downloadLink.parentNode.removeChild(downloadLink);
        }
      }, 1000);

      // Kurzes Erfolgs-Feedback
      btnPdfList.forEach(btn => {
        btn.innerHTML = '✓ Heruntergeladen!';
      });
      setTimeout(() => {
        btnPdfList.forEach(btn => {
          if (btn._origText) btn.innerHTML = btn._origText;
          btn.style.pointerEvents = 'auto';
          btn.style.opacity = '1';
        });
      }, 2000);
      return;

    } catch (err) {
      console.warn("Backend PDF generation failed, trying client-side html2pdf:", err);

      // 2. Client-Fallback mit html2pdf (erzeugt ebenfalls direkt eine PDF-Datei ohne Druckdialog)
      if (typeof window.html2pdf === 'function' || (window.html2pdf && typeof window.html2pdf().from === 'function')) {
        try {
          const targetEl = document.querySelector('.certificate-paper');
          const opt = {
            margin: [4, 6, 4, 6],
            filename: filename,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
          };
          window.html2pdf().set(opt).from(targetEl || certHtml).save();
          btnPdfList.forEach(btn => {
            btn.innerHTML = '✓ Heruntergeladen!';
          });
          setTimeout(() => {
            btnPdfList.forEach(btn => {
              if (btn._origText) btn.innerHTML = btn._origText;
              btn.style.pointerEvents = 'auto';
              btn.style.opacity = '1';
            });
          }, 2000);
          return;
        } catch (clientErr) {
          console.error("Client fallback html2pdf failed:", clientErr);
        }
      }

      // 3. Fehlerfall: Sanftes Feedback auf dem Button ohne blockierende Alert-Meldung
      btnPdfList.forEach(btn => {
        btn.innerHTML = '⚠️ Bitte Drucken nutzen';
      });
      setTimeout(() => {
        btnPdfList.forEach(btn => {
          if (btn._origText) btn.innerHTML = btn._origText;
          btn.style.pointerEvents = 'auto';
          btn.style.opacity = '1';
        });
      }, 3000);
    }
  }

  // Zweite Druck-Option: In separatem Fenster öffnen
  function openPrintWindow(htmlContent, title) {
    const certHtml = htmlContent || (document.getElementById('certificateModalContainer') ? document.getElementById('certificateModalContainer').innerHTML : '');
    const win = window.open('', '_blank', 'width=840,height=960');
    if (!win) {
      alert("Bitte erlaube Popups für den Direktdruck.");
      return;
    }
    const pageTitle = title || 'Magdeburg Mobil - Verspätungsnachweis';
    win.document.open();
    win.document.write(`<!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="UTF-8">
      <title>${pageTitle}</title>
      <style>
        ${getCertificatePrintCSS()}
      </style>
    </head>
    <body>
      ${certHtml}
      <script>
        window.onload = function() {
          setTimeout(function() { window.print(); }, 200);
        };
      </script>
    </body>
    </html>`);
    win.document.close();
  }

  root.CertificateEngine = {
    getOperatorDetails: getOperatorDetails,
    buildCertificateHTML: buildCertificateHTML,
    buildConnectionCertificateHTML: buildConnectionCertificateHTML,
    openCertificateModal: openCertificateModal,
    openConnectionCertificateModal: openConnectionCertificateModal,
    closeCertificateModal: closeCertificateModal,
    printCertificate: printCertificate,
    saveAsPdf: saveAsPdf,
    openPrintWindow: openPrintWindow
  };

})(typeof window !== 'undefined' ? window : this);
