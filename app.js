document.addEventListener('DOMContentLoaded', () => {
    // -----------------------------------------------------------------------
    // Constants & Configuration
    // -----------------------------------------------------------------------
    const isLocalEnv = (
        window.location.protocol === 'file:' ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.startsWith('192.168.') ||
        window.location.hostname.startsWith('10.') ||
        window.location.hostname === ''
    );

    const API_BASE = isLocalEnv ? 'http://127.0.0.1:5000/api' : '/api';

    // Home Screen Cards behavior & Navigation Logo Link
    const homeCards = document.querySelectorAll('.home-card');
    homeCards.forEach(card => {
        card.addEventListener('click', () => {
            const target = card.getAttribute('data-target');
            switchTab(target);
            if (target === 'departures') {
                fetchDepartures();
                scrollToResults();
            } else if (target === 'connections') {
                setTimeout(() => {
                    const originInput = document.getElementById('originInput');
                    if (originInput) originInput.focus();
                }, 100);
            }
        });
    });

    const headerLogo = document.querySelector('.header-logo');
    if (headerLogo) {
        headerLogo.addEventListener('click', () => {
            switchTab('home');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        headerLogo.style.cursor = 'pointer';
    }

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

    // Transport toggle buttons
    const transportBtns = document.querySelectorAll('.transport-pill-btn');
    const allowedTransport = {
        tram: true,
        bus: true,
        regional: true,
        express: true
    };

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
    const detailsOperator = document.getElementById('detailsOperator');

    // Mobile Journey Modal
    const journeyModal = document.getElementById('journeyModal');
    const journeyModalTitle = document.getElementById('journeyModalTitle');
    const modalLineBadge = document.getElementById('modalLineBadge');
    const modalDirection = document.getElementById('modalDirection');
    const journeyMessages = document.getElementById('journeyMessages');
    const journeyRoute = document.getElementById('journeyRoute');
    const journeyLoading = document.getElementById('journeyLoading');
    const modalOperator = document.getElementById('modalOperator');
    const closeModalBtn = document.getElementById('closeModal');

    // Loading screen state
    let isInitialLoad = true;
    let loadingStatusInterval = null;

    // Close desktop details button wiring
    const detailsCloseBtn = document.getElementById('detailsCloseBtn');
    if (detailsCloseBtn) {
        detailsCloseBtn.addEventListener('click', () => {
            if (journeyDetailInterval) {
                clearInterval(journeyDetailInterval);
                journeyDetailInterval = null;
            }
            activeJourneyData = null;
            detailsContent.style.display = 'none';
            detailsPlaceholder.style.display = 'flex';
        });
    }

    // Clock Widgets
    const widgetClockTime = document.getElementById('widgetClockTime');
    const widgetClockDate = document.getElementById('widgetClockDate');

    // -----------------------------------------------------------------------
    // Theming Engine & Secret Jinx Mode System
    // -----------------------------------------------------------------------
    let currentTheme = localStorage.getItem('theme') || 'light';
    let isJinxUnlocked = localStorage.getItem('jinx_unlocked') === 'true' || currentTheme === 'jinx';
    let themeClickCount = 0;
    let themeClickTimer = null;
    let keyBuffer = '';
    let jinxCanvas = null;
    let jinxAnimId = null;

    function initJinxParticleCanvas() {
        if (!jinxCanvas) {
            jinxCanvas = document.createElement('canvas');
            jinxCanvas.className = 'jinx-sparks-canvas';
            document.body.appendChild(jinxCanvas);
        }
        
        jinxCanvas.style.display = 'block';
        const ctx = jinxCanvas.getContext('2d');
        let width = jinxCanvas.width = window.innerWidth;
        let height = jinxCanvas.height = window.innerHeight;

        const onResize = () => {
            if (jinxCanvas) {
                width = jinxCanvas.width = window.innerWidth;
                height = jinxCanvas.height = window.innerHeight;
            }
        };
        window.removeEventListener('resize', onResize);
        window.addEventListener('resize', onResize);

        const particles = [];
        const colors = ['#FF007F', '#FF0055', '#00F0FF', '#E0AAFF', '#FF3399', '#9900FF'];
        for (let i = 0; i < 50; i++) {
            particles.push({
                x: Math.random() * width,
                y: Math.random() * height,
                radius: Math.random() * 2.8 + 1,
                color: colors[Math.floor(Math.random() * colors.length)],
                speedY: -(Math.random() * 1.6 + 0.6),
                speedX: (Math.random() - 0.5) * 0.9,
                alpha: Math.random() * 0.8 + 0.2
            });
        }

        function drawParticles() {
            if (currentTheme !== 'jinx') {
                if (jinxCanvas) jinxCanvas.style.display = 'none';
                return;
            }
            ctx.clearRect(0, 0, width, height);
            
            particles.forEach(p => {
                p.y += p.speedY;
                p.x += p.speedX;
                if (p.y < -10) {
                    p.y = height + 10;
                    p.x = Math.random() * width;
                }
                ctx.save();
                ctx.globalAlpha = p.alpha;
                ctx.shadowBlur = 12;
                ctx.shadowColor = p.color;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            });

            jinxAnimId = requestAnimationFrame(drawParticles);
        }

        if (jinxAnimId) cancelAnimationFrame(jinxAnimId);
        drawParticles();
    }

    function applyTheme(theme) {
        currentTheme = theme;
        appContainer.classList.remove('theme-light', 'theme-dark', 'theme-jinx');
        
        if (theme === 'light') {
            appContainer.classList.add('theme-light');
            if (themeToggleBtn) themeToggleBtn.textContent = '🌙';
            if (jinxCanvas) jinxCanvas.style.display = 'none';
        } else if (theme === 'dark') {
            appContainer.classList.add('theme-dark');
            if (themeToggleBtn) themeToggleBtn.textContent = '☀️';
            if (jinxCanvas) jinxCanvas.style.display = 'none';
        } else if (theme === 'jinx') {
            appContainer.classList.add('theme-jinx');
            if (themeToggleBtn) themeToggleBtn.textContent = '💣';
            initJinxParticleCanvas();
        }
        localStorage.setItem('theme', theme);
    }

    function triggerJinxUnlock(forceToggle = false) {
        if (!isJinxUnlocked) {
            isJinxUnlocked = true;
            localStorage.setItem('jinx_unlocked', 'true');
        }

        // Silent Flash Overlay Effect
        const flash = document.createElement('div');
        flash.className = 'jinx-flash-overlay';
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 550);

        if (currentTheme === 'jinx' && forceToggle) {
            applyTheme('dark');
        } else {
            applyTheme('jinx');
        }
    }

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            if (currentTheme === 'jinx') {
                applyTheme('dark');
                showToast('Farbschema auf Dark Mode gewechselt', 'success');
            } else {
                const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
                applyTheme(nextTheme);
                showToast(`Farbschema auf ${nextTheme === 'dark' ? 'Dark Mode' : 'Light Mode'} gewechselt`, 'success');
            }
        });
    }

    // Secret MVB Logo 7-click trigger
    const brandLogo = document.querySelector('.logo-link') || document.querySelector('.header-logo');
    let logoClickCount = 0;
    let logoClickTimer = null;
    if (brandLogo) {
        brandLogo.addEventListener('click', (e) => {
            logoClickCount++;
            clearTimeout(logoClickTimer);
            logoClickTimer = setTimeout(() => { logoClickCount = 0; }, 2000);
            if (logoClickCount >= 7) {
                e.preventDefault();
                logoClickCount = 0;
                triggerJinxUnlock(true);
            }
        });
    }

    // Secret Konami Code & Key Sequence Listener
    const konamiCode = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
    let konamiIndex = 0;

    window.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();

        // Konami Code check
        if (key === konamiCode[konamiIndex]) {
            konamiIndex++;
            if (konamiIndex === konamiCode.length) {
                konamiIndex = 0;
                triggerJinxUnlock(true);
                return;
            }
        } else {
            konamiIndex = 0;
        }

        // Secret input / typing check
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            const val = e.target.value.toLowerCase();
            if (val.includes('jinx') || val.includes('arcane') || val.includes('powder') || val.includes('kaboom') || val.includes('zaun')) {
                triggerJinxUnlock(true);
                e.target.value = '';
            }
            return;
        }

        keyBuffer += key;
        if (keyBuffer.length > 20) keyBuffer = keyBuffer.slice(-20);

        if (keyBuffer.includes('jinx') || keyBuffer.includes('arcane') || keyBuffer.includes('powder') || keyBuffer.includes('kaboom') || keyBuffer.includes('zaun') || keyBuffer.includes('666')) {
            keyBuffer = '';
            triggerJinxUnlock(true);
        }
    });

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

    function hideLoadingScreen() {
        const loadingScreen = document.getElementById('app-loading-screen');
        if (loadingScreen) {
            if (loadingStatusInterval) {
                clearInterval(loadingStatusInterval);
                loadingStatusInterval = null;
            }
            loadingScreen.classList.add('fade-out');
            setTimeout(() => {
                loadingScreen.remove();
            }, 500);
        }
    }

    function renderOperator(operatorName, container) {
        if (!container) return;
        container.innerHTML = '';
        if (!operatorName) return;

        const opLower = operatorName.toLowerCase();
        let logoSrc = null;
        let altText = operatorName;

        if (opLower.includes('mvb') || opLower.includes('magdeburg')) {
            logoSrc = 'logo_mvb.png';
            altText = 'MVB';
        } else if (opLower.includes('db') || opLower.includes('bahn') || opLower.includes('dostgo') || opLower.includes('s-bahn') || opLower.includes('regio')) {
            logoSrc = 'logo_db.png';
            altText = 'Deutsche Bahn';
        } else if (opLower.includes('odeg') || opLower.includes('ostdeutsch')) {
            logoSrc = 'logo_odeg.png';
            altText = 'ODEG';
        } else if (opLower.includes('pvgs')) {
            logoSrc = 'logo_pvgs.png';
            altText = 'PVGS';
        } else if (opLower.includes('börde') || opLower.includes('boerde')) {
            logoSrc = 'logo_boerdebus.png';
            altText = 'BördeBus';
        } else if (opLower.includes('njl') || opLower.includes('jerichow')) {
            logoSrc = 'logo_njl.png';
            altText = 'NJL';
        } else if (opLower.includes('kvg') || opLower.includes('salzland')) {
            logoSrc = 'logo_kvg.png';
            altText = 'KVG';
        } else if (opLower.includes('flix')) {
            logoSrc = 'logo_flixbus.png';
            altText = 'FlixBus';
        } else if (opLower.includes('havag') || opLower.includes('halle')) {
            logoSrc = 'logo_havag.png';
            altText = 'HAVAG';
        } else if (opLower.includes('metronom')) {
            logoSrc = 'logo_metronom.png';
            altText = 'metronom';
        }

        if (logoSrc) {
            const img = document.createElement('img');
            img.src = logoSrc;
            img.alt = altText;
            img.className = 'operator-logo';
            container.appendChild(img);
        } else {
            const span = document.createElement('span');
            span.className = 'operator-text';
            span.textContent = operatorName;
            container.appendChild(span);
        }
    }

    function computeEstimatedTimeStr(timeStr, delay) {
        if (!timeStr || delay === null || delay === undefined) return '';
        try {
            const [h, m] = timeStr.split(':').map(Number);
            const total = h * 60 + m + delay;
            const newH = (Math.floor(total / 60) % 24 + 24) % 24;
            const newM = (total % 60 + 60) % 60;
            return `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`;
        } catch (e) {
            return '';
        }
    }

    function updateDepartureCardDelay(journeyId, journeyData) {
        if (!journeyId) return;
        const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(journeyId) : journeyId.replace(/([#;,.+*~':"!^$[\]()=>|@])/g, "\\$1");
        const card = document.querySelector(`.departure-card[data-journey-id="${escapedId}"]`);
        if (!card) return;

        let delay = null;
        if (journeyData.stops && journeyData.stops.length > 0) {
            const currentStop = journeyData.stops.find(s => 
                s.name.toLowerCase().includes(currentStation.name.toLowerCase()) ||
                currentStation.name.toLowerCase().includes(s.name.toLowerCase())
            );
            if (currentStop && currentStop.delay !== null && currentStop.delay !== undefined) {
                delay = currentStop.delay;
            } else {
                delay = journeyData.stops[0].delay;
            }
        }

        if (delay === null) return;

        const badge = card.querySelector('.delay-badge');
        if (badge) {
            if (delay < 0) {
                badge.className = 'delay-badge early';
                badge.textContent = `${delay} Min`;
            } else if (delay <= 1) {
                badge.className = 'delay-badge on-time';
                badge.textContent = 'pünktlich';
            } else if (delay < 5) {
                badge.className = 'delay-badge light-delay';
                badge.textContent = `+${delay} Min`;
            } else {
                badge.className = 'delay-badge heavy-delay';
                badge.textContent = `+${delay} Min`;
            }
        }

        const plannedEl = card.querySelector('.departure-time-planned');
        if (plannedEl) {
            const timeStr = plannedEl.textContent;
            const estimatedStr = computeEstimatedTimeStr(timeStr, delay);
            if (estimatedStr) {
                let estEl = card.querySelector('.departure-time-estimated');
                if (!estEl) {
                    estEl = document.createElement('span');
                    estEl.className = 'departure-time-estimated';
                    plannedEl.after(estEl);
                }
                estEl.textContent = `Erwartet: ${estimatedStr}`;
            }
        }
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
    const LOCAL_POPULAR_STATIONS = [
        {"id": "7393", "name": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz"},
        {"id": "8010224", "name": "Magdeburg Hbf"},
        {"id": "6929", "name": "Magdeburg, Hauptbahnhof/Kölner Platz"},
        {"id": "7488", "name": "Magdeburg, Alter Markt"},
        {"id": "7412", "name": "Magdeburg, Hasselbachplatz"},
        {"id": "7414", "name": "Magdeburg, Damaschkeplatz"},
        {"id": "7404", "name": "Magdeburg, Sudenburg"},
        {"id": "7449", "name": "Magdeburg, Reform"},
        {"id": "7423", "name": "Magdeburg, Neustädter See"},
        {"id": "7454", "name": "Magdeburg, Buckau Wasserwerk"},
        {"id": "7402", "name": "Magdeburg, Diesdorf"},
        {"id": "7409", "name": "Magdeburg, Herrenkrug"}
    ];

    function setupAutocomplete(inputEl, suggestionsEl, clearBtnEl, onSelect) {
        let debounceTimer;
        let lastQuery = '';

        const renderSuggestions = (list) => {
            suggestionsEl.innerHTML = '';
            if (!list || !list.length) {
                suggestionsEl.hidden = true;
                return;
            }
            list.forEach(station => {
                const li = document.createElement('li');
                li.className = 'suggestion-item';
                li.role = 'option';
                li.textContent = station.name;
                li.addEventListener('mousedown', (e) => {
                    // Prevent input blur before click registers
                    e.preventDefault();
                });
                li.addEventListener('click', () => {
                    inputEl.value = station.name;
                    suggestionsEl.hidden = true;
                    onSelect(station);
                });
                suggestionsEl.appendChild(li);
            });
            suggestionsEl.hidden = false;
        };

        inputEl.addEventListener('input', () => {
            const query = inputEl.value.trim();
            lastQuery = query;

            if (clearBtnEl) {
                clearBtnEl.hidden = query.length === 0;
            }

            if (query.length < 1) {
                suggestionsEl.innerHTML = '';
                suggestionsEl.hidden = true;
                return;
            }

            // Instant 0ms local match or clear old list
            const queryLower = query.toLowerCase();
            const localMatches = LOCAL_POPULAR_STATIONS.filter(s => s.name.toLowerCase().includes(queryLower));
            renderSuggestions(localMatches);

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
                    const data = await res.json();
                    if (inputEl.value.trim() === lastQuery && data && data.length) {
                        renderSuggestions(data);
                    }
                } catch (err) {
                    console.error('Autocomplete Fehler:', err);
                }
            }, 80);
        });

        inputEl.addEventListener('focus', () => {
            const query = inputEl.value.trim();
            if (query.length >= 1) {
                const queryLower = query.toLowerCase();
                const localMatches = LOCAL_POPULAR_STATIONS.filter(s => s.name.toLowerCase().includes(queryLower));
                if (localMatches.length > 0) {
                    renderSuggestions(localMatches);
                }
            }
        });

        if (clearBtnEl) {
            clearBtnEl.addEventListener('click', () => {
                inputEl.value = '';
                lastQuery = '';
                suggestionsEl.innerHTML = '';
                suggestionsEl.hidden = true;
                clearBtnEl.hidden = true;
                inputEl.focus();
            });
        }

        document.addEventListener('click', (e) => {
            if (!inputEl.contains(e.target) && !suggestionsEl.contains(e.target)) {
                clearTimeout(debounceTimer);
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

    transportBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = btn.getAttribute('data-mode');
            allowedTransport[mode] = !allowedTransport[mode];
            btn.classList.toggle('active', allowedTransport[mode]);
            btn.setAttribute('aria-pressed', allowedTransport[mode] ? 'true' : 'false');
        });
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
            renderDepartures(data, silent);
            
            if (isInitialLoad) {
                isInitialLoad = false;
                hideLoadingScreen();
            }
        } catch (err) {
            console.error('Abfahrtsladefehler:', err);
            departuresLoading.hidden = true;
            if (!silent) {
                departuresList.innerHTML = '<div class="error-card glass-card">Die Abfahrten konnten nicht geladen werden.</div>';
            }
            if (isInitialLoad) {
                isInitialLoad = false;
                hideLoadingScreen();
            }
        }
    }

    function renderDepartures(deps, silent = false) {
        if (silent) {
            departuresList.classList.add('no-animation');
        } else {
            departuresList.classList.remove('no-animation');
        }

        const now = new Date();
        const filtered = deps.filter(dep => {
            if (!activeFilters.all && !activeFilters[dep.type]) return false;
            
            if (isNowModeActive) {
                const depDate = getDepartureDate(dep.time, dep.day_offset || 0);
                const actualDepDate = new Date(depDate.getTime() + (dep.delay || 0) * 60000);
                if (actualDepDate - now < 0) {
                    return false;
                }
            }
            return true;
        });

        departuresList.innerHTML = '';

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
            
            const cardJourneyId = dep.journey_id ? `${dep.journey_id}_${dep.time.replace(':', '')}_${idx}` : `dep_${dep.line.replace(/\s+/g, '')}_${dep.time.replace(':', '')}_${idx}`;
            dep.card_journey_id = cardJourneyId;
            card.setAttribute('data-journey-id', cardJourneyId);
            
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

            const showEstimated = dep.delay && dep.delay !== 0 && dep.estimatedTime;
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

        countdowns.forEach(el => {
            const plannedTime = el.getAttribute('data-planned');
            const delay = parseInt(el.getAttribute('data-delay') || '0', 10);
            const dayOffset = parseInt(el.getAttribute('data-offset') || '0', 10);

            const depDate = getDepartureDate(plannedTime, dayOffset);
            const actualDepDate = new Date(depDate.getTime() + delay * 60000);
            const now = new Date();
            const diffMs = actualDepDate - now;

            if (diffMs < 0) {
                // Animate fade-out and slide-up before removing
                const card = el.closest('.departure-card');
                if (card && !card.classList.contains('fade-out-exit')) {
                    card.classList.add('fade-out-exit');
                    card.style.transition = 'all 0.5s ease';
                    card.style.opacity = '0';
                    card.style.transform = 'translateX(-20px)';
                    card.style.maxHeight = card.offsetHeight + 'px';
                    setTimeout(() => {
                        card.style.maxHeight = '0';
                        card.style.padding = '0';
                        card.style.margin = '0';
                        card.style.border = 'none';
                    }, 100);
                    setTimeout(() => {
                        card.remove();
                    }, 600);
                }
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
        const stationSuggestions = document.getElementById('stationSuggestions');
        if (stationSuggestions) stationSuggestions.hidden = true;
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
        if (detailsOperator) detailsOperator.innerHTML = '';

        detailsTitle.textContent = `Linie ${dep.line}`;
        detailsSubtitle.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        detailsLineBadge.textContent = dep.line;
        detailsLineBadge.style.backgroundColor = dep.lineColor || '#018e4a';
        detailsLineBadge.classList.toggle('dark-text', luminance > 180);

        const targetId = dep.card_journey_id || dep.journey_id;

        const loadDetails = async (isQuiet = false) => {
            try {
                const queryParams = `journey_id=${encodeURIComponent(dep.journey_id)}&line=${encodeURIComponent(dep.line)}&direction=${encodeURIComponent(dep.direction)}&time=${encodeURIComponent(dep.time)}&delay=${encodeURIComponent(dep.delay || 0)}&station_name=${encodeURIComponent(currentStation.name)}&_=${Date.now()}`;
                const res = await fetch(`${API_BASE}/journey?${queryParams}`);
                const data = await res.json();
                
                if (activeJourneyData && (activeJourneyData.card_journey_id || activeJourneyData.journey_id) === targetId) {
                    renderStopsTimelineHTML(data, detailsRoute, detailsMessages, !isQuiet);
                    updateDepartureCardDelay(targetId, data);
                    renderOperator(data.operator, detailsOperator);
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
        if (modalOperator) modalOperator.innerHTML = '';

        journeyModalTitle.textContent = `Linie ${dep.line}`;
        modalDirection.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        modalLineBadge.textContent = dep.line;
        modalLineBadge.style.backgroundColor = dep.lineColor || '#018e4a';
        modalLineBadge.classList.toggle('dark-text', luminance > 180);

        journeyModal.focus();

        const mobTargetId = dep.card_journey_id || dep.journey_id;

        const loadDetails = async (isQuiet = false) => {
            if (!isQuiet) {
                journeyLoading.hidden = false;
            }
            try {
                const queryParams = `journey_id=${encodeURIComponent(dep.journey_id)}&line=${encodeURIComponent(dep.line)}&direction=${encodeURIComponent(dep.direction)}&time=${encodeURIComponent(dep.time)}&delay=${encodeURIComponent(dep.delay || 0)}&station_name=${encodeURIComponent(currentStation.name)}&_=${Date.now()}`;
                const res = await fetch(`${API_BASE}/journey?${queryParams}`);
                const data = await res.json();
                
                if (journeyModal.hidden) return;
                
                journeyLoading.hidden = true;
                renderStopsTimelineHTML(data, journeyRoute, journeyMessages, !isQuiet);
                updateDepartureCardDelay(mobTargetId, data);
                renderOperator(data.operator, modalOperator);
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

    function animateVehicleMarker(routeContainer, type, data) {
        if (!data || !data.stops || !data.stops.length) return;

        const stopDoms = routeContainer.querySelectorAll('.journey-stop');
        if (data.stops.length !== stopDoms.length) return;

        // Cancel any existing animation frame request for this container
        if (routeContainer._animationFrameId) {
            cancelAnimationFrame(routeContainer._animationFrameId);
            routeContainer._animationFrameId = null;
        }

        // Parse all stop actual times to timestamps
        const stopTimes = data.stops.map(stop => {
            const now = new Date();
            const [h, m] = stop.time.split(':').map(Number);
            const stopDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
            if (stop.day_offset) {
                stopDate.setDate(stopDate.getDate() + stop.day_offset);
            }
            const delay = stop.delay || 0;
            return stopDate.getTime() + (delay * 60 * 1000);
        });

        // Find or create the floating marker
        let marker = routeContainer.querySelector('.vehicle-floating-marker');
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'vehicle-floating-marker';
            
            let emoji = '🚃';
            if (type === 'bus') emoji = '🚌';
            else if (type === 'tram') emoji = '🚋';
            else if (type === 'regional') emoji = '🚆';
            else if (type === 'express') emoji = '🚄';
            
            marker.textContent = emoji;
            marker.style.position = 'absolute';
            marker.style.zIndex = '15';
            marker.style.transform = 'translate(-50%, -50%)';
            marker.style.fontSize = '1.2rem';
            marker.style.pointerEvents = 'none';
            routeContainer.appendChild(marker);
        } else {
            let emoji = '🚃';
            if (type === 'bus') emoji = '🚌';
            else if (type === 'tram') emoji = '🚋';
            else if (type === 'regional') emoji = '🚆';
            else if (type === 'express') emoji = '🚄';
            marker.textContent = emoji;
        }

        function updatePosition() {
            if (!document.body.contains(routeContainer)) {
                return;
            }

            const nowMs = Date.now();
            let activeStopIdx = -1;
            let interpolationFraction = 0;

            if (nowMs <= stopTimes[0]) {
                activeStopIdx = 0;
                interpolationFraction = 0;
            } else if (nowMs >= stopTimes[stopTimes.length - 1]) {
                activeStopIdx = stopTimes.length - 1;
                interpolationFraction = 0;
            } else {
                for (let i = 0; i < stopTimes.length - 1; i++) {
                    if (nowMs >= stopTimes[i] && nowMs <= stopTimes[i+1]) {
                        activeStopIdx = i;
                        const duration = stopTimes[i+1] - stopTimes[i];
                        interpolationFraction = duration > 0 ? (nowMs - stopTimes[i]) / duration : 1;
                        break;
                    }
                }
            }

            // Update dot visual classes dynamically
            stopDoms.forEach((sDom, idx) => {
                const dotEl = sDom.querySelector('.stop-dot');
                if (dotEl) {
                    dotEl.classList.remove('current', 'passed', 'future');
                    if (idx < activeStopIdx) {
                        dotEl.classList.add('passed');
                    } else if (idx === activeStopIdx) {
                        dotEl.classList.add('current');
                    } else {
                        dotEl.classList.add('future');
                    }
                }
            });

            let targetTop, targetLeft;
            const dotCurrent = stopDoms[activeStopIdx].querySelector('.stop-dot');

            if (interpolationFraction === 0 || activeStopIdx === stopTimes.length - 1) {
                const coords = getRelativeOffset(dotCurrent, routeContainer);
                targetTop = coords.top + dotCurrent.offsetHeight / 2;
                targetLeft = coords.left + dotCurrent.offsetWidth / 2;
            } else {
                const dotNext = stopDoms[activeStopIdx + 1].querySelector('.stop-dot');
                const coordsCurrent = getRelativeOffset(dotCurrent, routeContainer);
                const coordsNext = getRelativeOffset(dotNext, routeContainer);

                const topCurrent = coordsCurrent.top + dotCurrent.offsetHeight / 2;
                const leftCurrent = coordsCurrent.left + dotCurrent.offsetWidth / 2;

                const topNext = coordsNext.top + dotNext.offsetHeight / 2;
                const leftNext = coordsNext.left + dotNext.offsetWidth / 2;

                targetTop = topCurrent + (topNext - topCurrent) * interpolationFraction;
                targetLeft = leftCurrent + (leftNext - leftCurrent) * interpolationFraction;
            }

            marker.style.top = targetTop + 'px';
            marker.style.left = targetLeft + 'px';

            const dotFirst = stopDoms[0].querySelector('.stop-dot');
            const coordsFirst = getRelativeOffset(dotFirst, routeContainer);
            const firstY = coordsFirst.top + dotFirst.offsetHeight / 2;

            const dotLast = stopDoms[stopDoms.length - 1].querySelector('.stop-dot');
            const coordsLast = getRelativeOffset(dotLast, routeContainer);
            const lastY = coordsLast.top + dotLast.offsetHeight / 2;

            const totalHeight = Math.max(0, lastY - firstY);

            const bgLine = routeContainer.querySelector('.journey-route-bg-line');
            if (bgLine) {
                bgLine.style.top = firstY + 'px';
                bgLine.style.height = totalHeight + 'px';
            }

            const progressBar = routeContainer.querySelector('.journey-route-progress');
            if (progressBar) {
                progressBar.style.top = firstY + 'px';
                progressBar.style.height = Math.max(0, targetTop - firstY) + 'px';
            }

            // Dynamically construct a gradient based on the lineColor of each stop
            const gradientParts = [];
            data.stops.forEach((stop, idx) => {
                const dot = stopDoms[idx].querySelector('.stop-dot');
                const coords = getRelativeOffset(dot, routeContainer);
                const y = coords.top + dot.offsetHeight / 2;
                const pct = totalHeight > 0 ? ((y - firstY) / totalHeight) * 100 : 0;
                const color = stop.lineColor || data.lineColor || 'var(--primary)';
                
                if (idx === 0) {
                    gradientParts.push(`${color} 0%`);
                }
                gradientParts.push(`${color} ${pct}%`);
                if (idx < data.stops.length - 1) {
                    const nextStop = data.stops[idx + 1];
                    const nextColor = nextStop.lineColor || data.lineColor || 'var(--primary)';
                    if (nextColor !== color) {
                        gradientParts.push(`${nextColor} ${pct}%`);
                    }
                }
            });
            const gradientStr = `linear-gradient(to bottom, ${gradientParts.join(', ')})`;

            if (bgLine) {
                bgLine.style.background = gradientStr;
                bgLine.style.backgroundSize = `100% ${totalHeight}px`;
                bgLine.style.backgroundPosition = 'top left';
            }
            if (progressBar) {
                progressBar.style.background = gradientStr;
                progressBar.style.backgroundSize = `100% ${totalHeight}px`;
                progressBar.style.backgroundPosition = 'top left';
                const activeColor = data.stops[activeStopIdx]?.lineColor || data.lineColor || 'var(--primary)';
                progressBar.style.boxShadow = `0 0 6px ${activeColor}`;
            }

            routeContainer._animationFrameId = requestAnimationFrame(updatePosition);
        }

        updatePosition();
    }

    function getLineColor(lineStr) {
        if (!lineStr) return 'var(--primary)';
        const clean = lineStr.replace('Linie', '').replace('Line', '').replace('Bus', '').replace('Str', '').replace('Tram', '').replace('Nachtbus', '').trim();
        return JS_LINE_COLORS[clean] || 'var(--primary)';
    }

    function getFormattedDateForOffset(baseDateStr, dayOffset = 0) {
        if (!baseDateStr) {
            const now = new Date();
            now.setDate(now.getDate() + dayOffset);
            const daysShort = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
            return `${daysShort[now.getDay()]} ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
        }
        try {
            let yr, mo, dy;
            if (baseDateStr.length === 8) {
                yr = parseInt(baseDateStr.substring(0, 4), 10);
                mo = parseInt(baseDateStr.substring(4, 6), 10) - 1;
                dy = parseInt(baseDateStr.substring(6, 8), 10);
            } else if (baseDateStr.includes('-')) {
                const parts = baseDateStr.split('-');
                yr = parseInt(parts[0], 10);
                mo = parseInt(parts[1], 10) - 1;
                dy = parseInt(parts[2], 10);
            } else {
                const now = new Date();
                now.setDate(now.getDate() + dayOffset);
                const daysShort = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
                return `${daysShort[now.getDay()]} ${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
            }
            const d = new Date(yr, mo, dy);
            d.setDate(d.getDate() + dayOffset);
            const daysShort = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];
            const dayName = daysShort[d.getDay()];
            const dayFormatted = String(d.getDate()).padStart(2, '0');
            const monthFormatted = String(d.getMonth() + 1).padStart(2, '0');
            return `${dayName} ${dayFormatted}.${monthFormatted}.${d.getFullYear()}`;
        } catch (e) {
            return '';
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
        timelineWrapper.setAttribute('role', 'region');
        timelineWrapper.setAttribute('aria-label', `Fahrverlauf Linie ${data.line}`);
        
        let currentLineColor = data.lineColor || 'var(--primary)';
        timelineWrapper.style.setProperty('--timeline-color', currentLineColor);

        const bgLineEl = document.createElement('div');
        bgLineEl.className = 'journey-route-bg-line';
        timelineWrapper.appendChild(bgLineEl);

        const progressEl = document.createElement('div');
        progressEl.className = 'journey-route-progress';
        timelineWrapper.appendChild(progressEl);

        let currentDayOffset = 0;

        stops.forEach((stop, idx) => {
            const stopOffset = stop.day_offset || 0;
            let isDayChange = false;

            if (idx > 0) {
                const prevStop = stops[idx - 1];
                const prevTime = prevStop.depTime || prevStop.arrTime || prevStop.time;
                const currTime = stop.depTime || stop.arrTime || stop.time;

                if (stopOffset > currentDayOffset || (currTime && prevTime && currTime < prevTime && stopOffset === currentDayOffset)) {
                    isDayChange = true;
                    if (stopOffset <= currentDayOffset) {
                        currentDayOffset = currentDayOffset + 1;
                    } else {
                        currentDayOffset = stopOffset;
                    }
                }
            } else {
                currentDayOffset = stopOffset;
            }

            if (isDayChange) {
                const dayDivider = document.createElement('div');
                dayDivider.className = 'day-change-divider';
                const formattedDate = getFormattedDateForOffset(data.date, currentDayOffset);
                dayDivider.innerHTML = `
                    <div class="day-change-badge">
                        📅 ${formattedDate ? formattedDate : `Neuer Tag (+${currentDayOffset} Tag${currentDayOffset > 1 ? 'e' : ''})`}
                    </div>
                `;
                timelineWrapper.appendChild(dayDivider);
            }

            // Update line color if there is a line transition on this stop or a valid non-generic stop line color
            if (stop.transitionLine) {
                const newColor = getLineColor(stop.transitionLine);
                currentLineColor = newColor !== 'var(--primary)' ? newColor : (data.transitionColor || currentLineColor);
            } else if (stop.lineColor && stop.lineColor !== '#8E8E93' && stop.lineColor !== '#5F7D95') {
                currentLineColor = stop.lineColor;
            }

            const stopEl = document.createElement('div');
            stopEl.className = 'journey-stop';
            if (idx === 0) stopEl.classList.add('first-stop');
            if (idx === stops.length - 1) stopEl.classList.add('last-stop');
            stopEl.style.setProperty('--i', idx);
            stopEl.style.setProperty('--timeline-color', currentLineColor);

            const timeArea = document.createElement('div');
            timeArea.className = 'stop-time-area';
            
            const hasArr = stop.arrTime;
            const hasDep = stop.depTime;
            
            if (hasArr && hasDep && stop.arrTime !== stop.depTime) {
                let arrDelayHtml = '';
                if (stop.arrDelay !== null && stop.arrDelay !== undefined && !stop.cancelled) {
                    if (stop.arrDelay > 0) arrDelayHtml = `<span class="stop-delay positive" style="font-size: 8px;">+${stop.arrDelay}</span>`;
                    else if (stop.arrDelay < 0) arrDelayHtml = `<span class="stop-delay early" style="font-size: 8px;">${stop.arrDelay}</span>`;
                    else arrDelayHtml = `<span class="stop-delay on-time" style="font-size: 8px;">pünktlich</span>`;
                }
                
                let depDelayHtml = '';
                if (stop.depDelay !== null && stop.depDelay !== undefined && !stop.cancelled) {
                    if (stop.depDelay > 0) depDelayHtml = `<span class="stop-delay positive" style="font-size: 8px;">+${stop.depDelay}</span>`;
                    else if (stop.depDelay < 0) depDelayHtml = `<span class="stop-delay early" style="font-size: 8px;">${stop.depDelay}</span>`;
                    else depDelayHtml = `<span class="stop-delay on-time" style="font-size: 8px;">pünktlich</span>`;
                }
                
                timeArea.innerHTML = `
                    <div style="display:flex; flex-direction:column; align-items:flex-end; line-height: 1.1; margin-bottom: 4px;">
                        <span class="stop-time" style="font-size: 11px; opacity: 0.85;">${stop.arrTime}</span>
                        ${arrDelayHtml}
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; line-height: 1.1;">
                        <span class="stop-time">${stop.depTime}</span>
                        ${depDelayHtml}
                    </div>
                `;
            } else {
                const displayTime = stop.depTime || stop.arrTime || stop.time || "00:00";
                const displayDelay = stop.depDelay !== null ? stop.depDelay : stop.arrDelay;
                
                let delayHtml = '';
                if (displayDelay !== null && displayDelay !== undefined && !stop.cancelled) {
                    if (displayDelay > 0) {
                        delayHtml = `<span class="stop-delay positive">+${displayDelay}</span>`;
                    } else if (displayDelay < 0) {
                        delayHtml = `<span class="stop-delay early">${displayDelay}</span>`;
                    } else {
                        delayHtml = `<span class="stop-delay on-time">pünktlich</span>`;
                    }
                }
                
                timeArea.innerHTML = `
                    <div class="stop-time">${displayTime}</div>
                    ${delayHtml}
                `;
            }
            stopEl.appendChild(timeArea);

            const dotArea = document.createElement('div');
            dotArea.className = 'stop-dot-area';
            
            const dot = document.createElement('div');
            dot.className = 'stop-dot';
            dot.style.setProperty('--timeline-color', currentLineColor);
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

            if (stop.transitionLine) {
                const badgeEl = document.createElement('div');
                badgeEl.className = 'stop-transition-badge';
                badgeEl.style.fontSize = '10px';
                badgeEl.style.fontWeight = '700';
                badgeEl.style.color = 'var(--text-primary)';
                badgeEl.style.background = 'rgba(255, 255, 255, 0.08)';
                badgeEl.style.backdropFilter = 'blur(8px)';
                badgeEl.style.borderLeft = `4px solid ${data.transitionColor || currentLineColor || 'var(--primary)'}`;
                badgeEl.style.padding = '3px 8px';
                badgeEl.style.marginTop = '6px';
                badgeEl.style.borderRadius = '4px';
                badgeEl.style.display = 'inline-flex';
                badgeEl.style.alignItems = 'center';
                badgeEl.style.gap = '4px';
                badgeEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
                badgeEl.textContent = `🔄 Verkehrt ab hier als ${stop.transitionLine}`;
                infoEl.appendChild(badgeEl);
            }

            if (stop.isRequestStop || stop.requestStopNote) {
                const reqBadgeEl = document.createElement('div');
                reqBadgeEl.className = 'stop-request-badge';
                reqBadgeEl.style.fontSize = '10px';
                reqBadgeEl.style.fontWeight = '700';
                reqBadgeEl.style.color = '#F0A500';
                reqBadgeEl.style.background = 'rgba(240, 165, 0, 0.12)';
                reqBadgeEl.style.backdropFilter = 'blur(8px)';
                reqBadgeEl.style.border = '1px solid rgba(240, 165, 0, 0.3)';
                reqBadgeEl.style.padding = '3px 8px';
                reqBadgeEl.style.marginTop = '4px';
                reqBadgeEl.style.borderRadius = '4px';
                reqBadgeEl.style.display = 'inline-flex';
                reqBadgeEl.style.alignItems = 'center';
                reqBadgeEl.style.gap = '4px';
                reqBadgeEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
                reqBadgeEl.innerHTML = `🙋 ${stop.requestStopNote || 'Halt bei Bedarf'}`;
                infoEl.appendChild(reqBadgeEl);
            }

            if (platformBadge) infoEl.innerHTML += platformBadge;
            stopEl.appendChild(infoEl);

            timelineWrapper.appendChild(stopEl);
        });

        routeContainer.appendChild(timelineWrapper);
        animateVehicleMarker(timelineWrapper, data.type, data);

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
        if (!isDesktopLayout() && detailsContent.style.display === 'flex' && activeJourneyData) {
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
            const url = `${API_BASE}/connections?origin=${encodeURIComponent(originId)}&destination=${encodeURIComponent(destId)}&date=${dateVal}&time=${timeVal}&tram=${allowedTransport.tram}&bus=${allowedTransport.bus}&regional=${allowedTransport.regional}&express=${allowedTransport.express}`;
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
        const originSuggestions = document.getElementById('originSuggestions');
        const destSuggestions = document.getElementById('destSuggestions');
        if (originSuggestions) originSuggestions.hidden = true;
        if (destSuggestions) destSuggestions.hidden = true;
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
                            
                            <button class="show-live-tracking-btn" data-jid="${leg.journey_id}" data-line="${leg.line}" data-dir="${leg.destination}" data-time="${leg.departure_time}" data-delay="${leg.departure_delay || 0}" data-color="${leg.lineColor || '#018e4a'}" style="background:none; border:none; color:var(--primary); font-size:11px; font-weight:600; cursor:pointer; padding: 4px 0; margin-top:4px; display:flex; align-items:center; gap:4px;">
                                🚃 Live-Verlauf &amp; Position
                            </button>
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
                if (e.target.closest('.show-live-tracking-btn')) return;
                toggleDetails();
            });

            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    if (e.target.closest('.show-live-tracking-btn')) return;
                    e.preventDefault();
                    toggleDetails();
                }
            });

            connectionsList.appendChild(card);
        });

        // Wire up live tracking buttons for connection legs
        document.querySelectorAll('.show-live-tracking-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent expanding/collapsing parent connection card
                const jid = btn.getAttribute('data-jid');
                const line = btn.getAttribute('data-line');
                const direction = btn.getAttribute('data-dir');
                const time = btn.getAttribute('data-time');
                const delay = parseInt(btn.getAttribute('data-delay') || '0', 10);
                const lineColor = btn.getAttribute('data-color');

                const journeyData = {
                    journey_id: jid,
                    line: line,
                    direction: direction,
                    time: time,
                    delay: delay,
                    lineColor: lineColor
                };

                handleItemSelection(journeyData);
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
                <span class="alert-time">🕒 ${alert.time || 'Aktuell'}</span>
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

    // Start PWA / Render cold start loading screen status message rotation
    const loadingStatusText = document.getElementById('loadingStatusText');
    if (loadingStatusText) {
        let elapsed = 0;
        loadingStatusInterval = setInterval(() => {
            elapsed += 2;
            if (elapsed === 6) {
                loadingStatusText.textContent = 'Server-Instanz wacht auf... (Das kann bis zu 50 Sek. dauern)';
            } else if (elapsed === 16) {
                loadingStatusText.textContent = 'Schnittstellen werden initialisiert...';
            } else if (elapsed === 26) {
                loadingStatusText.textContent = 'Fahrplan-Daten werden geladen...';
            } else if (elapsed === 36) {
                loadingStatusText.textContent = 'Bereitstellen des Live-Portals...';
            }
        }, 2000);
    }

    // Set the initial view to the Home Dashboard on load
    switchTab('home');
});
