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
import re
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
# Monkeypatch pyhafas BaseParseLegHelper.parse_leg to fix KeyError: 'ctx'
# ---------------------------------------------------------------------------
from pyhafas.profile.base.helper.parse_leg import BaseParseLegHelper
from pyhafas.types.fptf import Leg, Mode

original_parse_leg = BaseParseLegHelper.parse_leg

def patched_parse_leg(self, journey, common, departure, arrival, date, jny_type="JNY", gis=None):
    if jny_type == "WALK" or jny_type == "TRSF":
        leg_origin = self.parse_lid_to_station(common['locL'][departure['locX']]['lid'])
        leg_destination = self.parse_lid_to_station(common['locL'][arrival['locX']]['lid'])
        gis_id = ""
        if gis and isinstance(gis, dict):
            gis_id = gis.get('ctx') or gis.get('id') or ""
        return Leg(
            id=gis_id,
            origin=leg_origin,
            destination=leg_destination,
            departure=self.parse_datetime(departure['dTimeS'], date),
            arrival=self.parse_datetime(arrival['aTimeS'], date),
            mode=Mode.WALKING,
            name=None,
            distance=gis.get('dist') if (gis and isinstance(gis, dict)) else None
        )
    return original_parse_leg(self, journey, common, departure, arrival, date, jny_type, gis)

BaseParseLegHelper.parse_leg = patched_parse_leg

# ---------------------------------------------------------------------------
# Monkeypatch BaseProfile.format_products_filter to copy defaultProducts
# ---------------------------------------------------------------------------
from pyhafas.profile.base import BaseProfile

def patched_format_products_filter(self, requested_products: dict) -> dict:
    products = list(self.defaultProducts) # Copy list to prevent mutating profile defaultProducts in-place!
    for requested_product in requested_products:
        if requested_products[requested_product]:
            try:
                products.index(requested_product)
            except ValueError:
                products.append(requested_product)
        elif not requested_products[requested_product]:
            try:
                products.pop(products.index(requested_product))
            except ValueError:
                pass
    bitmask_sum = 0
    for product in products:
        try:
            for product_bitmask in self.availableProducts[product]:
                bitmask_sum += product_bitmask
        except KeyError:
            from pyhafas.exceptions.product import ProductNotAvailableError
            raise ProductNotAvailableError(
                'The product "{}" is not available in chosen profile.'.format(product))
    return {
        'type': 'PROD',
        'mode': 'INC',
        'value': str(bitmask_sum)
    }

BaseProfile.format_products_filter = patched_format_products_filter

def get_profile_products(client, allowed_modes):
    """
    Map generalized allowed_modes keys to profile-specific product names.
    allowed_modes: dict of {'tram': bool, 'bus': bool, 'regional': bool, 'express': bool}
    """
    profile_class_name = client.profile.__class__.__name__
    products = {}
    
    tram = allowed_modes.get('tram', True)
    bus = allowed_modes.get('bus', True)
    regional = allowed_modes.get('regional', True)
    express = allowed_modes.get('express', True)

    if "NASAProfile" in profile_class_name:
        products['tram'] = tram
        products['bus'] = bus
        products['regional'] = regional
        products['suburban'] = regional
        products['long_distance'] = express
        products['long_distance_express'] = express
    else:
        products['tram'] = tram
        products['bus'] = bus
        products['regional'] = regional
        products['regional_express'] = regional
        products['suburban'] = regional
        products['long_distance'] = express
        products['long_distance_express'] = express
        
    return products

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

@app.after_request
def add_header(response):
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, post-check=0, pre-check=0, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

# ---------------------------------------------------------------------------
# HAFAS Client Initialisation (graceful – app works even if clients fail)
# ---------------------------------------------------------------------------
try:
    nasa_client = HafasClient(NASAProfile())
except Exception as e:
    print(f"[WARN] Could not initialise NASA client: {e}")
    nasa_client = None

try:
    db_client = HafasClient(DBProfile())
except Exception as e:
    print(f"[WARN] Could not initialise DB client: {e}")
    db_client = None

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


def clean_db_line_name(name: str) -> str:
    """
    Clean up DB train names (e.g. 'S S5 (Zug-Nr. 5575)' -> 'S5', 'RE3 (Zug-Nr. 3309)' -> 'RE3').
    Supports non-breaking spaces (\xa0) and multiple spaces.
    """
    if not name:
        return ""
    # Normalize all whitespaces (including non-breaking spaces \xa0) to single space
    name = re.sub(r'\s+', ' ', name).strip()
    # Remove "(Zug-Nr. ...)"
    name = re.sub(r'\s*\(Zug-Nr\..*?\)', '', name)
    name = re.sub(r'\s*Zug-Nr\..*$', '', name)
    # Remove double S prefix like "S S3" -> "S3"
    name = re.sub(r'^S\s+S(\d+)', r'S\1', name)
    # Remove "Bus " prefix from train replacement buses (e.g. "Bus S1" -> "S1", "Bus RE1" -> "RE1")
    name = re.sub(r'^bus\s+(s\d+|re\d+|rb\d+)', r'\1', name, flags=re.IGNORECASE)
    return name.strip()


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
        re.match(r'^s\s*\d+', line_lower) or
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


def get_line_color(line_name: str, operator_name: str = None) -> str:
    """
    Look up the canonical hex colour for a transit line.
    If operator_name is not 'MVB', returns standard colors for that operator
    (e.g., DB red, S-Bahn green, ODEG blue/green, BördeBus blue-green, PVGS dark blue).
    For MVB, returns the canonical line color from LINE_COLORS.
    """
    if not line_name:
        return '#888888'

    # If operator is not specified, guess it from the line name
    if not operator_name:
        j_line_clean = line_name.lower().replace(" ", "")
        if j_line_clean.startswith('str') or j_line_clean.startswith('tram'):
            operator_name = "MVB"
        elif j_line_clean == 're1':
            operator_name = "ODEG"
        elif j_line_clean.startswith('re') or j_line_clean.startswith('rb') or j_line_clean.startswith('s') or j_line_clean.startswith('ice') or j_line_clean.startswith('ic'):
            operator_name = "DB"
        elif j_line_clean.startswith('bus'):
            digits = ''.join(c for c in j_line_clean if c.isdigit())
            if digits and int(digits) <= 99:
                operator_name = "MVB"
            else:
                operator_name = "BUS_OTHER"
        else:
            if "odeg" in j_line_clean:
                operator_name = "ODEG"
            elif "pvgs" in j_line_clean:
                operator_name = "PVGS"
            elif "börde" in j_line_clean or "boerde" in j_line_clean:
                operator_name = "BördeBus"
            elif "njl" in j_line_clean or "jerichow" in j_line_clean:
                operator_name = "NJL"
            elif "kvg" in j_line_clean or "salzland" in j_line_clean:
                operator_name = "KVG"
            elif "flix" in j_line_clean:
                operator_name = "FlixBus"
            elif "havag" in j_line_clean or "halle" in j_line_clean:
                operator_name = "HAVAG"
            elif "metronom" in j_line_clean:
                operator_name = "metronom"
            else:
                operator_name = "MVB"

    # Enforce operator-specific coloring
    op_clean = operator_name.upper().replace(" ", "") if operator_name else ""
    
    if "ODEG" in op_clean:
        return '#2C6930'  # ODEG dark green / corporate green
    elif "PVGS" in op_clean:
        return '#0A356A'  # PVGS dark blue
    elif "BÖRDE" in op_clean or "BOERDE" in op_clean:
        return '#2C7E9C'  # BördeBus blue-green
    elif "NJL" in op_clean:
        return '#10355C'  # NJL dark blue
    elif "KVG" in op_clean:
        return '#EE9A00'  # KVG Salzland gold
    elif "FLIX" in op_clean:
        return '#73C000'  # FlixBus light green
    elif "HAVAG" in op_clean:
        return '#D01B13'  # HAVAG red
    elif "METRONOM" in op_clean:
        return '#004F9F'  # metronom blue
    elif "DB" in op_clean or "DEUTSCHEBAHN" in op_clean:
        if line_name.lower().startswith('s'):
            return '#00975F'  # S-Bahn green
        return '#C00000'  # DB red
    elif op_clean != "MVB":
        line_lower = line_name.lower().replace(" ", "")
        if line_lower.startswith('str') or line_lower.startswith('tram'):
            return '#8E8E93'  # Generic tram grey
        elif line_lower.startswith('s') and any(c.isdigit() for c in line_lower):
            return '#00975F'  # Generic S-Bahn green
        elif line_lower.startswith('re') or line_lower.startswith('rb'):
            return '#C00000'  # Generic regional rail red
        return '#5F7D95'  # Generic bus slate blue

    # For MVB: look up in LINE_COLORS
    key = normalize_line_name(line_name)
    if key in LINE_COLORS:
        return LINE_COLORS[key]

    key_no_space = key.replace(" ", "")
    if key_no_space in LINE_COLORS:
        return LINE_COLORS[key_no_space]

    digits = ''.join(c for c in key if c.isdigit())
    if digits in LINE_COLORS:
        return LINE_COLORS[digits]

    raw = line_name.strip()
    if raw in LINE_COLORS:
        return LINE_COLORS[raw]

    # Fallback MVB color
    line_lower = line_name.lower().replace(" ", "")
    if line_lower.startswith('str') or line_lower.startswith('tram'):
        return '#006651'  # Default MVB tram green
    return '#5F7D95'  # Default MVB bus slate blue


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

        # Slight delay variations along the route
        stop_delay = delay
        if i < idx:
            stop_delay = max(0, delay - (idx - i) // 2)
        elif i > idx:
            stop_delay = delay + (i - idx) // 3

        actual_dt = stop_dt + datetime.timedelta(minutes=stop_delay)
        passed = actual_dt.timestamp() < now_ts
        time_str = stop_dt.strftime('%H:%M')

        estimated = _compute_estimated_time(time_str, stop_delay) if stop_delay >= 5 else None
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

    j_line_clean = line.lower().replace(" ", "")
    if j_line_clean == 're1':
        operator_name = "ODEG"
    elif j_line_clean.startswith('str') or j_line_clean.startswith('tram') or j_line_clean.startswith('bus'):
        operator_name = "MVB"
    elif j_line_clean.startswith('re') or j_line_clean.startswith('rb') or j_line_clean.startswith('s') or j_line_clean.startswith('ice') or j_line_clean.startswith('ic'):
        operator_name = "DB"
    else:
        operator_name = "MVB"

    return jsonify({
        "line": line,
        "direction": direction if direction else (stops_list[-1] if stops_list else "Endstation"),
        "lineColor": line_color,
        "vehiclePosition": vehicle_pos,
        "progressPercent": progress,
        "totalStops": total_stops,
        "trip_num": None,
        "messages": [],
        "stops": stops,
        "type": classify_line_type(line),
        "operator": operator_name
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
    Queries local Magdeburg stations first, then queries HAFAS clients in parallel.
    Prioritizes Magdeburg stations at the top of the list.
    """
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    # 1. Local Magdeburg stations list
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
    local_matches = [s for s in stations if query_lower in s["name"].lower()]

    results = list(local_matches)
    seen_ids = {item["id"] for item in local_matches}

    try:
        def query_nasa():
            if not nasa_client:
                return []
            try:
                return [{"id": loc.id, "name": loc.name} for loc in nasa_client.locations(query) if loc.id]
            except Exception as ex:
                print(f"[WARN] NASA location search failed: {ex}")
                return []

        def query_db():
            if not db_client:
                return []
            try:
                return [{"id": loc.id, "name": loc.name} for loc in db_client.locations(query) if loc.id]
            except Exception as ex:
                print(f"[WARN] DB location search failed: {ex}")
                return []

        def query_oebb():
            if not oebb_client:
                return []
            try:
                return [{"id": loc.id, "name": loc.name} for loc in oebb_client.locations(query) if loc.id]
            except Exception as ex:
                print(f"[WARN] OEBB location search failed: {ex}")
                return []

        from concurrent.futures import ThreadPoolExecutor
        tasks = [query_nasa, query_db, query_oebb]
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(task) for task in tasks]
            for future in futures:
                try:
                    task_results = future.result(timeout=1.5)
                    for item in task_results:
                        if item["id"] not in seen_ids:
                            results.append(item)
                            seen_ids.add(item["id"])
                except Exception as ex:
                    print(f"[WARN] Parallel search task failed or timed out: {ex}")

    except Exception as e:
        print(f"[ERROR] Search API: {e}")

    # Prioritize Magdeburg stations at the top
    results_magdeburg = [r for r in results if "magdeburg" in r["name"].lower()]
    results_other = [r for r in results if "magdeburg" not in r["name"].lower()]
    results = results_magdeburg + results_other

    return jsonify(results)


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

    # Route to the right client based on station ID length (cascading fallback)
    if station_id and str(station_id).startswith("80"):
        client_order = [db_client, oebb_client, nasa_client]
    else:
        client_order = [nasa_client, db_client]

    client_order = [c for c in client_order if c is not None]

    departures = None
    active_client = None
    db_deps = []

    # Map Magdeburg local plazas and NASA station IDs to DB main station IDs
    MAIN_STATION_MAP = {
        # Local Magdeburg plaza IDs
        "7393": "8010224",  # Magdeburg Willy-Brandt-Platz -> Magdeburg Hbf
        "6929": "8010224",  # Magdeburg Kölner Platz -> Magdeburg Hbf
        "7392": "8010224",  # Magdeburg Hbf local -> Magdeburg Hbf
        
        # NASA (INSA) station IDs mapped to DB station IDs
        "9000001": "8010224",   # Magdeburg Hbf -> Magdeburg Hbf
        "009000001": "8010224",
        "9000002": "8010226",   # Magdeburg-Neustadt -> Magdeburg-Neustadt
        "009000002": "8010226",
        "9000003": "8010225",   # Magdeburg-Buckau -> Magdeburg-Buckau
        "009000003": "8010225",
        "9000004": "8010228",   # Magdeburg-Sudenburg -> Magdeburg-Sudenburg
        "009000004": "8010228",
        "9000015": "8012282",   # Magdeburg-Herrenkrug -> Magdeburg-Herrenkrug
        "009000015": "8012282",
        "9000016": "8012281",   # Magdeburg-Eichenweiler -> Magdeburg-Eichenweiler
        "009000016": "8012281",
    }
    db_station_id = MAIN_STATION_MAP.get(str(station_id))

    def fetch_primary(client_candidate):
        try:
            return client_candidate.departures(
                station=station_id,
                date=search_dt,
                duration=duration,
                max_trips=40
            )
        except Exception as ex:
            print(f"[WARN] Departures call failed for client {client_candidate.profile.__class__.__name__}: {ex}")
            return None

    def fetch_db_aux():
        if not db_client or not db_station_id:
            return []
        try:
            return db_client.departures(
                station=db_station_id,
                date=search_dt,
                duration=duration,
                max_trips=40
            )
        except Exception as ex:
            print(f"[WARN] DB aux departures call failed: {ex}")
            return []

    # If the primary client is NASA and we have a DB station ID, query them in parallel
    if client_order and client_order[0] == nasa_client and db_station_id and db_client:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_prim = executor.submit(fetch_primary, client_order[0])
            future_db = executor.submit(fetch_db_aux)
            departures = future_prim.result()
            db_deps = future_db.result()
        if departures is not None:
            active_client = client_order[0]

    # Fallback cascade if departures is still None
    if departures is None:
        for client_candidate in client_order:
            departures = fetch_primary(client_candidate)
            if departures is not None:
                active_client = client_candidate
                break

    try:
        if active_client and departures is not None:
            result = []
            for dep in departures:
                # Delay in minutes
                delay = None
                if dep.dateTime and dep.delay is not None:
                    delay = int(dep.delay.total_seconds() / 60)

                line_name = clean_db_line_name(dep.name)
                line_type = classify_line_type(line_name)

                # Try to merge real-time delay from DB departures for national rail trips
                if delay is None and line_type in ["regional", "express"] and db_deps:
                    cleaned_prim_line = line_name.lower().replace(" ", "")
                    
                    # Safe local timezone conversion helper
                    def to_local_tz(dt, tz):
                        if dt is None:
                            return None
                        if dt.tzinfo is None:
                            return tz.localize(dt)
                        return dt.astimezone(tz)

                    prim_time = to_local_tz(dep.dateTime, local_tz)
                    for db_dep in db_deps:
                        cleaned_db_line = clean_db_line_name(db_dep.name).lower().replace(" ", "")
                        if cleaned_prim_line == cleaned_db_line or cleaned_prim_line in cleaned_db_line or cleaned_db_line in cleaned_prim_line:
                            db_time = to_local_tz(db_dep.dateTime, local_tz)
                            if prim_time and db_time:
                                time_diff = abs((prim_time - db_time).total_seconds())
                                if time_diff < 300: # 5 minutes window
                                    if db_dep.delay is not None:
                                        delay = int(db_dep.delay.total_seconds() / 60)
                                    else:
                                        # If DB HAFAS has no delay value for this matched train, it is on time (delay = 0)
                                        delay = 0
                                    break

                line_name = clean_db_line_name(dep.name)
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

                # Estimated time (shown for all non-zero real-time delays)
                estimated = _compute_estimated_time(time_str, delay) if (delay is not None and delay != 0) else None

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
    now = datetime.datetime.now(local_tz)
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

    # Try DB client, NASA, then OEBB
    client_order = [db_client, nasa_client, oebb_client]
    client_order = [c for c in client_order if c is not None]

    for client_candidate in client_order:
        try:
            temp_res = client_candidate.profile.request(req_data).res
            if temp_res and temp_res.get('journey'):
                res = temp_res
                active_client = client_candidate
                break
        except Exception as e:
            print(f"[WARN] {client_candidate.profile.__class__.__name__} JourneyDetails failed for {journey_id}: {e}")

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
        journey_date_str = journey.get('date')
        if not journey_date_str:
            journey_date_str = datetime.datetime.now(local_tz).strftime('%Y%m%d')
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
            journey_line = clean_db_line_name(first_prod.get('name', fallback_line))

        # Resolve operator (Verkehrsunternehmen)
        operator_name = None
        opL = common.get('opL', [])
        prodL = common.get('prodL', [])
        
        # Try to resolve operator from the first product
        if prod_list:
            first_prod = prod_list[0]
            prod_idx = first_prod.get('prodX', 0)
            if prod_idx < len(prodL):
                product = prodL[prod_idx]
                opr_idx = product.get('oprX')
                if opr_idx is not None and opr_idx < len(opL):
                    operator_name = opL[opr_idx].get('name', opL[opr_idx].get('code'))
                
                if not operator_name:
                    prod_ctx = product.get('prodCtx', {})
                    operator_name = prod_ctx.get('op')
        
        if not operator_name:
            j_line_clean = journey_line.lower().replace(" ", "")
            if j_line_clean.startswith('str') or j_line_clean.startswith('tram'):
                operator_name = "MVB"
            elif j_line_clean == 're1':
                operator_name = "ODEG"
            elif j_line_clean.startswith('re') or j_line_clean.startswith('rb') or j_line_clean.startswith('s') or j_line_clean.startswith('ice') or j_line_clean.startswith('ic'):
                operator_name = "DB"
            elif j_line_clean.startswith('bus'):
                digits = ''.join(c for c in j_line_clean if c.isdigit())
                if digits and int(digits) <= 99:
                    operator_name = "MVB"
                else:
                    operator_name = "BUS_OTHER"
            else:
                if "odeg" in j_line_clean:
                    operator_name = "ODEG"
                elif "pvgs" in j_line_clean:
                    operator_name = "PVGS"
                elif "börde" in j_line_clean or "boerde" in j_line_clean:
                    operator_name = "BördeBus"
                elif "njl" in j_line_clean or "jerichow" in j_line_clean:
                    operator_name = "NJL"
                elif "kvg" in j_line_clean or "salzland" in j_line_clean:
                    operator_name = "KVG"
                elif "flix" in j_line_clean:
                    operator_name = "FlixBus"
                elif "havag" in j_line_clean or "halle" in j_line_clean:
                    operator_name = "HAVAG"
                elif "metronom" in j_line_clean:
                    operator_name = "metronom"
                else:
                    operator_name = "MVB"

        # Explicit override for RE1 (which is operated by ODEG)
        if journey_line.lower().replace(" ", "") == 're1':
            operator_name = "ODEG"

        journey_direction = journey.get('dirTxt', fallback_direction)
        line_color = get_line_color(journey_line, operator_name)

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

            # Parse arrival time
            arr_time_str = None
            arr_delay = None
            if a_time_s:
                try:
                    hour = int(a_time_s[0:2])
                    arr_time_str = f"{hour % 24:02d}:{a_time_s[2:4]}"
                except Exception:
                    arr_time_str = f"{a_time_s[0:2]}:{a_time_s[2:4]}"
                if a_time_r:
                    arr_delay = parse_hafas_time(a_time_r) - parse_hafas_time(a_time_s)
                    if arr_delay < -1000: arr_delay += 1440
                    elif arr_delay > 1000: arr_delay -= 1440

            # Parse departure time
            dep_time_str = None
            dep_delay = None
            if d_time_s:
                try:
                    hour = int(d_time_s[0:2])
                    dep_time_str = f"{hour % 24:02d}:{d_time_s[2:4]}"
                except Exception:
                    dep_time_str = f"{d_time_s[0:2]}:{d_time_s[2:4]}"
                if d_time_r:
                    dep_delay = parse_hafas_time(d_time_r) - parse_hafas_time(d_time_s)
                    if dep_delay < -1000: dep_delay += 1440
                    elif dep_delay > 1000: dep_delay -= 1440

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
            # Calculate passed state dynamically using actual delayed departure/arrival time if available
            stop_time_raw = s.get('dTimeR', s.get('dTimeS', s.get('aTimeR', s.get('aTimeS'))))
            if stop_time_raw and journey_date_str:
                try:
                    base_dt = datetime.datetime.strptime(journey_date_str, '%Y%m%d')
                    base_dt = local_tz.localize(base_dt)
                    h = int(stop_time_raw[0:2])
                    m = int(stop_time_raw[2:4])
                    s_sec = int(stop_time_raw[4:6]) if len(stop_time_raw) >= 6 else 0
                    days_add = h // 24
                    h = h % 24
                    stop_dt = base_dt + datetime.timedelta(days=days_add, hours=h, minutes=m, seconds=s_sec)
                    if stop_dt:
                        passed = stop_dt < now
                except Exception as e:
                    print(f"[WARN] Failed to parse HAFAS stop time {stop_time_raw} with date {journey_date_str}: {e}")

            # Get the line name and color for this stop
            stop_line = journey_line
            prodL = common.get('prodL', [])
            prod_idx = s.get('dProdX', s.get('aProdX'))
            if prod_idx is not None and prod_idx < len(prodL):
                stop_line = clean_db_line_name(prodL[prod_idx].get('name', journey_line))
            stop_color = get_line_color(stop_line, operator_name)

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

            # Estimated time (shown for all non-zero real-time delays)
            estimated = _compute_estimated_time(time_str, delay) if (delay is not None and delay != 0) else None

            stops.append({
                "name": name,
                "time": time_str,
                "delay": delay,
                "arrTime": arr_time_str,
                "arrDelay": arr_delay,
                "depTime": dep_time_str,
                "depDelay": dep_delay,
                "passed": passed,
                "platform": pltf,
                "cancelled": cancelled,
                "day_offset": day_offset,
                "estimatedTime": estimated,
                "isVehicleHere": False,  # set below
                "line": stop_line,
                "lineColor": stop_color,
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

        # ---- Detect Line Transitions from Operator Messages ----
        transition_info = None
        transition_color = None
        
        def _stop_names_match(n1: str, n2: str) -> bool:
            c1 = n1.lower().replace("magdeburg,", "").replace(" ", "").strip()
            c2 = n2.lower().replace("magdeburg,", "").replace(" ", "").strip()
            return c1 in c2 or c2 in c1

        for msg in messages:
            txt = msg.get('text', '')
            # Match 1: "verkehrt ab <stop> als <line>" or "weiter ab <stop> als <line>"
            m1 = re.search(r'(?:verkehrt|weiter)\s+ab\s+(.+?)\s+als\s+(Str\s*\d+|Bus\s*\d+|Linie\s*\d+|\d+)', txt, re.IGNORECASE)
            if m1:
                transition_info = {
                    "stopName": m1.group(1).strip(),
                    "newLine": m1.group(2).strip()
                }
                break
            # Match 2: "als <line> ab <stop>"
            m2 = re.search(r'als\s+(Str\s*\d+|Bus\s*\d+|Linie\s*\d+|\d+)\s+ab\s+(.+)', txt, re.IGNORECASE)
            if m2:
                transition_info = {
                    "stopName": m2.group(2).strip(),
                    "newLine": m2.group(1).strip()
                }
                break

        if transition_info:
            transition_color = get_line_color(transition_info["newLine"])
            trans_idx = -1
            for i, s in enumerate(stops):
                if _stop_names_match(transition_info["stopName"], s["name"]):
                    trans_idx = i
                    s["transitionLine"] = transition_info["newLine"]
                    break
            
            if trans_idx != -1:
                line_after = normalize_line_name(transition_info["newLine"])
                line_before = normalize_line_name(fallback_line) if fallback_line else normalize_line_name(journey_line)
                
                print(f"[DEBUG_TRANS] Initial: line_before={line_before}, line_after={line_after}, fallback_line={fallback_line}, journey_line={journey_line}", flush=True)

                # If resolved to the same name, fall back to journey_line for line_before
                if line_before.lower().replace(" ", "") == line_after.lower().replace(" ", ""):
                    line_before = normalize_line_name(journey_line)
                    # If still the same, try to resolve from the main line name if fallback_line is different
                    if line_before.lower().replace(" ", "") == line_after.lower().replace(" ", "") and fallback_line:
                        line_before = normalize_line_name(fallback_line)

                # If still resolved to the same, look at the first stop's line name as a fallback
                if line_before.lower().replace(" ", "") == line_after.lower().replace(" ", ""):
                    first_stop_line = stops[0].get("line")
                    if first_stop_line and normalize_line_name(first_stop_line).lower().replace(" ", "") != line_after.lower().replace(" ", ""):
                        line_before = normalize_line_name(first_stop_line)

                print(f"[DEBUG_TRANS] Final: line_before={line_before}, line_after={line_after}", flush=True)

                # Only apply override if we resolved two distinct lines
                if line_before.lower().replace(" ", "") != line_after.lower().replace(" ", ""):
                    for i, s in enumerate(stops):
                        if i < trans_idx:
                            s["line"] = line_before
                            s["lineColor"] = get_line_color(line_before)
                        else:
                            s["line"] = line_after
                            s["lineColor"] = get_line_color(line_after)

        # Operator has already been resolved at the top
        pass

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
            "type": classify_line_type(journey_line),
            "transitionColor": transition_color,
            "operator": operator_name
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

    tram = request.args.get('tram', 'true').lower() == 'true'
    bus = request.args.get('bus', 'true').lower() == 'true'
    regional = request.args.get('regional', 'true').lower() == 'true'
    express = request.args.get('express', 'true').lower() == 'true'

    allowed_modes = {
        'tram': tram,
        'bus': bus,
        'regional': regional,
        'express': express
    }

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
            """Try NASA, DB, then OEBB to resolve a station name to an ID."""
            if name.isdigit():
                return name
            if nasa_client:
                try:
                    locs = nasa_client.locations(name)
                    if locs:
                        return locs[0].id
                except Exception:
                    pass
            if db_client:
                try:
                    locs = db_client.locations(name)
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

        if nasa_client or db_client or oebb_client:
            try:
                resolved_origin = _resolve_location(origin)
            except Exception as e:
                print(f"[WARN] Error resolving origin '{origin}': {e}")
            try:
                resolved_dest = _resolve_location(destination)
            except Exception as e:
                print(f"[WARN] Error resolving destination '{destination}': {e}")

        # Choose the appropriate client (cascading fallback query)
        client_order = [nasa_client]
        if resolved_origin and resolved_dest:
            if len(str(resolved_origin)) >= 7 or len(str(resolved_dest)) >= 7:
                client_order = [db_client, oebb_client, nasa_client]
            else:
                client_order = [nasa_client, db_client]

        client_order = [c for c in client_order if c is not None]

        journeys = None
        active_client = None

        for client_candidate in client_order:
            try:
                journeys = client_candidate.journeys(
                    origin=resolved_origin,
                    destination=resolved_dest,
                    date=search_dt,
                    max_changes=3,
                    max_journeys=5,
                    products=get_profile_products(client_candidate, allowed_modes)
                )
                if journeys is not None:
                    active_client = client_candidate
                    break
            except Exception as ex:
                print(f"[WARN] Journeys planning failed for client {client_candidate.profile.__class__.__name__}: {ex}")

        if active_client and journeys is not None:
            result = []
            for j in journeys:
                legs = []
                non_walk_count = 0
                has_disallowed_mode = False

                for leg in j.legs:
                    # Delays
                    dep_delay = None
                    if leg.departureDelay is not None:
                        dep_delay = int(leg.departureDelay.total_seconds() / 60)
                    arr_delay = None
                    if leg.arrivalDelay is not None:
                        arr_delay = int(leg.arrivalDelay.total_seconds() / 60)

                    line_name = clean_db_line_name(leg.name) if leg.name else "Fußweg"
                    line_type = classify_line_type(line_name, leg.mode.name)

                    if line_type == "tram" and not tram:
                        has_disallowed_mode = True
                    if line_type == "bus" and not bus:
                        has_disallowed_mode = True
                    if line_type == "regional" and not regional:
                        has_disallowed_mode = True
                    if line_type == "express" and not express:
                        has_disallowed_mode = True

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

                if has_disallowed_mode:
                    continue

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
    print(f"[INFO] No HAFAS connections found, returning empty result.")
    return jsonify([])


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

            # Scrape actual publication date/time
            time_str = "Aktuell"
            date_tag = article.find('span', class_='kt-post-date')
            if date_tag:
                time_str = date_tag.get_text(strip=True)

            if title and desc:
                disruptions.append({
                    "id": disruption_id,
                    "title": title,
                    "desc": desc,
                    "time": time_str,
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
    port = int(os.environ.get("PORT", 5000))
    print("=" * 60)
    print("  MVB Magdeburg Transit Backend")
    print(f"  NASA client: {'OK' if nasa_client else 'UNAVAILABLE'}")
    print(f"  OEBB client: {'OK' if oebb_client else 'UNAVAILABLE'}")
    print(f"  Starting on http://0.0.0.0:{port}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=port, debug=True, use_reloader=False)
