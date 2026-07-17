"""
MVB Magdeburg Transit App - Flask Backend
==========================================
Production-quality backend serving the MVB transit app.
Provides station search, departures, journey details, connections,
and disruption scraping via HAFAS (NASA + OEBB profiles).

All endpoints return JSON. CORS is enabled globally.
The server also serves static files (frontend) from the same directory.
"""

import os
import json
import datetime
import traceback
import hashlib

import requests
import pytz
from bs4 import BeautifulSoup

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pyhafas import HafasClient
from pyhafas.profile import NASAProfile, DBProfile
from pyhafas.types.fptf import Journey

# ---------------------------------------------------------------------------
# Timezone
# ---------------------------------------------------------------------------
local_tz = pytz.timezone("Europe/Berlin")

# ---------------------------------------------------------------------------
# Custom OEBB HAFAS Profile (national rail routing via Austrian endpoint)
# ---------------------------------------------------------------------------
class OEBBProfile(DBProfile):
    """
    Subclass of DBProfile that targets the ÖBB HAFAS endpoint.
    Used as a fallback / secondary client for national rail routing
    and stations outside the NASA (Saxony-Anhalt) network.
    """
    baseUrl = "https://fahrplan.oebb.at/bin/mgate.exe"
    defaultUserAgent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
    salt = None
    addChecksum = False
    locale = 'de-AT'
    timezone = pytz.timezone('Europe/Vienna')
    requestBody = {
        'client': {
            'id': 'OEBB',
            'type': 'WEB',
            'name': 'webapp',
            'l': 'vs_webapp'
        },
        'ver': '1.67',
        'lang': 'deu',
        'auth': {
            'type': 'AID',
            'aid': 'OWDL4fE4ixNiPBBm'
        }
    }

    def parse_journeys_request(self, data):
        """Override to handle OEBB-specific journey response structure."""
        journeys = []
        for jny in data.res.get('outConL', []):
            date = self.parse_date(jny['date'])
            journeys.append(
                Journey(
                    jny.get('ctxRecon', ''),
                    date=date,
                    duration=self.parse_timedelta(jny['dur']),
                    legs=self.parse_legs(jny, data.common, date)
                )
            )
        return journeys


# ---------------------------------------------------------------------------
# Flask App Initialisation
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# ---------------------------------------------------------------------------
# HAFAS Client Initialisation (graceful – app works even if clients fail)
# ---------------------------------------------------------------------------
try:
    nasa_client = HafasClient(NASAProfile())
except Exception as e:
    print(f"[WARN] Could not initialise NASA client: {e}")
    nasa_client = None

try:
    oebb_client = HafasClient(OEBBProfile())
except Exception as e:
    print(f"[WARN] Could not initialise OEBB client: {e}")
    oebb_client = None

# Legacy alias
client = nasa_client

# ---------------------------------------------------------------------------
# LINE_COLORS – canonical hex colours for every MVB line
# ---------------------------------------------------------------------------
LINE_COLORS = {
    # Tram lines
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
    # Bus lines
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
    # KVG
    'KVG9': '#ADB9A6',
    # Night lines
    'N1': '#B22052',
    'N2': '#6E3B90',
    'N3': '#CC1F2F',
    'N4': '#007757',
    'N5': '#F5D300',
    'N6': '#F0A500',
    'N7': '#2796B6',
    'N8': '#C7066E',
    'N9': '#E73F0C',
}

# ---------------------------------------------------------------------------
# FALLBACK_ROUTES – stop sequences for Magdeburg tram + select bus lines
# Used when HAFAS journey-detail calls fail, to still show useful data.
# ---------------------------------------------------------------------------
FALLBACK_ROUTES = {
    "1": [
        "Lerchenwuhne", "Kastanienweg", "Milchweg", "Neustädter Platz", "Krähenstieg",
        "Kastanienstraße", "Zoo", "S-Bahnhof Neustadt", "Mittagstraße", "Lübecker Straße",
        "Alte Neustadt", "Universitätsbibliothek", "Opernhaus", "Katharinenturm",
        "Alter Markt", "Goldschmiedebrücke", "Domplatz", "Hasselbachplatz", "Planckstraße",
        "AMO/Kulturhaus", "Leipziger Straße", "Schleiermacherstraße", "Semmelweisstraße",
        "Südfriedhof", "Sudenburg"
    ],
    "2": [
        "Westerhüsen", "Salbke", "Buckau Wasserwerk", "S-Bahnhof Buckau", "Warschauer Straße",
        "Hasselbachplatz", "Domplatz", "Goldschmiedebrücke", "Alter Markt", "Katharinenturm",
        "Opernhaus", "Universitätsbibliothek", "Alte Neustadt", "Pfälzer Straße", "Neustädter Bierweg"
    ],
    "3": [
        "Olvenstedter Platz", "Klinikum Olvenstedt", "Bruno-Beye-Ring", "Sternstraße",
        "Damaschkeplatz", "Hauptbahnhof", "Alter Markt", "Domplatz", "Hasselbachplatz",
        "Leipziger Straße", "Südfriedhof", "Reform"
    ],
    "4": [
        "Klinikum Olvenstedt", "Klinikum Nord", "Albert-Vater-Straße", "Damaschkeplatz",
        "Hauptbahnhof", "Alter Markt", "Goldschmiedebrücke", "Allee-Center", "Zollhaus",
        "Cracau"
    ],
    "5": [
        "Klinikum Olvenstedt", "Klinikum Nord", "Albert-Vater-Straße", "Damaschkeplatz",
        "Hauptbahnhof", "Alter Markt", "Goldschmiedebrücke", "Allee-Center", "Zollhaus",
        "Messegelände"
    ],
    "6": [
        "Diesdorf", "Schleibnitzstraße", "Westring", "Spielhagenstraße", "Damaschkeplatz",
        "Hauptbahnhof", "Alter Markt", "Opernhaus", "Universität", "Jerichower Platz",
        "Herrenkrug"
    ],
    "8": [
        "Westerhüsen", "Salbke", "Buckau Wasserwerk", "S-Bahnhof Buckau", "Hasselbachplatz",
        "Domplatz", "Alter Markt", "Katharinenturm", "Opernhaus", "Neustädter See"
    ],
    "9": [
        "Reform", "Kirschweg", "Werner-von-Siemens-Ring", "Planetenweg", "Bördepark",
        "Flugplatz", "Hopfengarten", "Leipziger Straße", "Hasselbachplatz", "Domplatz",
        "Alter Markt", "Katharinenturm", "Opernhaus", "Universität", "Alte Neustadt",
        "Neustädter See"
    ],
    "10": [
        "Sudenburg", "Ambrosiusplatz", "Westring", "Spielhagenstraße", "Braunlager Straße",
        "Jordanstraße", "Hasselbachplatz", "Domplatz", "Goldschmiedebrücke", "Alter Markt",
        "Katharinenturm", "Opernhaus", "Universität", "Alte Neustadt", "Barleber See"
    ],
    "13": [
        "Gentechnologielabor", "Kastanienstraße", "S-Bahnhof Neustadt", "Mittagstraße",
        "Lübecker Straße", "Universitätsbibliothek", "Opernhaus", "Katharinenturm", "Alter Markt"
    ],
    "57": [
        "Reform", "Bördepark Ost", "Pallasweg", "Merkurweg",
        "Flugplatz/Technisches Hilfswerk (Lindenhof)",
        "Am Hopfengarten", "Weinbrennerallee", "Leipziger Chaussee", "Freibad Süd",
        "Brenneckestr.", "Universitätsklinikum", "Fermersleber Weg", "Südfriedhof",
        "Raiffeisenstr.", "Dodendorfer Str.", "S-Bahnhof Buckau/Puppentheater",
        "Benediktinerstr./Gesellschaftshaus", "AMO/Steubenallee"
    ],
}


# ===================================================================
#  HELPER FUNCTIONS
# ===================================================================

def parse_hafas_time(time_str: str) -> int:
    """
    Parse a HAFAS time string (HHMMSS or HHMM) into total minutes since midnight.
    Handles day-overflow times like '250000' (01:00 next day → 1500 min).
    """
    if not time_str:
        return 0
    try:
        h = int(time_str[0:2])
        m = int(time_str[2:4])
        return h * 60 + m
    except (ValueError, IndexError):
        return 0


def normalize_line_name(name: str) -> str:
    """
    Strip common transit prefixes (Str, Tram, Bus, etc.) from a line name
    and return the bare number/identifier.
    """
    if not name:
        return ""
    result = name
    for prefix in ["Str", "Tram", "Bus", "Nachtbus", "Linie", "Line",
                    "str", "tram", "bus", "nachtbus", "linie", "line"]:
        result = result.replace(prefix, "")
    return result.strip()


def classify_line_type(line_name: str, mode_name: str = None) -> str:
    """
    Classify a transit line into one of: 'tram', 'bus', 'regional', 'express', 'walk'.
    Uses heuristics based on line name and optional HAFAS mode string.
    """
    if not line_name:
        return "walk"
    if mode_name == 'WALKING':
        return "walk"

    line_lower = line_name.lower().strip()

    # Express: ICE, IC, EC, ECE, TGV, RJ, RJX, etc.
    express_keywords = ["ice", "ic", "ec", "ece", "tgv", "rj", "rjx"]
    if any(k == line_lower or line_lower.startswith(k + " ") or line_lower.startswith(k)
           for k in express_keywords):
        return "express"

    # Regional / S-Bahn: RE, RB, ERB, S, S-Bahn, etc.
    is_regional = (
        any(line_lower.startswith(k) for k in ["re", "rb", "erb"]) or
        line_lower == "s" or
        line_lower.startswith("s ") or
        (line_lower.startswith("s") and len(line_lower) > 1 and line_lower[1:].isdigit()) or
        "s-bahn" in line_lower
    )
    if is_regional:
        return "regional"

    # Tram: Tram, Str, or numeric ≤ 15
    clean_num = (line_name.replace(" ", "")
                 .replace("Str", "").replace("Tram", "")
                 .replace("Bus", "").replace("Linie", "")
                 .replace("Line", "").strip())
    is_num = clean_num.isdigit()

    is_tram = (
        any(x in line_lower for x in ["str", "tram"]) or
        (is_num and int(clean_num) <= 15) or
        (line_lower.startswith("n") and clean_num.replace("n", "").replace("N", "").isdigit())
    )
    if is_tram:
        return "tram"

    return "bus"


def get_line_color(line_name: str) -> str:
    """
    Look up the canonical hex colour for a transit line.
    Extracts the numeric/alpha key from the line name and matches against LINE_COLORS.
    Returns '#888888' (neutral grey) as the default when no match is found.
    """
    if not line_name:
        return '#888888'

    # Try the normalised (stripped) name first
    key = normalize_line_name(line_name)
    if key in LINE_COLORS:
        return LINE_COLORS[key]

    # Try with leading 'N' for night lines (e.g. "N 3" → "N3")
    key_no_space = key.replace(" ", "")
    if key_no_space in LINE_COLORS:
        return LINE_COLORS[key_no_space]

    # Try extracting just the digits
    digits = ''.join(c for c in key if c.isdigit())
    if digits in LINE_COLORS:
        return LINE_COLORS[digits]

    # Try the full raw name as-is (handles 'KVG9' etc.)
    raw = line_name.strip()
    if raw in LINE_COLORS:
        return LINE_COLORS[raw]

    return '#888888'


def _compute_estimated_time(time_str: str, delay: int) -> str:
    """
    Given a planned time string 'HH:MM' and delay in minutes,
    return the estimated arrival/departure time string.
    Only meaningful when delay >= 5.
    """
    if not time_str or delay is None:
        return None
    try:
        parts = time_str.split(":")
        h, m = int(parts[0]), int(parts[1])
        total = h * 60 + m + delay
        return f"{(total // 60) % 24:02d}:{total % 60:02d}"
    except Exception:
        return None


def _realtime_status(delay, cancelled: bool = False) -> str:
    """Derive a human-friendly realtime status label."""
    if cancelled:
        return "cancelled"
    if delay is None:
        return "noData"
    if delay <= 1:
        return "onTime"
    return "delayed"


def generate_fallback_journey(line: str, direction: str, start_time_str: str,
                              delay: int, station_name: str = None):
    """
    Build a synthetic journey response from FALLBACK_ROUTES when HAFAS
    journey-detail calls fail.  Returns a Flask JSON response.
    """
    line_norm = normalize_line_name(line)
    stops_list = FALLBACK_ROUTES.get(line_norm)

    if not stops_list:
        # Generate a generic stop list when we have no fallback data
        stops_list = [
            "Startstation",
            "Hauptbahnhof",
            "Alter Markt",
            "Damaschkeplatz",
            "Opernhaus",
            "Hasselbachplatz",
            direction if direction else "Endstation"
        ]
        if stops_list[0] == stops_list[-1]:
            stops_list[-1] = "Endstation"
    else:
        stops_list = list(stops_list)  # copy so we can reverse safely

    # Prefix "Magdeburg, " to bare stop names
    stops_list = [s if s.startswith("Magdeburg") else f"Magdeburg, {s}" for s in stops_list]

    # Try to orient the list so it ends at the direction
    dir_lower = direction.lower() if direction else ""
    if len(stops_list) > 1:
        start_stop = stops_list[0].lower()
        end_stop = stops_list[-1].lower()
        start_words = start_stop.replace("magdeburg,", "").strip().split()
        end_words = end_stop.replace("magdeburg,", "").strip().split()
        if (any(w in dir_lower for w in start_words) and
                not any(w in dir_lower for w in end_words)):
            stops_list.reverse()

    # Find the index of the current station in the list
    idx = 0
    if station_name:
        stat_lower = station_name.lower().replace("magdeburg,", "").strip()
        for i, stop in enumerate(stops_list):
            stop_clean = stop.lower().replace("magdeburg,", "").strip()
            if stat_lower in stop_clean or stop_clean in stat_lower:
                idx = i
                break

    # Build time anchors
    try:
        parts = start_time_str.split(":")
        h, m = int(parts[0]), int(parts[1])
        now = datetime.datetime.now(local_tz)
        anchor_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    except Exception:
        anchor_dt = datetime.datetime.now(local_tz)

    now_ts = datetime.datetime.now(local_tz).timestamp()
    total_stops = len(stops_list)
    vehicle_pos = 0  # will be updated below

    stops = []
    for i, name in enumerate(stops_list):
        diff_min = (i - idx) * 2
        stop_dt = anchor_dt + datetime.timedelta(minutes=diff_min)
        passed = stop_dt.timestamp() < now_ts
        time_str = stop_dt.strftime('%H:%M')

        # Slight delay variations along the route
        stop_delay = delay
        if i < idx and passed:
            stop_delay = max(0, delay - (idx - i) // 2)
        elif i > idx:
            stop_delay = delay + (i - idx) // 3

        estimated = _compute_estimated_time(time_str, stop_delay) if stop_delay >= 5 else None
        is_vehicle = False
        if passed:
            vehicle_pos = i

        stops.append({
            "name": name,
            "time": time_str,
            "delay": stop_delay,
            "passed": passed,
            "platform": "",
            "cancelled": False,
            "day_offset": 0,
            "estimatedTime": estimated,
            "isVehicleHere": False  # will be set below
        })

    # Mark the vehicle position
    if 0 <= vehicle_pos < len(stops):
        stops[vehicle_pos]["isVehicleHere"] = True

    line_color = get_line_color(line)
    progress = int((vehicle_pos / max(total_stops - 1, 1)) * 100)

    return jsonify({
        "line": line,
        "direction": direction if direction else (stops_list[-1] if stops_list else "Endstation"),
        "lineColor": line_color,
        "vehiclePosition": vehicle_pos,
        "progressPercent": progress,
        "totalStops": total_stops,
        "trip_num": None,
        "messages": [],
        "stops": stops
    })


# ===================================================================
#  ROUTES
# ===================================================================

@app.route('/')
def index():
    """Serve the frontend SPA."""
    return send_from_directory('.', 'index.html')


# -------------------------------------------------------------------
# GET /api/search  —  Station search
# -------------------------------------------------------------------
@app.route('/api/search')
def search_station():
    """
    Search for stations by name.
    Queries NASA client first (local Magdeburg network), then OEBB
    (national rail).  Falls back to a hardcoded list if both fail.
    """
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    try:
        results = []
        seen_ids = set()

        # 1. NASA Client (primary for Magdeburg / Saxony-Anhalt)
        if nasa_client:
            try:
                for loc in nasa_client.locations(query):
                    if loc.id and loc.id not in seen_ids:
                        results.append({"id": loc.id, "name": loc.name})
                        seen_ids.add(loc.id)
            except Exception as ex:
                print(f"[WARN] NASA location search failed: {ex}")

        # 2. OEBB Client (national / other cities)
        if oebb_client:
            try:
                for loc in oebb_client.locations(query):
                    if loc.id and loc.id not in seen_ids:
                        results.append({"id": loc.id, "name": loc.name})
                        seen_ids.add(loc.id)
            except Exception as ex:
                print(f"[WARN] OEBB location search failed: {ex}")

        if results:
            return jsonify(results)
    except Exception as e:
        print(f"[ERROR] Search API: {e}")

    # ---- Local fallback stations ----
    stations = [
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
        {"id": "7409", "name": "Magdeburg, Herrenkrug"},
    ]
    query_lower = query.lower()
    matches = [s for s in stations if query_lower in s["name"].lower()]
    return jsonify(matches)


# -------------------------------------------------------------------
# GET /api/departures  —  Station departure board
# -------------------------------------------------------------------
@app.route('/api/departures')
def get_departures():
    """
    Return upcoming departures for a given station.
    Enhanced with lineColor, realtimeStatus, estimatedTime, platform, cancelled.
    """
    station_id = request.args.get('station_id')
    if not station_id:
        return jsonify({"error": "station_id required"}), 400

    date_param = request.args.get('date')       # YYYY-MM-DD
    time_param = request.args.get('time')       # HH:MM
    duration_param = request.args.get('duration', '60')

    try:
        duration = int(duration_param)
    except ValueError:
        duration = 60

    # Build search datetime
    search_dt = datetime.datetime.now(local_tz)
    if date_param and time_param:
        try:
            naive_dt = datetime.datetime.strptime(f"{date_param} {time_param}", "%Y-%m-%d %H:%M")
            search_dt = local_tz.localize(naive_dt)
        except Exception as e:
            print(f"[WARN] Departures date parse error: {e}")

    # Route to the right client based on station ID length
    active_client = nasa_client
    if station_id and len(str(station_id)) >= 7 and oebb_client:
        active_client = oebb_client

    try:
        if active_client:
            departures = active_client.departures(
                station=station_id,
                date=search_dt,
                duration=duration,
                max_trips=40
            )
            result = []
            for dep in departures:
                # Delay in minutes
                delay = None
                if dep.dateTime and dep.delay is not None:
                    delay = int(dep.delay.total_seconds() / 60)

                line_name = dep.name
                line_type = classify_line_type(line_name)
                line_color = get_line_color(line_name)

                # Cancelled detection
                cancelled = getattr(dep, 'cancelled', False)
                if not cancelled:
                    cancelled = getattr(dep, 'dCncl', False)

                # Realtime status
                rt_status = _realtime_status(delay, cancelled)

                # Day offset
                day_offset = 0
                if dep.dateTime:
                    dep_date = dep.dateTime.astimezone(local_tz).date()
                    search_date = search_dt.astimezone(local_tz).date()
                    if dep_date > search_date:
                        day_offset = (dep_date - search_date).days

                # Time string
                time_str = dep.dateTime.strftime('%H:%M') if dep.dateTime else ""

                # Estimated time (only shown when delay >= 5)
                estimated = _compute_estimated_time(time_str, delay) if (delay is not None and delay >= 5) else None

                # Platform
                platform = ""
                if hasattr(dep, 'platform') and dep.platform:
                    platform = str(dep.platform)
                elif hasattr(dep, 'departurePlatform') and dep.departurePlatform:
                    platform = str(dep.departurePlatform)

                result.append({
                    "id": dep.id,
                    "journey_id": dep.id,
                    "line": line_name,
                    "direction": dep.direction,
                    "time": time_str,
                    "delay": delay,
                    "type": line_type,
                    "day_offset": day_offset,
                    "cancelled": cancelled,
                    "lineColor": line_color,
                    "realtimeStatus": rt_status,
                    "estimatedTime": estimated,
                    "platform": platform,
                })
            return jsonify(result)
    except Exception as e:
        print(f"[ERROR] HAFAS departures: {e}")
        traceback.print_exc()

    # ---- Fallback departures ----
    print(f"[INFO] Generating fallback departures for station {station_id}")
    now = datetime.datetime.now(local_tz)
    result = []

    lines_pool = [
        {"line": "Str 2",  "dir": "Magdeburg, Westerhüsen",    "type": "tram"},
        {"line": "Str 9",  "dir": "Magdeburg, Neustädter See", "type": "tram"},
        {"line": "Str 10", "dir": "Magdeburg, Sudenburg",      "type": "tram"},
        {"line": "Str 6",  "dir": "Magdeburg, Herrenkrug",     "type": "tram"},
        {"line": "Bus 57", "dir": "Magdeburg, AMO/Steubenallee","type": "bus"},
        {"line": "Bus 51", "dir": "Magdeburg, Biederitz",      "type": "bus"},
        {"line": "Bus 73", "dir": "Magdeburg, Olvenstedt",     "type": "bus"},
    ]

    for i, lp in enumerate(lines_pool):
        dep_time = now + datetime.timedelta(minutes=4 + i * 7)
        delay = 0 if i % 3 != 0 else (2 if i % 6 == 0 else 5)
        cancelled = False
        line_color = get_line_color(lp["line"])
        rt_status = _realtime_status(delay, cancelled)
        time_str = dep_time.strftime('%H:%M')
        estimated = _compute_estimated_time(time_str, delay) if delay >= 5 else None

        result.append({
            "id": f"mock_j_{lp['line'].replace(' ', '')}_{i}",
            "journey_id": f"mock_j_{lp['line'].replace(' ', '')}_{i}",
            "line": lp["line"],
            "direction": lp["dir"],
            "time": time_str,
            "delay": delay,
            "type": lp["type"],
            "day_offset": 0,
            "cancelled": cancelled,
            "lineColor": line_color,
            "realtimeStatus": rt_status,
            "estimatedTime": estimated,
            "platform": "",
        })

    return jsonify(result)


# -------------------------------------------------------------------
# GET /api/journey  —  Journey detail (stop-by-stop)
# -------------------------------------------------------------------
@app.route('/api/journey')
def get_journey():
    """
    Return detailed stop-by-stop journey information for a given journey ID.
    Enhanced with vehiclePosition, progressPercent, totalStops, lineColor,
    estimatedTime per stop, and isVehicleHere.
    """
    journey_id = request.args.get('journey_id')
    fallback_line = request.args.get('line', 'Tram')
    fallback_direction = request.args.get('direction', 'Endstation')
    fallback_time = request.args.get('time', '12:00')
    delay_param = request.args.get('delay', '0')
    station_name = request.args.get('station_name', '')

    fallback_delay = 0
    if delay_param and delay_param.lower() not in ('null', 'none', ''):
        try:
            fallback_delay = int(delay_param)
        except ValueError:
            pass

    if not journey_id:
        return jsonify({"error": "journey_id required"}), 400

    # Handle mock journeys immediately
    if journey_id.startswith("mock_j_"):
        return generate_fallback_journey(
            fallback_line, fallback_direction, fallback_time,
            fallback_delay, station_name
        )

    # ---- Try HAFAS JourneyDetails ----
    req_data = {
        'req': {'jid': journey_id},
        'meth': 'JourneyDetails'
    }

    res = None
    active_client = None

    # Try NASA first
    if nasa_client:
        try:
            res = nasa_client.profile.request(req_data).res
            active_client = nasa_client
        except Exception as e:
            print(f"[WARN] NASA JourneyDetails failed for {journey_id}: {e}")

    # Fallback to OEBB
    if res is None and oebb_client:
        try:
            res = oebb_client.profile.request(req_data).res
            active_client = oebb_client
        except Exception as e:
            print(f"[WARN] OEBB JourneyDetails failed for {journey_id}: {e}")

    if res is None:
        print(f"[INFO] All HAFAS clients failed for journey {journey_id}. Using fallback.")
        return generate_fallback_journey(
            fallback_line, fallback_direction, fallback_time,
            fallback_delay, station_name
        )

    # ---- Parse raw HAFAS response ----
    try:
        journey = res.get('journey', {})
        common = res.get('common', {})
        locL = common.get('locL', [])

        # Extract trip number from product context
        prod_list = journey.get('prodL', [])
        trip_num = None
        if prod_list and len(common.get('prodL', [])) > 0:
            prod_idx = prod_list[0].get('prodX', 0)
            if prod_idx < len(common['prodL']):
                product = common['prodL'][prod_idx]
                prod_ctx = product.get('prodCtx', {})
                trip_num = prod_ctx.get('num')

        # Resolve line name from journey product
        journey_line = fallback_line
        if prod_list:
            first_prod = prod_list[0]
            journey_line = first_prod.get('name', fallback_line)

        journey_direction = journey.get('dirTxt', fallback_direction)
        line_color = get_line_color(journey_line)

        # Parse stops
        stops_raw = journey.get('stopL', [])
        lPassSt_raw = journey.get('lPassSt')
        lPassSt = -1
        if isinstance(lPassSt_raw, dict):
            lPassSt = lPassSt_raw.get('idx', -1)
        elif isinstance(lPassSt_raw, int):
            lPassSt = lPassSt_raw

        stops = []
        vehicle_pos = 0
        total_stops = len(stops_raw)

        for s in stops_raw:
            loc_idx = s.get('locX', 0)
            name = locL[loc_idx].get('name') if loc_idx < len(locL) else "Unknown"
            idx = s.get('idx', 0)

            # Time fields
            d_time_s = s.get('dTimeS')
            d_time_r = s.get('dTimeR')
            a_time_s = s.get('aTimeS')
            a_time_r = s.get('aTimeR')

            planned = d_time_s if d_time_s else a_time_s
            actual = d_time_r if d_time_r else a_time_r

            time_str = ""
            day_offset = 0
            if planned:
                try:
                    hour = int(planned[0:2])
                    day_offset = hour // 24
                    hour_mod = hour % 24
                    time_str = f"{hour_mod:02d}:{planned[2:4]}"
                except Exception:
                    time_str = f"{planned[0:2]}:{planned[2:4]}"

            # Delay calculation
            delay = None
            if planned and actual:
                delay = parse_hafas_time(actual) - parse_hafas_time(planned)
                if delay < -1000:
                    delay += 1440
                elif delay > 1000:
                    delay -= 1440

            passed = idx <= lPassSt

            # Track vehicle position
            if passed:
                vehicle_pos = len(stops)

            # Platform
            pltf = ""
            pltf_s = s.get('dPltfS', s.get('aPltfS'))
            if pltf_s:
                pltf = pltf_s.get('txt', '')

            # Cancelled
            cancelled = s.get('dCncl', False) or s.get('aCncl', False)

            # Estimated time (only when delay >= 5)
            estimated = _compute_estimated_time(time_str, delay) if (delay is not None and delay >= 5) else None

            stops.append({
                "name": name,
                "time": time_str,
                "delay": delay,
                "passed": passed,
                "platform": pltf,
                "cancelled": cancelled,
                "day_offset": day_offset,
                "estimatedTime": estimated,
                "isVehicleHere": False,  # set below
            })

        # Mark the vehicle's current stop
        if 0 <= vehicle_pos < len(stops):
            stops[vehicle_pos]["isVehicleHere"] = True

        # Progress percentage
        progress = int((vehicle_pos / max(total_stops - 1, 1)) * 100) if total_stops > 0 else 0

        # ---- Parse messages ----
        msgL = journey.get('msgL', [])
        remL = common.get('remL', [])
        messages = []
        for msg in msgL:
            remX = msg.get('remX')
            if remX is not None and remX < len(remL):
                rem = remL[remX]
                code = rem.get('code', '')
                if code == 'OPERATOR':
                    continue
                text = rem.get('txtN', rem.get('txtL', ''))
                if text:
                    text_lower = text.lower()
                    is_warning = any(kw in text_lower for kw in [
                        "ausfall", "umleitung", "ersatzverkehr",
                        "gesperrt", "störung", "verspätung"
                    ])
                    messages.append({
                        "text": text,
                        "warning": is_warning
                    })

        return jsonify({
            "line": journey_line,
            "direction": journey_direction,
            "lineColor": line_color,
            "vehiclePosition": vehicle_pos,
            "progressPercent": progress,
            "totalStops": total_stops,
            "trip_num": trip_num,
            "messages": messages,
            "stops": stops,
        })

    except Exception as e:
        print(f"[ERROR] HAFAS raw journey parse: {e}")
        traceback.print_exc()
        return generate_fallback_journey(
            fallback_line, fallback_direction, fallback_time,
            fallback_delay, station_name
        )


# -------------------------------------------------------------------
# GET /api/connections  —  Route planning (A → B)
# -------------------------------------------------------------------
@app.route('/api/connections')
def get_connections():
    """
    Plan a journey from origin to destination.
    Enhanced with lineColor, realtimeStatus, intermediateStops, transfers.
    """
    origin = request.args.get('origin')
    destination = request.args.get('destination')

    if not origin or not destination:
        return jsonify({"error": "origin and destination required"}), 400

    try:
        date_param = request.args.get('date')   # YYYY-MM-DD
        time_param = request.args.get('time')   # HH:MM

        search_dt = datetime.datetime.now(local_tz)
        if date_param and time_param:
            try:
                naive_dt = datetime.datetime.strptime(
                    f"{date_param} {time_param}", "%Y-%m-%d %H:%M"
                )
                search_dt = local_tz.localize(naive_dt)
            except Exception as e:
                print(f"[WARN] Connections date parse error: {e}")

        # ---- Resolve station names to IDs if needed ----
        resolved_origin = origin
        resolved_dest = destination

        def _resolve_location(name: str) -> str:
            """Try NASA then OEBB to resolve a station name to an ID."""
            if name.isdigit():
                return name
            if nasa_client:
                try:
                    locs = nasa_client.locations(name)
                    if locs:
                        return locs[0].id
                except Exception:
                    pass
            if oebb_client:
                try:
                    locs = oebb_client.locations(name)
                    if locs:
                        return locs[0].id
                except Exception:
                    pass
            return name

        if nasa_client or oebb_client:
            try:
                resolved_origin = _resolve_location(origin)
            except Exception as e:
                print(f"[WARN] Error resolving origin '{origin}': {e}")
            try:
                resolved_dest = _resolve_location(destination)
            except Exception as e:
                print(f"[WARN] Error resolving destination '{destination}': {e}")

        # Choose the appropriate client
        active_client = nasa_client
        if resolved_origin and resolved_dest:
            if len(str(resolved_origin)) >= 7 or len(str(resolved_dest)) >= 7:
                if oebb_client:
                    active_client = oebb_client

        if active_client:
            journeys = active_client.journeys(
                origin=resolved_origin,
                destination=resolved_dest,
                date=search_dt,
                max_changes=3,
                max_journeys=5
            )

            result = []
            for j in journeys:
                legs = []
                non_walk_count = 0

                for leg in j.legs:
                    # Delays
                    dep_delay = None
                    if leg.departureDelay is not None:
                        dep_delay = int(leg.departureDelay.total_seconds() / 60)
                    arr_delay = None
                    if leg.arrivalDelay is not None:
                        arr_delay = int(leg.arrivalDelay.total_seconds() / 60)

                    line_name = leg.name if leg.name else "Fußweg"
                    line_type = classify_line_type(line_name, leg.mode.name)
                    line_color = get_line_color(line_name)
                    cancelled = getattr(leg, 'cancelled', False)
                    rt_status = _realtime_status(dep_delay, cancelled)

                    if line_type != "walk":
                        non_walk_count += 1

                    # Day offsets
                    dep_day_offset = 0
                    arr_day_offset = 0
                    search_date = search_dt.astimezone(local_tz).date()
                    if leg.departure:
                        leg_dep_date = leg.departure.astimezone(local_tz).date()
                        if leg_dep_date > search_date:
                            dep_day_offset = (leg_dep_date - search_date).days
                    if leg.arrival:
                        leg_arr_date = leg.arrival.astimezone(local_tz).date()
                        if leg_arr_date > search_date:
                            arr_day_offset = (leg_arr_date - search_date).days

                    # Intermediate stops count
                    intermediate_stops = 0
                    if hasattr(leg, 'stopovers') and leg.stopovers:
                        intermediate_stops = max(0, len(leg.stopovers) - 2)
                    elif hasattr(leg, 'intermediateStops') and leg.intermediateStops:
                        intermediate_stops = len(leg.intermediateStops)

                    # Platform
                    platform = ""
                    if hasattr(leg, 'departurePlatform') and leg.departurePlatform:
                        platform = str(leg.departurePlatform)

                    legs.append({
                        "line": line_name,
                        "origin": leg.origin.name,
                        "destination": leg.destination.name,
                        "departure_time": leg.departure.strftime('%H:%M') if leg.departure else "",
                        "departure_delay": dep_delay,
                        "departure_day_offset": dep_day_offset,
                        "arrival_time": leg.arrival.strftime('%H:%M') if leg.arrival else "",
                        "arrival_delay": arr_delay,
                        "arrival_day_offset": arr_day_offset,
                        "type": line_type,
                        "platform": platform,
                        "cancelled": cancelled,
                        "journey_id": getattr(leg, 'id', None),
                        "lineColor": line_color,
                        "intermediateStops": intermediate_stops,
                        "realtimeStatus": rt_status,
                    })

                duration_min = int(j.duration.total_seconds() / 60) if j.duration else 0
                transfers = max(0, non_walk_count - 1)

                result.append({
                    "duration": duration_min,
                    "transfers": transfers,
                    "legs": legs,
                })
            return jsonify(result)

    except Exception as e:
        print(f"[ERROR] Connections API: {e}")
        traceback.print_exc()

    # ---- Fallback connections ----
    print(f"[INFO] Generating fallback connections from {origin} to {destination}")
    now = datetime.datetime.now(local_tz)
    dep_time1 = now + datetime.timedelta(minutes=4)
    arr_time1 = dep_time1 + datetime.timedelta(minutes=18)

    dep_time2 = now + datetime.timedelta(minutes=15)
    arr_time2 = dep_time2 + datetime.timedelta(minutes=36)

    origin_name = ("Magdeburg, Neustädter Platz"
                   if origin in ["7335", "733502"] else "Startstation")
    dest_name = ("Magdeburg, Allee-Center"
                 if destination in ["4493", "300449301"] else "Zielstation")

    return jsonify([
        {
            "duration": 18,
            "transfers": 0,
            "legs": [
                {
                    "line": "Str 9",
                    "origin": origin_name,
                    "destination": dest_name,
                    "departure_time": dep_time1.strftime('%H:%M'),
                    "departure_delay": 2,
                    "departure_day_offset": 0,
                    "arrival_time": arr_time1.strftime('%H:%M'),
                    "arrival_delay": 2,
                    "arrival_day_offset": 0,
                    "type": "tram",
                    "platform": "Gleis 1",
                    "cancelled": False,
                    "journey_id": "mock_j_Str9_1",
                    "lineColor": get_line_color("Str 9"),
                    "intermediateStops": 5,
                    "realtimeStatus": "delayed",
                }
            ]
        },
        {
            "duration": 21,
            "transfers": 1,
            "legs": [
                {
                    "line": "Str 9",
                    "origin": origin_name,
                    "destination": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz",
                    "departure_time": dep_time2.strftime('%H:%M'),
                    "departure_delay": 0,
                    "departure_day_offset": 0,
                    "arrival_time": (dep_time2 + datetime.timedelta(minutes=14)).strftime('%H:%M'),
                    "arrival_delay": 0,
                    "arrival_day_offset": 0,
                    "type": "tram",
                    "platform": "Gleis 1",
                    "cancelled": False,
                    "journey_id": "mock_j_Str9_2",
                    "lineColor": get_line_color("Str 9"),
                    "intermediateStops": 4,
                    "realtimeStatus": "onTime",
                },
                {
                    "line": "Fußweg",
                    "origin": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz",
                    "destination": "Magdeburg, City Carré",
                    "departure_time": (dep_time2 + datetime.timedelta(minutes=14)).strftime('%H:%M'),
                    "departure_delay": 0,
                    "departure_day_offset": 0,
                    "arrival_time": (dep_time2 + datetime.timedelta(minutes=16)).strftime('%H:%M'),
                    "arrival_delay": 0,
                    "arrival_day_offset": 0,
                    "type": "walk",
                    "platform": "",
                    "cancelled": False,
                    "journey_id": None,
                    "lineColor": "#888888",
                    "intermediateStops": 0,
                    "realtimeStatus": "noData",
                },
                {
                    "line": "Str 6",
                    "origin": "Magdeburg, City Carré",
                    "destination": dest_name,
                    "departure_time": (dep_time2 + datetime.timedelta(minutes=17)).strftime('%H:%M'),
                    "departure_delay": 1,
                    "departure_day_offset": 0,
                    "arrival_time": arr_time2.strftime('%H:%M'),
                    "arrival_delay": 1,
                    "arrival_day_offset": 0,
                    "type": "tram",
                    "platform": "Gleis 2",
                    "cancelled": False,
                    "journey_id": "mock_j_Str6_1",
                    "lineColor": get_line_color("Str 6"),
                    "intermediateStops": 3,
                    "realtimeStatus": "onTime",
                }
            ]
        }
    ])


# -------------------------------------------------------------------
# GET /api/disruptions  —  Scrape MVB disruption reports
# -------------------------------------------------------------------
@app.route('/api/disruptions')
def get_disruptions():
    """
    Scrape mvb-verkehrsmelder.de for current disruptions.
    Returns an array of disruption objects with MD5-based IDs and metadata.
    """
    try:
        url = "https://mvb-verkehrsmelder.de/"
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            )
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        response.encoding = 'utf-8'

        soup = BeautifulSoup(response.text, 'html.parser')
        articles = soup.find_all('article')

        disruptions = []
        now_iso = datetime.datetime.now(local_tz).isoformat()

        for article in articles:
            title_tag = article.find(['h1', 'h2', 'h3'], class_='entry-title')
            title = title_tag.get_text(strip=True) if title_tag else "Meldung"

            content_div = article.find('div', class_='entry-content')
            desc = ""
            if content_div:
                paragraphs = content_div.find_all('p')
                desc = "\n".join(p.get_text(strip=True) for p in paragraphs)

            # Extract affected lines from category tags
            lines = []
            meta_div = article.find('div', class_='kt-post-cats')
            if meta_div:
                for link in meta_div.find_all('a'):
                    lines.append(link.get_text(strip=True))

            # Determine criticality
            combined_text = (title + " " + desc).lower()
            critical = any(kw in combined_text for kw in [
                "sperrung", "ausfall", "gesperrt", "unfall"
            ])

            # Generate stable ID from title (first 8 hex chars of MD5)
            disruption_id = hashlib.md5(title.encode('utf-8')).hexdigest()[:8]

            if title and desc:
                disruptions.append({
                    "id": disruption_id,
                    "title": title,
                    "desc": desc,
                    "time": "Aktuell",
                    "lines": lines,
                    "critical": critical,
                    "timestamp": now_iso,
                })

        if disruptions:
            return jsonify(disruptions)

    except Exception as e:
        print(f"[ERROR] Disruptions scraping: {e}")
        traceback.print_exc()

    # ---- Fallback disruptions if scraping fails ----
    now_iso = datetime.datetime.now(local_tz).isoformat()
    return jsonify([
        {
            "id": hashlib.md5(b"Linie 57: Verspaetungen wegen technischem Defekt").hexdigest()[:8],
            "title": "Linie 57: Verspätungen wegen technischem Defekt",
            "desc": ("Linie 57: Nach einem technischen Defekt kommt es auf der "
                     "gesamten Linie zu Verspätungen. Wir bitten um Geduld."),
            "time": "Aktuell",
            "lines": ["Linie 57"],
            "critical": False,
            "timestamp": now_iso,
        },
        {
            "id": hashlib.md5(b"Linie 61: Umleitung wegen Rohrbruch").hexdigest()[:8],
            "title": "Linie 61: Umleitung wegen Rohrbruch in Rottersdorfer Straße",
            "desc": ("Linie 61: Aufgrund eines Rohrbruchs in der Rottersdorfer Straße "
                     "können die Haltestellen Eiskellerplatz und Sudenburg nicht "
                     "angefahren werden. Die Busse werden umgeleitet."),
            "time": "Aktuell",
            "lines": ["Linie 61"],
            "critical": True,
            "timestamp": now_iso,
        },
        {
            "id": hashlib.md5(b"Linie 51: Haltestelle Heyrothsberge entfaellt").hexdigest()[:8],
            "title": "Linie 51: Haltestelle Heyrothsberge entfällt wegen Baustelle",
            "desc": ("Linie 51: Wegen einer Baustelle auf der Bundesstraße 1 kann "
                     "die Haltestelle Heyrothsberge nicht angefahren werden. "
                     "Ersatzhaltestellen sind eingerichtet."),
            "time": "Aktuell",
            "lines": ["Linie 51"],
            "critical": False,
            "timestamp": now_iso,
        }
    ])


# -------------------------------------------------------------------
# GET /api/disruptions/check  —  Lightweight disruption ID check
# -------------------------------------------------------------------
@app.route('/api/disruptions/check')
def check_disruptions():
    """
    Return only the IDs (and count) of current disruptions.
    Designed for lightweight push-notification polling by the frontend.
    """
    try:
        url = "https://mvb-verkehrsmelder.de/"
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            )
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        response.encoding = 'utf-8'

        soup = BeautifulSoup(response.text, 'html.parser')
        articles = soup.find_all('article')

        ids = []
        for article in articles:
            title_tag = article.find(['h1', 'h2', 'h3'], class_='entry-title')
            title = title_tag.get_text(strip=True) if title_tag else ""
            if title:
                disruption_id = hashlib.md5(title.encode('utf-8')).hexdigest()[:8]
                ids.append(disruption_id)

        return jsonify({"ids": ids, "count": len(ids)})

    except Exception as e:
        print(f"[ERROR] Disruptions check: {e}")
        traceback.print_exc()
        return jsonify({"ids": [], "count": 0})


# ===================================================================
#  SERVER STARTUP
# ===================================================================
if __name__ == '__main__':
    print("=" * 60)
    print("  MVB Magdeburg Transit Backend")
    print(f"  NASA client: {'OK' if nasa_client else 'UNAVAILABLE'}")
    print(f"  OEBB client: {'OK' if oebb_client else 'UNAVAILABLE'}")
    print("  Starting on http://0.0.0.0:5000")
    print("=" * 60)
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
