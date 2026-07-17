document.addEventListener('DOMContentLoaded', () => {
    // -----------------------------------------------------------------------
    // Constants & Configuration
    // -----------------------------------------------------------------------
    const API_BASE = '/api';

    const JS_LINE_COLORS = {
        '1':  '#B22052',
        '2':  '#5566A4',
        '3':  '#F5D300',
        '4':  '#7FC600',
        '5':  '#BA832C',
        '6':  '#6E3B90',
        '8':  '#F0A500',
        '9':  '#006651',
        '10': '#2796B6',
        '13': '#3A4136',
        '51': '#5566A4',
        '52': '#F0A500',
        '53': '#F5D300',
        '54': '#7FC600',
        '55': '#BA832C',
        '56': '#E1C700',
        '57': '#E70097',
        '58': '#008B8B',
        '59': '#006651',
        '61': '#2796B6',
        '66': '#B13507',
        '69': '#6E3B90',
        '71': '#CC1F2F',
        '72': '#006EB7',
        '73': '#3A4136',
        'KVG9': '#ADB9A6',
        'N1': '#B22052',
        'N2': '#6E3B90',
        'N3': '#CC1F2F',
        'N4': '#007757',
        'N5': '#F5D300',
        'N6': '#F0A500',
        'N7': '#2796B6',
        'N8': '#C7066E',
        'N9': '#E73F0C',
    };



    // -----------------------------------------------------------------------
    // State Management
    // -----------------------------------------------------------------------
    let currentStation = { id: '7393', name: 'Magdeburg, Hauptbahnhof' };
    let originStation = null;
    let destStation = null;
    
    let activeFilters = {
        all: true,
        tram: false,
        bus: false,
        regional: false
    };

    let departuresCache = [];
    let isNowModeActive = true;
    let isConnNowActive = true;
    let nowInterval = null;
    let silentFetchInterval = null;
    let connectionStopsInterval = null;
    let activeJourneyData = null;
    let journeyDetailInterval = null;
    let alertsInterval = null;
    let clockInterval = null;
    let knownDisruptionIds = new Set(JSON.parse(localStorage.getItem('knownDisruptions') || '[]'));

    // PWA Service Worker Registration
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(() => console.log('Service Worker registriert'))
            .catch(err => console.error('Service Worker Fehler:', err));
    }

    // -----------------------------------------------------------------------
    // DOM Elements
    // -----------------------------------------------------------------------
    const appContainer = document.getElementById('app');

    // Header
    const headerTime = document.getElementById('headerTime');
    const headerNavLinks = document.querySelectorAll('.header-nav .nav-link');
    const headerAlertBadge = document.getElementById('headerAlertBadge');
    const themeToggleBtn = document.getElementById('themeToggleBtn');

    // Bottom Navigation (Mobile)
    const tabButtonsMobile = document.querySelectorAll('.tab-nav-mobile .tab-btn');
    const alertBadgeMobile = document.getElementById('alertBadge');

    // Hero section and forms
    const heroSection = document.getElementById('heroSection');
    const formDepartures = document.getElementById('form-departures');
    const formConnections = document.getElementById('form-connections');

    // Departures Form
    const stationInput = document.getElementById('stationInput');
    const stationSuggestions = document.getElementById('stationSuggestions');
    const clearStationBtn = document.getElementById('clearStation');
    const depDate = document.getElementById('depDate');
    const depTime = document.getElementById('depTime');
    const depDuration = document.getElementById('depDuration');
    const nowBtn = document.getElementById('nowBtn');
    const submitDepBtn = document.getElementById('submitDepBtn');

    // Connections Form
    const originInput = document.getElementById('originInput');
    const originSuggestions = document.getElementById('originSuggestions');
    const destInput = document.getElementById('destInput');
    const destSuggestions = document.getElementById('destSuggestions');
    const swapBtn = document.getElementById('swapBtn');
    const connDate = document.getElementById('connDate');
    const connTime = document.getElementById('connTime');
    const connNowBtn = document.getElementById('connNowBtn');
    const submitConnBtn = document.getElementById('submitConnBtn');

    // Quick Action Bar
    const actionButtons = document.querySelectorAll('.quick-action-bar .action-btn');

    // Timetable Results layout
    const mainResultsArea = document.getElementById('main-results-area');
    const tabPanels = document.querySelectorAll('.result-tab-content');

    // Departures Result List
    const filterPills = document.querySelectorAll('.filter-pill');
    const departuresList = document.getElementById('departuresList');
    const departuresLoading = document.getElementById('departuresLoading');
    const departuresEmpty = document.getElementById('departuresEmpty');

    // Connections Result List
    const connectionsList = document.getElementById('connectionsList');
    const connectionsLoading = document.getElementById('connectionsLoading');
    const connectionsEmpty = document.getElementById('connectionsEmpty');

    // Alerts Result List
    const alertsList = document.getElementById('alertsList');
    const alertsLoading = document.getElementById('alertsLoading');
    const pushBanner = document.getElementById('pushBanner');
    const enablePushBtn = document.getElementById('enablePush');
    const dismissPushBtn = document.getElementById('dismissPush');



    // Desktop Details Panel
    const detailsPlaceholder = document.getElementById('detailsPlaceholder');
    const detailsContent = document.getElementById('detailsContent');
    const detailsLineBadge = document.getElementById('detailsLineBadge');
    const detailsTitle = document.getElementById('detailsTitle');
    const detailsSubtitle = document.getElementById('detailsSubtitle');
    const detailsMessages = document.getElementById('detailsMessages');
    const detailsRoute = document.getElementById('detailsRoute');

    // Mobile Journey Modal
    const journeyModal = document.getElementById('journeyModal');
    const journeyModalTitle = document.getElementById('journeyModalTitle');
    const modalLineBadge = document.getElementById('modalLineBadge');
    const modalDirection = document.getElementById('modalDirection');
    const journeyMessages = document.getElementById('journeyMessages');
    const journeyRoute = document.getElementById('journeyRoute');
    const journeyLoading = document.getElementById('journeyLoading');
    const closeModalBtn = document.getElementById('closeModal');

    // Clock Widgets
    const widgetClockTime = document.getElementById('widgetClockTime');
    const widgetClockDate = document.getElementById('widgetClockDate');

    // -----------------------------------------------------------------------
    // Theming Engine (Light Mode by default)
    // -----------------------------------------------------------------------
    let currentTheme = localStorage.getItem('theme') || 'light';

    function applyTheme(theme) {
        if (theme === 'light') {
            appContainer.classList.remove('theme-dark');
            appContainer.classList.add('theme-light');
            if (themeToggleBtn) themeToggleBtn.textContent = '🌙';
        } else {
            appContainer.classList.remove('theme-light');
            appContainer.classList.add('theme-dark');
            if (themeToggleBtn) themeToggleBtn.textContent = '☀️';
        }
        localStorage.setItem('theme', theme);
    }

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            applyTheme(currentTheme);
            showToast(`Farbschema auf ${currentTheme === 'dark' ? 'Dark Mode' : 'Light Mode'} gewechselt`, 'success');
        });
    }
    applyTheme(currentTheme);

    // -----------------------------------------------------------------------
    // Helper Functions
    // -----------------------------------------------------------------------
    function getLuminance(hex) {
        if (!hex) return 0;
        hex = hex.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    function formatPlatform(plat) {
        if (!plat) return '';
        let p = String(plat).trim();
        if (p.toLowerCase().startsWith('gleis')) {
            return p;
        }
        if (p.toLowerCase().startsWith('gl.')) {
            return 'Gleis ' + p.substring(3).trim();
        }
        return 'Gleis ' + p;
    }

    function setDateTimeToNow() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');

        const dateStr = `${year}-${month}-${day}`;
        const timeStr = `${hours}:${minutes}`;

        if (isNowModeActive) {
            depDate.value = dateStr;
            depTime.value = timeStr;
        }
        if (isConnNowActive) {
            connDate.value = dateStr;
            connTime.value = timeStr;
        }
    }

    function isDesktopLayout() {
        return window.innerWidth >= 1024;
    }

    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast-notification ${type}`;
        
        let icon = 'ℹ️';
        if (type === 'success') icon = '✅';
        if (type === 'warning') icon = '⚠️';
        if (type === 'critical') icon = '🚨';

        toast.innerHTML = `
            <span class="toast-icon">${icon}</span>
            <div class="toast-content">${message}</div>
        `;
        container.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 50);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    }

    const ariaLiveRegion = document.getElementById('ariaLive');
    function announceToScreenReader(msg) {
        ariaLiveRegion.textContent = msg;
    }

    function updateClockWidgets() {
        const now = new Date();
        const timeStrLong = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const timeStrShort = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const dateOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
        const dateStr = now.toLocaleDateString('de-DE', dateOptions);

        if (headerTime) headerTime.textContent = timeStrShort;
        if (widgetClockTime) widgetClockTime.textContent = timeStrLong;
        if (widgetClockDate) widgetClockDate.textContent = dateStr;
    }
    clockInterval = setInterval(updateClockWidgets, 1000);
    updateClockWidgets();

    // Smooth scroll to results area
    function scrollToResults() {
        setTimeout(() => {
            mainResultsArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
    }

    // -----------------------------------------------------------------------
    // Synchronized Tab Navigation (Desktop Header Menu + Mobile Bottom Tab Nav)
    // -----------------------------------------------------------------------
    function switchTab(targetTabId) {
        if (connectionStopsInterval) {
            clearInterval(connectionStopsInterval);
            connectionStopsInterval = null;
        }
        // Toggle hero section and inner forms depending on mode
        if (targetTabId === 'departures') {
            heroSection.style.display = 'block';
            heroSection.hidden = false;
            formDepartures.hidden = false;
            formConnections.hidden = true;
        } else if (targetTabId === 'connections') {
            heroSection.style.display = 'block';
            heroSection.hidden = false;
            formDepartures.hidden = true;
            formConnections.hidden = false;
        } else {
            // Hide search card entirely for Alerts & Map networks
            heroSection.style.display = 'none';
            heroSection.hidden = true;
        }

        const currentActivePanel = document.querySelector('.result-tab-content:not([hidden])');
        const targetPanel = document.getElementById(`panel-${targetTabId}`);

        if (currentActivePanel === targetPanel) return;

        if (currentActivePanel) {
            currentActivePanel.classList.add('fade-out');
            currentActivePanel.classList.remove('fade-in');
            
            setTimeout(() => {
                currentActivePanel.hidden = true;
                currentActivePanel.classList.remove('fade-out');
                
                targetPanel.hidden = false;
                targetPanel.classList.add('fade-in');
                

            }, 120);
        } else {
            targetPanel.hidden = false;
            targetPanel.classList.add('fade-in');
        }

        // Sync Desktop Menu Buttons
        headerNavLinks.forEach(btn => {
            const target = btn.getAttribute('data-target');
            btn.classList.toggle('active', target === targetTabId);
        });

        // Sync Mobile Navigation Buttons
        tabButtonsMobile.forEach(btn => {
            const tab = btn.getAttribute('data-tab');
            if (tab === targetTabId) {
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
            } else {
                btn.classList.remove('active');
                btn.setAttribute('aria-selected', 'false');
            }
        });

        announceToScreenReader(`Bereich ${targetTabId} geladen.`);
    }

    [...headerNavLinks, ...tabButtonsMobile].forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-target') || btn.getAttribute('data-tab');
            switchTab(targetTab);
            // Only scroll to results if we aren't showing search card
            if (targetTab === 'alerts' || targetTab === 'tickets') {
                // Instantly scroll up to top since content fills the screen
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                // If searching, stay at top to let user enter text
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });

    // -----------------------------------------------------------------------
    // Autocomplete Input Setup
    // -----------------------------------------------------------------------
    function setupAutocomplete(inputEl, suggestionsEl, clearBtnEl, onSelect) {
        let debounceTimer;

        inputEl.addEventListener('input', () => {
            const query = inputEl.value.trim();
            
            if (clearBtnEl) {
                clearBtnEl.hidden = query.length === 0;
            }

            if (query.length < 3) {
                suggestionsEl.innerHTML = '';
                suggestionsEl.hidden = true;
                return;
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
                    const data = await res.json();
                    
                    suggestionsEl.innerHTML = '';
                    if (!data.length) {
                        suggestionsEl.hidden = true;
                        return;
                    }

                    data.forEach(station => {
                        const li = document.createElement('li');
                        li.className = 'suggestion-item';
                        li.role = 'option';
                        li.textContent = station.name;
                        li.addEventListener('click', () => {
                            inputEl.value = station.name;
                            suggestionsEl.hidden = true;
                            onSelect(station);
                        });
                        suggestionsEl.appendChild(li);
                    });
                    suggestionsEl.hidden = false;
                } catch (err) {
                    console.error('Autocomplete Fehler:', err);
                }
            }, 300);
        });

        if (clearBtnEl) {
            clearBtnEl.addEventListener('click', () => {
                inputEl.value = '';
                suggestionsEl.innerHTML = '';
                suggestionsEl.hidden = true;
                clearBtnEl.hidden = true;
                inputEl.focus();
            });
        }

        document.addEventListener('click', (e) => {
            if (!inputEl.contains(e.target) && !suggestionsEl.contains(e.target)) {
                suggestionsEl.hidden = true;
            }
        });
    }

    setupAutocomplete(stationInput, stationSuggestions, clearStationBtn, (station) => {
        currentStation = station;
    });

    setupAutocomplete(originInput, originSuggestions, null, (station) => {
        originStation = station;
    });

    setupAutocomplete(destInput, destSuggestions, null, (station) => {
        destStation = station;
    });

    swapBtn.addEventListener('click', () => {
        const startVal = originInput.value;
        const startStationObj = originStation;

        originInput.value = destInput.value;
        originStation = destStation;

        destInput.value = startVal;
        destStation = startStationObj;

        swapBtn.style.transform = 'rotate(180deg)';
        swapBtn.style.transition = 'transform 0.4s var(--ease-spring)';
        setTimeout(() => {
            swapBtn.style.transform = 'none';
            swapBtn.style.transition = 'none';
        }, 400);

        announceToScreenReader('Start- und Zielort getauscht.');
    });

    // -----------------------------------------------------------------------
    // Filter Pills handling
    // -----------------------------------------------------------------------
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const filterType = pill.getAttribute('data-filter');

            if (filterType === 'all') {
                activeFilters.all = true;
                activeFilters.tram = false;
                activeFilters.bus = false;
                activeFilters.regional = false;
            } else {
                activeFilters.all = false;
                activeFilters[filterType] = !activeFilters[filterType];

                const activeCount = ['tram', 'bus', 'regional'].filter(k => activeFilters[k]).length;
                if (activeCount === 0 || activeCount === 3) {
                    activeFilters.all = true;
                    activeFilters.tram = false;
                    activeFilters.bus = false;
                    activeFilters.regional = false;
                }
            }

            filterPills.forEach(p => {
                const type = p.getAttribute('data-filter');
                if (activeFilters[type]) {
                    p.classList.add('active');
                    p.setAttribute('aria-pressed', 'true');
                } else {
                    p.classList.remove('active');
                    p.setAttribute('aria-pressed', 'false');
                }
            });

            renderDepartures(departuresCache);
        });
    });

    // -----------------------------------------------------------------------
    // DateTime Controls & JETZT Live Update Engine
    // -----------------------------------------------------------------------
    setDateTimeToNow();

    nowBtn.addEventListener('click', () => {
        isNowModeActive = !isNowModeActive;
        nowBtn.classList.toggle('active', isNowModeActive);
        nowBtn.setAttribute('aria-pressed', isNowModeActive ? 'true' : 'false');
        
        if (isNowModeActive) {
            setDateTimeToNow();
            startLiveUpdateEngine();
            fetchDepartures();
            showToast('Live-Modus aktiv. Abfahrts-Countdowns werden aktualisiert.', 'success');
        } else {
            stopLiveUpdateEngine();
            showToast('Live-Modus beendet. Zeige statische Abfahrten.', 'info');
        }
    });

    [depDate, depTime, depDuration].forEach(input => {
        input.addEventListener('change', () => {
            if (isNowModeActive) {
                isNowModeActive = false;
                nowBtn.classList.remove('active');
                nowBtn.setAttribute('aria-pressed', 'false');
                stopLiveUpdateEngine();
            }
        });
    });

    connNowBtn.addEventListener('click', () => {
        isConnNowActive = !isConnNowActive;
        connNowBtn.classList.toggle('active', isConnNowActive);
        connNowBtn.setAttribute('aria-pressed', isConnNowActive ? 'true' : 'false');
        
        if (isConnNowActive) {
            setDateTimeToNow();
            startLiveUpdateEngine();
            showToast('Live-Modus für Verbindungssuche aktiv.', 'success');
        } else {
            stopLiveUpdateEngine();
            showToast('Live-Modus für Verbindungssuche beendet.', 'info');
        }
    });

    [connDate, connTime].forEach(input => {
        input.addEventListener('change', () => {
            if (isConnNowActive) {
                isConnNowActive = false;
                connNowBtn.classList.remove('active');
                connNowBtn.setAttribute('aria-pressed', 'false');
                stopLiveUpdateEngine();
            }
        });
    });

    function startLiveUpdateEngine() {
        if (nowInterval) clearInterval(nowInterval);
        if (silentFetchInterval) clearInterval(silentFetchInterval);

        nowInterval = setInterval(updateAllCountdowns, 1000);

        silentFetchInterval = setInterval(() => {
            if (isNowModeActive || isConnNowActive) {
                setDateTimeToNow();
            }
            if (isNowModeActive) {
                fetchDepartures(true);
            }
        }, 20000); // 20s
    }

    function stopLiveUpdateEngine() {
        if (!isNowModeActive && !isConnNowActive) {
            if (nowInterval) {
                clearInterval(nowInterval);
                nowInterval = null;
            }
            if (silentFetchInterval) {
                clearInterval(silentFetchInterval);
                silentFetchInterval = null;
            }
            document.querySelectorAll('.departure-countdown').forEach(el => el.textContent = '');
        }
    }

    // -----------------------------------------------------------------------
    // Fetch and Render Departures
    // -----------------------------------------------------------------------
    async function fetchDepartures(silent = false) {
        if (!currentStation.id) return;
        
        if (!silent) {
            departuresLoading.hidden = false;
            departuresList.innerHTML = '';
            departuresEmpty.hidden = true;
        }

        const dateVal = depDate.value;
        const timeVal = depTime.value;
        const durationVal = depDuration.value;

        try {
            const url = `${API_BASE}/departures?station_id=${currentStation.id}&date=${dateVal}&time=${timeVal}&duration=${durationVal}`;
            const res = await fetch(url);
            const data = await res.json();
            
            departuresCache = data;
            departuresLoading.hidden = true;
            renderDepartures(data);
        } catch (err) {
            console.error('Abfahrtsladefehler:', err);
            departuresLoading.hidden = true;
            if (!silent) {
                departuresList.innerHTML = '<div class="error-card glass-card">Die Abfahrten konnten nicht geladen werden.</div>';
            }
        }
    }

    function renderDepartures(deps) {
        departuresList.innerHTML = '';

        const filtered = deps.filter(dep => {
            if (activeFilters.all) return true;
            return activeFilters[dep.type];
        });

        if (!filtered.length) {
            departuresEmpty.hidden = false;
            return;
        }
        departuresEmpty.hidden = true;

        filtered.forEach((dep, idx) => {
            const card = document.createElement('div');
            card.className = 'departure-card';
            if (dep.cancelled) card.classList.add('cancelled');
            card.style.setProperty('--i', idx);
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            
            const stateText = dep.cancelled ? 'Ausfall' : (dep.delay > 0 ? `Verspätung +${dep.delay} Minuten` : (dep.delay < 0 ? `Verfrühung ${dep.delay} Minuten` : 'pünktlich'));
            card.setAttribute('aria-label', `${dep.line} nach ${dep.direction}, geplant ${dep.time}, ${stateText}`);

            const luminance = getLuminance(dep.lineColor);
            const textClass = luminance > 180 ? 'dark-text' : '';

            let delayBadgeHtml = '';
            if (dep.cancelled) {
                delayBadgeHtml = `<span class="delay-badge cancelled">Ausfall</span>`;
            } else if (dep.delay === null || dep.delay === undefined) {
                delayBadgeHtml = `<span class="delay-badge no-realtime">keine Echtzeit</span>`;
            } else if (dep.delay < 0) {
                delayBadgeHtml = `<span class="delay-badge early">${dep.delay} Min</span>`;
            } else if (dep.delay <= 1) {
                delayBadgeHtml = `<span class="delay-badge on-time">pünktlich</span>`;
            } else if (dep.delay < 5) {
                delayBadgeHtml = `<span class="delay-badge light-delay">+${dep.delay} Min</span>`;
            } else {
                delayBadgeHtml = `<span class="delay-badge heavy-delay">+${dep.delay} Min</span>`;
            }

            const showEstimated = dep.delay >= 5 && dep.estimatedTime;
            const estimatedHtml = showEstimated 
                ? `<span class="departure-time-estimated">Erwartet: ${dep.estimatedTime}</span>`
                : '';

            const platformHtml = dep.platform 
                ? `<span class="departure-platform">${formatPlatform(dep.platform)}</span>`
                : '';

            card.innerHTML = `
                <div class="line-badge ${textClass}" style="background-color: ${dep.lineColor || '#018e4a'}">
                    ${dep.line}
                </div>
                <div class="departure-info">
                    <span class="departure-direction">${dep.direction}</span>
                    ${platformHtml}
                </div>
                <div class="departure-time">
                    <span class="departure-time-planned">${dep.time}</span>
                    ${estimatedHtml}
                    <span class="departure-countdown" data-planned="${dep.time}" data-delay="${dep.delay || 0}" data-offset="${dep.day_offset}"></span>
                    ${delayBadgeHtml}
                </div>
            `;

            const selectAction = () => handleItemSelection(dep);
            card.addEventListener('click', selectAction);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectAction();
                }
            });

            departuresList.appendChild(card);
        });

        if (isNowModeActive) {
            updateAllCountdowns();
        }
    }

    function getDepartureDate(timeStr, dayOffset = 0) {
        const [h, m] = timeStr.split(':').map(Number);
        const date = new Date();
        date.setHours(h, m, 0, 0);
        if (dayOffset) {
            date.setDate(date.getDate() + dayOffset);
        } else {
            const now = new Date();
            if (now.getHours() - h > 18) {
                date.setDate(date.getDate() + 1);
            } else if (h - now.getHours() > 18) {
                date.setDate(date.getDate() - 1);
            }
        }
        return date;
    }

    function updateAllCountdowns() {
        if (!isNowModeActive) return;

        const countdowns = document.querySelectorAll('.departure-countdown');
        let needsRefetch = false;

        countdowns.forEach(el => {
            const plannedTime = el.getAttribute('data-planned');
            const delay = parseInt(el.getAttribute('data-delay') || '0', 10);
            const dayOffset = parseInt(el.getAttribute('data-offset') || '0', 10);

            const depDate = getDepartureDate(plannedTime, dayOffset);
            const actualDepDate = new Date(depDate.getTime() + delay * 60000);
            const now = new Date();
            const diffMs = actualDepDate - now;

            if (diffMs < -30000) {
                el.textContent = 'abgefahren';
                el.classList.add('departed');
                needsRefetch = true;
            } else if (diffMs < 0) {
                el.textContent = 'jetzt';
                el.classList.remove('departed');
                el.style.color = 'var(--success)';
            } else if (diffMs < 60000) {
                const secs = Math.ceil(diffMs / 1000);
                el.textContent = `in ${secs} Sek`;
                el.classList.remove('departed');
                el.style.color = 'var(--primary-light)';
            } else {
                const mins = Math.ceil(diffMs / 60000);
                el.textContent = `in ${mins} Min`;
                el.classList.remove('departed');
                el.style.color = '';
            }
        });

        if (needsRefetch) {
            fetchDepartures(true);
        }
    }

    startLiveUpdateEngine();
    fetchDepartures();

    // Trigger departures search from widget button
    submitDepBtn.addEventListener('click', () => {
        const text = stationInput.value.trim();
        if (!text) {
            showToast('Bitte gib einen Haltestellennamen ein', 'warning');
            return;
        }
        switchTab('departures');
        fetchDepartures();
        scrollToResults();
    });

    // -----------------------------------------------------------------------
    // Adaptive Detail View Dispatcher (Mobile Modal vs Desktop Right Panel)
    // -----------------------------------------------------------------------
    function handleItemSelection(dep) {
        activeJourneyData = dep;
        
        if (isDesktopLayout()) {
            openJourneyDesktopPanel(dep);
        } else {
            openJourneyMobileModal(dep);
        }
    }

    async function openJourneyDesktopPanel(dep) {
        if (journeyDetailInterval) clearInterval(journeyDetailInterval);
        
        detailsPlaceholder.style.display = 'none';
        detailsContent.style.display = 'flex';
        detailsRoute.innerHTML = '';
        detailsMessages.innerHTML = '';

        detailsTitle.textContent = `Linie ${dep.line}`;
        detailsSubtitle.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        detailsLineBadge.textContent = dep.line;
        detailsLineBadge.style.backgroundColor = dep.lineColor || '#018e4a';
        detailsLineBadge.classList.toggle('dark-text', luminance > 180);

        const loadDetails = async (isQuiet = false) => {
            try {
                const queryParams = `journey_id=${encodeURIComponent(dep.journey_id)}&line=${encodeURIComponent(dep.line)}&direction=${encodeURIComponent(dep.direction)}&time=${encodeURIComponent(dep.time)}&delay=${encodeURIComponent(dep.delay || 0)}&station_name=${encodeURIComponent(currentStation.name)}`;
                const res = await fetch(`${API_BASE}/journey?${queryParams}`);
                const data = await res.json();
                
                if (activeJourneyData && activeJourneyData.journey_id === dep.journey_id) {
                    renderStopsTimelineHTML(data, detailsRoute, detailsMessages, !isQuiet);
                }
            } catch (err) {
                console.error('Desktop-Details Ladefehler:', err);
                if (!isQuiet) {
                    detailsRoute.innerHTML = '<div class="error-card glass-card">Verlauf konnte nicht geladen werden.</div>';
                }
            }
        };

        await loadDetails();
        journeyDetailInterval = setInterval(() => loadDetails(true), 30000);
    }

    async function openJourneyMobileModal(dep) {
        if (journeyDetailInterval) clearInterval(journeyDetailInterval);

        journeyModal.hidden = false;
        journeyLoading.hidden = false;
        journeyRoute.innerHTML = '';
        journeyMessages.innerHTML = '';

        journeyModalTitle.textContent = `Linie ${dep.line}`;
        modalDirection.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        modalLineBadge.textContent = dep.line;
        modalLineBadge.style.backgroundColor = dep.lineColor || '#018e4a';
        modalLineBadge.classList.toggle('dark-text', luminance > 180);

        journeyModal.focus();

        const loadDetails = async (isQuiet = false) => {
            if (!isQuiet) {
                journeyLoading.hidden = false;
            }
            try {
                const queryParams = `journey_id=${encodeURIComponent(dep.journey_id)}&line=${encodeURIComponent(dep.line)}&direction=${encodeURIComponent(dep.direction)}&time=${encodeURIComponent(dep.time)}&delay=${encodeURIComponent(dep.delay || 0)}&station_name=${encodeURIComponent(currentStation.name)}`;
                const res = await fetch(`${API_BASE}/journey?${queryParams}`);
                const data = await res.json();
                
                if (journeyModal.hidden) return;
                
                journeyLoading.hidden = true;
                renderStopsTimelineHTML(data, journeyRoute, journeyMessages, !isQuiet);
            } catch (err) {
                console.error('Mobile-Modal Ladefehler:', err);
                journeyLoading.hidden = true;
                if (!isQuiet) {
                    journeyRoute.innerHTML = '<div class="error-card glass-card">Verlauf konnte nicht geladen werden.</div>';
                }
            }
        };

        await loadDetails();
        journeyDetailInterval = setInterval(() => loadDetails(true), 30000);
    }

    function getRelativeOffset(element, parent) {
        let top = 0;
        let left = 0;
        let el = element;
        while (el && el !== parent) {
            top += el.offsetTop;
            left += el.offsetLeft;
            el = el.offsetParent;
        }
        return { top, left };
    }

    function animateVehicleMarker(routeContainer) {
        const currentDot = routeContainer.querySelector('.stop-dot.current');
        if (!currentDot) return;

        // 1. Get old marker position if exists in routeContainer
        const oldMarker = routeContainer.querySelector('.vehicle-floating-marker');
        let oldPos = null;
        if (oldMarker) {
            oldPos = {
                top: oldMarker.style.top,
                left: oldMarker.style.left
            };
            oldMarker.remove();
        }

        // 2. Calculate new target coordinates relative to routeContainer
        const coords = getRelativeOffset(currentDot, routeContainer);
        const targetTop = coords.top + currentDot.offsetHeight / 2;
        const targetLeft = coords.left + currentDot.offsetWidth / 2;

        // 3. Create new floating marker
        const marker = document.createElement('div');
        marker.className = 'vehicle-floating-marker';
        marker.textContent = '🚃';
        marker.style.position = 'absolute';
        marker.style.zIndex = '15';
        marker.style.transform = 'translate(-50%, -50%)';
        marker.style.fontSize = '1.2rem';
        marker.style.pointerEvents = 'none';

        if (oldPos) {
            // Start at old position without transition
            marker.style.transition = 'none';
            marker.style.top = oldPos.top;
            marker.style.left = oldPos.left;
            routeContainer.appendChild(marker);
            
            // Force reflow
            marker.offsetHeight;

            // Animate to new position
            marker.style.transition = 'top 2.5s cubic-bezier(0.25, 1, 0.5, 1), left 2.5s cubic-bezier(0.25, 1, 0.5, 1)';
            marker.style.top = targetTop + 'px';
            marker.style.left = targetLeft + 'px';
        } else {
            // Just place it at target position immediately
            marker.style.top = targetTop + 'px';
            marker.style.left = targetLeft + 'px';
            routeContainer.appendChild(marker);
        }
    }

    function renderStopsTimelineHTML(data, routeContainer, messagesContainer, animate = true) {
        routeContainer.innerHTML = '';
        messagesContainer.innerHTML = '';

        if (data.messages && data.messages.length > 0) {
            data.messages.forEach(msg => {
                const alertDiv = document.createElement('div');
                alertDiv.className = `alert-card glass-card ${msg.warning ? 'critical' : ''}`;
                alertDiv.style.borderLeftWidth = '3px';
                alertDiv.style.padding = '8px 12px';
                alertDiv.style.marginBottom = '12px';
                alertDiv.innerHTML = `
                    <div style="font-size:var(--font-size-sm); display:flex; gap:6px; align-items:center; font-weight:600;">
                        <span>${msg.warning ? '⚠️' : 'ℹ️'}</span>
                        <span>${msg.text}</span>
                    </div>
                `;
                messagesContainer.appendChild(alertDiv);
            });
        }

        const stops = data.stops;
        if (!stops || !stops.length) {
            routeContainer.innerHTML = '<p style="color:var(--text-secondary); text-align:center; padding:12px;">Kein Verlauf verfügbar.</p>';
            return;
        }

        const timelineWrapper = document.createElement('div');
        timelineWrapper.className = `journey-route ${animate ? 'animated' : 'no-animation'}`;
        timelineWrapper.style.setProperty('--timeline-color', data.lineColor || 'var(--primary)');

        stops.forEach((stop, idx) => {
            const stopEl = document.createElement('div');
            stopEl.className = 'journey-stop';
            if (idx === 0) stopEl.classList.add('first-stop');
            if (idx === stops.length - 1) stopEl.classList.add('last-stop');
            stopEl.style.setProperty('--i', idx);

            let delayHtml = '';
            if (stop.delay !== null && stop.delay !== undefined && !stop.cancelled) {
                if (stop.delay > 0) {
                    delayHtml = `<span class="stop-delay positive">+${stop.delay}</span>`;
                } else if (stop.delay < 0) {
                    delayHtml = `<span class="stop-delay early">${stop.delay}</span>`;
                } else {
                    delayHtml = `<span class="stop-delay on-time">pünktlich</span>`;
                }
            }
            
            const timeArea = document.createElement('div');
            timeArea.className = 'stop-time-area';
            timeArea.innerHTML = `
                <div class="stop-time">${stop.time}</div>
                ${delayHtml}
            `;
            stopEl.appendChild(timeArea);

            const dotArea = document.createElement('div');
            dotArea.className = 'stop-dot-area';
            
            const dot = document.createElement('div');
            dot.className = 'stop-dot';
            if (stop.cancelled) {
                dot.classList.add('cancelled');
            } else if (stop.isVehicleHere) {
                dot.classList.add('current');
            } else if (stop.passed) {
                dot.classList.add('passed');
            } else {
                dot.classList.add('future');
            }
            dotArea.appendChild(dot);
            stopEl.appendChild(dotArea);

            const platformBadge = stop.platform 
                ? `<span class="stop-platform-badge">${formatPlatform(stop.platform)}</span>`
                : '';
            
            const infoEl = document.createElement('div');
            infoEl.className = 'stop-info';
            
            const nameEl = document.createElement('div');
            nameEl.className = 'stop-name';
            nameEl.textContent = stop.name.replace('Magdeburg, ', '');
            if (stop.cancelled) nameEl.classList.add('cancelled');
            else if (stop.passed) nameEl.classList.add('passed');

            infoEl.appendChild(nameEl);
            if (platformBadge) infoEl.innerHTML += platformBadge;
            stopEl.appendChild(infoEl);

            timelineWrapper.appendChild(stopEl);
        });

        routeContainer.appendChild(timelineWrapper);
        animateVehicleMarker(timelineWrapper);

        setTimeout(() => {
            const currentVehicleDot = routeContainer.querySelector('.stop-dot.current');
            if (currentVehicleDot) {
                currentVehicleDot.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 150);
    }

    function closeJourneyModal() {
        journeyModal.classList.add('closing');
        if (journeyDetailInterval) {
            clearInterval(journeyDetailInterval);
            journeyDetailInterval = null;
        }
        setTimeout(() => {
            journeyModal.hidden = true;
            journeyModal.classList.remove('closing');
        }, 380);
    }

    closeModalBtn.addEventListener('click', closeJourneyModal);

    window.addEventListener('resize', () => {
        if (!isDesktopLayout() && !journeyModal.hidden === false && activeJourneyData) {
            detailsContent.style.display = 'none';
            detailsPlaceholder.style.display = 'flex';
            openJourneyMobileModal(activeJourneyData);
        } else if (isDesktopLayout() && !journeyModal.hidden && activeJourneyData) {
            closeJourneyModal();
            openJourneyDesktopPanel(activeJourneyData);
        }
    });

    // -----------------------------------------------------------------------
    // Connections Search Submission
    // -----------------------------------------------------------------------
    async function triggerConnectionSearch() {
        const startText = originInput.value.trim();
        const destText = destInput.value.trim();

        if (!startText || !destText) {
            showToast('Bitte gib einen Start- und Zielort ein', 'warning');
            return;
        }

        connectionsLoading.hidden = false;
        connectionsList.innerHTML = '';
        connectionsEmpty.hidden = true;

        const dateVal = connDate.value;
        const timeVal = connTime.value;

        const originId = originStation ? originStation.id : startText;
        const destId = destStation ? destStation.id : destText;

        try {
            const url = `${API_BASE}/connections?origin=${encodeURIComponent(originId)}&destination=${encodeURIComponent(destId)}&date=${dateVal}&time=${timeVal}`;
            const res = await fetch(url);
            const data = await res.json();
            
            connectionsLoading.hidden = true;
            renderConnections(data);
        } catch (err) {
            console.error('Verbindungsfehler:', err);
            connectionsLoading.hidden = true;
            connectionsList.innerHTML = '<div class="error-card glass-card">Die Verbindungen konnten nicht geladen werden.</div>';
        }
    }

    submitConnBtn.addEventListener('click', () => {
        switchTab('connections');
        triggerConnectionSearch();
        scrollToResults();
    });

    function renderConnections(conns) {
        if (!conns.length) {
            connectionsEmpty.hidden = false;
            return;
        }
        connectionsEmpty.hidden = true;

        conns.forEach((conn, idx) => {
            const firstLeg = conn.legs[0];
            const lastLeg = conn.legs[conn.legs.length - 1];
            const depTime = firstLeg ? firstLeg.departure_time : '';
            const arrTime = lastLeg ? lastLeg.arrival_time : '';

            const card = document.createElement('div');
            card.className = 'connection-card';
            card.style.setProperty('--i', idx);
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-expanded', 'false');

            let legsPreviewHtml = '<div class="connection-timeline-bar-container" style="display:flex; height:24px; border-radius:var(--radius-sm); overflow:hidden; margin: 12px 0; background:rgba(0,0,0,0.03);">';
            conn.legs.forEach(leg => {
                const styleColor = leg.type === 'walk' ? '#777' : (leg.lineColor || '#018e4a');
                const legLabel = leg.type === 'walk' ? '🚶' : leg.line;
                
                legsPreviewHtml += `
                    <div style="flex: 1; background-color: ${styleColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight:700; border-right:1px solid var(--bg-primary);">
                        <span>${legLabel}</span>
                    </div>
                `;
            });
            legsPreviewHtml += '</div>';

            let timelineHtml = `<div class="connection-timeline" style="display: none; margin-top: 16px; border-top:1px solid var(--card-border); padding-top:16px;">`;
            conn.legs.forEach((leg, lIdx) => {
                const textClass = getLuminance(leg.lineColor) > 180 ? 'dark-text' : '';
                const isTransit = leg.type !== 'walk';
                
                let detailRow = '';
                if (isTransit) {
                    let delayHtml = '';
                    if (leg.departure_delay !== null && leg.departure_delay !== undefined) {
                        if (leg.departure_delay > 0) {
                            delayHtml = `<span class="leg-delay positive" style="font-size:10px; margin-left:6px; color:var(--danger); font-weight:700;">+${leg.departure_delay} Min</span>`;
                        } else if (leg.departure_delay < 0) {
                            delayHtml = `<span class="leg-delay early" style="font-size:10px; margin-left:6px; color:#00b4d8; font-weight:700;">${leg.departure_delay} Min</span>`;
                        } else {
                            delayHtml = `<span class="leg-delay on-time" style="font-size:10px; margin-left:6px; color:var(--success); font-weight:700;">(pünktlich)</span>`;
                        }
                    } else {
                        delayHtml = `<span class="leg-delay no-rt" style="font-size:10px; margin-left:6px; color:var(--text-muted);">(keine Echtzeit)</span>`;
                    }
                    
                    detailRow = `
                        <div class="connection-leg transit-leg" style="--leg-color: ${leg.lineColor || 'var(--primary)'}">
                            <div class="leg-departure">
                                <span class="leg-time">${leg.departure_time}</span>
                                <span class="leg-station"><strong>${leg.origin}</strong></span>
                                ${delayHtml}
                            </div>
                            <div class="leg-line-info">
                                <span class="leg-line-badge ${textClass}" style="background-color: ${leg.lineColor}">${leg.line}</span>
                                <span class="leg-direction">Richtung ${leg.destination}</span>
                                ${leg.platform ? `<span class="stop-platform-badge" style="margin-left:8px;">${formatPlatform(leg.platform)}</span>` : ''}
                            </div>
                            <div class="leg-arrival">
                                <span class="leg-time">${leg.arrival_time}</span>
                                <span class="leg-station">${leg.destination}</span>
                            </div>
                            
                            <button class="show-intermediate-btn" data-jid="${leg.journey_id}" data-line="${leg.line}" data-dir="${leg.destination}" data-time="${leg.departure_time}" data-delay="${leg.departure_delay || 0}" style="background:none; border:none; color:var(--primary); font-size:11px; font-weight:600; cursor:pointer; padding: 4px 0; margin-top:4px; display:flex; align-items:center; gap:2px;">
                                🔽 Zwischenhalte anzeigen
                            </button>
                            <div class="intermediate-stops-box" style="display:none; margin-top:8px; padding-left:12px; border-left:1px dashed var(--card-border);"></div>
                        </div>
                    `;
                } else {
                    detailRow = `
                        <div class="connection-leg walk-leg">
                            <div class="leg-departure">
                                <span class="leg-time">${leg.departure_time}</span>
                                <span class="leg-station">${leg.origin}</span>
                            </div>
                            <div class="leg-walk-info">
                                <span>🚶</span>
                                <span>Fußweg (${leg.destination})</span>
                            </div>
                            <div class="leg-arrival">
                                <span class="leg-time">${leg.arrival_time}</span>
                                <span class="leg-station">${leg.destination}</span>
                            </div>
                        </div>
                    `;
                }

                timelineHtml += detailRow;

                if (lIdx < conn.legs.length - 1) {
                    timelineHtml += `
                        <div class="transfer-indicator">
                            <span>🔄 Umsteigen</span>
                        </div>
                    `;
                }
            });
            timelineHtml += `</div>`;

            card.innerHTML = `
                <div class="connection-header">
                    <div class="connection-summary">
                        <span class="connection-duration">⏱️ ${conn.duration} Min</span>
                        <span class="connection-transfers">${conn.transfers === 0 ? 'Direktfahrt' : `${conn.transfers} Umst.`}</span>
                    </div>
                    <div class="connection-times">
                        <div class="connection-time-range">${depTime} - ${arrTime}</div>
                    </div>
                </div>
                ${legsPreviewHtml}
                <div style="font-size:11px; color:var(--text-secondary); text-align:center;">Klicke für Verbindungsdetails</div>
                ${timelineHtml}
            `;

            const toggleDetails = () => {
                const timeline = card.querySelector('.connection-timeline');
                const isExpanded = timeline.style.display === 'block';
                timeline.style.display = isExpanded ? 'none' : 'block';
                card.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
                
                const promptText = card.querySelector('div:nth-of-type(2)');
                if (promptText) {
                    promptText.textContent = isExpanded ? 'Klicke für Verbindungsdetails' : 'Details ausblenden';
                }
            };

            card.addEventListener('click', (e) => {
                if (e.target.closest('.show-intermediate-btn')) return;
                toggleDetails();
            });

            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('.show-intermediate-btn')) return;
                    e.preventDefault();
                    toggleDetails();
                }
            });

            connectionsList.appendChild(card);
        });

        document.querySelectorAll('.show-intermediate-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jid = btn.getAttribute('data-jid');
                const line = btn.getAttribute('data-line');
                const dir = btn.getAttribute('data-dir');
                const time = btn.getAttribute('data-time');
                const delay = btn.getAttribute('data-delay');
                const stopsBox = btn.nextElementSibling;

                const isShown = stopsBox.style.display === 'block';
                if (isShown) {
                    stopsBox.style.display = 'none';
                    btn.textContent = '🔽 Zwischenhalte anzeigen';
                    if (connectionStopsInterval) {
                        clearInterval(connectionStopsInterval);
                        connectionStopsInterval = null;
                    }
                } else {
                    if (connectionStopsInterval) {
                        clearInterval(connectionStopsInterval);
                        connectionStopsInterval = null;
                    }

                    stopsBox.style.display = 'block';
                    stopsBox.innerHTML = '<div style="font-size:11px; padding:6px; color:var(--text-secondary);">Lade Zwischenhalte...</div>';
                    btn.textContent = '🔼 Zwischenhalte ausblenden';

                    const loadStops = async () => {
                        try {
                            const res = await fetch(`${API_BASE}/journey?journey_id=${encodeURIComponent(jid)}&line=${encodeURIComponent(line)}&direction=${encodeURIComponent(dir)}&time=${encodeURIComponent(time)}&delay=${encodeURIComponent(delay)}`);
                            const data = await res.json();
                            
                            if (stopsBox.style.display !== 'block') return;
                            
                            if (!data.stops || !data.stops.length) {
                                stopsBox.innerHTML = '<div style="font-size:10px; color:var(--text-muted);">Keine Wegdaten.</div>';
                                return;
                            }
                            
                            const fragment = document.createDocumentFragment();
                            data.stops.forEach(stop => {
                                const row = document.createElement('div');
                                row.style.display = 'flex';
                                row.style.justifyContent = 'space-between';
                                row.style.fontSize = '11px';
                                row.style.padding = '3px 0';
                                
                                let nameText = stop.name.replace('Magdeburg, ', '');
                                let delayText = '';
                                if (stop.delay !== null && stop.delay !== undefined) {
                                    if (stop.delay > 0) {
                                        delayText = ` <span style="color:var(--danger); font-weight:700;">+${stop.delay} Min</span>`;
                                    } else if (stop.delay < 0) {
                                        delayText = ` <span style="color:#00b4d8; font-weight:700;">${stop.delay} Min</span>`;
                                    } else {
                                        delayText = ` <span style="color:var(--success); font-weight:700;">pünktlich</span>`;
                                    }
                                }
                                
                                const vehicleLabel = stop.isVehicleHere ? ' 🚃 <strong style="color:var(--primary); font-weight:700;">(Aktueller Standort)</strong>' : '';
                                const textStyle = stop.isVehicleHere 
                                    ? 'font-weight:700; color:var(--primary);' 
                                    : (stop.passed ? 'color:var(--text-secondary); opacity:0.7;' : 'color:var(--text-primary);');

                                row.innerHTML = `
                                    <span style="${textStyle}">${nameText}${vehicleLabel}</span>
                                    <span style="color: var(--text-muted); font-variant-numeric: tabular-nums;">${stop.time}${delayText}</span>
                                `;
                                fragment.appendChild(row);
                            });
                            
                            stopsBox.innerHTML = '';
                            stopsBox.appendChild(fragment);
                        } catch (err) {
                            if (stopsBox.innerHTML.includes('Lade')) {
                                stopsBox.innerHTML = '<div style="font-size:10px; color:var(--danger);">Fehler beim Laden.</div>';
                            }
                        }
                    };

                    await loadStops();
                    connectionStopsInterval = setInterval(loadStops, 30000); // 30s auto-refresh
                }
            });
        });
    }

    // -----------------------------------------------------------------------
    // Quick Actions Bar Click Handlers
    // -----------------------------------------------------------------------
    actionButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-action');
            
            if (action === 'live-departures') {
                switchTab('departures');
                fetchDepartures();
                scrollToResults();
            } else if (action === 'alerts') {
                switchTab('alerts');
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else if (action === 'connections') {
                switchTab('connections');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                setTimeout(() => {
                    originInput.focus();
                }, 100);
            } else if (action === 'tickets') {
                switchTab('tickets');
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    });

    // -----------------------------------------------------------------------
    // Disruptions & Push Notification Engine
    // -----------------------------------------------------------------------
    function initPushBanner() {
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                pushBanner.hidden = false;
            } else {
                pushBanner.hidden = true;
            }
        } else {
            pushBanner.hidden = true;
        }
    }

    enablePushBtn.addEventListener('click', () => {
        Notification.requestPermission().then(permission => {
            pushBanner.hidden = true;
            if (permission === 'granted') {
                showToast('Meldungen erfolgreich abonniert!', 'success');
            } else {
                showToast('Meldungen blockiert. Ändere dies in den Browsereinstellungen.', 'warning');
            }
        });
    });

    dismissPushBtn.addEventListener('click', () => {
        pushBanner.hidden = true;
    });

    initPushBanner();

    async function fetchDisruptions(silent = false) {
        if (!silent) {
            alertsLoading.hidden = false;
            alertsList.innerHTML = '';
        }

        try {
            const res = await fetch(`${API_BASE}/disruptions`);
            const data = await res.json();
            
            alertsLoading.hidden = true;
            renderDisruptions(data);
        } catch (err) {
            console.error('Meldungsfehler:', err);
            alertsLoading.hidden = true;
            if (!silent) {
                alertsList.innerHTML = '<div class="error-card glass-card">Meldungen konnten nicht geladen werden.</div>';
            }
        }
    }

    function renderDisruptions(alerts) {
        alertsList.innerHTML = '';
        
        const validAlerts = alerts.filter(a => a.title && a.desc);
        
        if (!validAlerts.length) {
            alertsList.innerHTML = `
                <div class="empty-state glass-card" style="text-align:center; padding: var(--space-6);">
                    <span style="font-size:3rem; display:block; margin-bottom:12px;">✅</span>
                    <p style="font-weight:600; color:var(--success);">Freie Fahrt im gesamten Netz</p>
                    <p style="font-size:var(--font-size-sm); color:var(--text-secondary); margin-top:4px;">Aktuell liegen keine Betriebsstörungen vor.</p>
                </div>
            `;
            alertBadgeMobile.hidden = true;
            headerAlertBadge.hidden = true;
            return;
        }

        alertBadgeMobile.textContent = validAlerts.length;
        alertBadgeMobile.hidden = false;
        headerAlertBadge.textContent = validAlerts.length;
        headerAlertBadge.hidden = false;

        validAlerts.forEach((alert, idx) => {
            const card = document.createElement('div');
            card.className = 'alert-card';
            if (alert.critical) card.classList.add('critical');
            card.style.setProperty('--i', idx);

            const criticalBadge = alert.critical 
                ? '<span class="alert-critical-badge">🚨 Kritisch</span>'
                : '';

            let linesHtml = '';
            if (alert.lines && alert.lines.length > 0) {
                alert.lines.forEach(lineStr => {
                    const cleanLine = lineStr.replace('Linie', '').replace('Line', '').replace('Bus', '').replace('Str', '').replace('Tram', '').trim();
                    if (cleanLine) {
                        const lineColor = JS_LINE_COLORS[cleanLine] || '#888888';
                        const textClass = getLuminance(lineColor) > 180 ? 'dark-text' : '';
                        linesHtml += `<span class="alert-line-badge ${textClass}" style="background-color: ${lineColor}">${cleanLine}</span>`;
                    }
                });
            }

            card.innerHTML = `
                <div class="alert-card-header">
                    <span class="alert-title">${alert.title}</span>
                    ${criticalBadge}
                </div>
                <p class="alert-description">${alert.desc}</p>
                <div class="alert-lines">${linesHtml}</div>
                <span class="alert-time">🕒 Aktuell</span>
            `;

            alertsList.appendChild(card);
        });
    }

    async function checkNewDisruptionsBackground() {
        try {
            const res = await fetch(`${API_BASE}/disruptions/check`);
            const data = await res.json();
            
            const fetchedIds = data.ids || [];
            let hasNew = false;
            
            fetchedIds.forEach(id => {
                if (!knownDisruptionIds.has(id)) {
                    hasNew = true;
                    knownDisruptionIds.add(id);
                }
            });

            if (hasNew) {
                localStorage.setItem('knownDisruptions', JSON.stringify(Array.from(knownDisruptionIds)));
                
                const fullRes = await fetch(`${API_BASE}/disruptions`);
                const fullData = await fullRes.json();
                
                renderDisruptions(fullData);

                const newlyFound = fullData.find(a => !knownDisruptionIds.has(a.id));
                const notificationTitle = newlyFound ? newlyFound.title : 'Neue Störungsmeldung';
                
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification('Nahverkehr Magdeburg', {
                        body: notificationTitle,
                        icon: '/hourglass_logo.png'
                    });
                }

                showToast(`Neue Störung: ${notificationTitle}`, 'critical');
            }
        } catch (err) {
            console.warn('Hintergrundcheck Fehler:', err);
        }
    }

    fetchDisruptions();
    alertsInterval = setInterval(checkNewDisruptionsBackground, 45000);

    // Ticket card expandable headers accordion
    document.querySelectorAll('.ticket-card-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.parentElement;
            const descBox = card.querySelector('.ticket-description-box');
            const icon = card.querySelector('.ticket-toggle-icon');
            const isHidden = descBox.hidden;
            
            descBox.hidden = !isHidden;
            icon.textContent = isHidden ? '−' : '+';
            
            header.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
        });
        
        // Keydown support
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                header.click();
            }
        });
    });
});
