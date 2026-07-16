document.addEventListener('DOMContentLoaded', () => {
    // Smart API Base URL: If opened directly via file://, point to local server.
    const API_BASE = window.location.protocol === 'file:' 
        ? 'http://127.0.0.1:5000/api' 
        : '/api';

    // Global Filter and Cache State
    const activeFilters = {
        tram: true,
        bus: true,
        regional: true,
        express: true
    };
    let lastFetchedDepartures = [];
    let lastFetchedConnections = [];

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
    let linesWithDisruptions = new Set();
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
        const mobileNavItems = document.querySelectorAll('.nav-item-mobile');
        mobileNavItems.forEach(i => i.classList.remove('active'));
        sections.forEach(s => s.classList.remove('active'));
        
        const activeDesktop = document.querySelector(`.nav-item-desktop[data-target="${targetId}"]`);
        const activeMobile = document.querySelector(`.nav-item-mobile[data-target="${targetId}"]`);
        const targetSection = document.getElementById(targetId);
        
        if (activeDesktop) activeDesktop.classList.add('active');
        if (activeMobile) activeMobile.classList.add('active');
        if (targetSection) targetSection.classList.add('active');
    }

    desktopNavItems.forEach(item => {
        item.addEventListener('click', () => {
            switchTab(item.getAttribute('data-target'));
        });
    });

    // Mobile Bottom Navigation handler
    const mobileNavItems = document.querySelectorAll('.nav-item-mobile');
    mobileNavItems.forEach(item => {
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

    // Filter pill setup
    function setupFilterPills() {
        const filterPills = document.querySelectorAll('.filter-pill');
        filterPills.forEach(pill => {
            pill.addEventListener('click', () => {
                const vehicleType = pill.getAttribute('data-vehicle');
                toggleFilter(vehicleType);
            });
        });
    }

    function toggleFilter(vehicleType) {
        activeFilters[vehicleType] = !activeFilters[vehicleType];
        
        // Synchronize all pills UI (both departures and connections panels)
        const pills = document.querySelectorAll(`.filter-pill[data-vehicle="${vehicleType}"]`);
        pills.forEach(pill => {
            if (activeFilters[vehicleType]) {
                pill.classList.add('active');
            } else {
                pill.classList.remove('active');
            }
        });
        
        // Re-render departures if cache exists
        if (lastFetchedDepartures && lastFetchedDepartures.length > 0) {
            renderDepartures(lastFetchedDepartures);
        }
        
        // Re-render connections if cache exists
        if (lastFetchedConnections && lastFetchedConnections.length > 0) {
            renderConnectionsList(lastFetchedConnections);
        }
    }

    setupFilterPills();

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
        let shape = 'shape-bus';
        let icon = 'directions_bus';
        
        if (type === 'tram') {
            shape = 'shape-tram';
            icon = 'tram';
        } else if (type === 'bus') {
            shape = 'shape-bus';
            icon = 'directions_bus';
        } else if (type === 'regional') {
            shape = 'shape-regional';
            icon = 'train';
        } else if (type === 'express') {
            shape = 'shape-express';
            icon = 'train';
        } else if (type === 'walk') {
            shape = 'shape-walk';
            icon = 'directions_walk';
        }
        
        const colorClass = `line-color-${cleanName}`;
        const typeClass = `type-${type}`;
        
        return {
            text: cleanName,
            shape: shape,
            colorClass: `${colorClass} ${typeClass}`,
            type: type,
            icon: icon
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
        
        if (cleanTown.includes('magdeburg')) {
            zone = 'MD (Zone 010)';
        } else if (cleanTown.includes('schönebeck') || cleanTown.includes('schoenebeck')) {
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
            lastFetchedDepartures = data;
            renderDepartures(data);
            currentStationName.textContent = currentStationText;
            updateTariffZone(currentStationText);
        } catch (err) {
            console.error("Departures error:", err);
            if (!quiet) {
                departuresContainer.innerHTML = `
                    <div class="loading-state">
                        <span class="material-icons-round" style="font-size: 36px; color: var(--text-white);">error_outline</span>
                        <p style="color: var(--text-white); font-weight: 600;">Verbindungsproblem</p>
                        <p style="font-size:11px;">Die Daten konnten nicht geladen werden.<br>Läuft das Python Backend?</p>
                    </div>
                `;
            }
        }
    }

    function renderDepartures(departures) {
        lastFetchedDepartures = departures;
        
        // Filter based on activeFilters
        const filteredDeps = departures.filter(dep => activeFilters[dep.type]);
        
        departuresContainer.innerHTML = '';
        if (!filteredDeps || filteredDeps.length === 0) {
            departuresContainer.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 32px; color: var(--text-gray);">info_outline</span>
                    <p>Keine Abfahrten für die ausgewählten Verkehrsmittel.</p>
                </div>
            `;
            return;
        }

        filteredDeps.forEach((dep, index) => {
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

            let disruptionIconHtml = '';
            if (linesWithDisruptions.has(style.text)) {
                disruptionIconHtml = `<span class="material-icons-round" style="font-size: 14px; color: #ff9f0a; vertical-align: middle; margin-left: 6px; animation: alertPulse 1.5s infinite;" title="Störung vorhanden">warning</span>`;
            }

            let timeText = dep.time;
            if (dep.day_offset > 0) {
                timeText += `<span class="day-offset-indicator">+${dep.day_offset}</span>`;
            }

            card.innerHTML = `
                <div class="line-badge ${style.shape} ${style.colorClass}">${style.text}</div>
                <div class="departure-info">
                    <div class="destination-line">${dep.direction}${disruptionIconHtml}</div>
                    <div class="time-row-departures">
                        <span class="material-icons-round" style="font-size: 14px;">schedule</span>
                        <span>Soll: ${timeText}</span>
                    </div>
                    ${expectedTimeHtml}
                </div>
                <div class="departure-time-section">
                    <div class="time-value">${timeText}</div>
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
                    <span class="material-icons-round" style="font-size: 32px; color: var(--text-white);">error_outline</span>
                    <p style="color: var(--text-white);">Linienverlauf konnte nicht geladen werden.</p>
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
        
        // Render trip-specific messages/alerts if any
        if (data.messages && data.messages.length > 0) {
            const msgBox = document.createElement('div');
            msgBox.className = 'journey-messages-box';
            let msgsHtml = '';
            data.messages.forEach(msg => {
                const icon = msg.warning ? 'warning' : 'info';
                const colorClass = msg.warning ? 'msg-warning' : 'msg-info';
                msgsHtml += `
                    <div class="journey-message-item ${colorClass}">
                        <span class="material-icons-round journey-msg-icon">${icon}</span>
                        <span class="journey-msg-text">${msg.text}</span>
                    </div>
                `;
            });
            msgBox.innerHTML = msgsHtml;
            container.appendChild(msgBox);
        }

        const stops = data.stops;
        if (!stops || stops.length === 0) {
            container.innerHTML += '<div class="loading-state"><p>Keine Haltestellen verfügbar.</p></div>';
            return;
        }

        const hasRealtime = stops.some(stop => stop.delay !== null && stop.delay !== undefined);

        let vehicleIdx = -1;
        if (hasRealtime) {
            for (let i = 0; i < stops.length; i++) {
                if (stops[i].passed) {
                    vehicleIdx = i;
                }
            }
            if (vehicleIdx === -1 && stops.length > 0) {
                vehicleIdx = 0;
            }
        }

        stops.forEach((stop, index) => {
            const isPassed = stop.passed;
            const isVehicleHere = hasRealtime && (index === vehicleIdx);
            
            let timeText = stop.time;
            if (stop.day_offset > 0) {
                timeText += `<span class="day-offset-indicator-small">+${stop.day_offset}</span>`;
            }

            let delayOffsetHtml = '';
            let expectedTimeHtml = '';

            if (stop.delay !== null && stop.delay !== undefined) {
                if (stop.delay > 0) {
                    delayOffsetHtml = `<span class="stop-delay-offset late">+${stop.delay}</span>`;
                    const expectedTimeStr = calculateExpectedTime(stop.time, stop.delay);
                    if (expectedTimeStr) {
                        expectedTimeHtml = `<div class="expected-time-label" style="font-size: 8px; padding: 1px 4px; margin-top: 2px;">Soll ${timeText} -> Erwartet ${expectedTimeStr}</div>`;
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
                    <span class="stop-sched-time">${timeText}</span>
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
                    <p style="color: var(--text-white); font-weight:600; margin-bottom: 4px;">Eingabe unvollständig</p>
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
            lastFetchedConnections = data;
            renderConnectionsList(data);
        } catch (err) {
            console.error("Connection search error:", err);
            connectionsContainer.innerHTML = `
                <div class="connection-placeholder-info">
                    <span class="material-icons-round">error_outline</span>
                    <p style="color: var(--text-white); font-weight:600;">Verbindungssuche fehlgeschlagen</p>
                    <p style="font-size: 11px;">Die Routen konnten nicht berechnet werden.</p>
                </div>
            `;
        }
    });

    function renderConnectionsList(connections) {
        lastFetchedConnections = connections;
        
        // Filter based on activeFilters (exclude connection if any leg is a type that is unchecked)
        const filteredConns = connections.filter(conn => 
            conn.legs.every(leg => leg.type === 'walk' || activeFilters[leg.type])
        );
        
        connectionsContainer.innerHTML = '';
        if (!filteredConns || filteredConns.length === 0) {
            connectionsContainer.innerHTML = `
                <div class="connection-placeholder-info">
                    <span class="material-icons-round">sentiment_dissatisfied</span>
                    <p>Keine passenden Verbindungen mit den ausgewählten Verkehrsmitteln gefunden.</p>
                </div>
            `;
            return;
        }

        connections.forEach((conn, index) => {
            const firstLeg = conn.legs[0];
            const lastLeg = conn.legs[conn.legs.length - 1];
            const depTime = firstLeg ? firstLeg.departure_time : "--:--";
            const arrTime = lastLeg ? lastLeg.arrival_time : "--:--";

            let depTimeText = depTime;
            if (firstLeg && firstLeg.departure_day_offset > 0) {
                depTimeText += `<span class="day-offset-indicator-small">+${firstLeg.departure_day_offset}</span>`;
            }
            let arrTimeText = arrTime;
            if (lastLeg && lastLeg.arrival_day_offset > 0) {
                arrTimeText += `<span class="day-offset-indicator-small">+${lastLeg.arrival_day_offset}</span>`;
            }

            const card = document.createElement('div');
            card.className = 'connection-card';
            card.style.animation = `slideUpFade 0.4s cubic-bezier(0.16, 1, 0.3, 1) ${index * 0.05}s forwards`;
            card.style.opacity = 0;

            // Helper to parse time to minutes
            function parseTimeToMinutes(timeStr) {
                if (!timeStr) return 0;
                const parts = timeStr.split(':');
                return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
            }

            // Generate legs preview split bar
            let legsPreviewHtml = '<div class="connection-timeline-bar-container">';
            conn.legs.forEach((leg) => {
                const depMin = parseTimeToMinutes(leg.departure_time);
                const arrMin = parseTimeToMinutes(leg.arrival_time);
                let duration = arrMin - depMin;
                if (leg.arrival_day_offset > leg.departure_day_offset) {
                    duration += 1440;
                }
                if (duration <= 0) duration = 10;

                if (leg.line === 'Fußweg' || leg.type === 'walk') {
                    legsPreviewHtml += `
                        <div class="connection-bar-segment walk-segment" style="flex: ${duration};">
                            <span class="material-icons-round" style="font-size: 11px;">directions_walk</span>
                            <span class="segment-duration">${duration}m</span>
                        </div>
                    `;
                } else {
                    const style = getLineStyles(leg.line, leg.type);
                    
                    let realTimeHtml = '';
                    if (leg.departure_delay !== null && leg.departure_delay !== undefined) {
                        const delayVal = leg.departure_delay;
                        const delayText = delayVal >= 0 ? `+${delayVal}` : `${delayVal}`;
                        const colorClass = delayVal > 0 ? 'delay-badge-red' : 'delay-badge-green';
                        realTimeHtml = `<span class="segment-delay-badge ${colorClass}">${delayText}</span>`;
                    }

                    let warningIcon = '';
                    if (linesWithDisruptions.has(style.text)) {
                        warningIcon = `<span class="material-icons-round" style="font-size: 10px; color: #ff9f0a; margin-right: 3px; animation: alertPulse 1.5s infinite;" title="Störung vorhanden">warning</span>`;
                    }

                    legsPreviewHtml += `
                        <div class="connection-bar-segment transit-segment ${style.colorClass} ${leg.cancelled ? 'cancelled' : ''}" style="flex: ${duration};">
                            ${warningIcon}
                            <span class="segment-line-name">${style.text}</span>
                            ${realTimeHtml}
                        </div>
                    `;
                }
            });
            legsPreviewHtml += '</div>';

            card.innerHTML = `
                <div class="connection-card-header">
                    <div class="connection-duration">
                        <span class="material-icons-round">schedule</span>
                        ${conn.duration} Min
                    </div>
                    <div class="connection-time-window">
                        ${depTimeText} - ${arrTimeText}
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
        
        let headerDep = conn.legs[0].departure_time;
        if (conn.legs[0].departure_day_offset > 0) {
            headerDep += `<sup>+${conn.legs[0].departure_day_offset}</sup>`;
        }
        let headerArr = conn.legs[conn.legs.length - 1].arrival_time;
        if (conn.legs[conn.legs.length - 1].arrival_day_offset > 0) {
            headerArr += `<sup>+${conn.legs[conn.legs.length - 1].arrival_day_offset}</sup>`;
        }
        detailRouteTitle.innerHTML = `${headerDep} - ${headerArr}`;
        detailRouteSummary.textContent = `${startName.replace("Magdeburg, ", "")} ➔ ${endName.replace("Magdeburg, ", "")}`;

        connectionLegsContainer.innerHTML = '';
        
        conn.legs.forEach((leg, index) => {
            const item = document.createElement('div');
            // If the leg is cancelled, we mark the whole container with cancelled class -> thick red left line!
            item.className = `connection-leg-item ${leg.cancelled ? 'cancelled' : ''}`;

            let lineBadgeHtml = '';
            let detailsHtml = '';

            let legDepTimeText = leg.departure_time;
            if (leg.departure_day_offset > 0) {
                legDepTimeText += `<span class="day-offset-indicator-small">+${leg.departure_day_offset}</span>`;
            }
            let legArrTimeText = leg.arrival_time;
            if (leg.arrival_day_offset > 0) {
                legArrTimeText += `<span class="day-offset-indicator-small">+${leg.arrival_day_offset}</span>`;
            }

            if (leg.line === 'Fußweg' || leg.type === 'walk') {
                lineBadgeHtml = `<span class="leg-badge-preview walk"><span class="material-icons-round" style="font-size: 11px; vertical-align: middle;">directions_walk</span> Fußweg</span>`;
                detailsHtml = `
                    <div class="leg-time-row">
                        <span>Abmarsch: <strong>${legDepTimeText}</strong></span>
                        <span>Ankunft: <strong>${legArrTimeText}</strong></span>
                    </div>
                    <div style="font-size: 13px; font-weight: 500; color: var(--text-white);">
                        Fußweg von ${leg.origin} bis ${leg.destination}
                    </div>
                `;
            } else {
                const style = getLineStyles(leg.line, leg.type);
                
                let warningBadge = '';
                if (linesWithDisruptions.has(style.text)) {
                    warningBadge = ` <span class="leg-disruption-badge" style="background: rgba(255,159,10,0.15); border: 1px solid rgba(255,159,10,0.4); border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight:600; color: #ff9f0a; display: inline-flex; align-items: center; gap: 4px; animation: alertPulse 1.5s infinite;"><span class="material-icons-round" style="font-size:12px;">warning</span> Störung</span>`;
                }

                let cancelledBadge = leg.cancelled ? `<span class="cancelled-badge">Ausfall</span>` : '';
                                lineBadgeHtml = `<span class="leg-badge-preview line-badge ${style.shape} ${style.colorClass}" style="padding: 4px 10px; font-size:12px;">${leg.line}</span>${cancelledBadge}${warningBadge}`;
                
                // Real-time delay text
                let depDelayText = '';
                if (leg.departure_delay !== null && leg.departure_delay !== undefined) {
                    if (leg.departure_delay > 0) {
                        depDelayText = ` <span class="leg-delay-text delay-red">(+${leg.departure_delay} Min)</span>`;
                    } else if (leg.departure_delay < 0) {
                        depDelayText = ` <span class="leg-delay-text delay-green">(${leg.departure_delay} Min)</span>`;
                    } else {
                        depDelayText = ` <span class="leg-delay-text delay-green">(+0 Min)</span>`;
                    }
                }

                let arrDelayText = '';
                if (leg.arrival_delay !== null && leg.arrival_delay !== undefined) {
                    if (leg.arrival_delay > 0) {
                        arrDelayText = ` <span class="leg-delay-text delay-red">(+${leg.arrival_delay} Min)</span>`;
                    } else if (leg.arrival_delay < 0) {
                        arrDelayText = ` <span class="leg-delay-text delay-green">(${leg.arrival_delay} Min)</span>`;
                    } else {
                        arrDelayText = ` <span class="leg-delay-text delay-green">(+0 Min)</span>`;
                    }
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
                        <span>Soll: ${legDepTimeText}${depDelayText} ${expectedDepTimeText}</span>
                        <span class="leg-platform">${leg.platform ? leg.platform : ''}</span>
                    </div>
                    <div class="leg-station-name" style="color: var(--text-white); font-size:14px; margin-bottom: 8px;">
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
                        renderInlineStopsList(data, container, type);
                    } catch (err) {
                        console.error("Inline stops error:", err);
                        container.innerHTML = `<p style="font-size:11px;color:#ff3b30;padding:5px;">Fehler beim Laden.</p>`;
                    }
                }
            });
        });
    }

    function renderInlineStopsList(data, container, type) {
        container.innerHTML = '';

        // Render trip-specific messages/alerts if any
        if (data.messages && data.messages.length > 0) {
            const msgBox = document.createElement('div');
            msgBox.className = 'journey-messages-box';
            let msgsHtml = '';
            data.messages.forEach(msg => {
                const icon = msg.warning ? 'warning' : 'info';
                const colorClass = msg.warning ? 'msg-warning' : 'msg-info';
                msgsHtml += `
                    <div class="journey-message-item ${colorClass}">
                        <span class="material-icons-round journey-msg-icon">${icon}</span>
                        <span class="journey-msg-text">${msg.text}</span>
                    </div>
                `;
            });
            msgBox.innerHTML = msgsHtml;
            container.appendChild(msgBox);
        }

        const stops = data.stops;
        if (!stops || stops.length === 0) {
            container.innerHTML += '<p style="color:var(--text-gray);font-size:11px;">Keine Haltestellen vorhanden.</p>';
            return;
        }

        const vehicleIcon = (type === 'tram') ? 'tram' : 'directions_bus';

        // Check if any stop has real-time delay data
        const hasRealtime = stops.some(stop => stop.delay !== null && stop.delay !== undefined);

        // Find the index of the last passed stop
        let lastPassedIndex = -1;
        stops.forEach((stop, idx) => {
            if (stop.passed) {
                lastPassedIndex = idx;
            }
        });

        // Helper to create the vehicle location row
        function createVehicleRow() {
            const vehicleRow = document.createElement('div');
            vehicleRow.className = 'inline-stop-row live-vehicle-position';
            vehicleRow.innerHTML = `
                <div class="inline-stop-node" style="border-color:#1c75c9; background:#fff; animation: alertPulse 1.5s infinite; display:flex; align-items:center; justify-content:center; box-shadow:0 0 8px rgba(28,117,201,0.5);">
                    <span class="material-icons-round" style="font-size:10px; color:#1c75c9;">${vehicleIcon}</span>
                </div>
                <div class="inline-stop-details">
                    <span class="live-vehicle-badge">
                        <span class="material-icons-round">${vehicleIcon}</span>
                        Fahrzeug befindet sich hier (Live-Standort)
                    </span>
                </div>
            `;
            return vehicleRow;
        }

        // If the vehicle has not reached the first stop yet, draw it at the top
        if (hasRealtime && lastPassedIndex === -1 && stops.length > 0 && !stops[0].cancelled) {
            container.appendChild(createVehicleRow());
        }

        stops.forEach((stop, idx) => {
            const row = document.createElement('div');
            
            // If stop is cancelled or passed, apply classes
            let stateClass = 'future';
            if (stop.cancelled) {
                stateClass = 'cancelled';
            } else if (stop.passed) {
                stateClass = 'passed';
            }

            row.className = `inline-stop-row ${stateClass}`;

            let delayText = '';
            if (stop.delay !== null && stop.delay !== undefined) {
                if (stop.delay > 0) {
                    delayText = ` <span class="stop-delay-offset late">(+${stop.delay})</span>`;
                } else if (stop.delay < 0) {
                    delayText = ` <span class="stop-delay-offset early">(${stop.delay})</span>`;
                } else {
                    delayText = ` <span class="stop-delay-offset ontime">(±0)</span>`;
                }
            }

            // Node styling based on state
            let nodeHtml = '';
            if (stop.cancelled) {
                nodeHtml = `<div class="inline-stop-node" style="border-color:#ff3b30; background:rgba(255,59,48,0.2);"><span class="material-icons-round" style="font-size:10px; color:#ff3b30;">close</span></div>`;
            } else if (stop.passed) {
                nodeHtml = `<div class="inline-stop-node"><span class="material-icons-round" style="font-size:8px; color:var(--text-gray-dark);">done</span></div>`;
            } else {
                nodeHtml = `<div class="inline-stop-node"></div>`;
            }

            row.innerHTML = `
                ${nodeHtml}
                <div class="inline-stop-details">
                    <span class="inline-stop-name">${stop.name.replace("Magdeburg, ", "")} ${stop.cancelled ? '(Ausfall)' : ''}</span>
                    <span class="inline-stop-time">${stop.time}${delayText}</span>
                </div>
            `;
            container.appendChild(row);

            // If this stop was the last passed stop, and there are more stops, render vehicle between this and next (only if real-time exists)
            if (hasRealtime && idx === lastPassedIndex && idx < stops.length - 1 && !stops[idx + 1].cancelled) {
                container.appendChild(createVehicleRow());
            }
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
        
        // Track known disruptions for notification system and populate linesWithDisruptions
        const currentKeys = new Set();
        linesWithDisruptions.clear();
        
        activeDisruptions.forEach(dis => {
            const key = `${dis.title}|${dis.desc}`;
            currentKeys.add(key);
            
            if (!isFirstDisruptionLoad && !knownDisruptionKeys.has(key)) {
                showDisruptionToast(dis);
            }

            // Filter by accident/disruption keywords
            const titleLower = dis.title.toLowerCase();
            const descLower = dis.desc.toLowerCase();
            const keywords = ["unfall", "störung", "störungen", "unfälle", "gleissperrung", "betriebsstörung", "unfallstelle", "sperrung"];
            const isAccidentOrDisruption = keywords.some(kw => titleLower.includes(kw) || descLower.includes(kw));

            if (isAccidentOrDisruption && dis.lines) {
                dis.lines.forEach(lineStr => {
                    let clean = lineStr.replace("Linie", "").replace("Line", "").replace("Bus", "").replace("Str", "").replace("Tram", "").trim();
                    if (clean) {
                        linesWithDisruptions.add(clean);
                    }
                });
            }
        });
        
        knownDisruptionKeys = currentKeys;
        isFirstDisruptionLoad = false;

        if (activeDisruptions.length === 0) {
            container.innerHTML = `
                <div class="loading-state">
                    <span class="material-icons-round" style="font-size: 36px; color: var(--text-white);">check_circle_outline</span>
                    <p style="color: var(--text-white); font-weight:600;">Freie Fahrt</p>
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
    function setCurrentDateTime(dateInput, timeInput) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        
        if (dateInput) dateInput.value = `${year}-${month}-${day}`;
        if (timeInput) timeInput.value = `${hours}:${minutes}`;
    }

    // --- Initialize ---
    const setNowBtn = document.getElementById('set-now-btn');
    if (setNowBtn) {
        setNowBtn.addEventListener('click', (e) => {
            e.preventDefault();
            setCurrentDateTime(departuresDateInput, departuresTimeInput);
            fetchDepartures();
        });
    }

    const routeNowBtn = document.getElementById('route-now-btn');
    if (routeNowBtn) {
        routeNowBtn.addEventListener('click', (e) => {
            e.preventDefault();
            setCurrentDateTime(routeDateInput, routeTimeInput);
        });
    }

    fetchDepartures();
    fetchDisruptions();

    // 4. Ticket collapse/expand toggler
    document.querySelectorAll('.mvb-ticket-card.expandable').forEach(card => {
        card.addEventListener('click', () => {
            const details = card.querySelector('.ticket-details-collapse');
            const icon = card.querySelector('.ticket-toggle-icon');
            if (details) {
                const isExpanded = details.style.display === 'block';
                details.style.display = isExpanded ? 'none' : 'block';
                if (icon) {
                    icon.textContent = isExpanded ? 'add' : 'remove';
                }
            }
        });
    });

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
