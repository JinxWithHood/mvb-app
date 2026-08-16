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

    // Support Render static deployment fallback or custom backend URL
    const customApiUrl = localStorage.getItem('custom_api_url') || new URLSearchParams(window.location.search).get('api');
    if (customApiUrl) {
        localStorage.setItem('custom_api_url', customApiUrl);
    }
    
    let API_BASE = customApiUrl;
    if (!API_BASE) {
        if (isLocalEnv) {
            API_BASE = 'http://127.0.0.1:5000/api';
        } else if (window.location.hostname.includes('magdeburg-mobil.onrender.com')) {
            // magdeburg-mobil is a static frontend deployment, route API to active Python backend
            API_BASE = 'https://mvb-app.onrender.com/api';
        } else {
            API_BASE = '/api';
        }
    }

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
        // SEV lines (MVB Schienenersatzverkehr)
        '40': '#FF6F00',
        '41': '#B22052',
        '42': '#5566A4',
        '43': '#F5D300',
        '44': '#7FC600',
        '45': '#BA832C',
        '46': '#6E3B90',
        '47': '#E70097',
        '48': '#F0A500',
        '49': '#006651',
        // Bus lines
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
        // S-Bahn
        'S1': '#00975F',
        'S':  '#00975F',
        // HSB
        'HSB': '#8B0000',
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
    let currentStation = { id: '7393', name: 'Magdeburg, Hauptbahnhof/Willy-Brandt-Platz' };
    let originStation = null;
    let destStation = null;
    
    let activeFilters = {
        all: true,
        tram: false,
        bus: false,
        sbahn: false,
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
        sbahn: true,
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

    // Alerts & Traffic Hub Result List
    const alertsList = document.getElementById('alertsList');
    const alertsLoading = document.getElementById('alertsLoading');
    const alertsStatusTitle = document.getElementById('alertsStatusTitle');
    const alertsStatusSubtitle = document.getElementById('alertsStatusSubtitle');
    const statusIndicatorDot = document.getElementById('statusIndicatorDot');
    const refreshAlertsBtn = document.getElementById('refreshAlertsBtn');
    const alertsPushCard = document.getElementById('alertsPushCard');
    const pushStatusIcon = document.getElementById('pushStatusIcon');
    const pushStatusHeadline = document.getElementById('pushStatusHeadline');
    const pushStatusSubline = document.getElementById('pushStatusSubline');
    const togglePushBtn = document.getElementById('togglePushBtn');
    const testPushBtn = document.getElementById('testPushBtn');
    const alertsSearchInput = document.getElementById('alertsSearchInput');
    const clearAlertsSearch = document.getElementById('clearAlertsSearch');
    const alertChipBtns = document.querySelectorAll('.alert-chip-btn');
    const countAll = document.getElementById('countAll');
    const countTram = document.getElementById('countTram');
    const countBus = document.getElementById('countBus');
    const countCritical = document.getElementById('countCritical');



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

    function triggerJinxExplosion() {
        if (!isJinxUnlocked) {
            isJinxUnlocked = true;
            localStorage.setItem('jinx_unlocked', 'true');
        }

        // 1. Screenshake on entire app container
        appContainer.classList.remove('jinx-screenshake');
        void appContainer.offsetWidth; // trigger reflow
        appContainer.classList.add('jinx-screenshake');
        setTimeout(() => appContainer.classList.remove('jinx-screenshake'), 750);

        // 2. Mobile Haptic Vibration
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate([100, 50, 200, 50, 300]);
            } catch (e) {}
        }

        // 3. Shockwave & Glitch Explosion Overlay
        const explosion = document.createElement('div');
        explosion.className = 'jinx-explosion-overlay';
        explosion.innerHTML = `
            <div class="jinx-shockwave-ring"></div>
            <div class="jinx-explosion-burst">💣💥</div>
        `;
        document.body.appendChild(explosion);
        setTimeout(() => explosion.remove(), 850);

        // 4. Flash Screen Overlay
        const flash = document.createElement('div');
        flash.className = 'jinx-flash-overlay';
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 600);

        // 5. Apply Jinx Theme
        applyTheme('jinx');
        showToast('💣💥 BOOM! Jinx Secret aktiviert! 💥💣', 'success');
    }

    function triggerJinxUnlock(forceToggle = false) {
        triggerJinxExplosion();
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

    // Secret Input Listener (Works on Mobile Keyboard, Desktop Typing & Paste!)
    document.addEventListener('input', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            const val = e.target.value || '';
            const clean = val.toLowerCase().replace(/[\s\-_]/g, '');
            if (clean.includes('jinxwithhoodistderbeste')) {
                e.target.value = '';
                e.target.blur();
                triggerJinxExplosion();
            }
        }
    });

    // Secret Typing-Only Listener (Physical Keyboard)
    window.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();

        // Secret input / typing check in search inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            const val = (e.target.value || '').toLowerCase().replace(/[\s\-_]/g, '');
            if (val.includes('jinxwithhoodistderbeste')) {
                triggerJinxExplosion();
                e.target.value = '';
                e.target.blur();
            }
            return;
        }

        keyBuffer += key;
        if (keyBuffer.length > 30) keyBuffer = keyBuffer.slice(-30);

        if (keyBuffer.includes('jinxwithhoodistderbeste')) {
            keyBuffer = '';
            triggerJinxExplosion();
        }
    });

    applyTheme(currentTheme);

    // -----------------------------------------------------------------------
    // Helper Functions
    // -----------------------------------------------------------------------
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    const MVB_OFFICIAL_LINE_COLORS = {
        '1': '#B22052', '2': '#5566A4', '3': '#F5D300', '4': '#7FC600',
        '5': '#BA832C', '6': '#6E3B90', '8': '#F0A500', '9': '#006651',
        '10': '#2796B6', '13': '#3A4136', '15': '#B22052',
        '51': '#5566A4', '52': '#F0A500', '53': '#F5D300', '54': '#7FC600',
        '55': '#BA832C', '56': '#E1C700', '57': '#E70097', '58': '#008B8B',
        '59': '#006651', '61': '#2796B6', '66': '#B13507', '69': '#6E3B90',
        '71': '#CC1F2F', '72': '#006EB7', '73': '#3A4136', 'KVG9': '#ADB9A6',
        'N1': '#B22052', 'N2': '#6E3B90', 'N3': '#CC1F2F', 'N4': '#007757',
        'N5': '#F5D300', 'N6': '#F0A500', 'N7': '#2796B6', 'N8': '#C7066E',
        'N9': '#E73F0C', 'S1': '#008037'
    };

    function makeTransitPillHtml(lineKey) {
        const c = MVB_OFFICIAL_LINE_COLORS[lineKey] || '#5566A4';
        const isLight = ['3', '8', '52', '53', '54', '56', 'KVG9', 'N5', 'N6'].includes(lineKey);
        const textColor = isLight ? '#111827' : '#ffffff';
        const shadow = isLight ? 'none' : '0 1px 2px rgba(0,0,0,0.4)';

        let icon = '🚋';
        let name = `Linie ${lineKey}`;
        if (lineKey.startsWith('N')) {
            icon = '🌙';
            name = `Nachtlinie ${lineKey}`;
        } else if (lineKey === 'S1') {
            icon = '🚆';
            name = 'S1';
        } else if (/^\d+$/.test(lineKey) && parseInt(lineKey, 10) >= 50) {
            icon = '🚌';
            name = `Linie ${lineKey}`;
        }

        return ` <span class="transit-pill" style="background-color:${c}; color:${textColor} !important; text-shadow:${shadow}; padding:2px 8px; border-radius:12px; font-weight:700; font-size:0.88em; display:inline-flex; align-items:center; gap:4px;">${icon} ${name}</span> `;
    }

    function formatTransitText(rawStr) {
        if (!rawStr) return '';
        let text = escapeHtml(rawStr);

        // 1. Spacing fixes for glued words and punctuation
        text = text.replace(/([a-zäöüß])([A-ZÄÖÜ])/g, '$1 $2');
        text = text.replace(/(\.)([A-ZÄÖÜ])/g, '$1 $2');
        text = text.replace(/(\d+)\.([A-Za-zÄÖÜäöü])/g, '$1. $2');
        text = text.replace(/\s+([,.:;])/g, '$1');
        text = text.replace(/\s+/g, ' ').trim();

        // 2. Semantic Emojis without duplicate repetitions
        text = text.replace(/\b(Haltestelle|Haltestellen)\b/g, '🚏 $1');
        text = text.replace(/\b(Hauptbahnhof)\b/g, '🚉 $1');
        text = text.replace(/\b(Elbauenpark)\b/g, '🌳 $1');
        text = text.replace(/\b(Arenen|AVNET-Arena|MDCC-Arena|Getec-Arena)\b/g, '🏟️ $1');
        text = text.replace(/\b(Fußballspiel\s+(?:1\.\s*FC\s+Magdeburg|FCM)|Fußballspiel|1\.\s*FC\s+Magdeburg|FCM)\b/g, '⚽ $1');
        text = text.replace(/^(Anreise\b|Hinfahrt\b)/g, '🟢 <strong>$1</strong>');
        text = text.replace(/^(Abreise\b|Rückfahrt\b)/g, '🔴 <strong>$1</strong>');

        // 3. MVB Line Badges with authentic colors
        text = text.replace(/\b(Linien?|Bussen?|Bus|Nachtlinien?|Nachtlinie|Str\.)\s+([0-9NKVG,\sund/–-]+)\b/g, (match, prefix, nums) => {
            const tokens = nums.split(/(\d+|N\d+|KVG\d+|und|,|\s+)/);
            const res = [];
            for (const tok of tokens) {
                const t = tok.trim();
                if (MVB_OFFICIAL_LINE_COLORS[t]) {
                    res.push(makeTransitPillHtml(t));
                } else if (t) {
                    res.push(tok);
                }
            }
            return res.join('');
        });

        text = text.replace(/\b(?:S-Bahn\s+)?S1\b/g, makeTransitPillHtml('S1'));

        // 4. Punctuation and spacing cleanup
        text = text.replace(/\s+([,.:;])/g, '$1');
        text = text.replace(/([,.:;])([^\s\d<])/g, '$1 $2');
        text = text.replace(/\.{2,}/g, '.');
        text = text.replace(/\.\s*\./g, '.');
        return text.replace(/\s+/g, ' ').trim();
    }

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

        // 1. HSB (Harzer Schmalspurbahnen / Brockenbahn) FIRST to prevent 'bahn' match!
        if (opLower.includes('hsb') || opLower.includes('harzer') || opLower.includes('brocken') || opLower.includes('selketal') || opLower.includes('harzquer')) {
            const badge = document.createElement('div');
            badge.className = 'operator-badge hsb-badge';
            badge.innerHTML = '<span class="op-icon">🚂</span> <span>HSB</span>';
            container.appendChild(badge);
            return;
        }

        if (opLower.includes('mvb') || opLower.includes('magdeburg')) {
            logoSrc = 'logo_mvb.png';
            altText = 'MVB';
        } else if (opLower === 'db' || opLower.includes('deutsche bahn') || opLower.includes('db regio') || opLower.includes('db fernverkehr') || opLower.includes('dostgo') || opLower.includes('s-bahn mitte') || opLower.includes('db start')) {
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

    function isMvbTram(type, line, operator) {
        if (type !== 'tram') return false;
        const op = (operator || '').toLowerCase();
        if (op && !op.includes('mvb') && !op.includes('magdeburg')) return false;
        return true;
    }

    function isMvbLine40to49(lineStr, operatorStr) {
        if (!lineStr) return false;
        const op = (operatorStr || 'MVB').toLowerCase();
        if (!op.includes('mvb') && !op.includes('magdeburg')) return false;
        const digits = lineStr.replace(/\D/g, '');
        return Boolean(digits && parseInt(digits, 10) >= 40 && parseInt(digits, 10) <= 49);
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
                if (targetTabId === 'news') {
                    if (typeof closeNewsReader === 'function') closeNewsReader();
                    fetchNews();
                }
            }, 120);
        } else {
            targetPanel.hidden = false;
            targetPanel.classList.add('fade-in');
            if (targetTabId === 'news') {
                if (typeof closeNewsReader === 'function') closeNewsReader();
                fetchNews();
            }
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
            if (targetTab === 'alerts' || targetTab === 'tickets' || targetTab === 'news') {
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
        {"id": "7306", "name": "Magdeburg, Sudenburg, Braunlager Str."},
        {"id": "7308", "name": "Magdeburg, Sudenburg, Kroatenweg"},
        {"id": "7449", "name": "Magdeburg, Reform"},
        {"id": "7423", "name": "Magdeburg, Neustädter See"},
        {"id": "7454", "name": "Magdeburg, Buckau Wasserwerk"},
        {"id": "7320", "name": "Magdeburg, Diesdorf"},
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
                activeFilters.sbahn = false;
                activeFilters.regional = false;
            } else {
                activeFilters.all = false;
                activeFilters[filterType] = !activeFilters[filterType];

                const filterKeys = ['tram', 'bus', 'sbahn', 'regional'];
                const activeCount = filterKeys.filter(k => activeFilters[k]).length;
                if (activeCount === 0 || activeCount === filterKeys.length) {
                    activeFilters.all = true;
                    activeFilters.tram = false;
                    activeFilters.bus = false;
                    activeFilters.sbahn = false;
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
            if (!activeFilters.all) {
                const lineLower = (dep.line || '').toLowerCase();
                const isTram = (dep.type === 'tram');
                const isBus = (dep.type === 'bus' || dep.type === 'sev' || dep.isSEV);
                const isSbahn = (dep.type === 'sbahn' || lineLower.startsWith('s1') || lineLower.startsWith('s-bahn') || lineLower.startsWith('s 1'));
                const isRegio = (dep.type === 'regional' || dep.type === 'express' || dep.type === 'hsb');

                if (activeFilters.tram && isTram) return true;
                if (activeFilters.bus && isBus) return true;
                if (activeFilters.sbahn && isSbahn) return true;
                if (activeFilters.regional && isRegio) return true;
                return false;
            }
            
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

            const lineLower = (dep.line || '').toLowerCase().trim();
            const isSbahn = (dep.type === 'sbahn' || lineLower.startsWith('s-bahn') || /^s\s*\d+/.test(lineLower)) && !lineLower.startsWith('str') && !lineLower.startsWith('tram');
            const isHsb = (dep.type === 'hsb' || dep.operator === 'HSB' || lineLower.includes('hsb') || lineLower.includes('brocken'));
            const isSev = (dep.type === 'sev' || dep.isSEV);

            let badgeExtraClass = '';
            let lineIconHtml = '';
            if (isSbahn) {
                badgeExtraClass = 'sbahn-badge';
                lineIconHtml = '<span class="sbahn-symbol">S</span>';
            } else if (isHsb) {
                badgeExtraClass = 'hsb-badge';
                lineIconHtml = '<span class="hsb-icon">🚂</span>';
            }

            let sevTagHtml = '';
            if (isSev) {
                const sevLabel = dep.sevInfo || 'Schienenersatzverkehr';
                sevTagHtml = `<span class="departure-sev-tag" style="font-size:10px; font-weight:700; color:#FF6F00; background:rgba(255,111,0,0.12); padding:1px 5px; border-radius:3px; border:1px solid rgba(255,111,0,0.3); margin-left:6px;" title="${sevLabel}">🚌 SEV</span>`;
            }

            card.innerHTML = `
                <div class="line-badge ${textClass} ${badgeExtraClass}" style="background-color: ${dep.lineColor || '#018e4a'}">
                    ${lineIconHtml ? `${lineIconHtml} ` : ''}${dep.line}
                </div>
                <div class="departure-info">
                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; min-width:0;">
                        <span class="departure-direction">${dep.direction}</span>
                        ${sevTagHtml}
                    </div>
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

        const cleanLineName = dep.line || '';
        const titlePrefix = cleanLineName.toLowerCase().startsWith('linie') ? '' : 'Linie ';
        detailsTitle.textContent = `${titlePrefix}${cleanLineName}`;
        detailsSubtitle.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        detailsLineBadge.textContent = cleanLineName;
        detailsLineBadge.style.backgroundColor = dep.lineColor || '#018e4a';
        detailsLineBadge.classList.toggle('dark-text', luminance > 180);

        const targetId = dep.card_journey_id || dep.journey_id;

        const loadDetails = async (isQuiet = false) => {
            try {
                const queryParams = `journey_id=${encodeURIComponent(dep.journey_id)}&line=${encodeURIComponent(dep.line)}&direction=${encodeURIComponent(dep.direction)}&time=${encodeURIComponent(dep.time)}&delay=${encodeURIComponent(dep.delay || 0)}&station_name=${encodeURIComponent(currentStation.name)}&_=${Date.now()}`;
                const res = await fetch(`${API_BASE}/journey?${queryParams}`);
                const data = await res.json();
                
                if (activeJourneyData && (activeJourneyData.card_journey_id || activeJourneyData.journey_id) === targetId) {
                    if (data.line) {
                        const finalLine = data.line;
                        const pfx = finalLine.toLowerCase().startsWith('linie') ? '' : 'Linie ';
                        detailsTitle.textContent = `${pfx}${finalLine}`;
                        detailsLineBadge.textContent = finalLine;
                    }
                    if (data.lineColor) {
                        detailsLineBadge.style.backgroundColor = data.lineColor;
                        const lum = getLuminance(data.lineColor);
                        detailsLineBadge.classList.toggle('dark-text', lum > 180);
                    }
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

        const cleanLineName = dep.line || '';
        const titlePrefix = cleanLineName.toLowerCase().startsWith('linie') ? '' : 'Linie ';
        journeyModalTitle.textContent = `${titlePrefix}${cleanLineName}`;
        modalDirection.textContent = `Richtung ${dep.direction}`;

        const luminance = getLuminance(dep.lineColor);
        modalLineBadge.textContent = cleanLineName;
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
                if (data.line) {
                    const finalLine = data.line;
                    const pfx = finalLine.toLowerCase().startsWith('linie') ? '' : 'Linie ';
                    journeyModalTitle.textContent = `${pfx}${finalLine}`;
                    modalLineBadge.textContent = finalLine;
                }
                if (data.lineColor) {
                    modalLineBadge.style.backgroundColor = data.lineColor;
                    const lum = getLuminance(data.lineColor);
                    modalLineBadge.classList.toggle('dark-text', lum > 180);
                }
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
            marker.style.position = 'absolute';
            marker.style.zIndex = '15';
            marker.style.transform = 'translate(-50%, -50%)';
            marker.style.pointerEvents = 'none';
            routeContainer.appendChild(marker);
        }

        const opStr = (data.operator || '').toLowerCase();
        const lineStr = (data.line || '').toLowerCase();
        const isHsb = (data.operator === 'HSB' || type === 'hsb' || lineStr.includes('hsb') || lineStr.includes('brocken') || opStr.includes('harzer'));
        
        // Distinguish Magdeburg MVB trams from other cities (e.g. Halle/HAVAG, Leipzig/LVB, Berlin/BVG)
        const isOtherCityOp = opStr.includes('havag') || opStr.includes('halle') || opStr.includes('lvb') || opStr.includes('bvg') || opStr.includes('berlin') || opStr.includes('dvb') || opStr.includes('dresden') || opStr.includes('evag') || opStr.includes('erfurt') || opStr.includes('jena') || opStr.includes('potsdam') || opStr.includes('cottbus');
        
        let hasOtherCityStop = false;
        if (data.stops && data.stops.length > 0) {
            hasOtherCityStop = data.stops.some(s => {
                const sn = (s.name || '').toLowerCase();
                // Exclude Magdeburger streets named after other cities (Leipziger Str., Hallesche Str., Berliner Chaussee, Dresdener Str.)
                if (sn.includes('leipziger') || sn.includes('hallesche') || sn.includes('berliner') || sn.includes('dresdener')) {
                    return false;
                }
                return sn.includes('halle (') || sn.includes('halle,') || sn.includes('leipzig,') || sn.includes('leipzig hbf') || sn.includes('berlin,') || sn.includes('berlin hbf') || sn.includes('dresden,') || sn.includes('erfurt,') || sn.includes('jena,') || sn.includes('potsdam,') || sn.includes('cottbus,');
            });
        }

        const isMvbTramLine = ['1', '2', '3', '4', '5', '6', '8', '9', '10', '13'].some(l => lineStr.replace(/\D/g, '') === l);
        const isExplicitMvb = opStr.includes('mvb') || opStr.includes('magdeburg');
        const isMvbTram = (type === 'tram' && !isOtherCityOp && !hasOtherCityStop && (isExplicitMvb || isMvbTramLine || !opStr));
        const isMvbBus = ((type === 'bus' || type === 'sev' || data.isSEV) && !isOtherCityOp && !hasOtherCityStop && (isExplicitMvb || !opStr || ['51', '52', '53', '54', '56', '57', '58', '59', '61', '66', '69', '71', '72', '73', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49'].some(l => lineStr.replace(/\D/g, '') === l)));
        const isSbahn = (type === 'sbahn' || lineStr.startsWith('s1') || lineStr.startsWith('s-bahn') || lineStr.startsWith('s 1')) && !lineStr.startsWith('str') && !lineStr.startsWith('tram');
        const isSev = (type === 'sev' || data.isSEV || lineStr.startsWith('sev'));

        if (isMvbTram) {
            marker.className = 'vehicle-floating-marker tram-mvb-marker';
            marker.innerHTML = '<img src="assets/tram_mvb.png" alt="MVB Straßenbahn" class="vehicle-marker-img">';
            marker.style.fontSize = '';
        } else if (isMvbBus) {
            marker.className = 'vehicle-floating-marker bus-mvb-marker';
            marker.innerHTML = '<img src="assets/bus_mvb.png" alt="MVB Bus" class="vehicle-marker-img">';
            marker.style.fontSize = '';
        } else if (isHsb) {
            marker.className = 'vehicle-floating-marker hsb-marker';
            marker.textContent = '🚂';
            marker.style.fontSize = '1.3rem';
        } else if (isSbahn) {
            marker.className = 'vehicle-floating-marker sbahn-marker';
            marker.innerHTML = '<span class="sbahn-marker-circle">S</span>';
            marker.style.fontSize = '';
        } else if (isSev) {
            marker.className = 'vehicle-floating-marker sev-marker';
            marker.textContent = '🚌';
            marker.style.fontSize = '1.2rem';
        } else if (type === 'tram') {
            marker.className = 'vehicle-floating-marker';
            marker.textContent = '🚋';
            marker.style.fontSize = '1.3rem';
        } else if (type === 'bus') {
            marker.className = 'vehicle-floating-marker';
            marker.textContent = '🚌';
            marker.style.fontSize = '1.2rem';
        } else if (type === 'express') {
            marker.className = 'vehicle-floating-marker';
            marker.textContent = '🚄';
            marker.style.fontSize = '1.2rem';
        } else {
            marker.className = 'vehicle-floating-marker';
            marker.textContent = '🚆';
            marker.style.fontSize = '1.2rem';
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

    function formatRequestStopHtml(note, stopName, operatorName, lineName) {
        const opLower = (operatorName || 'MVB').toLowerCase();
        const lineLower = (lineName || '').toLowerCase();
        const isMvb = opLower.includes('mvb') || opLower.includes('magdeburg') || lineLower.startsWith('str') || lineLower.startsWith('tram') || lineLower.startsWith('n');

        // For MVB (or any city line), passenger demand stops do NOT require phone booking/registration
        if (isMvb || !note || note === 'Halt bei Bedarf' || (!note.includes('039') && !note.includes('Tel') && !note.includes('tel'))) {
            return `
                <div class="stop-request-badge simple">
                    <span>🙋</span>
                    <span>Halt bei Bedarf</span>
                </div>
            `;
        }

        let text = note;
        // Clean stop name in parens from end
        text = text.replace(/\s*\([^)]*\)\s*$/, '').trim();

        // Extract phone number (only for regional carriers)
        const phoneMatch = text.match(/(?:Tel\.?:?\s*)?(\+?49[0-9\s/-]{6,}|0[1-9][0-9\s/-]{6,})/i);
        let phoneNumber = null;
        let cleanPhone = null;
        if (phoneMatch) {
            phoneNumber = phoneMatch[1].trim();
            cleanPhone = phoneNumber.replace(/[\s/-]/g, '');
        }

        if (!cleanPhone) {
            return `
                <div class="stop-request-badge simple">
                    <span>🙋</span>
                    <span>Halt bei Bedarf</span>
                </div>
            `;
        }

        // Extract booking deadline notice
        let advanceNotice = 'Bis 1 Std. vor Fahrtbeginn';
        if (/bis\s*30\s*min/i.test(text)) {
            advanceNotice = 'Bis 30 Min. vor Abfahrt';
        } else if (/bis\s*1\s*(?:h|std)/i.test(text)) {
            advanceNotice = 'Bis 1 Std. vor Abfahrt';
        } else if (/bis\s*2\s*std/i.test(text)) {
            advanceNotice = 'Bis 2 Std. vor Abfahrt';
        }

        let earlyNotice = '';
        if (/vor\s*8:?00|19-8\s*uhr|am\s*vortag/i.test(text)) {
            earlyNotice = 'Fahrten vor 8:00 Uhr: Vorabend bis 18:00 Uhr anmelden';
        }

        return `
            <div class="request-stop-card">
                <div class="request-stop-header">
                    <span class="req-icon">🙋</span>
                    <span class="req-title">Regionaler Rufbus</span>
                </div>
                <div class="request-stop-body">
                    <div class="req-row">
                        <span class="req-label">⏱️ Voranmeldung:</span>
                        <span class="req-val">${advanceNotice}</span>
                    </div>
                    <div class="req-row">
                        <span class="req-label">📞 Rufbus:</span>
                        <a href="tel:${cleanPhone}" class="req-phone-btn" onclick="event.stopPropagation();">
                            <span>📞 ${phoneNumber}</span>
                        </a>
                    </div>
                    ${earlyNotice ? `
                    <div class="req-row req-hint">
                        <span>🌙 ${earlyNotice}</span>
                    </div>` : ''}
                </div>
            </div>
        `;
    }

    function renderStopsTimelineHTML(data, routeContainer, messagesContainer, animate = true) {
        routeContainer.innerHTML = '';
        messagesContainer.innerHTML = '';

        if (data.isSEV || data.type === 'sev' || data.sev_info) {
            const sevText = data.sev_info || 'Schienenersatzverkehr';
            const sevDiv = document.createElement('div');
            sevDiv.className = 'alert-card glass-card sev-info-banner';
            sevDiv.style.borderLeft = '3px solid #FF6F00';
            sevDiv.style.background = 'rgba(255, 111, 0, 0.12)';
            sevDiv.style.padding = '8px 12px';
            sevDiv.style.marginBottom = '12px';
            sevDiv.style.borderRadius = 'var(--radius-sm)';
            sevDiv.innerHTML = `
                <div style="font-size:var(--font-size-sm); display:flex; gap:6px; align-items:center; font-weight:700; color:#FF6F00;">
                    <span>🚌</span>
                    <span>${sevText}</span>
                </div>
            `;
            messagesContainer.appendChild(sevDiv);
        }

        if (data.messages && data.messages.length > 0) {
            data.messages.forEach(msg => {
                if (data.sev_info && msg.text && msg.text.includes(data.sev_info)) return;
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
                badgeEl.style.fontSize = '11px';
                badgeEl.style.fontWeight = '700';
                badgeEl.style.color = 'var(--text-primary)';
                badgeEl.style.background = 'rgba(255, 255, 255, 0.08)';
                badgeEl.style.backdropFilter = 'blur(8px)';
                badgeEl.style.borderLeft = `4px solid ${data.transitionColor || currentLineColor || 'var(--primary)'}`;
                badgeEl.style.padding = '4px 10px';
                badgeEl.style.marginTop = '6px';
                badgeEl.style.borderRadius = '4px';
                badgeEl.style.display = 'inline-flex';
                badgeEl.style.alignItems = 'center';
                badgeEl.style.gap = '6px';
                badgeEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
                const dirText = stop.transitionDirection ? ` in Richtung ${stop.transitionDirection}` : '';
                badgeEl.textContent = `🔄 Verkehrt ab hier als ${stop.transitionLine}${dirText}`;
                infoEl.appendChild(badgeEl);
            }

            if (stop.isRequestStop || stop.requestStopNote) {
                const reqWrapper = document.createElement('div');
                reqWrapper.innerHTML = formatRequestStopHtml(stop.requestStopNote, stop.name, data.operator, data.line);
                infoEl.appendChild(reqWrapper);
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
            const url = `${API_BASE}/connections?origin=${encodeURIComponent(originId)}&destination=${encodeURIComponent(destId)}&date=${dateVal}&time=${timeVal}&tram=${allowedTransport.tram}&bus=${allowedTransport.bus}&sbahn=${allowedTransport.sbahn}&regional=${allowedTransport.regional}&express=${allowedTransport.express}`;
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
                let legLabel = leg.type === 'walk' ? '🚶' : leg.line;
                if (leg.type === 'sbahn') legLabel = `🟢 ${leg.line}`;
                else if (leg.type === 'hsb') legLabel = `🚂 ${leg.line}`;
                else if (leg.type === 'sev' || leg.isSEV) legLabel = `🚌 ${leg.line}`;
                
                legsPreviewHtml += `
                    <div style="flex: 1; background-color: ${styleColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight:700; border-right:1px solid var(--bg-primary); padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
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

                    const lineLower = (leg.line || '').toLowerCase();
                    const isSbahn = (leg.type === 'sbahn' || lineLower.startsWith('s1') || lineLower.startsWith('s-bahn') || lineLower.startsWith('s 1'));
                    const isHsb = (leg.type === 'hsb' || lineLower.includes('hsb') || lineLower.includes('brocken'));
                    const isSev = (leg.type === 'sev' || leg.isSEV || leg.line.toUpperCase().startsWith('SEV'));

                    let badgeIcon = '';
                    let badgeClass = '';
                    if (isSbahn) {
                        badgeClass = 'sbahn-badge';
                        badgeIcon = '<span class="sbahn-symbol">S</span> ';
                    } else if (isHsb) {
                        badgeClass = 'hsb-badge';
                        badgeIcon = '🚂 ';
                    } else if (isSev) {
                        badgeClass = 'sev-badge';
                        badgeIcon = '🚌 ';
                    }
                    
                    detailRow = `
                        <div class="connection-leg transit-leg" style="--leg-color: ${leg.lineColor || 'var(--primary)'}">
                            <div class="leg-departure">
                                <span class="leg-time">${leg.departure_time}</span>
                                <span class="leg-station"><strong>${leg.origin}</strong></span>
                                ${delayHtml}
                            </div>
                            <div class="leg-line-info">
                                <span class="leg-line-badge ${textClass} ${badgeClass}" style="background-color: ${leg.lineColor}">${badgeIcon}${leg.line}</span>
                                <span class="leg-direction">Richtung ${leg.destination}</span>
                                ${leg.platform ? `<span class="stop-platform-badge" style="margin-left:8px;">${formatPlatform(leg.platform)}</span>` : ''}
                            </div>
                            <div class="leg-arrival">
                                <span class="leg-time">${leg.arrival_time}</span>
                                <span class="leg-station">${leg.destination}</span>
                            </div>
                            
                            <button class="show-live-tracking-btn" data-jid="${leg.journey_id}" data-line="${leg.line}" data-dir="${leg.destination}" data-time="${leg.departure_time}" data-delay="${leg.departure_delay || 0}" data-color="${leg.lineColor || '#018e4a'}" style="background:none; border:none; color:var(--primary); font-size:11px; font-weight:600; cursor:pointer; padding: 4px 0; margin-top:4px; display:flex; align-items:center; gap:4px;">
                                ${isMvbTram(leg.type, leg.line) ? '🚋' : (isHsb ? '🚂' : (isSbahn ? '🟢' : (isSev ? '🚌' : '🚆')))} Live-Verlauf &amp; Position
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
    // Disruptions & Verkehrsmelder Engine with Fixed Push Architecture
    // -----------------------------------------------------------------------
    let rawDisruptionsData = [];
    let currentDisruptionFilter = 'all';
    let currentDisruptionQuery = '';
    let knownDisruptionIds = new Set(JSON.parse(localStorage.getItem('knownDisruptions') || '[]'));
    let pushEnabled = (localStorage.getItem('mvb_push_enabled') === 'true') && ('Notification' in window && Notification.permission === 'granted');
    let pushBannerDismissed = localStorage.getItem('mvb_push_banner_dismissed') === 'true';
    const dismissPushBtn = document.getElementById('dismissPushBtn');

    function updatePushStatusUI() {
        if (!('Notification' in window)) {
            if (alertsPushCard) alertsPushCard.style.display = 'none';
            return;
        }

        if (pushBannerDismissed || pushEnabled) {
            if (alertsPushCard) alertsPushCard.classList.add('dismissed');
        } else {
            if (alertsPushCard) alertsPushCard.classList.remove('dismissed');
        }

        const perm = Notification.permission;
        if (perm === 'granted') {
            if (pushEnabled) {
                if (pushStatusIcon) pushStatusIcon.textContent = '🔔';
                if (pushStatusHeadline) pushStatusHeadline.textContent = 'Push-Benachrichtigungen aktiv';
                if (pushStatusSubline) pushStatusSubline.textContent = 'Du wirst automatisch bei neuen Störungen und Sperrungen im MVB-Netz benachrichtigt.';
                if (togglePushBtn) {
                    togglePushBtn.textContent = '🔕 Deaktivieren';
                    togglePushBtn.className = 'btn-push-toggle active';
                }
                if (testPushBtn) testPushBtn.style.display = 'inline-flex';
                if (alertsPushCard) alertsPushCard.classList.remove('disabled');
            } else {
                if (pushStatusIcon) pushStatusIcon.textContent = '🔕';
                if (pushStatusHeadline) pushStatusHeadline.textContent = 'Push-Benachrichtigungen pausiert';
                if (pushStatusSubline) pushStatusSubline.textContent = 'Benachrichtigungen sind vorübergehend stummgeschaltet.';
                if (togglePushBtn) {
                    togglePushBtn.textContent = '🔔 Aktivieren';
                    togglePushBtn.className = 'btn-push-toggle';
                }
                if (testPushBtn) testPushBtn.style.display = 'none';
                if (alertsPushCard) alertsPushCard.classList.add('disabled');
            }
        } else if (perm === 'denied') {
            if (pushStatusIcon) pushStatusIcon.textContent = '🚫';
            if (pushStatusHeadline) pushStatusHeadline.textContent = 'Benachrichtigungen blockiert';
            if (pushStatusSubline) pushStatusSubline.textContent = 'Berechtigung im Browser verweigert. Erlaube Benachrichtigungen im Seitenschloss der Adressleiste.';
            if (togglePushBtn) {
                togglePushBtn.textContent = '⚙️ Einstellungen';
                togglePushBtn.className = 'btn-push-toggle active';
            }
            if (testPushBtn) testPushBtn.style.display = 'none';
            if (alertsPushCard) alertsPushCard.classList.add('disabled');
        } else {
            // default
            if (pushStatusIcon) pushStatusIcon.textContent = '🔔';
            if (pushStatusHeadline) pushStatusHeadline.textContent = 'Push-Benachrichtigungen aktivieren';
            if (pushStatusSubline) pushStatusSubline.textContent = 'Erhalte sofort eine Info auf dein Gerät bei Streckensperrungen & SEV.';
            if (togglePushBtn) {
                togglePushBtn.textContent = '🔔 Aktivieren';
                togglePushBtn.className = 'btn-push-toggle';
            }
            if (testPushBtn) testPushBtn.style.display = 'none';
            if (alertsPushCard) alertsPushCard.classList.remove('disabled');
        }
    }

    if (dismissPushBtn) {
        dismissPushBtn.addEventListener('click', () => {
            pushBannerDismissed = true;
            localStorage.setItem('mvb_push_banner_dismissed', 'true');
            if (alertsPushCard) alertsPushCard.classList.add('dismissed');
        });
    }

    if (togglePushBtn) {
        togglePushBtn.addEventListener('click', () => {
            if (!('Notification' in window)) {
                showToast('Dein Browser unterstützt keine Push-Benachrichtigungen.', 'warning');
                return;
            }

            if (Notification.permission === 'granted') {
                pushEnabled = true;
                pushBannerDismissed = true;
                localStorage.setItem('mvb_push_enabled', 'true');
                localStorage.setItem('mvb_push_banner_dismissed', 'true');
                updatePushStatusUI();
                showToast('Push-Benachrichtigungen aktiviert! 🔔', 'success');
            } else if (Notification.permission === 'denied') {
                showToast('Benachrichtigungen sind im Browser blockiert. Bitte in den Browsereinstellungen freigeben.', 'warning');
            } else {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        pushEnabled = true;
                        pushBannerDismissed = true;
                        localStorage.setItem('mvb_push_enabled', 'true');
                        localStorage.setItem('mvb_push_banner_dismissed', 'true');
                        // Seed all existing disruption IDs so we NEVER trigger false new alert on activation!
                        rawDisruptionsData.forEach(item => {
                            if (item.id) knownDisruptionIds.add(item.id);
                        });
                        localStorage.setItem('knownDisruptions', JSON.stringify(Array.from(knownDisruptionIds)));
                        updatePushStatusUI();
                        showToast('Push-Benachrichtigungen erfolgreich aktiviert! 🎉', 'success');
                    } else {
                        updatePushStatusUI();
                        showToast('Benachrichtigungen wurden nicht aktiviert.', 'warning');
                    }
                });
            }
        });
    }

    if (testPushBtn) {
        testPushBtn.addEventListener('click', () => {
            if ('Notification' in window && Notification.permission === 'granted') {
                try {
                    new Notification('🚨 Test: MVB Verkehrsmelder', {
                        body: 'Push-Benachrichtigungen funktionieren einwandfrei! Du wirst bei echten Störungen rechtzeitig informiert.',
                        icon: 'assets/tram_mvb.png'
                    });
                } catch (e) {
                    console.warn('Test push error:', e);
                }
            }
            showToast('Test-Benachrichtigung gesendet! 🔔', 'success');
        });
    }

    if (refreshAlertsBtn) {
        refreshAlertsBtn.addEventListener('click', () => {
            fetchDisruptions(false);
            showToast('Verkehrsmelder aktualisiert', 'info');
        });
    }

    // Search and Category Chips
    if (alertsSearchInput) {
        alertsSearchInput.addEventListener('input', (e) => {
            currentDisruptionQuery = (e.target.value || '').trim().toLowerCase();
            if (clearAlertsSearch) clearAlertsSearch.hidden = !currentDisruptionQuery;
            applyDisruptionsFilter();
        });
    }

    if (clearAlertsSearch) {
        clearAlertsSearch.addEventListener('click', () => {
            if (alertsSearchInput) alertsSearchInput.value = '';
            currentDisruptionQuery = '';
            clearAlertsSearch.hidden = true;
            applyDisruptionsFilter();
        });
    }

    alertChipBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            alertChipBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDisruptionFilter = btn.getAttribute('data-filter') || 'all';
            applyDisruptionsFilter();
        });
    });

    function updateCategoryCounts(alerts) {
        let allC = alerts.length, tramC = 0, busC = 0, critC = 0;
        alerts.forEach(a => {
            const t = (a.title + ' ' + a.desc + ' ' + (a.lines || []).join(' ')).toLowerCase();
            const isTram = t.includes('str') || t.includes('tram') || t.includes('bahn') || (a.lines || []).some(l => {
                const d = parseInt(l.replace(/\D/g, ''), 10);
                return d >= 1 && d <= 13;
            });
            const isBus = t.includes('bus') || t.includes('sev') || t.includes('ersatzverkehr') || (a.lines || []).some(l => {
                const d = parseInt(l.replace(/\D/g, ''), 10);
                return (d >= 40 && d <= 73) || l.toLowerCase().includes('n');
            });
            const isCrit = a.critical || t.includes('sperrung') || t.includes('ausfall') || t.includes('gesperrt');

            if (isTram) tramC++;
            if (isBus) busC++;
            if (isCrit) critC++;
        });

        if (countAll) countAll.textContent = allC;
        if (countTram) countTram.textContent = tramC;
        if (countBus) countBus.textContent = busC;
        if (countCritical) countCritical.textContent = critC;
    }

    function updateHubStatus(alerts) {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} Uhr`;
        if (alertsStatusSubtitle) alertsStatusSubtitle.textContent = `Stand: Heute, ${timeStr}`;

        if (!alerts.length) {
            if (alertsStatusTitle) alertsStatusTitle.textContent = 'Freie Fahrt im gesamten Netz';
            if (statusIndicatorDot) {
                statusIndicatorDot.className = 'status-indicator-dot';
            }
            return;
        }

        const hasCritical = alerts.some(a => a.critical);
        const sevCount = alerts.filter(a => (a.title + a.desc).toLowerCase().includes('sev') || (a.title + a.desc).toLowerCase().includes('ersatzverkehr')).length;
        
        let statusSummary = `${alerts.length} ${alerts.length === 1 ? 'Meldung' : 'Meldungen'} im MVB-Netz`;
        if (sevCount > 0) {
            statusSummary += ` (${sevCount}x SEV)`;
        }

        if (alertsStatusTitle) alertsStatusTitle.textContent = statusSummary;
        if (statusIndicatorDot) {
            statusIndicatorDot.className = hasCritical ? 'status-indicator-dot danger' : 'status-indicator-dot warning';
        }
    }

    function applyDisruptionsFilter() {
        if (!alertsList) return;
        alertsList.innerHTML = '';

        let filtered = rawDisruptionsData.filter(a => {
            const t = (a.title + ' ' + a.desc + ' ' + (a.lines || []).join(' ')).toLowerCase();
            
            // Search text match
            if (currentDisruptionQuery && !t.includes(currentDisruptionQuery)) {
                return false;
            }

            // Category match
            if (currentDisruptionFilter === 'tram') {
                return t.includes('str') || t.includes('tram') || t.includes('bahn') || (a.lines || []).some(l => {
                    const d = parseInt(l.replace(/\D/g, ''), 10);
                    return d >= 1 && d <= 13;
                });
            } else if (currentDisruptionFilter === 'bus') {
                return t.includes('bus') || t.includes('sev') || t.includes('ersatzverkehr') || (a.lines || []).some(l => {
                    const d = parseInt(l.replace(/\D/g, ''), 10);
                    return (d >= 40 && d <= 73) || l.toLowerCase().includes('n');
                });
            } else if (currentDisruptionFilter === 'critical') {
                return a.critical || t.includes('sperrung') || t.includes('ausfall') || t.includes('gesperrt');
            }
            return true;
        });

        if (!filtered.length) {
            alertsList.innerHTML = `
                <div class="empty-state glass-card" style="text-align:center; padding: var(--space-6);">
                    <span style="font-size:3rem; display:block; margin-bottom:12px;">🔍</span>
                    <p style="font-weight:600; color:var(--text-primary);">Keine passenden Meldungen gefunden</p>
                    <p style="font-size:var(--font-size-sm); color:var(--text-secondary); margin-top:4px;">Versuche andere Suchbegriffe oder wähle die Kategorie „Alle“.</p>
                </div>
            `;
            return;
        }

        filtered.forEach((alert, idx) => {
            const card = document.createElement('div');
            card.className = 'alert-card';
            if (alert.critical) card.classList.add('critical');
            card.style.setProperty('--i', idx);

            const criticalBadge = alert.critical 
                ? '<span class="alert-critical-badge">🚨 Sperrung / Kritisch</span>'
                : '';

            let linesHtml = '';
            let hasSevLine = false;
            if (alert.lines && alert.lines.length > 0) {
                alert.lines.forEach(lineStr => {
                    const cleanLine = lineStr.replace('Linie', '').replace('Line', '').replace('Bus', '').replace('Str', '').replace('Tram', '').replace('SEV', '').trim();
                    if (cleanLine) {
                        const digits = cleanLine.replace(/\D/g, '');
                        const isMvbSev = digits && parseInt(digits, 10) >= 40 && parseInt(digits, 10) <= 49;
                        if (isMvbSev) hasSevLine = true;

                        let badgeLabel = cleanLine;
                        let extraClass = '';
                        if (isMvbSev) {
                            badgeLabel = `🚌 SEV ${digits}`;
                            extraClass = 'sev-alert-badge';
                        } else if (cleanLine.toLowerCase().startsWith('s1') || cleanLine.toLowerCase().startsWith('s')) {
                            badgeLabel = `🟢 ${cleanLine}`;
                        } else if (cleanLine.toLowerCase().includes('hsb') || cleanLine.toLowerCase().includes('brocken')) {
                            badgeLabel = `🚂 ${cleanLine}`;
                        }

                        const lineColor = JS_LINE_COLORS[digits] || JS_LINE_COLORS[cleanLine] || '#888888';
                        const textClass = getLuminance(lineColor) > 180 ? 'dark-text' : '';
                        linesHtml += `<span class="alert-line-badge ${textClass} ${extraClass}" style="background-color: ${lineColor}">${badgeLabel}</span>`;
                    }
                });
            }

            const sevBadge = hasSevLine || (alert.title && (alert.title.includes('SEV') || alert.title.includes('Schienenersatzverkehr'))) || (alert.desc && (alert.desc.includes('SEV') || alert.desc.includes('Schienenersatzverkehr')))
                ? '<span class="alert-sev-tag">🚌 Schienenersatzverkehr (SEV)</span>'
                : '';

            card.innerHTML = `
                <div class="alert-card-header">
                    <h4 class="alert-title">${alert.title}</h4>
                    <div class="alert-badges-wrapper">
                        ${sevBadge}
                        ${criticalBadge}
                    </div>
                </div>
                <p class="alert-description">${alert.desc}</p>
                <div class="alert-card-footer">
                    <div class="alert-lines">${linesHtml}</div>
                    <div class="alert-footer-meta">
                        <span class="alert-time">🕒 ${alert.time || 'Aktuell'}</span>
                        <button class="alert-copy-btn" title="Meldung kopieren" aria-label="Meldung kopieren">📋 Kopieren</button>
                    </div>
                </div>
            `;

            const copyBtn = card.querySelector('.alert-copy-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    const textToCopy = `${alert.title}\n\n${alert.desc}\n(Quelle: MVB Verkehrsmelder / Magdeburg Mobil)`;
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(textToCopy).then(() => {
                            showToast('Meldung in Zwischenablage kopiert! 📋', 'success');
                        });
                    }
                });
            }

            alertsList.appendChild(card);
        });
    }

    async function fetchDisruptions(silent = false) {
        if (!silent) {
            alertsLoading.hidden = false;
            alertsList.innerHTML = '';
        }

        try {
            const res = await fetch(`${API_BASE}/disruptions`);
            const data = await res.json();
            
            alertsLoading.hidden = true;
            rawDisruptionsData = data.filter(a => a.title && a.desc);

            // Seed known IDs so we never alert on existing items
            rawDisruptionsData.forEach(item => {
                if (item.id) knownDisruptionIds.add(item.id);
            });
            localStorage.setItem('knownDisruptions', JSON.stringify(Array.from(knownDisruptionIds)));

            updateCategoryCounts(rawDisruptionsData);
            updateHubStatus(rawDisruptionsData);
            applyDisruptionsFilter();

            if (alertBadgeMobile) {
                alertBadgeMobile.textContent = rawDisruptionsData.length;
                alertBadgeMobile.hidden = rawDisruptionsData.length === 0;
            }
            if (headerAlertBadge) {
                headerAlertBadge.textContent = rawDisruptionsData.length;
                headerAlertBadge.hidden = rawDisruptionsData.length === 0;
            }
        } catch (err) {
            console.error('Meldungsfehler:', err);
            alertsLoading.hidden = true;
            if (!silent) {
                alertsList.innerHTML = '<div class="error-card glass-card">Meldungen konnten nicht geladen werden.</div>';
            }
        }
    }

    async function checkNewDisruptionsBackground() {
        try {
            const res = await fetch(`${API_BASE}/disruptions/check`);
            const data = await res.json();
            
            const fetchedIds = data.ids || [];
            if (!fetchedIds.length) return;

            // If knownDisruptionIds is empty (e.g. storage cleared), just seed it without spamming
            if (knownDisruptionIds.size === 0) {
                fetchedIds.forEach(id => knownDisruptionIds.add(id));
                localStorage.setItem('knownDisruptions', JSON.stringify(Array.from(knownDisruptionIds)));
                return;
            }

            // Check for truly brand-new IDs
            const brandNewIds = fetchedIds.filter(id => !knownDisruptionIds.has(id));

            if (brandNewIds.length > 0) {
                brandNewIds.forEach(id => knownDisruptionIds.add(id));
                localStorage.setItem('knownDisruptions', JSON.stringify(Array.from(knownDisruptionIds)));
                
                // Fetch full data silently to refresh view
                const fullRes = await fetch(`${API_BASE}/disruptions`);
                const fullData = await fullRes.json();
                
                rawDisruptionsData = fullData.filter(a => a.title && a.desc);
                updateCategoryCounts(rawDisruptionsData);
                updateHubStatus(rawDisruptionsData);
                applyDisruptionsFilter();

                if (alertBadgeMobile) {
                    alertBadgeMobile.textContent = rawDisruptionsData.length;
                    alertBadgeMobile.hidden = rawDisruptionsData.length === 0;
                }
                if (headerAlertBadge) {
                    headerAlertBadge.textContent = rawDisruptionsData.length;
                    headerAlertBadge.hidden = rawDisruptionsData.length === 0;
                }

                // Fire notification ONLY if push is actively enabled
                if (pushEnabled && ('Notification' in window) && Notification.permission === 'granted') {
                    const newestAlert = rawDisruptionsData.find(a => brandNewIds.includes(a.id));
                    const notificationTitle = newestAlert ? newestAlert.title : 'Neue Störungsmeldung';
                    const notificationBody = newestAlert ? newestAlert.desc.substring(0, 120) + '...' : 'Details im Verkehrsmelder';
                    
                    try {
                        new Notification('🚨 MVB Störungsmeldung', {
                            body: `${notificationTitle}\n${notificationBody}`,
                            icon: 'assets/tram_mvb.png'
                        });
                    } catch (e) {
                        console.warn('Push error:', e);
                    }
                    showToast(`🚨 Neue Störung: ${notificationTitle}`, 'critical');
                }
            }
        } catch (err) {
            console.warn('Hintergrundcheck Fehler:', err);
        }
    }

    updatePushStatusUI();
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

    // -----------------------------------------------------------------------
    // MVB Aktuelles & News Stream Engine (https://www.mvbnet.de/aktuelles/)
    // -----------------------------------------------------------------------
    let rawNewsData = [];
    let newsFetchedOnce = false;

    const newsFeedView = document.getElementById('newsFeedView');
    const newsReaderView = document.getElementById('newsReaderView');
    const newsList = document.getElementById('newsList');
    const newsLoading = document.getElementById('newsLoading');
    const newsEmpty = document.getElementById('newsEmpty');
    const refreshNewsBtn = document.getElementById('refreshNewsBtn');

    const newsReaderBackBtn = document.getElementById('newsReaderBackBtn');
    const newsReaderBottomBackBtn = document.getElementById('newsReaderBottomBackBtn');
    const newsReaderOriginalLink = document.getElementById('newsReaderOriginalLink');
    const newsReaderLoading = document.getElementById('newsReaderLoading');
    const newsReaderArticle = document.getElementById('newsReaderArticle');
    const newsReaderHeroMedia = document.getElementById('newsReaderHeroMedia');
    const newsReaderHeroImg = document.getElementById('newsReaderHeroImg');
    const newsReaderDate = document.getElementById('newsReaderDate');
    const newsReaderTitle = document.getElementById('newsReaderTitle');
    const newsReaderBody = document.getElementById('newsReaderBody');

    function closeNewsReader() {
        if (newsReaderView) newsReaderView.hidden = true;
        if (newsFeedView) newsFeedView.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (newsReaderBackBtn) newsReaderBackBtn.addEventListener('click', closeNewsReader);
    if (newsReaderBottomBackBtn) newsReaderBottomBackBtn.addEventListener('click', closeNewsReader);

    // Keyboard navigation: Escape key closes article reader
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && newsReaderView && !newsReaderView.hidden) {
            closeNewsReader();
        }
    });

    async function openNewsArticle(item) {
        if (!newsReaderView || !newsFeedView) return;

        // Switch views
        newsFeedView.hidden = true;
        newsReaderView.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Set initial header info
        if (newsReaderTitle) newsReaderTitle.textContent = item.title || 'Meldung';
        if (newsReaderDate) newsReaderDate.textContent = `📅 ${item.date || 'Aktuell'}`;
        if (newsReaderOriginalLink) newsReaderOriginalLink.href = item.link || 'https://www.mvbnet.de/aktuelles/';

        // Hero image
        if (item.image && newsReaderHeroImg && newsReaderHeroMedia) {
            newsReaderHeroImg.src = item.image;
            newsReaderHeroImg.alt = item.title || 'MVB Foto';
            newsReaderHeroMedia.hidden = false;
        } else if (newsReaderHeroMedia) {
            newsReaderHeroMedia.hidden = true;
        }

        // Show loading skeleton while fetching full text
        if (newsReaderLoading) newsReaderLoading.hidden = false;
        if (newsReaderBody) {
            newsReaderBody.innerHTML = item.teaser ? `<p><em>${escapeHtml(item.teaser)}</em></p>` : '';
        }

        try {
            let articleData = null;
            try {
                const resp = await fetch(`${API_BASE}/news/article?url=${encodeURIComponent(item.link)}&_=${Date.now()}`);
                if (resp.ok) {
                    articleData = await resp.json();
                }
            } catch (err) {
                const fallbackResp = await fetch(`/api/news/article?url=${encodeURIComponent(item.link)}&_=${Date.now()}`);
                if (fallbackResp.ok) {
                    articleData = await fallbackResp.json();
                }
            }

            if (articleData && articleData.content_html) {
                if (newsReaderBody) {
                    newsReaderBody.innerHTML = articleData.content_html;
                }
                if (articleData.image && newsReaderHeroImg && newsReaderHeroMedia) {
                    newsReaderHeroImg.src = articleData.image;
                    newsReaderHeroMedia.hidden = false;
                }
            } else if (item.teaser && newsReaderBody) {
                newsReaderBody.innerHTML = `<p>${escapeHtml(item.teaser)}</p><p>Vollständiger Text wird geladen...</p>`;
            }
        } catch (e) {
            console.warn('Error fetching full article content:', e);
            if (newsReaderBody && item.teaser) {
                newsReaderBody.innerHTML = `<p>${escapeHtml(item.teaser)}</p><p><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">Auf mvbnet.de weiterlesen ↗</a></p>`;
            }
        } finally {
            if (newsReaderLoading) newsReaderLoading.hidden = true;
        }
    }

    async function fetchNews(forceRefresh = false) {
        if (newsFetchedOnce && !forceRefresh && rawNewsData.length > 0) {
            renderNewsFeed(rawNewsData);
            return;
        }

        if (newsLoading) newsLoading.hidden = false;
        if (newsList) newsList.style.display = 'none';
        if (newsEmpty) newsEmpty.hidden = true;

        try {
            let data = null;
            try {
                const resp = await fetch(`${API_BASE}/news?_=${Date.now()}`);
                if (resp.ok) {
                    data = await resp.json();
                }
            } catch (err) {
                const fallbackResp = await fetch(`/api/news?_=${Date.now()}`);
                if (fallbackResp.ok) {
                    data = await fallbackResp.json();
                }
            }

            if (data && Array.isArray(data) && data.length > 0) {
                rawNewsData = data;
            } else {
                throw new Error('No news returned');
            }

            newsFetchedOnce = true;
            renderNewsFeed(rawNewsData);
        } catch (e) {
            console.warn('Error fetching live MVB news, loading static backup:', e);
            rawNewsData = [
                {
                    id: "fb_1",
                    title: "Zum Schulbeginn: so fahren Bus und Bahn",
                    link: "https://www.mvbnet.de/zum-schulbeginn-so-fahren-bus-und-bahn/",
                    date: "13. August 2026",
                    image: "https://www.mvbnet.de//files/2026/08/230626_Olvenstedter8-846x400.jpg",
                    teaser: "Am 17. August beginnt das neue Schuljahr und einige Umleitungen werden beendet sein. Die MVB geben einen Überblick der Änderungen und Linienanpassungen.",
                    category: "Fahrplan & Verkehr"
                },
                {
                    id: "fb_2",
                    title: "„Malle“ und Fußball: An- und Abreise mit zusätzlichen Straßenbahnen",
                    link: "https://www.mvbnet.de/malle-und-fussball-an-und-abreise-mit-zusaetzlichen-strassenbahnen/",
                    date: "4. August 2026",
                    image: "https://www.mvbnet.de//files/2026/08/070822_1.FCM_MVB7-846x400.jpg",
                    teaser: "Am Samstag findet das Mega-Malle-Festival im Elbauenpark statt. Zur An- und Abreise verstärkt die MVB den Straßenbahntakt mit Sonderzügen.",
                    category: "Events & Freizeit"
                },
                {
                    id: "fb_3",
                    title: "Besondere Aussichten: Doppeldecker fährt bei CSD-Demonstration mit",
                    link: "https://www.mvbnet.de/besondere-aussichten-doppeldecker-faehrt-bei-csd-demonstration-mit-3/",
                    date: "4. August 2026",
                    image: "https://www.mvbnet.de//files/2024/08/CSD_Demo_MD_2022-7-846x400.jpg",
                    teaser: "Unter dem Motto „WÄHL Liebe“ setzt der CSD in Magdeburg ein Zeichen. Zum vierten Mal fährt der rote Doppeldeckerbus der MVB im Demonstrationszug mit.",
                    category: "Events & Freizeit"
                },
                {
                    id: "fb_4",
                    title: "Haltestelle Domplatz wird zum „Platz für alle“",
                    link: "https://www.mvbnet.de/haltestelle-domplatz-wird-zum-platz-fuer-alle/",
                    date: "31. Juli 2026",
                    image: "https://www.mvbnet.de//files/2026/07/310726_MVB_CSD1-846x400.jpg",
                    teaser: "Anlässlich des Christopher Street Days in Magdeburg gestaltet die MVB die Straßenbahnhaltestelle Domplatz für einen Monat in Regenbogenfarben.",
                    category: "Events & Freizeit"
                },
                {
                    id: "fb_5",
                    title: "MVB startet neue Mobilitäts-App als Testversion",
                    link: "https://www.mvbnet.de/mvb-startet-neue-mobilitaets-app-als-testversion/",
                    date: "28. Juli 2026",
                    image: "https://www.mvbnet.de//files/2026/07/mockup2-mvb-app-846x400.jpg",
                    teaser: "Die Magdeburger Verkehrsbetriebe bündeln Fahrplanauskunft, Ticketkauf und Serviceangebote in einer neuen modernen Mobilitäts-App.",
                    category: "Digital & Service"
                },
                {
                    id: "fb_6",
                    title: "Gewinnaktion: Pyro Games 2026",
                    link: "https://www.mvbnet.de/gewinnaktion-pyro-games-2026/",
                    date: "24. Juli 2026",
                    image: "https://www.mvbnet.de//files/2026/07/Medium-Rectangel-Pyro-MD26-MVB-300x250px2.jpg",
                    teaser: "Wenn der Himmel über dem Elbauenpark in leuchtenden Farben erstrahlt und Feuerwerk zu einer Show verschmilzt: Jetzt Freikarten gewinnen!",
                    category: "Aktion & Tickets"
                }
            ];
            renderNewsFeed(rawNewsData);
        } finally {
            if (newsLoading) newsLoading.hidden = true;
            if (newsList) newsList.style.display = 'grid';
        }
    }

    function renderNewsFeed(items) {
        if (!newsList) return;
        newsList.innerHTML = '';

        if (!items || items.length === 0) {
            if (newsEmpty) newsEmpty.hidden = false;
            return;
        }

        if (newsEmpty) newsEmpty.hidden = true;

        items.forEach(item => {
            const card = document.createElement('article');
            card.className = 'news-card glass-card';
            card.style.cursor = 'pointer';

            const hasImg = !!item.image;
            const imgMarkup = hasImg
                ? `<div class="news-card-media">
                     <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" class="news-card-img" loading="lazy" onerror="this.parentElement.classList.add('no-image'); this.style.display='none';">
                   </div>`
                : `<div class="news-card-media no-image"></div>`;

            card.innerHTML = `
                ${imgMarkup}
                <div class="news-card-body">
                  <div class="news-card-meta">
                    <span class="news-card-date">📅 ${escapeHtml(item.date)}</span>
                    <span class="news-card-source">mvbnet.de</span>
                  </div>
                  <h3 class="news-card-title">
                    <span class="news-title-link">${formatTransitText(item.title)}</span>
                  </h3>
                  <p class="news-card-teaser">${formatTransitText(item.teaser)}</p>
                  <div class="news-card-footer">
                    <button class="news-read-more-btn" aria-label="Artikel ${escapeHtml(item.title)} in der App lesen">
                      <span>📖 In der App lesen</span> <span class="arrow-icon" aria-hidden="true">→</span>
                    </button>
                  </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                e.preventDefault();
                openNewsArticle(item);
            });

            newsList.appendChild(card);
        });
    }

    if (refreshNewsBtn) {
        refreshNewsBtn.addEventListener('click', () => {
            fetchNews(true);
            showToast('Meldungen aktualisiert 📰', 'info');
        });
    }

    // Automatic Live Background Polling for New MVB News (every 3 minutes)
    setInterval(() => {
        if (newsFetchedOnce) {
            fetch(`${API_BASE}/news?_=${Date.now()}`)
                .then(r => r.ok ? r.json() : null)
                .then(latestNews => {
                    if (Array.isArray(latestNews) && latestNews.length > 0) {
                        const topNew = latestNews[0];
                        const topOld = rawNewsData[0];
                        if (topOld && topNew.id !== topOld.id) {
                            rawNewsData = latestNews;
                            renderNewsFeed(rawNewsData);
                            showToast('Neue MVB-Meldung eingetroffen 📰', 'info');
                        }
                    }
                })
                .catch(() => {});
        }
    }, 180000);

    // Also re-check when the user returns to the tab
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && newsFetchedOnce) {
            fetch(`${API_BASE}/news?_=${Date.now()}`)
                .then(r => r.ok ? r.json() : null)
                .then(latestNews => {
                    if (Array.isArray(latestNews) && latestNews.length > 0) {
                        const topNew = latestNews[0];
                        const topOld = rawNewsData[0];
                        if (topOld && topNew.id !== topOld.id) {
                            rawNewsData = latestNews;
                            renderNewsFeed(rawNewsData);
                        }
                    }
                })
                .catch(() => {});
        }
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

    // Dismiss fullscreen loading screen smoothly once initialization is complete
    setTimeout(() => {
        hideLoadingScreen();
    }, 200);
});
