document.addEventListener('DOMContentLoaded', () => {
    // Smart API Base URL: If opened directly via file://, point to local server.
    const API_BASE = window.location.protocol === 'file:' 
        ? 'http://127.0.0.1:5000/api' 
        : '/api';

    // UI Navigation Elements
    const desktopNavItems = document.querySelectorAll('.nav-item-desktop');
    const sections = document.querySelectorAll('.content-section');
    
    // Unified tab Mode Selector (Abfahrten vs Verbindungssuche)
    const modeDeparturesBtn = document.getElementById('mode-departures-btn');
    const modeConnectionsBtn = document.getElementById('mode-connections-btn');
    const departuresWidget = document.getElementById('departures-search-widget');
    const connectionsWidget = document.getElementById('connections-search-widget');

    // UI Elements for Departures
    const searchInput = document.getElementById('station-search');
    const searchResults = document.getElementById('search-results');
    const currentStationName = document.getElementById('current-station-name');
    const currentStationTariffZone = document.getElementById('current-station-tariff-zone');
    const departuresContainer = document.getElementById('departures-container');
    const refreshBtn = document.getElementById('refresh-btn');
    const quickAlertBtn = document.getElementById('quick-alert-btn');
    const disruptionBadge = document.getElementById('disruption-badge');
    const clearSearchBtn = document.getElementById('clear-search');
    const departuresDateInput = document.getElementById('departures-date');
    const departuresTimeInput = document.getElementById('departures-time');
    const departuresDurationSelect = document.getElementById('departures-duration');

    // UI Elements for Connection Planner
    const routeStartInput = document.getElementById('route-start');
    const routeStartResults = document.getElementById('route-start-results');
    const routeDestInput = document.getElementById('route-dest');
    const routeDestResults = document.getElementById('route-dest-results');
    const searchConnectionsBtn = document.getElementById('search-connections-btn');
    const connectionsContainer = document.getElementById('connections-container');
    const routeDateInput = document.getElementById('route-date');
    const routeTimeInput = document.getElementById('route-time');

    // Unified Detail Panel Elements (Right-hand panel)
    const unifiedPlaceholder = document.getElementById('unified-placeholder');
    const desktopTimelineCard = document.getElementById('desktop-timeline-card');
    const connectionDetailCard = document.getElementById('connection-detail-card');

    // Departures timeline fields
    const desktopJourneyBadge = document.getElementById('desktop-journey-badge');
    const desktopJourneyLineTitle = document.getElementById('desktop-journey-line-title');
    const desktopJourneyDirection = document.getElementById('desktop-journey-direction');
    const desktopJourneyContainer = document.getElementById('desktop-journey-container');
    const desktopJourneyDate = document.getElementById('desktop-journey-date');


    // Connection details timeline fields
    const detailRouteDuration = document.getElementById('detail-route-duration');
    const detailRouteTitle = document.getElementById('detail-route-title');
    const detailRouteSummary = document.getElementById('detail-route-summary');
    const connectionLegsContainer = document.getElementById('connection-legs-container');
    
    // State Variables
    let currentStationId = '7393'; // Default to Magdeburg, Hauptbahnhof
    let currentStationText = 'Magdeburg, Hauptbahnhof/Willy-Brandt-Platz';
    let activeJourneyData = null; // Stored to re-render if needed
    let activeConnectionData = null;
    let searchMode = 'departures'; // 'departures' or 'connections'
    let knownDisruptionKeys = new Set();
    let isFirstDisruptionLoad = true;
    let timelineRefreshInterval = null;

    // Selected stations for connection planner
    let connectionStartStop = { name: '', id: '' };
    let connectionDestStop = { name: '', id: '' };

    // Set today's date in Germany format (DD.MM.YYYY)
    const today = new Date();
    const formattedDate = today.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    if (desktopJourneyDate) desktopJourneyDate.textContent = formattedDate;

    // Set default values for departures and connection planner date and time input boxes
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const hh = String(today.getHours()).padStart(2, '0');
    const min = String(today.getMinutes()).padStart(2, '0');

    if (routeDateInput && routeTimeInput) {
        routeDateInput.value = `${yyyy}-${mm}-${dd}`;
        routeTimeInput.value = `${hh}:${min}`;
    }
    if (departuresDateInput && departuresTimeInput) {
        departuresDateInput.value = `${yyyy}-${mm}-${dd}`;
        departuresTimeInput.value = `${hh}:${min}`;
    }

    // --- Navigation Switching (Top Tabs) ---
    function switchTab(targetId) {
        desktopNavItems.forEach(i => i.classList.remove('active'));
        sections.forEach(s => s.classList.remove('active'));
        
        const activeDesktop = document.querySelector(`.nav-item-desktop[data-target="${targetId}"]`);
        const targetSection = document.getElementById(targetId);
        
        if (activeDesktop) activeDesktop.classList.add('active');
        if (targetSection) targetSection.classList.add('active');
    }

    desktopNavItems.forEach(item => {
        item.addEventListener('click', () => {
            switchTab(item.getAttribute('data-target'));
        });
    });

    // --- Mode Selector (Abfahrten vs Verbindungssuche) ---
    function switchSearchMode(mode) {
        searchMode = mode;
        if (mode === 'departures') {
            modeDeparturesBtn.classList.add('active');
            modeConnectionsBtn.classList.remove('active');
            departuresWidget.style.display = 'block';
            connectionsWidget.style.display = 'none';

            // Show active departure details if selected, else show placeholder
            if (activeJourneyData) {
                unifiedPlaceholder.style.display = 'none';
                desktopTimelineCard.style.display = 'flex';
                connectionDetailCard.style.display = 'none';
            } else {
                unifiedPlaceholder.style.display = 'flex';
                desktopTimelineCard.style.display = 'none';
                connectionDetailCard.style.display = 'none';
            }
        } else {
            modeDeparturesBtn.classList.remove('active');
            modeConnectionsBtn.classList.add('active');
            departuresWidget.style.display = 'none';
            connectionsWidget.style.display = 'block';

            // Show active connection details if selected, else show placeholder
            if (activeConnectionData) {
                unifiedPlaceholder.style.display = 'none';
                desktopTimelineCard.style.display = 'none';
                connectionDetailCard.style.display = 'flex';
            } else {
                unifiedPlaceholder.style.display = 'flex';
                desktopTimelineCard.style.display = 'none';
                connectionDetailCard.style.display = 'none';
            }
        }
    }

    modeDeparturesBtn.addEventListener('click', () => switchSearchMode('departures'));
    modeConnectionsBtn.addEventListener('click', () => switchSearchMode('connections'));

    // Quick Alerts click
    quickAlertBtn.addEventListener('click', () => {
        switchTab('stoerungen');
    });

    // Refresh action
    refreshBtn.addEventListener('click', () => {
        fetchDepartures();
        fetchDisruptions();
        
        const refreshIcon = refreshBtn.querySelector('.material-icons-round');
        refreshIcon.style.transform = 'rotate(360deg)';
        refreshIcon.style.transition = 'transform 0.8s ease';
        setTimeout(() => {
            refreshIcon.style.transform = 'none';
            refreshIcon.style.transition = 'none';
        }, 800);
    });

    // Automatic refresh when departures duration, date, or time changes
    if (departuresDateInput) {
        departuresDateInput.addEventListener('change', () => fetchDepartures());
    }
    if (departuresTimeInput) {
        departuresTimeInput.addEventListener('change', () => fetchDepartures());
    }
    if (departuresDurationSelect) {
        departuresDurationSelect.addEventListener('change', () => fetchDepartures());
    }

    // --- Search Autocomplete Inputs ---
    function setupAutocomplete(inputEl, resultsEl, onSelect) {
        let timeout;
        inputEl.addEventListener('input', (e) => {
            clearTimeout(timeout);
            const query = e.target.value.trim();
            
            if (query.length < 3) {
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                return;
            }

            timeout = setTimeout(async () => {
                try {
                    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
                    const data = await res.json();
                    renderInlineSearchResults(data, resultsEl, inputEl, onSelect);
                } catch (err) {
                    console.error("Autocomplete search error:", err);
                }
            }, 300);
        });

        // Hide search results when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (!inputEl.contains(e.target) && !resultsEl.contains(e.target)) {
                resultsEl.style.display = 'none';
            }
        });
    }

    function renderInlineSearchResults(results, resultsContainer, inputElement, onSelect) {
        resultsContainer.innerHTML = '';
        if (results.length === 0) {
            resultsContainer.style.display = 'none';
            return;
        }

        results.forEach(station => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `
                <span class="material-icons-round" style="font-size: 16px; color: var(--text-gray);">place</span>
                <span>${station.name}</span>
            `;
            div.addEventListener('click', () => {
                inputElement.value = station.name;
                resultsContainer.style.display = 'none';
                onSelect(station);
            });
            resultsContainer.appendChild(div);
        });
        resultsContainer.style.display = 'block';
    }

    // Setup departures search
    setupAutocomplete(searchInput, searchResults, (station) => {
        currentStationId = station.id;
        currentStationText = station.name;
        currentStationName.textContent = station.name;
        updateTariffZone(station.name);
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';
        
        // Reset departures details
        activeJourneyData = null;
        unifiedPlaceholder.style.display = 'flex';
        desktopTimelineCard.style.display = 'none';
        
        fetchDepartures();
    });

    searchInput.addEventListener('input', (e) => {
        if (e.target.value.length > 0) {
            clearSearchBtn.style.display = 'block';
        } else {
            clearSearchBtn.style.display = 'none';
        }
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.style.display = 'none';
        searchResults.style.display = 'none';
        searchInput.focus();
    });

    // Setup connection planner search inputs
    setupAutocomplete(routeStartInput, routeStartResults, (station) => {
        connectionStartStop.name = station.name;
        connectionStartStop.id = station.id;
    });

    setupAutocomplete(routeDestInput, routeDestResults, (station) => {
        connectionDestStop.name = station.name;
        connectionDestStop.id = station.id;
    });

    // --- Line badge color formatting ---
    function getLineStyles(lineName, type) {
        const cleanName = lineName.replace("Str", "").replace("Tram", "").replace("Bus", "").replace("Linie", "").replace("Line", "").replace(" ", "").trim();
        const isTram = type === 'tram';
        const colorClass = `line-color-${cleanName}`;
        
        return {
            text: cleanName,
            shape: isTram ? 'shape-tram' : 'shape-bus',
            colorClass: colorClass,
            type: isTram ? 'tram' : 'bus',
            icon: isTram ? 'tram' : 'directions_bus'
        };
    }

    // Dynamic marego Tariff Zone calculator
    function updateTariffZone(stationName) {
        if (!currentStationTariffZone) return;
        
        let town = 'Magdeburg';
        if (stationName && stationName.includes(',')) {
            town = stationName.split(',')[0].trim();
        }
        
        const cleanTown = town.toLowerCase();
        let zone = 'MD (Zone 010)'; // Default to city zone
        
        if (cleanTown.includes('schönebeck') || cleanTown.includes('schoenebeck')) {
            zone = 'Schönebeck (Zone 021)';
        } else if (cleanTown.includes('wolmirstedt')) {
            zone = 'Wolmirstedt (Zone 018)';
        } else if (cleanTown.includes('burg')) {
            zone = 'Burg (Zone 012)';
        } else if (cleanTown.includes('biederitz') || cleanTown.includes('heyrothsberge')) {
            zone = 'Biederitz (Zone 022)';
        } else if (cleanTown.includes('barleben')) {
            zone = 'Barleben (Zone 010/018)';
        } else if (cleanTown.includes('haldensleben')) {
            zone = 'Haldensleben (Zone 015)';
        } else if (cleanTown.includes('wanzleben')) {
            zone = 'Wanzleben (Zone 037)';
        } else {
            if (cleanTown !== 'magdeburg') {
                zone = `${town} (Umland-Tarif)`;
            }
        }
        
        currentStationTariffZone.textContent = `${town} • marego Tarifzone ${zone}`;
    }

    // Helper to calculate expected time for delays > 5 mins
    function calculateExpectedTime(plannedTime, delay) {
        if (!plannedTime || delay <= 5) return '';
        try {
            const [h, m] = plannedTime.split(':').map(Number);
            const expectedDate = new Date();
            expectedDate.setHours(h);
            expectedDate.setMinutes(m + delay);
            return expectedDate.toLocaleTimeString('de-DE', {
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            console.error("Delay calculations error:", e);
            return '';
        }
    }



    // --- Fetch Live Departures ---
    async function fetchDepartures(quiet = false) {
        if (!quiet) {
            departuresContainer.innerHTML = `
                <div class="loading-state">
                    <div class="custom-spinner"></div>
                    <p>Suche Verbindungen...</p>
                </div>
            `;
        }

        const dateVal = departuresDateInput ? departuresDateInput.value : '';
        const timeVal = departuresTimeInput ? departuresTimeInput.value : '';
        const durationVal = departuresDurationSelect ? departuresDurationSelect.value : '60';

        const url = `${API_BASE}/departures?station_id=${currentStationId}&date=${encodeURIComponent(dateVal)}&time=${encodeURIComponent(timeVal)}&duration=${encodeURIComponent(durationVal)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            const data = await res.json();
            renderDepartures(data);
            currentStationName.textContent = currentStationText;
            updateTariffZone(currentStationText);
        } catch (err) {
            console.error("Departures error:", err);
            if (!quiet) {
                departuresContainer.innerHTML = `
                    <div class="loading-state">
                        <span class="material-icons-round" style="font-size: 36px; color: #fff;">error_outline</span>
                        <p style="color:#fff; font-weight: 600;">Verbindungsproblem</p>
                        <p style="font-size:11px;">Die Daten konnten nicht geladen werden.<br>Läuft das Python Backend?</p>
                    </div>
                `;
            }
        }
    }

    function renderDepartures(departures) {
        departuresContainer.innerHTML = '';
        if (!departures || departures.length === 0) {
            departuresContainer.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 32px; color: var(--text-gray);">info_outline</span>
                    <p>Aktuell keine Abfahrten in den nächsten 60 Minuten.</p>
                </div>
            `;
            return;
        }

        departures.forEach((dep, index) => {
            const style = getLineStyles(dep.line, dep.type);
            
            let delayHtml = '';
            let expectedTimeHtml = '';

            if (dep.delay !== null && dep.delay !== undefined) {
                if (dep.delay > 0) {
                    delayHtml = `<span class="delay-indicator delay-late">+${dep.delay} Min</span>`;
                    const expectedTimeStr = calculateExpectedTime(dep.time, dep.delay);
                    if (expectedTimeStr) {
                        expectedTimeHtml = `<div class="expected-time-label">Erwartet: ${expectedTimeStr}</div>`;
                    }
                } else if (dep.delay < 0) {
                    // negative delay: run too early -> show negative delay in red!
                    delayHtml = `<span class="delay-indicator delay-early">${dep.delay} Min</span>`;
                } else {
                    delayHtml = `<span class="delay-indicator delay-ontime">pünktlich</span>`;
                }
            }

            const card = document.createElement('div');
            card.className = 'departure-card';
            card.setAttribute('data-journey-id', dep.journey_id);
            card.setAttribute('data-line', dep.line);
            card.setAttribute('data-direction', dep.direction);
            card.setAttribute('data-time', dep.time);
            card.setAttribute('data-delay', dep.delay);
            card.setAttribute('data-type', dep.type);
            
            card.style.animation = `slideUpFade 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.04}s forwards`;
            card.style.opacity = 0;

            card.innerHTML = `
                <div class="line-badge ${style.shape} ${style.colorClass}">${style.text}</div>
                <div class="departure-info">
                    <div class="destination-line">${dep.direction}</div>
                    <div class="time-row-departures">
                        <span class="material-icons-round" style="font-size: 14px;">schedule</span>
                        <span>Soll: ${dep.time}</span>
                    </div>
                    ${expectedTimeHtml}
                </div>
                <div class="departure-time-section">
                    <div class="time-value">${dep.time}</div>
                    ${delayHtml}
                </div>
            `;

            card.addEventListener('click', () => {
                document.querySelectorAll('.departure-card').forEach(c => c.classList.remove('active-desktop'));
                card.classList.add('active-desktop');
                
                openJourneyTimeline({
                    id: dep.journey_id,
                    line: dep.line,
                    direction: dep.direction,
                    time: dep.time,
                    delay: dep.delay,
                    type: dep.type
                });
            });

            departuresContainer.appendChild(card);
        });
    }

    // --- Journey Timeline Details ---
    async function openJourneyTimeline(depInfo) {
        if (timelineRefreshInterval) {
            clearInterval(timelineRefreshInterval);
            timelineRefreshInterval = null;
        }

        unifiedPlaceholder.style.display = 'none';
        desktopTimelineCard.style.display = 'flex';
        connectionDetailCard.style.display = 'none';
        
        const style = getLineStyles(depInfo.line, depInfo.type);
        desktopJourneyBadge.className = `line-badge ${style.shape} ${style.colorClass}`;
        desktopJourneyBadge.textContent = style.text;
        desktopJourneyLineTitle.textContent = `Linie ${style.text}`;
        desktopJourneyDirection.textContent = `Richtung ${depInfo.direction}`;
        
        desktopJourneyContainer.innerHTML = `
            <div class="loading-state">
                <div class="custom-spinner"></div>
                <p>Berechne Fahrweg & Live-Positionen...</p>
            </div>
        `;
        
        activeJourneyData = depInfo;

        const url = `${API_BASE}/journey?journey_id=${encodeURIComponent(depInfo.id)}` + 
                    `&line=${encodeURIComponent(depInfo.line)}` +
                    `&direction=${encodeURIComponent(depInfo.direction)}` +
                    `&time=${encodeURIComponent(depInfo.time)}` +
                    `&delay=${encodeURIComponent(depInfo.delay)}` +
                    `&station_name=${encodeURIComponent(currentStationText)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            const data = await res.json();
            


            
            renderTimelineStops(data, depInfo.type, desktopJourneyContainer);

            // Set up background auto-refresh every 10 seconds for the active timeline tracking
            timelineRefreshInterval = setInterval(() => {
                refreshJourneyTimelineQuietly(depInfo);
            }, 10000);
        } catch (err) {
            console.error("Journey fetch error:", err);
            desktopJourneyContainer.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 32px; color: #fff;">error_outline</span>
                    <p>Linienverlauf konnte nicht geladen werden.</p>
                </div>
            `;
        }
    }

    async function refreshJourneyTimelineQuietly(depInfo) {
        // Only refresh if this journey is still selected
        if (!activeJourneyData || activeJourneyData.id !== depInfo.id) {
            return;
        }

        const url = `${API_BASE}/journey?journey_id=${encodeURIComponent(depInfo.id)}` + 
                    `&line=${encodeURIComponent(depInfo.line)}` +
                    `&direction=${encodeURIComponent(depInfo.direction)}` +
                    `&time=${encodeURIComponent(depInfo.time)}` +
                    `&delay=${encodeURIComponent(depInfo.delay)}` +
                    `&station_name=${encodeURIComponent(currentStationText)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Quiet HTTP Error ${res.status}`);
            const data = await res.json();

            // Re-render stops quietly (no spinner/flicker)
            if (activeJourneyData && activeJourneyData.id === depInfo.id) {


                renderTimelineStops(data, depInfo.type, desktopJourneyContainer);
            }
        } catch (err) {
            console.warn("Quiet journey refresh failed:", err);
        }
    }

    function getPlatformLabel(stopName, lineType) {
        if (stopName.includes("Hauptbahnhof") || stopName.includes("Hbf")) {
            const tracks = ["Gleis 1", "Gleis 2", "Gleis 5", "Gleis 6", "Gleis 7", "Gleis 8"];
            return tracks[Math.floor((stopName.length) % tracks.length)];
        }
        
        let hash = 0;
        for (let i = 0; i < stopName.length; i++) {
            hash = stopName.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        if (lineType === "tram") {
            return "Gleis " + (Math.abs(hash) % 2 === 0 ? "1" : "2");
        } else {
            return "Stg. " + (Math.abs(hash) % 2 === 0 ? "A" : "B");
        }
    }

    function renderTimelineStops(data, lineType, container) {
        container.innerHTML = '';
        const stops = data.stops;
        if (!stops || stops.length === 0) {
            container.innerHTML = '<div class="loading-state"><p>Keine Haltestellen verfügbar.</p></div>';
            return;
        }

        let vehicleIdx = -1;
        for (let i = 0; i < stops.length; i++) {
            if (stops[i].passed) {
                vehicleIdx = i;
            }
        }
        
        if (vehicleIdx === -1 && stops.length > 0) {
            vehicleIdx = 0;
        }

        stops.forEach((stop, index) => {
            const isPassed = stop.passed;
            const isVehicleHere = index === vehicleIdx;
            
            let delayOffsetHtml = '';
            let expectedTimeHtml = '';

            if (stop.delay !== null && stop.delay !== undefined) {
                if (stop.delay > 0) {
                    delayOffsetHtml = `<span class="stop-delay-offset late">+${stop.delay}</span>`;
                    const expectedTimeStr = calculateExpectedTime(stop.time, stop.delay);
                    if (expectedTimeStr) {
                        expectedTimeHtml = `<div class="expected-time-label" style="font-size: 8px; padding: 1px 4px; margin-top: 2px;">Soll ${stop.time} -> Erwartet ${expectedTimeStr}</div>`;
                    }
                } else if (stop.delay < 0) {
                    // early delay: run early -> show in red!
                    delayOffsetHtml = `<span class="stop-delay-offset early">${stop.delay}</span>`;
                } else {
                    delayOffsetHtml = `<span class="stop-delay-offset ontime">±0</span>`;
                }
            }

            const item = document.createElement('div');
            item.className = `timeline-stop ${isPassed ? 'passed' : ''} ${stop.cancelled ? 'cancelled' : ''}`;
            
            const vehicleIcon = lineType === 'tram' ? 'tram' : 'directions_bus';

            let dotHtml = '';
            if (isVehicleHere) {
                dotHtml = `
                    <div class="vehicle-marker">
                        <span class="material-icons-round">${vehicleIcon}</span>
                    </div>
                `;
            } else {
                dotHtml = `<div class="timeline-dot"></div>`;
            }

            const platform = stop.platform ? stop.platform : getPlatformLabel(stop.name, lineType);

            item.innerHTML = `
                <div class="timeline-time-col">
                    <span class="stop-sched-time">${stop.time}</span>
                    ${delayOffsetHtml}
                    ${expectedTimeHtml}
                </div>
                <div class="timeline-dot-col">
                    ${dotHtml}
                </div>
                <div class="timeline-name-col" title="${stop.name}">
                    ${stop.name}
                    ${stop.cancelled ? '<span class="cancelled-badge">Ausfall</span>' : ''}
                </div>
                <div class="timeline-platform-col">
                    ${platform}
                </div>
            `;

            container.appendChild(item);
        });

        setTimeout(() => {
            const vehicleEl = container.querySelector('.vehicle-marker');
            if (vehicleEl) {
                vehicleEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 200);
    }

    // --- Connection Planner Logic ---
    searchConnectionsBtn.addEventListener('click', async () => {
        const startVal = routeStartInput.value.trim();
        const destVal = routeDestInput.value.trim();

        if (!startVal || !destVal) {
            connectionsContainer.innerHTML = `
                <div class="connection-placeholder-info">
                    <span class="material-icons-round">info_outline</span>
                    <p style="color: #fff; font-weight:600; margin-bottom: 4px;">Eingabe unvollständig</p>
                    <p style="font-size:12px;">Bitte gib sowohl eine Start- als auch eine Ziel-Haltestelle ein.</p>
                </div>
            `;
            return;
        }

        connectionsContainer.innerHTML = `
            <div class="connection-placeholder-info">
                <div class="custom-spinner"></div>
                <p>Verbindungen werden gesucht...</p>
            </div>
        `;

        // Reset details panel
        activeConnectionData = null;
        unifiedPlaceholder.style.display = 'flex';
        connectionDetailCard.style.display = 'none';

        const originId = connectionStartStop.id ? connectionStartStop.id : startVal;
        const destId = connectionDestStop.id ? connectionDestStop.id : destVal;
        const dateVal = routeDateInput.value;
        const timeVal = routeTimeInput.value;

        const url = `${API_BASE}/connections?origin=${encodeURIComponent(originId)}&destination=${encodeURIComponent(destId)}&date=${encodeURIComponent(dateVal)}&time=${encodeURIComponent(timeVal)}`;
        
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            const data = await res.json();
            renderConnectionsList(data);
        } catch (err) {
            console.error("Connection search error:", err);
            connectionsContainer.innerHTML = `
                <div class="connection-placeholder-info">
                    <span class="material-icons-round">error_outline</span>
                    <p style="color: #fff; font-weight:600;">Verbindungssuche fehlgeschlagen</p>
                    <p style="font-size: 11px;">Die Routen konnten nicht berechnet werden.</p>
                </div>
            `;
        }
    });

    function renderConnectionsList(connections) {
        connectionsContainer.innerHTML = '';
        if (!connections || connections.length === 0) {
            connectionsContainer.innerHTML = `
                <div class="connection-placeholder-info">
                    <span class="material-icons-round">sentiment_dissatisfied</span>
                    <p>Keine Verbindungen gefunden.</p>
                </div>
            `;
            return;
        }

        connections.forEach((conn, index) => {
            const firstLeg = conn.legs[0];
            const lastLeg = conn.legs[conn.legs.length - 1];
            const depTime = firstLeg ? firstLeg.departure_time : "--:--";
            const arrTime = lastLeg ? lastLeg.arrival_time : "--:--";

            const card = document.createElement('div');
            card.className = 'connection-card';
            card.style.animation = `slideUpFade 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.05}s forwards`;
            card.style.opacity = 0;

            // Generate legs preview icons
            let legsPreviewHtml = '';
            conn.legs.forEach((leg, lIdx) => {
                if (leg.line === 'Fußweg' || leg.type === 'walk') {
                    legsPreviewHtml += `<span class="leg-badge-preview walk"><span class="material-icons-round" style="font-size: 11px; vertical-align: middle;">directions_walk</span></span>`;
                } else {
                    const style = getLineStyles(leg.line, leg.type);
                    legsPreviewHtml += `<span class="leg-badge-preview line-badge ${style.shape} ${style.colorClass} ${leg.cancelled ? 'cancelled' : ''}">${style.text}</span>`;
                }
                
                if (lIdx < conn.legs.length - 1) {
                    legsPreviewHtml += `<span class="material-icons-round leg-arrow">chevron_right</span>`;
                }
            });

            card.innerHTML = `
                <div class="connection-card-header">
                    <div class="connection-duration">
                        <span class="material-icons-round">schedule</span>
                        ${conn.duration} Min
                    </div>
                    <div class="connection-time-window">
                        ${depTime} - ${arrTime}
                    </div>
                </div>
                <div class="connection-legs-preview">
                    ${legsPreviewHtml}
                </div>
            `;

            card.addEventListener('click', () => {
                document.querySelectorAll('.connection-card').forEach(c => c.classList.remove('active-desktop'));
                card.classList.add('active-desktop');
                activeConnectionData = conn;
                showConnectionDetails(conn);
            });

            connectionsContainer.appendChild(card);
        });
    }

    function showConnectionDetails(conn) {
        unifiedPlaceholder.style.display = 'none';
        desktopTimelineCard.style.display = 'none';
        connectionDetailCard.style.display = 'flex';

        detailRouteDuration.textContent = `${conn.duration} Min`;
        
        const startName = conn.legs[0] ? conn.legs[0].origin : "Start";
        const endName = conn.legs[conn.legs.length - 1] ? conn.legs[conn.legs.length - 1].destination : "Ziel";
        detailRouteTitle.textContent = `${conn.legs[0].departure_time} - ${conn.legs[conn.legs.length - 1].arrival_time}`;
        detailRouteSummary.textContent = `${startName.replace("Magdeburg, ", "")} ➔ ${endName.replace("Magdeburg, ", "")}`;

        connectionLegsContainer.innerHTML = '';
        
        conn.legs.forEach((leg, index) => {
            const item = document.createElement('div');
            // If the leg is cancelled, we mark the whole container with cancelled class -> thick red left line!
            item.className = `connection-leg-item ${leg.cancelled ? 'cancelled' : ''}`;

            let lineBadgeHtml = '';
            let detailsHtml = '';

            if (leg.line === 'Fußweg' || leg.type === 'walk') {
                lineBadgeHtml = `<span class="leg-badge-preview walk"><span class="material-icons-round" style="font-size: 11px; vertical-align: middle;">directions_walk</span> Fußweg</span>`;
                detailsHtml = `
                    <div class="leg-time-row">
                        <span>Abmarsch: <strong>${leg.departure_time}</strong></span>
                        <span>Ankunft: <strong>${leg.arrival_time}</strong></span>
                    </div>
                    <div style="font-size: 13px; font-weight: 500; color: #fff;">
                        Fußweg von ${leg.origin} bis ${leg.destination}
                    </div>
                `;
            } else {
                const style = getLineStyles(leg.line, leg.type);
                
                let cancelledBadge = leg.cancelled ? `<span class="cancelled-badge">Ausfall</span>` : '';
                lineBadgeHtml = `<span class="leg-badge-preview line-badge ${style.shape} ${style.colorClass}" style="padding: 4px 10px; font-size:12px;">${leg.line}</span>${cancelledBadge}`;
                
                // Early run color (negative delay in red!)
                let depDelayText = '';
                if (leg.departure_delay > 0) {
                    depDelayText = ` (+${leg.departure_delay} Min)`;
                } else if (leg.departure_delay < 0) {
                    depDelayText = ` (<span class="stop-delay-offset early">${leg.departure_delay} Min</span>)`;
                }

                let arrDelayText = '';
                if (leg.arrival_delay > 0) {
                    arrDelayText = ` (+${leg.arrival_delay} Min)`;
                } else if (leg.arrival_delay < 0) {
                    arrDelayText = ` (<span class="stop-delay-offset early">${leg.arrival_delay} Min</span>)`;
                }
                
                let expectedDepTimeText = '';
                if (leg.departure_delay > 5) {
                    const expTime = calculateExpectedTime(leg.departure_time, leg.departure_delay);
                    if (expTime) expectedDepTimeText = `<span class="expected-time-label" style="font-size: 9px; padding: 1px 4px; margin-top: 0; margin-left: 6px;">Erwartet: ${expTime}</span>`;
                }

                // Show Intermediate Stops Button ("Mehr sehen")
                let intermediateStopsHtml = '';
                if (leg.journey_id) {
                    intermediateStopsHtml = `
                        <button class="show-intermediate-stops-btn" 
                                data-journey-id="${leg.journey_id}" 
                                data-line="${leg.line}" 
                                data-direction="${leg.destination}" 
                                data-time="${leg.departure_time}" 
                                data-delay="${leg.departure_delay}" 
                                data-type="${leg.type}" 
                                data-leg-index="${index}">
                            <span class="material-icons-round" style="font-size: 14px; vertical-align: middle;">expand_more</span>
                            Mehr sehen
                        </button>
                        <div class="inline-stops-timeline" id="inline-stops-container-${index}" style="display: none;"></div>
                    `;
                }

                detailsHtml = `
                    <div class="leg-time-row">
                        <span>Soll: ${leg.departure_time}${depDelayText} ${expectedDepTimeText}</span>
                        <span class="leg-platform">${leg.platform ? leg.platform : ''}</span>
                    </div>
                    <div class="leg-station-name" style="color: #fff; font-size:14px; margin-bottom: 8px;">
                        ${leg.origin}
                    </div>
                    <div class="leg-time-row" style="margin-top: 10px;">
                        <span>Ankunft: ${leg.arrival_time}${arrDelayText}</span>
                    </div>
                    <div class="leg-station-name" style="color: var(--text-gray); font-size:13px;">
                        ➔ ${leg.destination}
                    </div>
                    ${intermediateStopsHtml}
                `;
            }

            item.innerHTML = `
                <div class="leg-dot"></div>
                <div class="leg-details">
                    <div class="leg-header-row">
                        ${lineBadgeHtml}
                    </div>
                    ${detailsHtml}
                </div>
            `;
            connectionLegsContainer.appendChild(item);
        });

        // Add event listeners for "Mehr sehen" buttons
        document.querySelectorAll('.show-intermediate-stops-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jId = btn.getAttribute('data-journey-id');
                const line = btn.getAttribute('data-line');
                const direction = btn.getAttribute('data-direction');
                const time = btn.getAttribute('data-time');
                const delay = btn.getAttribute('data-delay');
                const type = btn.getAttribute('data-type');
                const legIdx = btn.getAttribute('data-leg-index');
                const container = document.getElementById(`inline-stops-container-${legIdx}`);

                if (container.style.display === 'flex' || container.style.display === 'block') {
                    container.style.display = 'none';
                    btn.innerHTML = `<span class="material-icons-round" style="font-size: 14px; vertical-align: middle;">expand_more</span> Mehr sehen`;
                } else {
                    container.innerHTML = `<div class="loading-state" style="padding:10px;"><div class="custom-spinner" style="width:16px;height:16px;"></div><p style="font-size:10px;margin-top:4px;">Lade Haltestellen...</p></div>`;
                    container.style.display = 'block';
                    btn.innerHTML = `<span class="material-icons-round" style="font-size: 14px; vertical-align: middle;">expand_less</span> Ausblenden`;

                    const url = `${API_BASE}/journey?journey_id=${encodeURIComponent(jId)}` + 
                                `&line=${encodeURIComponent(line)}` +
                                `&direction=${encodeURIComponent(direction)}` +
                                `&time=${encodeURIComponent(time)}` +
                                `&delay=${encodeURIComponent(delay)}` +
                                `&station_name=${encodeURIComponent(currentStationText)}`;

                    try {
                        const res = await fetch(url);
                        if (!res.ok) throw new Error("Journey error");
                        const data = await res.json();
                        renderInlineStopsList(data, container);
                    } catch (err) {
                        console.error("Inline stops error:", err);
                        container.innerHTML = `<p style="font-size:11px;color:#ff3b30;padding:5px;">Fehler beim Laden.</p>`;
                    }
                }
            });
        });
    }

    function renderInlineStopsList(data, container) {
        container.innerHTML = '';
        const stops = data.stops;
        if (!stops || stops.length === 0) {
            container.innerHTML = '<p style="color:var(--text-gray);font-size:11px;">Keine Haltestellen vorhanden.</p>';
            return;
        }



        stops.forEach(stop => {
            const row = document.createElement('div');
            // If stop is cancelled or passed, apply classes
            let stateClass = '';
            if (stop.cancelled) {
                stateClass = 'cancelled';
            } else if (stop.passed) {
                stateClass = 'passed';
            }

            row.className = `inline-stop-row ${stateClass}`;

            let delayText = '';
            if (stop.delay > 0) {
                delayText = ` (+${stop.delay})`;
            } else if (stop.delay < 0) {
                delayText = ` (<span class="stop-delay-offset early">${stop.delay}</span>)`;
            }

            row.innerHTML = `
                <span class="inline-stop-name">${stop.name.replace("Magdeburg, ", "")} ${stop.cancelled ? '(Ausfall)' : ''}</span>
                <span class="inline-stop-time">${stop.time}${delayText}</span>
            `;
            container.appendChild(row);
        });
    }

    // --- Fetch Live Disruptions ---
    async function fetchDisruptions() {
        const container = document.getElementById('disruptions-container');
        if (!container) return;

        try {
            const res = await fetch(`${API_BASE}/disruptions`);
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            const data = await res.json();
            renderDisruptions(data, container);
        } catch (err) {
            console.error("Disruptions error:", err);
            container.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 32px; color: var(--text-gray);">info_outline</span>
                    <p>Fehler beim Abrufen der Echtzeit-Meldungen.</p>
                </div>
            `;
        }
    }

    function showDisruptionToast(dis) {
        const toastContainer = document.getElementById('toast-container');
        if (!toastContainer) return;

        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        
        const icon = dis.critical ? 'warning' : 'info';
        
        toast.innerHTML = `
            <div class="toast-icon-wrapper">
                <span class="material-icons-round">${icon}</span>
            </div>
            <div class="toast-content" style="cursor:pointer;">
                <div class="toast-title">
                    <span>Neue Störungsmeldung</span>
                    <button class="toast-close-btn">
                        <span class="material-icons-round" style="font-size: 14px;">close</span>
                    </button>
                </div>
                <div class="toast-desc">${dis.title}</div>
            </div>
        `;
        
        toast.querySelector('.toast-content').addEventListener('click', (e) => {
            if (e.target.closest('.toast-close-btn')) return;
            switchTab('stoerungen');
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 600);
        });

        toast.querySelector('.toast-close-btn').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 600);
        });

        toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 600);
            }
        }, 8000);
    }

    function renderDisruptions(disruptions, container) {
        container.innerHTML = '';
        const activeDisruptions = disruptions.filter(d => d.title && d.desc);
        
        // Track known disruptions for notification system
        const currentKeys = new Set();
        activeDisruptions.forEach(dis => {
            const key = `${dis.title}|${dis.desc}`;
            currentKeys.add(key);
            
            if (!isFirstDisruptionLoad && !knownDisruptionKeys.has(key)) {
                showDisruptionToast(dis);
            }
        });
        
        knownDisruptionKeys = currentKeys;
        isFirstDisruptionLoad = false;

        if (activeDisruptions.length === 0) {
            container.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 36px; color: #fff;">check_circle_outline</span>
                    <p style="color:#fff; font-weight:600;">Freie Fahrt</p>
                    <p>Zurzeit gibt es keine bekannten Störungen im MVB-Netz.</p>
                </div>
            `;
            disruptionBadge.style.display = 'none';
            return;
        }

        disruptionBadge.textContent = activeDisruptions.length;
        disruptionBadge.style.display = 'block';

        function getStylesForDisruptionLine(lineStr) {
            let clean = lineStr.replace("Linie", "").replace("Line", "").replace("Bus", "").replace("Str", "").replace("Tram", "").trim();
            if (clean.length > 5 || !/^[A-Za-z0-9\s]+$/.test(clean) || clean === "") {
                return `<span class="mini-badge" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: var(--text-gray); font-size:11px; padding: 2px 8px; border-radius: 4px; font-family: 'Space Grotesk', sans-serif;">${lineStr}</span>`;
            }
            
            let isTram = true;
            const num = parseInt(clean, 10);
            if (!isNaN(num) && num >= 40) {
                isTram = false;
            } else if (clean.toLowerCase().startsWith('n')) {
                isTram = false;
            }
            
            const styles = getLineStyles(clean, isTram ? 'tram' : 'bus');
            return `<span class="line-badge-preview line-badge ${styles.shape} ${styles.colorClass}" style="padding: 2px 6px; font-size:10px; margin-right: 4px; font-family: 'Space Grotesk', sans-serif; display: inline-flex; align-items: center; justify-content: center; min-width: 20px;">${styles.text}</span>`;
        }

        activeDisruptions.forEach((dis, index) => {
            const linesHtml = dis.lines.map(line => {
                return getStylesForDisruptionLine(line);
            }).join('');
            
            const card = document.createElement('div');
            card.className = `disruption-card ${dis.critical ? 'critical' : ''}`;
            card.style.animation = `slideUpFade 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.05}s forwards`;
            card.style.opacity = 0;

            const icon = dis.critical ? 'warning' : 'info_outline';

            card.innerHTML = `
                <div class="disruption-header">
                    <span class="material-icons-round disruption-icon">${icon}</span>
                    <div class="disruption-title">${dis.title}</div>
                </div>
                <div class="disruption-desc">${dis.desc}</div>
                <div class="disruption-footer">
                    <div class="disruption-lines">${linesHtml}</div>
                    <div class="disruption-time">${dis.time}</div>
                </div>
            `;

            container.appendChild(card);
        });
    }

    // --- Initialize ---
    const setNowBtn = document.getElementById('set-now-btn');
    if (setNowBtn) {
        setNowBtn.addEventListener('click', () => {
            if (departuresDateInput) departuresDateInput.value = '';
            if (departuresTimeInput) departuresTimeInput.value = '';
            fetchDepartures();
        });
    }

    fetchDepartures();
    fetchDisruptions();

    // Periodically update departures every 30 seconds if set to "Jetzt" (inputs are empty)
    setInterval(() => {
        const activeTab = document.querySelector('.nav-item-desktop.active');
        const departuresSearchWidget = document.getElementById('departures-search-widget');
        const isDeparturesActive = activeTab && activeTab.getAttribute('data-target') === 'abfahrten' && 
                                   departuresSearchWidget && departuresSearchWidget.style.display !== 'none';
        
        if (isDeparturesActive) {
            const hasNoCustomDate = !departuresDateInput || !departuresDateInput.value;
            const hasNoCustomTime = !departuresTimeInput || !departuresTimeInput.value;
            if (hasNoCustomDate && hasNoCustomTime) {
                fetchDepartures(true); // quiet refresh
            }
        }
    }, 30000);

    // Periodically check for disruptions and show notifications every 45 seconds
    setInterval(() => {
        fetchDisruptions();
    }, 45000);
});
