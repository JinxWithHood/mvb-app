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
import time
import datetime
import traceback
import hashlib
import html

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

# ---------------------------------------------------------------------------
# Monkeypatch BaseStationBoardRequest.parse_station_board_request
# ---------------------------------------------------------------------------
from pyhafas.profile.base import BaseStationBoardRequest

original_parse_station_board_request = BaseStationBoardRequest.parse_station_board_request

def patched_parse_station_board_request(self, data, departure_arrival_prefix: str):
    legs = original_parse_station_board_request(self, data, departure_arrival_prefix)
    if data and hasattr(data, 'res') and isinstance(data.res, dict):
        jnyL = data.res.get('jnyL', [])
        common = getattr(data, 'common', {}) or {}
        remL = common.get('remL', [])
        himL = common.get('himL', [])
        for i, leg in enumerate(legs):
            if i < len(jnyL):
                raw_leg = jnyL[i]
                leg_msgs = []
                leg_hims = []
                for m in raw_leg.get('msgL', []):
                    m_type = m.get('type')
                    if m_type == 'REM':
                        rx = m.get('remX')
                        if rx is not None and rx < len(remL):
                            rem_item = remL[rx]
                            leg_msgs.append(rem_item.get('txtN') or rem_item.get('txtL') or '')
                    elif m_type == 'HIM':
                        hx = m.get('himX')
                        if hx is not None and hx < len(himL):
                            him_item = himL[hx]
                            leg_hims.append(him_item)
                leg.messages = leg_msgs
                leg.him_messages = leg_hims
                leg.raw_jny = raw_leg
    return legs

BaseStationBoardRequest.parse_station_board_request = patched_parse_station_board_request


def get_profile_products(client, allowed_modes):
    """
    Map generalized allowed_modes keys to profile-specific product names.
    allowed_modes: dict of {'tram': bool, 'bus': bool, 'regional': bool, 'express': bool, 'sbahn': bool}
    """
    profile_class_name = client.profile.__class__.__name__
    products = {}
    
    tram = allowed_modes.get('tram', True)
    bus = allowed_modes.get('bus', True)
    regional = allowed_modes.get('regional', True)
    express = allowed_modes.get('express', True)
    sbahn = allowed_modes.get('sbahn', True)

    if "NASAProfile" in profile_class_name:
        products['tram'] = tram
        products['bus'] = bus
        products['regional'] = regional
        products['suburban'] = sbahn
        products['long_distance'] = express
        products['long_distance_express'] = express
    else:
        products['tram'] = tram
        products['bus'] = bus
        products['regional'] = regional
        products['regional_express'] = regional
        products['suburban'] = sbahn
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
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')   # only this folder is served to the browser
CACHE_DIR = os.path.join(BASE_DIR, 'cache')     # runtime caches (not part of the repo)
os.makedirs(CACHE_DIR, exist_ok=True)

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path='')
CORS(app)

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
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
    # SEV lines (MVB Schienenersatzverkehr)
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
    # S-Bahn
    'S1': '#00975F',
    'S':  '#00975F',
    # HSB
    'HSB': '#8B0000',
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
        _, _, total_mins = parse_hafas_time_string(time_str)
        return total_mins
    except Exception:
        return 0


def parse_hafas_time_string(s: str):
    """
    Parses any HAFAS time string (8-digit DDHHMMSS, 7-digit DHHMMSS, 6-digit HHMMSS, or 4-digit HHMM)
    into:
    - time_str: 'HH:MM' (formatted 24h time, e.g. '00:05')
    - day_offset: int (number of days added, e.g. 0 or 1)
    - total_minutes: int (minutes from midnight of start date, e.g. 1445)
    """
    if not s:
        return None, 0, 0
    s = s.strip()
    day_offset = 0
    hour = 0
    minute = 0

    try:
        if len(s) == 8:
            # DDHHMMSS format (e.g. '01000500' -> day 1, 00:05)
            day_offset = int(s[0:2])
            hour = int(s[2:4])
            minute = int(s[4:6])
        elif len(s) == 7:
            # DHHMMSS format (e.g. '1000500' -> day 1, 00:05)
            day_offset = int(s[0:1])
            hour = int(s[1:3])
            minute = int(s[3:5])
        elif len(s) >= 4:
            # HHMMSS or HHMM format (e.g. '234000' or '250500')
            raw_hour = int(s[0:2])
            day_offset = raw_hour // 24
            hour = raw_hour % 24
            minute = int(s[2:4])
        else:
            return None, 0, 0

        time_fmt = f"{hour:02d}:{minute:02d}"
        total_mins = day_offset * 1440 + hour * 60 + minute
        return time_fmt, day_offset, total_mins
    except Exception:
        return None, 0, 0


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
    # Remove leading DB prefix like "DB S1" -> "S1", "DB RE1" -> "RE1", "DB IC" -> "IC"
    name = re.sub(r'^DB\s+', '', name, flags=re.IGNORECASE)
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
    result = re.sub(r'^(?:Str|STR|str|Tram|TRAM|tram|Bus|BUS|bus|Nachtbus|Linie|LINIE|linie|Line|LINE|line|SEV|sev)\s*', '', name, flags=re.IGNORECASE).strip()
    return result


SEV_INFO_MAP = {
    "40": "Schienenersatzverkehr",
    "41": "Schienenersatzverkehr",
    "42": "Schienenersatzverkehr",
    "43": "Schienenersatzverkehr Sperrung Hallische Str.",
    "44": "Schienenersatzverkehr",
    "45": "Schienenersatzverkehr",
    "46": "Schienenersatzverkehr",
    "47": "Schienenersatzverkehr",
    "48": "Schienenersatzverkehr Sperrung Alter Markt",
    "49": "Schienenersatzverkehr",
}


def classify_line_type(line_name: str, mode_name: str = None, operator_name: str = None) -> str:
    """
    Classify a transit line into one of: 'tram', 'bus', 'sbahn', 'regional', 'express', 'hsb', 'sev', 'walk'.
    Uses heuristics based on line name, operator, and optional HAFAS mode string.
    Lines 40-49 are classified as 'sev' ONLY for MVB (Magdeburger Verkehrsbetriebe).
    """
    if not line_name:
        return "walk"
    if mode_name == 'WALKING':
        return "walk"

    line_lower = line_name.lower().strip()
    op_lower = (operator_name or "").lower().strip()

    # HSB (Harzer Schmalspurbahnen / Brockenbahn)
    if any(k in line_lower or k in op_lower for k in ["hsb", "harzer schmalspur", "brocken", "selketal", "harzquer", "dampf"]):
        return "hsb"

    # Express: ICE, IC, EC, ECE, TGV, RJ, RJX, etc.
    express_keywords = ["ice", "ic", "ec", "ece", "tgv", "rj", "rjx"]
    if any(k == line_lower or line_lower.startswith(k + " ") or line_lower.startswith(k)
           for k in express_keywords):
        return "express"

    # S-Bahn: S1, S 1, S-Bahn, DB S1, etc. (MUST NOT match Str / Tram)
    if not line_lower.startswith("str") and not line_lower.startswith("tram"):
        if (line_lower.startswith("s-bahn") or
            line_lower.startswith("sbahn") or
            line_lower.startswith("s ") or
            bool(re.search(r'\b(s|sbahn|s-bahn)\s*\d+\b', line_lower)) or
            bool(re.match(r'^s\s*\d+', line_lower)) or
            (line_lower.startswith('s') and len(line_lower) > 1 and line_lower[1:].isdigit())):
            return "sbahn"

    # Regional: RE, RB, ERB, etc.
    is_regional = (
        any(line_lower.startswith(k) for k in ["re", "rb", "erb"]) or
        "regional" in line_lower
    )
    if is_regional:
        return "regional"

    # Digits extraction
    clean_num = (line_name.replace(" ", "")
                 .replace("Str", "").replace("STR", "").replace("str", "")
                 .replace("Tram", "").replace("TRAM", "").replace("tram", "")
                 .replace("Bus", "").replace("BUS", "").replace("bus", "")
                 .replace("Linie", "").replace("LINIE", "").replace("linie", "")
                 .replace("SEV", "").replace("sev", "")
                 .replace("Line", "").strip())
    is_num = clean_num.isdigit()

    # Check MVB SEV: lines 40-49 ONLY for MVB (Magdeburg)
    is_mvb = (not operator_name or "mvb" in op_lower or "magdeburg" in op_lower)
    if is_num and 40 <= int(clean_num) <= 49 and is_mvb:
        return "sev"

    # Tram: Tram, Str, or numeric <= 15 (MVB city network)
    is_tram = (
        any(x in line_lower for x in ["str", "tram"]) or
        (is_num and int(clean_num) <= 15 and is_mvb) or
        (line_lower.startswith("n") and clean_num.replace("n", "").replace("N", "").isdigit() and is_mvb)
    )
    if is_tram:
        return "tram"

    return "bus"


def clean_request_stop_note(note_text: str, stop_name: str = "") -> str:
    """Clean and deduplicate raw HAFAS Bedarfshalt notes."""
    if not note_text:
        return "Halt bei Bedarf"
    t = note_text.strip()
    
    # Strip any trailing parenthesized expressions at the very end
    # e.g., (Zeddenick (Sachsen-Anhalt) (Bus))
    while t.endswith(')'):
        paren_depth = 0
        cut_idx = -1
        for i in range(len(t) - 1, -1, -1):
            if t[i] == ')':
                paren_depth += 1
            elif t[i] == '(':
                paren_depth -= 1
                if paren_depth == 0:
                    cut_idx = i
                    break
        if cut_idx != -1:
            t = t[:cut_idx].strip()
        else:
            break

    # Deduplicate repeated sentences or phrases
    parts = [p.strip() for p in t.split('.') if p.strip()]
    seen = []
    for p in parts:
        p_low = p.lower()
        if not any(p_low == s.lower() or p_low in s.lower() for s in seen):
            seen.append(p)
    
    if seen:
        t = '. '.join(seen)
        if not t.endswith('.'):
            t += '.'

    t = re.sub(r'\s+', ' ', t).strip()
    return t


def normalize_station_name(name: str) -> str:
    """Normalize station names for comparison and route matching."""
    if not name:
        return ""
    n = name.lower().replace("magdeburg,", "").replace("magdeburg", "")
    n = re.sub(r'\(.*?\)', '', n)
    n = n.replace("straße", "str.").replace("strasse", "str.")
    n = n.replace("hauptbahnhof", "hbf").replace("s-bahnhof", "s-bf")
    return re.sub(r'\s+', ' ', n).strip()


def detect_diversion(line_name: str, direction: str, messages: list = None,
                     him_messages: list = None, station_name: str = None) -> dict:
    """
    Detects if a trip or departure is affected by an active diversion (Umleitung).
    Returns a dictionary with full diversion parameters or None.
    """
    messages = messages or []
    him_messages = him_messages or []
    line_norm = normalize_line_name(line_name)
    stat_norm = normalize_station_name(station_name or "")

    # Generic HIM / Umleitung parsing (only real HAFAS messages, no hard-coded routes)
    for him in him_messages:
        head = him.get('head', '')
        text = him.get('text', '')
        comb = head + " " + text
        if 'umleitung' in comb.lower() or 'gesperrt' in comb.lower():
            m_route = re.search(
                r'Die\s+(?:Linie\s+|Str\s+|Bus\s*)?(\d+|[A-Z0-9]+)\s+fährt\s+ab\s+([A-Za-z0-9\.\-\s]+?)\s+Umleitung(?:\s+als\s+Ringfahrt)?\s+über\s+(.+?)\s+zur\s+Haltestelle\s+([^,\.]+)',
                comb, re.IGNORECASE
            )
            if m_route and normalize_line_name(m_route.group(1)) == line_norm:
                from_st = m_route.group(2).strip()
                via_str = m_route.group(3).strip()
                to_st = m_route.group(4).strip()
                
                cancelled_list = []
                m_canc = re.search(r'Die\s+Haltestellen\s+(.+?)\s+entfallen', comb, re.IGNORECASE)
                if m_canc:
                    cancelled_list = [s.strip() for s in re.split(r'[,und]+', m_canc.group(1)) if s.strip()]
                    
                repl_str = ""
                m_repl = re.search(r'Ersatzverkehr(?:\s+Richtung\s+[^:]+)?:?\s*(.+)', comb, re.IGNORECASE)
                if m_repl:
                    repl_str = m_repl.group(1).strip()
                    
                st_canc = any(normalize_station_name(cs) in stat_norm for cs in cancelled_list if stat_norm)
                return {
                    "isDiverted": True,
                    "title": head or "Umleitung",
                    "text": re.sub(r'<[^>]+>', ' ', text).strip(),
                    "line": line_norm,
                    "fromStation": from_st,
                    "originalDirection": direction,
                    "newDirection": to_st,
                    "cancelledStops": cancelled_list,
                    "diversionStops": [s.strip() for s in re.split(r'[,und]+', via_str) if s.strip()] + [to_st],
                    "replacement": repl_str,
                    "stationCancelled": st_canc
                }

    return None



def get_line_color(line_name: str, operator_name: str = None) -> str:
    """
    Look up the canonical hex colour for a transit line.
    If operator_name is not 'MVB', returns standard colors for that operator.
    For MVB, returns the canonical line color from LINE_COLORS.
    """
    if not line_name:
        return '#888888'

    raw_clean = line_name.strip()
    norm_key = normalize_line_name(line_name)
    line_lower = line_name.lower().replace(" ", "")
    op_clean = operator_name.upper().replace(" ", "") if operator_name else ""

    # 1. Direct LINE_COLORS lookup first (matches '1', '2', '9', 'Str 9', '48', 'N1', etc.)
    for k in [norm_key, norm_key.replace(" ", ""), raw_clean, raw_clean.replace(" ", "")]:
        if k in LINE_COLORS:
            return LINE_COLORS[k]

    digits = ''.join(c for c in norm_key if c.isdigit())
    if digits and digits in LINE_COLORS:
        return LINE_COLORS[digits]

    # HSB (Harzer Schmalspurbahnen / Brockenbahn)
    if "HSB" in op_clean or any(k in line_lower for k in ["hsb", "brocken", "harzer", "selketal", "harzquer", "dampf"]):
        return '#8B0000'

    # S-Bahn (e.g. S1, S2, but NEVER Str / Tram)
    if not line_lower.startswith('str') and not line_lower.startswith('tram'):
        if (line_lower.startswith('s-bahn') or
            line_lower.startswith('sbahn') or
            re.match(r'^s\s*\d+', line_lower) or
            line_lower == 's'):
            return '#00975F'

    # 2. Enforce operator-specific coloring for non-MVB trains/buses
    if "ODEG" in op_clean:
        return '#2C6930'
    elif "PVGS" in op_clean:
        return '#0A356A'
    elif "BÖRDE" in op_clean or "BOERDE" in op_clean:
        return '#2C7E9C'
    elif "NJL" in op_clean:
        return '#10355C'
    elif "KVG" in op_clean:
        return '#EE9A00'
    elif "FLIX" in op_clean:
        return '#73C000'
    elif "HAVAG" in op_clean:
        return '#D01B13'
    elif "METRONOM" in op_clean:
        return '#004F9F'
    elif "DB" in op_clean or "DEUTSCHEBAHN" in op_clean:
        if line_name.lower().startswith('s'):
            return '#00975F'
        return '#C00000'

    # 3. Fallback color
    if line_lower.startswith('str') or line_lower.startswith('tram'):
        return '#006651'  # Default MVB tram green
    elif line_lower.startswith('s') and any(c.isdigit() for c in line_lower) and not line_lower.startswith('str'):
        return '#00975F'  # Default S-Bahn green
    elif line_lower.startswith('re') or line_lower.startswith('rb'):
        return '#C00000'  # Default RE/RB red
    return '#5F7D95'  # Default bus slate blue


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
        origin_name = station_name if station_name else "Start"
        dest_name = direction if direction else "Ziel"
        stops_list = [origin_name]
        if dest_name.lower().replace("magdeburg,", "").strip() != origin_name.lower().replace("magdeburg,", "").strip():
            stops_list.append(dest_name)
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
        day_offset = max(0, (stop_dt.date() - anchor_dt.date()).days)

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
            "day_offset": day_offset,
            "estimatedTime": estimated,
            "isVehicleHere": False,  # will be set below
            "isRequestStop": False,
            "requestStopNote": None
        })

    # Mark the vehicle position
    if 0 <= vehicle_pos < len(stops):
        stops[vehicle_pos]["isVehicleHere"] = True

    line_color = get_line_color(line)
    progress = int((vehicle_pos / max(total_stops - 1, 1)) * 100)

    j_line_clean = line.lower().replace(" ", "")
    if any(k in j_line_clean for k in ['hsb', 'brocken', 'harzer', 'selketal', 'harzquer', 'dampf']):
        operator_name = "HSB"
    elif j_line_clean == 're1':
        operator_name = "ODEG"
    elif j_line_clean.startswith('str') or j_line_clean.startswith('tram') or j_line_clean.startswith('bus'):
        operator_name = "MVB"
    elif j_line_clean.startswith('re') or j_line_clean.startswith('rb') or j_line_clean.startswith('s') or j_line_clean.startswith('ice') or j_line_clean.startswith('ic'):
        operator_name = "DB"
    else:
        operator_name = "MVB"

    line_type = classify_line_type(line, operator_name=operator_name)
    line_color = get_line_color(line, operator_name=operator_name)

    clean_j_num = normalize_line_name(line)
    sev_info = SEV_INFO_MAP.get(clean_j_num, "Schienenersatzverkehr") if line_type == "sev" else None
    messages = []
    if sev_info:
        messages.append({"text": sev_info, "warning": False, "is_sev": True})

    return jsonify({
        "line": line,
        "direction": direction if direction else (stops_list[-1] if stops_list else "Endstation"),
        "lineColor": line_color,
        "vehiclePosition": vehicle_pos,
        "progressPercent": progress,
        "totalStops": total_stops,
        "trip_num": None,
        "messages": messages,
        "stops": stops,
        "type": line_type,
        "isSEV": (line_type == "sev"),
        "sev_info": sev_info,
        "operator": operator_name
    })


# ===================================================================
#  ROUTES
# ===================================================================

@app.route('/')
def index():
    """Serve the frontend SPA."""
    return send_from_directory(PUBLIC_DIR, 'index.html')


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

    # 1. Local Magdeburg stations list with verified HAFAS IDs
    stations = [
        {"id": "7393", "name": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz"},
        {"id": "8010224", "name": "Magdeburg Hbf"},
        {"id": "6929", "name": "Magdeburg, Hauptbahnhof/Kölner Platz"},
        {"id": "7333", "name": "Magdeburg, Alter Markt"},
        {"id": "7330", "name": "Magdeburg, Hasselbachplatz (Tram/Bus)"},
        {"id": "3846", "name": "Magdeburg, City Carré"},
        {"id": "2985", "name": "Magdeburg, ZOB"},
        {"id": "7306", "name": "Magdeburg, Sudenburg, Braunlager Str."},
        {"id": "7308", "name": "Magdeburg, Sudenburg, Kroatenweg"},
        {"id": "3666", "name": "Magdeburg, Reform"},
        {"id": "7343", "name": "Magdeburg, Reform, Werner-Seelenbinder-Str."},
        {"id": "7349", "name": "Magdeburg, Neustädter See"},
        {"id": "7414", "name": "Magdeburg, Buckau (Wasserwerk)"},
        {"id": "7320", "name": "Magdeburg, Diesdorf"},
        {"id": "7520", "name": "Magdeburg, Herrenkrug (Tram)"},
        {"id": "7517", "name": "Magdeburg, Kastanienstr."},
        {"id": "7389", "name": "Magdeburg, Olvenstedter Platz"},
        {"id": "5251", "name": "Magdeburg, Messegelände/Elbauenpark"},
        {"id": "7483", "name": "Magdeburg, Arenen"},
        {"id": "7528", "name": "Magdeburg, Barleber See (Tram/Bus)"}
    ]
    query_lower = query.lower()
    local_matches = [s for s in stations if query_lower in s["name"].lower()]

    results = list(local_matches)
    seen_ids = {item["id"] for item in local_matches}
    seen_names = {item["name"].strip().lower() for item in local_matches}

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
                        iid = item.get("id")
                        norm_name = item.get("name", "").strip().lower()
                        if iid and iid not in seen_ids and norm_name not in seen_names:
                            results.append(item)
                            seen_ids.add(iid)
                            seen_names.add(norm_name)
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

    # Prioritise NASA client for all regional / central German stations (including DB 8010224 Magdeburg Hbf)
    # as NASA has live real-time delays for DB, RE, RB, IC, ICE, S1 and MVB
    client_order = [nasa_client, db_client, oebb_client]
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

    # If still None or empty, try auto-resolving station_id via NASA locations
    if departures is None and nasa_client:
        try:
            locs = nasa_client.locations(station_id)
            if locs and locs[0].id != station_id:
                print(f"[INFO] Auto-resolved invalid station_id {station_id} -> {locs[0].id} ({locs[0].name})")
                resolved_id = locs[0].id
                departures = nasa_client.departures(
                    station=resolved_id,
                    date=search_dt,
                    duration=duration,
                    max_trips=40
                )
                if departures is not None:
                    active_client = nasa_client
        except Exception as ex:
            print(f"[WARN] Auto-resolution failed for {station_id}: {ex}")

    try:
        if active_client and departures is not None:
            result = []
            for dep in departures:
                # Delay in minutes
                delay = None
                if dep.dateTime and dep.delay is not None:
                    delay = int(dep.delay.total_seconds() / 60)

                line_name = clean_db_line_name(dep.name)
                
                # Operator detection
                dep_op = getattr(dep, 'operator', None)
                if not dep_op and hasattr(dep, 'product') and dep.product:
                    dep_op = getattr(dep.product, 'operator', None)
                
                line_lower_check = line_name.lower().replace(" ", "")
                if any(k in line_lower_check for k in ['hsb', 'brocken', 'harzer', 'selketal', 'harzquer', 'dampf']):
                    dep_op = "HSB"

                line_type = classify_line_type(line_name, operator_name=dep_op)

                # Try to merge real-time delay from DB departures for national rail trips
                if delay is None and line_type in ["regional", "express", "sbahn"] and db_deps:
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
                                        delay = 0
                                    break

                line_color = get_line_color(line_name, operator_name=dep_op)

                # Cancelled detection
                cancelled = getattr(dep, 'cancelled', False)
                if not cancelled:
                    cancelled = getattr(dep, 'dCncl', False)

                # Realtime status
                rt_status = _realtime_status(delay, cancelled)

                # Diversion detection & handling
                dep_msgs = getattr(dep, 'messages', [])
                dep_hims = getattr(dep, 'him_messages', [])
                req_station_name = request.args.get('station_name', '')
                if not req_station_name and hasattr(dep, 'station') and dep.station:
                    req_station_name = getattr(dep.station, 'name', '')

                div_info = detect_diversion(
                    line_name=line_name,
                    direction=dep.direction,
                    messages=dep_msgs,
                    him_messages=dep_hims,
                    station_name=req_station_name
                )

                is_diverted = False
                original_direction = None
                dep_direction = dep.direction
                if div_info:
                    is_diverted = True
                    original_direction = dep.direction
                    dep_direction = div_info["newDirection"]
                    if not div_info.get("stationCancelled", False):
                        cancelled = False
                    else:
                        cancelled = True
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
                dep_raw_id = str(dep.id) if hasattr(dep, 'id') and dep.id else f"mock_j_{line_name.replace(' ', '')}_{time_str.replace(':', '')}_{idx}"
                is_sev = (line_type == "sev")
                clean_dep_num = normalize_line_name(line_name)
                sev_info = SEV_INFO_MAP.get(clean_dep_num, "Schienenersatzverkehr") if is_sev else None

                result.append({
                    "id": dep_raw_id,
                    "journey_id": dep_raw_id,
                    "line": line_name,
                    "raw_line": line_name,
                    "direction": dep_direction,
                    "originalDirection": original_direction if is_diverted else None,
                    "isDiverted": is_diverted,
                    "diversion": div_info if is_diverted else None,
                    "diversionInfo": (div_info["title"] + ": " + div_info["text"]) if is_diverted else None,
                    "time": time_str,
                    "delay": delay,
                    "type": line_type,
                    "isSEV": is_sev,
                    "sevInfo": sev_info,
                    "day_offset": day_offset,
                    "cancelled": cancelled,
                    "lineColor": line_color,
                    "realtimeStatus": rt_status,
                    "estimatedTime": estimated,
                    "platform": platform,
                    "operator": dep_op or ("HSB" if line_type == "hsb" else None)
                })

            return jsonify(result)
    except Exception as e:
        print(f"[ERROR] HAFAS departures: {e}")
        traceback.print_exc()

    return jsonify([])


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

    # Prioritise NASA client for live journey details in Saxony-Anhalt
    client_order = [nasa_client, oebb_client]
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
        
        if operator_name:
            op_low = operator_name.lower()
            if any(k in op_low or k in journey_line.lower() for k in ['hsb', 'brocken', 'harzer', 'selketal', 'harzquer', 'dampf']):
                operator_name = "HSB"
        else:
            j_line_clean = journey_line.lower().replace(" ", "")
            if any(k in j_line_clean for k in ['hsb', 'brocken', 'harzer', 'selketal', 'harzquer', 'dampf']):
                operator_name = "HSB"
            elif j_line_clean.startswith('str') or j_line_clean.startswith('tram'):
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
            arr_time_str, arr_day_offset, arr_mins_s = parse_hafas_time_string(a_time_s)
            arr_delay = None
            if a_time_s and a_time_r:
                _, _, arr_mins_r = parse_hafas_time_string(a_time_r)
                arr_delay = arr_mins_r - arr_mins_s
                if arr_delay < -1000: arr_delay += 1440
                elif arr_delay > 1000: arr_delay -= 1440

            # Parse departure time
            dep_time_str, dep_day_offset, dep_mins_s = parse_hafas_time_string(d_time_s)
            dep_delay = None
            if d_time_s and d_time_r:
                _, _, dep_mins_r = parse_hafas_time_string(d_time_r)
                dep_delay = dep_mins_r - dep_mins_s
                if dep_delay < -1000: dep_delay += 1440
                elif dep_delay > 1000: dep_delay -= 1440

            planned = d_time_s if d_time_s else a_time_s
            actual = d_time_r if d_time_r else a_time_r

            time_str, day_offset, planned_mins = parse_hafas_time_string(planned)
            if not day_offset:
                day_offset = dep_day_offset or arr_day_offset or 0

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
                raw_prod = prodL[prod_idx].get('name', journey_line)
                cleaned_prod = clean_db_line_name(raw_prod)
                if cleaned_prod and any(c.isdigit() for c in cleaned_prod):
                    stop_line = cleaned_prod
                else:
                    stop_line = journey_line

            stop_color = get_line_color(stop_line, operator_name)
            if stop_color == '#8E8E93' or stop_color == '#5F7D95':
                stop_color = line_color

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

            # Check request stop / Halt bei Bedarf flags & remarks (only for non-MVB regional carriers)
            is_mvb = (not operator_name or "mvb" in operator_name.lower() or "magdeburg" in operator_name.lower() or stop_line.lower().startswith("str") or stop_line.lower().startswith("tram"))
            stop_req_note = None
            is_req_stop = False
            
            if not is_mvb:
                is_req_stop = bool(s.get('dReqStop') or s.get('aReqStop') or s.get('requestStop') or s.get('type') == 'R')
                stop_msg_list = s.get('msgL', [])
                remL_common = common.get('remL', [])
                for s_msg in stop_msg_list:
                    remX = s_msg.get('remX')
                    if remX is not None and remX < len(remL_common):
                        rem_item = remL_common[remX]
                        txt_val = rem_item.get('txtN', rem_item.get('txtL', ''))
                        if txt_val:
                            txt_lower = txt_val.lower()
                            if any(kw in txt_lower for kw in ['bedarf', 'request', 'verlangen', 'rufbus', 'anrufbus']):
                                is_req_stop = True
                                stop_req_note = txt_val
                                break
                if is_req_stop and not stop_req_note:
                    stop_req_note = "Halt bei Bedarf"

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
                "isRequestStop": is_req_stop,
                "requestStopNote": stop_req_note,
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

        is_mvb_trip = (not operator_name or "mvb" in operator_name.lower() or "magdeburg" in operator_name.lower())
        if not is_mvb_trip:
            for msg in messages:
                txt = msg.get('text', '')
                txt_lower = txt.lower()
                if any(kw in txt_lower for kw in ['rufbus', 'anrufbus', 'voranmeldung']) and any(c.isdigit() for c in txt):
                    for s_item in stops:
                        clean_s_name = s_item['name'].lower().replace("magdeburg,", "").strip()
                        if clean_s_name and clean_s_name in txt_lower:
                            s_item['isRequestStop'] = True
                            s_item['requestStopNote'] = clean_request_stop_note(txt, s_item['name'])

        # ---- Detect Line Transitions from Stop-Level and Journey Messages ----
        transition_info = None
        transition_color = None
        initial_line = fallback_line if fallback_line else journey_line
        
        def _stop_names_match(n1: str, n2: str) -> bool:
            c1 = n1.lower().replace("magdeburg,", "").replace(" ", "").strip()
            c2 = n2.lower().replace("magdeburg,", "").replace(" ", "").strip()
            return c1 in c2 or c2 in c1

        # 1. First priority: check messages attached directly to individual stops
        for i, s_raw in enumerate(stops_raw):
            s_msgs = s_raw.get('msgL', [])
            for sm in s_msgs:
                rx = sm.get('remX')
                if rx is not None and rx < len(remL):
                    txt = remL[rx].get('txtN', remL[rx].get('txtL', ''))
                    # e.g. "Verkehrt ab hier als Str 5 in Richtung Klinikum Olvenstedt"
                    m = re.search(r'verkehrt\s+ab\s+hier\s+als\s+(Str\s*\d+|Bus\s*\d+|Linie\s*\d+|\d+)(?:\s+in\s+Richtung\s+([^\.]+))?', txt, re.IGNORECASE)
                    if m:
                        cand_line = m.group(1).strip()
                        cand_dir = m.group(2).strip() if m.group(2) else None
                        if i == 0:
                            initial_line = cand_line
                        else:
                            transition_info = {
                                "stopIndex": i,
                                "newLine": cand_line,
                                "newDirection": cand_dir
                            }
                            break
            if transition_info:
                break

        # 2. Second priority: check journey-level messages
        if not transition_info:
            all_msg_texts = []
            for jm in msgL:
                rx = jm.get('remX')
                if rx is not None and rx < len(remL):
                    all_msg_texts.append(remL[rx].get('txtN', remL[rx].get('txtL', '')))
            for rem in remL:
                all_msg_texts.append(rem.get('txtN', rem.get('txtL', '')))

            for txt in all_msg_texts:
                if not txt:
                    continue
                # Match: "verkehrt ab <stop> als <line> [in Richtung <dir>]" or "weiter ab <stop> als <line>"
                m1 = re.search(r'(?:verkehrt|weiter)\s+ab\s+(.+?)\s+als\s+(Str\s*\d+|Bus\s*\d+|Linie\s*\d+|\d+)(?:\s+in\s+Richtung\s+([^\.]+))?', txt, re.IGNORECASE)
                if m1 and m1.group(1).strip().lower() != 'hier':
                    stop_name_target = m1.group(1).strip()
                    cand_line = m1.group(2).strip()
                    cand_dir = m1.group(3).strip() if m1.group(3) else None
                    for idx, s in enumerate(stops):
                        if idx > 0 and _stop_names_match(stop_name_target, s["name"]):
                            transition_info = {
                                "stopIndex": idx,
                                "newLine": cand_line,
                                "newDirection": cand_dir
                            }
                            break
                    if transition_info:
                        break
                # Match: "als <line> ab <stop>"
                m2 = re.search(r'als\s+(Str\s*\d+|Bus\s*\d+|Linie\s*\d+|\d+)\s+ab\s+(.+)', txt, re.IGNORECASE)
                if m2:
                    stop_name_target = m2.group(2).strip()
                    cand_line = m2.group(1).strip()
                    for idx, s in enumerate(stops):
                        if idx > 0 and _stop_names_match(stop_name_target, s["name"]):
                            transition_info = {
                                "stopIndex": idx,
                                "newLine": cand_line,
                                "newDirection": None
                            }
                            break
                    if transition_info:
                        break

        if transition_info:
            trans_idx = transition_info["stopIndex"]
            transition_color = get_line_color(transition_info["newLine"])
            
            if 0 <= trans_idx < len(stops):
                stops[trans_idx]["transitionLine"] = transition_info["newLine"]
                if transition_info.get("newDirection"):
                    stops[trans_idx]["transitionDirection"] = transition_info["newDirection"]

                line_after = normalize_line_name(transition_info["newLine"])
                line_before = normalize_line_name(initial_line)

                for i, s in enumerate(stops):
                    if i < trans_idx:
                        s["line"] = line_before
                        s["lineColor"] = get_line_color(line_before)
                    else:
                        s["line"] = line_after
                        s["lineColor"] = get_line_color(line_after)

        j_type = classify_line_type(journey_line, operator_name=operator_name)
        clean_j_num = normalize_line_name(journey_line)
        sev_info = SEV_INFO_MAP.get(clean_j_num, "Schienenersatzverkehr") if j_type == "sev" else None
        if sev_info and not any(sev_info.lower() in m.get("text", "").lower() for m in messages):
            messages.insert(0, {"text": sev_info, "warning": False, "is_sev": True})

        # ---- Detect and Handle Diversions (Umleitungen) ----
        himL = common.get('himL', [])
        journey_hims = []
        for m in msgL:
            if m.get('type') == 'HIM':
                hx = m.get('himX')
                if hx is not None and hx < len(himL):
                    journey_hims.append(himL[hx])

        div_info = detect_diversion(
            line_name=journey_line,
            direction=journey_direction,
            messages=[m.get('text', '') for m in messages],
            him_messages=journey_hims or himL,
            station_name=station_name
        )

        is_diverted = False
        if div_info:
            is_diverted = True
            journey_direction = div_info["newDirection"]

            # Filter out cancelled / ghost stops from the regular schedule that occur after deviation point
            dev_station_norm = normalize_station_name(div_info["fromStation"])
            
            cleaned_stops = []
            dev_reached = False
            dev_idx = -1
            
            for s_idx, s in enumerate(stops):
                s_name_norm = normalize_station_name(s["name"])
                
                if dev_station_norm in s_name_norm or s_name_norm in dev_station_norm:
                    dev_reached = True
                
                # Check if this stop is one of the explicitly cancelled stops
                is_cancelled_target = any(normalize_station_name(cs) in s_name_norm or s_name_norm in normalize_station_name(cs) for cs in div_info.get("cancelledStops", []))
                if is_cancelled_target:
                    continue
                
                # Skip duplicate / scheduled ghost stops after the diversion point that were cancelled
                if dev_reached and s.get("cancelled", False):
                    continue
                
                cleaned_stops.append(s)
                if dev_reached and dev_idx == -1 and (dev_station_norm in s_name_norm or s_name_norm in dev_station_norm):
                    dev_idx = len(cleaned_stops) - 1

            if len(cleaned_stops) > 0:
                stops = cleaned_stops

            # Tag only the diversion loop stops with isDiversion = True
            div_names_norm = [normalize_station_name(ds) for ds in div_info.get("diversionStops", [])]
            for s in stops:
                s_name_norm = normalize_station_name(s["name"])
                if any(dn in s_name_norm or s_name_norm in dn for dn in div_names_norm):
                    s["isDiversion"] = True
                else:
                    s["isDiversion"] = False

            # Recompute vehicle position and progress
            vehicle_pos = 0
            for i, s in enumerate(stops):
                if s.get("passed", False):
                    vehicle_pos = i
                s["isVehicleHere"] = False
            if 0 <= vehicle_pos < len(stops):
                stops[vehicle_pos]["isVehicleHere"] = True
            total_stops = len(stops)
            progress = int((vehicle_pos / max(total_stops - 1, 1)) * 100) if total_stops > 0 else 0

            # Informative diversion banner built from the real HAFAS message
            cancelled_txt = ', '.join(div_info.get('cancelledStops', []))
            div_alert_text = f"Umleitung: Fahrt verkehrt ab {div_info.get('fromStation', '')} über eine geänderte Strecke zur {journey_direction}."
            if cancelled_txt:
                div_alert_text += f" Haltestellen {cancelled_txt} entfallen."
            if div_info.get('replacement'):
                div_alert_text += f" {div_info['replacement']}"
            messages = [{"text": div_alert_text, "warning": True, "is_diversion": True}] + messages

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
            "type": j_type,
            "isSEV": (j_type == "sev"),
            "sev_info": sev_info,
            "transitionColor": transition_color,
            "isDiverted": is_diverted,
            "diversion": div_info if is_diverted else None,
            "cancelledStops": div_info.get("cancelledStops") if is_diverted else None,
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
    sbahn = request.args.get('sbahn', 'true').lower() == 'true'

    allowed_modes = {
        'tram': tram,
        'bus': bus,
        'regional': regional,
        'express': express,
        'sbahn': sbahn
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
        client_order = [nasa_client, db_client, oebb_client]
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
                    if (line_type == "bus" or line_type == "sev") and not bus:
                        has_disallowed_mode = True
                    if line_type == "sbahn" and not sbahn:
                        has_disallowed_mode = True
                    if (line_type == "regional" or line_type == "hsb") and not regional:
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

                    is_sev = (line_type == "sev")
                    display_line = line_name
                    if is_sev and not line_name.upper().startswith("SEV"):
                        display_line = f"SEV {line_name}"

                    legs.append({
                        "line": display_line,
                        "raw_line": line_name,
                        "origin": leg.origin.name,
                        "destination": leg.destination.name,
                        "departure_time": leg.departure.strftime('%H:%M') if leg.departure else "",
                        "departure_delay": dep_delay,
                        "departure_day_offset": dep_day_offset,
                        "arrival_time": leg.arrival.strftime('%H:%M') if leg.arrival else "",
                        "arrival_delay": arr_delay,
                        "arrival_day_offset": arr_day_offset,
                        "type": line_type,
                        "isSEV": is_sev,
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

    # Scraping failed: report an error instead of showing invented disruptions
    return jsonify({"error": "Verkehrsmelder derzeit nicht erreichbar"}), 502


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


# -------------------------------------------------------------------
# GET /api/news  —  MVB Aktuelles & Magazin (from https://www.mvbnet.de/aktuelles/)
# -------------------------------------------------------------------
_news_cache = {"timestamp": 0, "data": []}

@app.route('/api/news')
def get_news():
    """
    Return recent news articles from MVB Aktuelles (https://www.mvbnet.de/aktuelles/).
    Includes caching to prevent excessive upstream scraping.
    """
    global _news_cache
    now_ts = time.time()

    # Return cache if valid for 15 minutes (900 seconds)
    if _news_cache["data"] and (now_ts - _news_cache["timestamp"] < 900):
        return jsonify(_news_cache["data"])

    try:
        url = 'https://www.mvbnet.de/aktuelles/'
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            ),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
        }
        resp = requests.get(url, headers=headers, timeout=10)
        resp.raise_for_status()
        resp.encoding = 'utf-8'

        soup = BeautifulSoup(resp.text, 'html.parser')
        news_items = []

        month_map = [
            (r'Jan(?:uar)?\.?', 'Januar'), (r'Feb(?:ruar)?\.?', 'Februar'), (r'Mär(?:z)?\.?|Mar(?:z)?\.?', 'März'),
            (r'Apr(?:il)?\.?', 'April'), (r'Mai', 'Mai'), (r'Jun(?:i)?\.?', 'Juni'),
            (r'Jul(?:i)?\.?', 'Juli'), (r'Aug(?:ust)?\.?', 'August'), (r'Sep(?:tember)?\.?', 'September'),
            (r'Okt(?:ober)?\.?', 'Oktober'), (r'Nov(?:ember)?\.?', 'November'), (r'Dez(?:ember)?\.?', 'Dezember')
        ]

        articles = soup.find_all('article')
        for art in articles:
            title_el = art.find(['h2', 'h3', 'h4', 'a'], class_=lambda c: c and any(x in c for x in ['title', 'headline', 'entry-title']))
            if not title_el:
                title_el = art.find(['h2', 'h3', 'h4'])

            title = title_el.get_text(strip=True) if title_el else ''
            if not title:
                continue

            link_el = art.find('a', href=True)
            link = link_el['href'] if link_el else 'https://www.mvbnet.de/aktuelles/'

            img_src = ''
            img_el = art.find('img')
            if img_el:
                img_src = img_el.get('data-src') or img_el.get('src') or ''
                if img_src.startswith('//'):
                    img_src = 'https:' + img_src
                elif img_src.startswith('/'):
                    img_src = 'https://www.mvbnet.de' + img_src

            date_el = art.find(['time', 'span', 'div'], class_=lambda c: c and any(x in c for x in ['date', 'time', 'meta-date', 'entry-date']))
            raw_date = date_el.get_text(strip=True) if date_el else ''

            clean_date = raw_date
            for pattern, full_month in month_map:
                if re.search(pattern, clean_date, re.IGNORECASE):
                    clean_date = re.sub(rf'(\d+)\s*(?:{pattern})\s*(\d{{4}})?', rf'\1. {full_month} \2', clean_date, flags=re.IGNORECASE).strip()
                    clean_date = re.sub(r'\s+', ' ', clean_date)
                    break

            p_els = art.find_all('p')
            teaser = ''
            for p in p_els:
                ptxt = p.get_text(strip=True)
                if ptxt and not ptxt.startswith(title[:15]) and len(ptxt) > 20:
                    teaser = ptxt
                    break
            if not teaser and p_els:
                teaser = p_els[0].get_text(strip=True)

            teaser = re.sub(r'^\d+[A-Za-zäöüß\.\s\d]+', '', teaser)
            teaser = re.sub(r'Weiterlesen.*$', '', teaser, flags=re.IGNORECASE)
            teaser = teaser.replace(title, '').strip()
            teaser = re.sub(r'^[–—:\-\s]+', '', teaser).strip()
            if len(teaser) > 260:
                teaser = teaser[:257].rsplit(' ', 1)[0] + '...'

            cat = 'Aktuelles'
            tl = title.lower() + ' ' + teaser.lower()
            if any(w in tl for w in ['umleitung', 'baustelle', 'sperrung', 'ersatzverkehr', 'fahrplan', 'gleis']):
                cat = 'Fahrplan & Verkehr'
            elif any(w in tl for w in ['gewinn', 'ticket', 'rabatt', 'aktion', 'gewinnspiel']):
                cat = 'Aktion & Tickets'
            elif any(w in tl for w in ['app', 'digital', 'test', 'technik', 'wlan', 'automat']):
                cat = 'Digital & Service'
            elif any(w in tl for w in ['event', 'malle', 'csd', 'festival', 'fußball', 'fussball', 'fcm', 'sommer', 'ausflug']):
                cat = 'Events & Freizeit'

            news_items.append({
                'id': hashlib.md5(title.encode('utf-8')).hexdigest()[:8],
                'title': title,
                'link': link,
                'date': clean_date or 'Aktuell',
                'image': img_src,
                'teaser': teaser,
                'category': cat
            })

        if news_items:
            _news_cache = {"timestamp": now_ts, "data": news_items}
            return jsonify(news_items)

    except Exception as e:
        print(f"[ERROR] MVB News scraping: {e}")
        traceback.print_exc()

    # Fallback data if upstream is down
    fallback_news = [
        {
            "id": "fb_news_1",
            "title": "Zum Schulbeginn: so fahren Bus und Bahn",
            "link": "https://www.mvbnet.de/zum-schulbeginn-so-fahren-bus-und-bahn/",
            "date": "13. August 2026",
            "image": "https://www.mvbnet.de//files/2026/08/230626_Olvenstedter8-846x400.jpg",
            "teaser": "Am 17. August beginnt das neue Schuljahr und einige Umleitungen werden beendet sein. Die MVB geben einen Überblick der Änderungen und Linienanpassungen.",
            "category": "Fahrplan & Verkehr"
        },
        {
            "id": "fb_news_2",
            "title": "„Malle“ und Fußball: An- und Abreise mit zusätzlichen Straßenbahnen",
            "link": "https://www.mvbnet.de/malle-und-fussball-an-und-abreise-mit-zusaetzlichen-strassenbahnen/",
            "date": "4. August 2026",
            "image": "https://www.mvbnet.de//files/2026/08/070822_1.FCM_MVB7-846x400.jpg",
            "teaser": "Am Samstag findet das Mega-Malle-Festival im Elbauenpark statt. Zur An- und Abreise verstärkt die MVB den Straßenbahntakt mit Sonderzügen.",
            "category": "Events & Freizeit"
        },
        {
            "id": "fb_news_3",
            "title": "Haltestelle Domplatz wird zum „Platz für alle“",
            "link": "https://www.mvbnet.de/haltestelle-domplatz-wird-zum-platz-fuer-alle/",
            "date": "31. Juli 2026",
            "image": "https://www.mvbnet.de//files/2026/07/310726_MVB_CSD1-846x400.jpg",
            "teaser": "Anlässlich des Christopher Street Days in Magdeburg gestaltet die MVB die Straßenbahnhaltestelle Domplatz für einen Monat in Regenbogenfarben.",
            "category": "Events & Freizeit"
        },
        {
            "id": "fb_news_4",
            "title": "MVB startet neue Mobilitäts-App als Testversion",
            "link": "https://www.mvbnet.de/mvb-startet-neue-mobilitaets-app-als-testversion/",
            "date": "28. Juli 2026",
            "image": "https://www.mvbnet.de//files/2026/07/mockup2-mvb-app-846x400.jpg",
            "teaser": "Die Magdeburger Verkehrsbetriebe bündeln Fahrplanauskunft, Ticketkauf und Serviceangebote in einer neuen modernen Mobilitäts-App.",
            "category": "Digital & Service"
        },
        {
            "id": "fb_news_5",
            "title": "Gewinnaktion: Pyro Games 2026",
            "link": "https://www.mvbnet.de/gewinnaktion-pyro-games-2026/",
            "date": "24. Juli 2026",
            "image": "https://www.mvbnet.de//files/2026/07/Medium-Rectangel-Pyro-MD26-MVB-300x250px2.jpg",
            "teaser": "Wenn der Himmel über dem Elbauenpark in leuchtenden Farben erstrahlt und Feuerwerk zu einer Show verschmilzt: Jetzt Freikarten gewinnen!",
            "category": "Aktion & Tickets"
        }
    ]
    return jsonify(fallback_news)


# -------------------------------------------------------------------
# Transit Line Helpers & Article Text Enrichment
# -------------------------------------------------------------------
MVB_OFFICIAL_LINE_COLORS = {
    # Straßenbahnen
    '1': '#B22052',
    '2': '#5566A4',
    '3': '#F5D300',
    '4': '#7FC600',
    '5': '#BA832C',
    '6': '#6E3B90',
    '8': '#F0A500',
    '9': '#006651',
    '10': '#2796B6',
    '13': '#3A4136',
    '15': '#B22052',

    # Buslinien
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

    # Nachtlinien
    'N1': '#B22052',
    'N2': '#6E3B90',
    'N3': '#CC1F2F',
    'N4': '#007757',
    'N5': '#F5D300',
    'N6': '#F0A500',
    'N7': '#2796B6',
    'N8': '#C7066E',
    'N9': '#E73F0C',

    # S-Bahn
    'S1': '#008037',
}

def make_pill_html(line_key):
    c = MVB_OFFICIAL_LINE_COLORS.get(line_key, '#5566A4')
    is_light = line_key in ['3', '8', '52', '53', '54', '56', 'KVG9', 'N5', 'N6']
    text_color = '#111827' if is_light else '#ffffff'
    shadow = 'none' if is_light else '0 1px 2px rgba(0,0,0,0.4)'
    
    if line_key.startswith('N'):
        icon = '🌙'
        name = f'Nachtlinie {line_key}'
    elif line_key == 'S1':
        icon = '🚆'
        name = 'S1'
    elif line_key.isdigit() and int(line_key) >= 50:
        icon = '🚌'
        name = f'Linie {line_key}'
    else:
        icon = '🚋'
        name = f'Linie {line_key}'
        
    return f' <span class="transit-pill" style="background-color:{c}; color:{text_color} !important; text-shadow:{shadow}; padding:2px 8px; border-radius:12px; font-weight:700; font-size:0.88em; display:inline-flex; align-items:center; gap:4px;">{icon} {name}</span> '

def enrich_transit_article_text(raw_text):
    if not raw_text:
        return ''
    # 1. Spacing fixes for glued words and punctuation
    text = re.sub(r'([a-zäöüß])([A-ZÄÖÜ])', r'\1 \2', raw_text)
    text = re.sub(r'(\.)([A-ZÄÖÜ])', r'\1 \2', text)
    text = re.sub(r'(\d+)\.([A-Za-zÄÖÜäöü])', r'\1. \2', text)
    text = re.sub(r'\s+([,.:;])', r'\1', text)
    text = re.sub(r'\s+', ' ', text).strip()

    # 2. Semantic Emojis for landmark & transit context (without duplicates)
    text = re.sub(r'\b(Haltestelle|Haltestellen)\b', r'🚏 \1', text)
    text = re.sub(r'\b(Hauptbahnhof)\b', r'🚉 \1', text)
    text = re.sub(r'\b(Elbauenpark)\b', r'🌳 \1', text)
    text = re.sub(r'\b(Arenen|AVNET-Arena|MDCC-Arena|Getec-Arena)\b', r'🏟️ \1', text)
    text = re.sub(r'\b(Fußballspiel\s+(?:1\.\s*FC\s+Magdeburg|FCM)|Fußballspiel|1\.\s*FC\s+Magdeburg|FCM)\b', r'⚽ \1', text)
    text = re.sub(r'^(Anreise\b|Hinfahrt\b)', r'🟢 <strong>\1</strong>', text)
    text = re.sub(r'^(Abreise\b|Rückfahrt\b)', r'🔴 <strong>\1</strong>', text)

    # 3. MVB Line Badges with authentic official MVB colors
    def line_cb(m):
        nums = m.group(2)
        tokens = re.split(r'(\d+|N\d+|KVG\d+|und|,|\s+)', nums)
        res = []
        for tok in tokens:
            t = tok.strip()
            if t in MVB_OFFICIAL_LINE_COLORS:
                res.append(make_pill_html(t))
            elif t:
                res.append(tok)
        return ''.join(res)

    text = re.sub(r'\b(Linien?|Bussen?|Bus|Nachtlinien?|Nachtlinie|Str\.)\s+([0-9NKVG,\sund/–-]+)\b', line_cb, text)
    text = re.sub(r'\b(?:S-Bahn\s+)?S1\b', make_pill_html('S1'), text)

    # 4. Punctuation and spacing cleanup
    text = re.sub(r'\s+([,.:;])', r'\1', text)
    text = re.sub(r'([,.:;])([^\s\d<])', r'\1 \2', text)
    text = re.sub(r'\.{2,}', '.', text)
    text = re.sub(r'\.\s*\.', '.', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


# -------------------------------------------------------------------
# GET /api/news/article  —  Fetch full in-app article content
# -------------------------------------------------------------------
_article_cache = {}

@app.route('/api/news/article')
def get_news_article():
    """
    Return full content for a single MVB news article from mvbnet.de.
    """
    article_url = request.args.get('url', '').strip()
    article_id = request.args.get('id', '').strip()

    if not article_url and not article_id:
        return jsonify({'error': 'Missing url or id parameter'}), 400

    if not article_url and article_id:
        for item in _news_cache.get("data", []):
            if item.get('id') == article_id:
                article_url = item.get('link')
                break

    if not article_url:
        return jsonify({'error': 'Article URL not found'}), 404

    if 'mvbnet.de' not in article_url:
        return jsonify({'error': 'Invalid domain'}), 400

    now_ts = time.time()
    if article_url in _article_cache:
        cached = _article_cache[article_url]
        if now_ts - cached['cached_at'] < 3600:
            return jsonify(cached['data'])

    try:
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/120.0.0.0 Safari/537.36'
            ),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
        }
        resp = requests.get(article_url, headers=headers, timeout=12)
        resp.raise_for_status()
        resp.encoding = 'utf-8'

        soup = BeautifulSoup(resp.text, 'html.parser')

        h1_el = soup.find('h1', class_=lambda c: c and any(x in c for x in ['entry-title', 'post-title', 'title'])) or soup.find('h1')
        title = h1_el.get_text(strip=True) if h1_el else 'MVB Aktuelles'

        date_el = soup.find(['time', 'span', 'div'], class_=lambda c: c and any(x in c for x in ['date', 'time', 'meta-date', 'entry-date']))
        date_str = date_el.get_text(strip=True) if date_el else ''

        hero_img = ''
        img_el = soup.find('img', class_=lambda c: c and any(x in c for x in ['wp-post-image', 'attachment-post-thumbnail', 'featured-img']))
        if not img_el:
            content_div = soup.find('div', class_=lambda c: c and 'entry-content' in c) or soup.find('article')
            if content_div:
                img_el = content_div.find('img')
        if img_el:
            hero_img = img_el.get('data-src') or img_el.get('src') or ''
            if hero_img.startswith('//'):
                hero_img = 'https:' + hero_img
            elif hero_img.startswith('/'):
                hero_img = 'https://www.mvbnet.de' + hero_img

        content_el = soup.find('div', class_=lambda c: c and 'entry-content' in c) or soup.find('article') or soup.find('main')
        paragraphs = []
        html_blocks = []

        if content_el:
            for unw in content_el.find_all(['script', 'style', 'noscript', 'iframe', 'form', 'nav', 'aside']):
                unw.decompose()

            for br in content_el.find_all('br'):
                br.replace_with(' ')

            for child in content_el.find_all(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'blockquote']):
                text = child.get_text(separator=' ', strip=True)
                if not text:
                    continue
                if any(skip in text.lower() for skip in ['weiterlesen auf', 'teilen mit:', 'ähnliche beiträge', 'verwandte artikel']):
                    continue

                enriched_text = enrich_transit_article_text(text)

                if child.name in ['h2', 'h3', 'h4']:
                    html_blocks.append(f'<{child.name}>{enriched_text}</{child.name}>')
                    paragraphs.append(text)
                elif child.name == 'blockquote':
                    html_blocks.append(f'<blockquote>{enriched_text}</blockquote>')
                    paragraphs.append(text)
                elif child.name in ['ul', 'ol']:
                    lis = [f'<li>{enrich_transit_article_text(li.get_text(separator=" ", strip=True))}</li>' for li in child.find_all('li') if li.get_text(strip=True)]
                    if lis:
                        html_blocks.append(f'<{child.name}>' + ''.join(lis) + f'</{child.name}>')
                        paragraphs.append('\n'.join(li.get_text(strip=True) for li in child.find_all('li')))
                elif child.name == 'p':
                    # Check if paragraph has images
                    p_img = child.find('img')
                    if p_img:
                        p_img_src = p_img.get('data-src') or p_img.get('src') or ''
                        if p_img_src.startswith('//'): p_img_src = 'https:' + p_img_src
                        elif p_img_src.startswith('/'): p_img_src = 'https://www.mvbnet.de' + p_img_src
                        if p_img_src and p_img_src != hero_img:
                            html_blocks.append(f'<figure class="article-inline-img"><img src="{html.escape(p_img_src)}" alt="" loading="lazy"></figure>')
                    if text:
                        html_blocks.append(f'<p>{enriched_text}</p>')
                        paragraphs.append(text)

        article_data = {
            'url': article_url,
            'title': title,
            'date': date_str,
            'image': hero_img,
            'content_html': '\n'.join(html_blocks),
            'paragraphs': paragraphs
        }

        _article_cache[article_url] = {
            'cached_at': now_ts,
            'data': article_data
        }
        return jsonify(article_data)

    except Exception as e:
        print(f"[ERROR] Fetching MVB article {article_url}: {e}")
        traceback.print_exc()

    fallback_article = {
        'url': article_url,
        'title': 'MVB Meldung',
        'date': 'Aktuell',
        'image': '',
        'content_html': '<p>Dieser Artikel konnte im Moment nicht in voller Länge geladen werden. Bitte versuche es in wenigen Augenblicken erneut oder nutze den Link zur Originalseite.</p>',
        'paragraphs': ['Dieser Artikel konnte im Moment nicht in voller Länge geladen werden.']
    }
    return jsonify(fallback_article)


# ===================================================================
#  SERVER STARTUP
# ===================================================================
# ===================================================================
#  LIVE-NETZKARTE: Tram network geometry + live vehicle positions
# ===================================================================
NETWORK_BBOX = (52.03, 11.50, 52.23, 11.78)  # south, west, north, east
NETWORK_CACHE_FILE = os.path.join(CACHE_DIR, 'network_cache.json')
NETWORK_CACHE_MAX_AGE = 7 * 24 * 3600
OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]
NETWORK_LINES_WANTED = ['1N', '1S', '1', '2', '3', '4', '5', '6', '8', '9', '10', '13']


def _dp_simplify(points, eps):
    """Douglas-Peucker polyline simplification (points = [[lat, lon], ...])."""
    if len(points) < 3:
        return points
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        t = ((px - ax) * dx + (py - ay) * dy) / length_sq if length_sq else 0
        t = max(0.0, min(1.0, t))
        ex, ey = ax + t * dx - px, ay + t * dy - py
        d = (ex * ex + ey * ey) ** 0.5
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = _dp_simplify(points[:idx + 1], eps)
        right = _dp_simplify(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def _chain_ways(ways):
    """Join ordered OSM way geometries of a route relation into continuous polylines."""
    def same(p, q):
        return abs(p[0] - q[0]) < 1e-6 and abs(p[1] - q[1]) < 1e-6

    segments, cur, first_len = [], None, None
    for w in ways:
        if cur is None:
            cur, first_len = list(w), len(w)
            continue
        if same(cur[-1], w[0]):
            cur += w[1:]
        elif same(cur[-1], w[-1]):
            cur += list(reversed(w))[1:]
        elif len(cur) == first_len and same(cur[0], w[0]):
            cur = list(reversed(cur)) + w[1:]
        elif len(cur) == first_len and same(cur[0], w[-1]):
            cur = list(reversed(cur)) + list(reversed(w))[1:]
        else:
            segments.append(cur)
            cur, first_len = list(w), len(w)
    if cur:
        segments.append(cur)
    return [[[round(p[0], 5), round(p[1], 5)] for p in _dp_simplify(seg, 0.00002)] for seg in segments]


def _build_network_from_overpass():
    s, w, n, e = NETWORK_BBOX
    query = (
        f'[out:json][timeout:120];'
        f'rel["route"="tram"]({s},{w},{n},{e})->.r;'
        f'.r out geom;'
        f'node(r.r)["name"];'
        f'out tags;'
        f'way["railway"="tram"]({s},{w},{n},{e});'
        f'out geom;'
    )
    data = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            resp = requests.post(endpoint, data={'data': query}, timeout=90,
                                 headers={'User-Agent': 'MagdeburgMobil/6 (private hobby project)'})
            if resp.ok:
                data = resp.json()
                break
            print(f"[WARN] Overpass {endpoint} -> HTTP {resp.status_code}")
        except Exception as ex:
            print(f"[WARN] Overpass {endpoint} failed: {ex}")
    if not data:
        return None

    names = {el['id']: el.get('tags', {}).get('name', '')
             for el in data.get('elements', []) if el.get('type') == 'node'}

    lines, seen = [], set()
    stops_by_id = {}
    for el in data.get('elements', []):
        if el.get('type') != 'relation':
            continue
        tags = el.get('tags', {})
        ref = (tags.get('ref') or '').strip()
        if ref not in NETWORK_LINES_WANTED or ref in seen:
            continue
        if tags.get('route') != 'tram':
            continue
        seen.add(ref)
        ways = [[[g['lat'], g['lon']] for g in m['geometry']]
                for m in el.get('members', [])
                if m.get('type') == 'way' and m.get('geometry') and m.get('role', '') in ('', 'forward', 'backward')]
        line_key = re.sub(r'[NS]$', '', ref)  # "1N"/"1S" -> "1"
        for m in el.get('members', []):
            if m.get('type') == 'node' and 'stop' in (m.get('role') or '') and 'lat' in m:
                sid = m['ref']
                st = stops_by_id.setdefault(sid, {
                    'id': sid, 'lat': round(m['lat'], 5), 'lon': round(m['lon'], 5),
                    'name': names.get(sid, ''), 'lines': []
                })
                if line_key not in st['lines']:
                    st['lines'].append(line_key)
        lines.append({
            'ref': line_key,
            'variant': ref,
            'color': LINE_COLORS.get(line_key, '#888888'),
            'from': tags.get('from', ''),
            'to': tags.get('to', ''),
            'segs': _chain_ways(ways),
        })

    # merge stop positions with the same name (both platforms) into one station dot
    stations = {}
    for st in stops_by_id.values():
        key = st['name'] or f"#{st['id']}"
        if key in stations:
            s0 = stations[key]
            s0['_n'] += 1
            s0['lat'] += (st['lat'] - s0['lat']) / s0['_n']
            s0['lon'] += (st['lon'] - s0['lon']) / s0['_n']
            s0['lines'] = sorted(set(s0['lines']) | set(st['lines']), key=lambda x: int(re.sub(r'\D', '', x) or 0))
        else:
            stations[key] = dict(st, _n=1)
    station_list = [{'name': v['name'], 'lat': round(v['lat'], 5), 'lon': round(v['lon'], 5), 'lines': v['lines']}
                    for v in stations.values() if v['name']]

    # Physical track network (every railway=tram way, incl. Wendeschleifen and depots)
    tracks = []
    for el in data.get('elements', []):
        if el.get('type') == 'way' and el.get('geometry') and (el.get('tags') or {}).get('railway') == 'tram':
            pts = [[g['lat'], g['lon']] for g in el['geometry']]
            simp = _dp_simplify(pts, 0.000008)
            tracks.append([[round(p[0], 5), round(p[1], 5)] for p in simp])

    lines.sort(key=lambda l: int(re.sub(r'\D', '', l['ref']) or 0))
    return {
        'v': 2,
        'tracks': tracks,
        'generated': datetime.datetime.now(local_tz).isoformat(),
        'source': '© OpenStreetMap-Mitwirkende (ODbL)',
        'bbox': NETWORK_BBOX,
        'lines': lines,
        'stations': station_list,
    }


@app.route('/api/network')
def get_network():
    """Tram network geometry (from OpenStreetMap via Overpass), cached on disk for 7 days."""
    force = request.args.get('refresh') == '1'
    cached = None
    if os.path.exists(NETWORK_CACHE_FILE):
        try:
            with open(NETWORK_CACHE_FILE, 'r', encoding='utf-8') as f:
                cached = json.load(f)
        except Exception:
            cached = None
        age = time.time() - os.path.getmtime(NETWORK_CACHE_FILE)
        if cached and cached.get('v') == 2 and age < NETWORK_CACHE_MAX_AGE and not force:
            return jsonify(cached)

    fresh = _build_network_from_overpass()
    if fresh and fresh.get('lines'):
        try:
            with open(NETWORK_CACHE_FILE, 'w', encoding='utf-8') as f:
                json.dump(fresh, f, ensure_ascii=False)
        except Exception as ex:
            print(f"[WARN] Could not write network cache: {ex}")
        return jsonify(fresh)
    if cached:
        return jsonify(cached)
    return jsonify({'error': 'Netzdaten derzeit nicht verfügbar', 'lines': [], 'stations': []}), 503


def _decode_hafas_polyline(encoded, precision=5):
    """Decode a Google-encoded polyline (HAFAS crdEncYX) to [[lat, lon], ...]."""
    coords, index, lat, lon = [], 0, 0, 0
    factor = 10 ** precision
    length = len(encoded)
    while index < length:
        for which in (0, 1):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if which == 0:
                lat += delta
            else:
                lon += delta
        coords.append([lat / factor, lon / factor])
    return coords


def _point_along(poly, cum, frac):
    """Point at fraction (0..1) of the total length of a polyline."""
    if not poly:
        return None
    if len(poly) == 1 or cum[-1] <= 0:
        return poly[0]
    target = max(0.0, min(1.0, frac)) * cum[-1]
    for i in range(1, len(cum)):
        if cum[i] >= target:
            seg = cum[i] - cum[i - 1]
            t = (target - cum[i - 1]) / seg if seg > 0 else 0
            return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t,
                    poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t]
    return poly[-1]


def _classify_radar_product(prod, operator=''):
    name = (prod.get('name') or '').strip()
    low = name.lower()
    ctx = prod.get('prodCtx') or {}
    cat = (ctx.get('catOut') or ctx.get('catOutS') or '').strip().lower()
    op = (operator or '').lower()
    cls = prod.get('cls')
    # long-distance coaches (FlixBus & co.) – never a tram, even with line numbers like "N300"
    if 'flix' in op or 'flix' in low or cat in ('flx', 'fernbus', 'fb') or 'fernbus' in cat:
        return 'fernbus'
    if low.startswith('str') or low.startswith('tram') or cat in ('str', 'tram') or cls == 32:
        return 'tram'
    if low.startswith('bus') or low.startswith('ruf') or cat.startswith('bus') or cls == 64:
        return 'bus'
    if low.startswith('s') and re.match(r'^s\s*\d', low):
        return 'sbahn'
    if any(low.startswith(k) for k in ('re', 'rb', 'hex', 'erb')):
        return 'regional'
    if any(low.startswith(k) for k in ('ice', 'ic', 'ec')):
        return 'express'
    guess = classify_line_type(name, operator_name=operator or None)
    # without an explicit tram marker we don't trust a "tram" guess (e.g. coach line "N881")
    return 'bus' if guess == 'tram' else guess


_radar_cache = {'ts': 0, 'data': None}


@app.route('/api/radar')
def get_radar():
    """Live vehicle positions in Magdeburg via HAFAS JourneyGeoPos (with short animation tracks)."""
    debug_raw = request.args.get('raw') == '1'
    now_ts = time.time()
    if not debug_raw and _radar_cache['data'] and now_ts - _radar_cache['ts'] < 8:
        return jsonify(_radar_cache['data'])

    client = nasa_client or oebb_client
    if client is None:
        return jsonify({'error': 'Kein HAFAS-Client verfügbar', 'vehicles': []}), 503

    s, w, n, e = NETWORK_BBOX
    now = datetime.datetime.now(local_tz)
    duration_s = 40
    base_req = {
        'maxJny': 400,
        'onlyRT': False,
        'date': now.strftime('%Y%m%d'),
        'time': now.strftime('%H%M%S'),
        'rect': {
            'llCrd': {'x': int(w * 1e6), 'y': int(s * 1e6)},
            'urCrd': {'x': int(e * 1e6), 'y': int(n * 1e6)},
        },
        'perSize': duration_s * 1000,
        'perStep': 5000,
        'ageOfReport': True,
        'trainPosMode': 'CALC',
    }

    res, last_err = None, None
    for extra in ({},):  # polylines are delivered via common.polyL anyway
        try:
            req_body = dict(base_req, **extra)
            res = client.profile.request({'meth': 'JourneyGeoPos', 'req': req_body}).res
            if res is not None:
                break
        except Exception as ex:
            last_err = ex
            print(f"[WARN] JourneyGeoPos failed ({'with' if extra else 'without'} polyline): {ex}")
    if res is None:
        return jsonify({'error': f'Live-Positionen nicht verfügbar: {last_err}', 'vehicles': []}), 502

    if debug_raw:
        match = request.args.get('match')
        jl = res.get('jnyL') or []
        sample = [j for j in jl if match and match in (j.get('jid') or '')][:2] if match else jl[:2]
        loc_names = [l.get('name') for l in (res.get('common') or {}).get('locL', [])]
        for j in sample:
            j['_stopNames'] = [loc_names[st['locX']] if st.get('locX') is not None and st['locX'] < len(loc_names) else None
                               for st in j.get('stopL') or []]
            j.pop('ani', None)
        return jsonify({'keys': list(res.keys()), 'commonKeys': list((res.get('common') or {}).keys()),
                        'count': len(res.get('jnyL') or []), 'sample': sample,
                        'prodSample': (res.get('common') or {}).get('prodL', [])[:3],
                        'polySample': (res.get('common') or {}).get('polyL', [])[:1]})

    common = res.get('common') or {}
    prod_l = common.get('prodL') or []
    poly_l = common.get('polyL') or []
    loc_l = common.get('locL') or []
    vehicles = []

    for jny in res.get('jnyL') or []:
        try:
            prod = prod_l[jny['prodX']] if 'prodX' in jny and jny['prodX'] < len(prod_l) else {}
            name = (prod.get('name') or prod.get('nameS') or '').strip()
            if not name:
                continue
            op_l = common.get('opL') or []
            op_x = prod.get('oprX')
            operator = (op_l[op_x].get('name') or '') if isinstance(op_x, int) and op_x < len(op_l) else ''
            vtype = _classify_radar_product(prod, operator)
            short = (prod.get('nameS') or (prod.get('prodCtx') or {}).get('line') or re.sub(r'^(Str|Bus|Tram)\s*', '', name)).strip()
            pos = jny.get('pos') or {}
            if 'x' not in pos or 'y' not in pos:
                continue
            lat, lon = pos['y'] / 1e6, pos['x'] / 1e6

            # Animation track: HAFAS gives, per frame, the segment (from-stop -> to-stop)
            # and the progress in percent on that segment; we map it onto the polyline.
            track = []
            ani = jny.get('ani') or {}
            poly = None
            if ani.get('poly') and ani['poly'].get('crdEncYX'):
                poly = _decode_hafas_polyline(ani['poly']['crdEncYX'])
            elif ani.get('polyG') and ani['polyG'].get('polyXL'):
                px = ani['polyG']['polyXL'][0]
                if px < len(poly_l) and poly_l[px].get('crdEncYX'):
                    poly = _decode_hafas_polyline(poly_l[px]['crdEncYX'])
            m_sec = ani.get('mSec') or []
            proc = ani.get('proc') or []
            f_loc = ani.get('fLocX') or []
            t_loc = ani.get('tLocX') or []

            def loc_crd(ix):
                if ix is None or ix < 0 or ix >= len(loc_l):
                    return None
                c = loc_l[ix].get('crd') or {}
                if 'x' in c and 'y' in c:
                    return [c['y'] / 1e6, c['x'] / 1e6]
                return None

            def nearest_idx(pt, start=0):
                best, best_i = None, None
                for i in range(start, len(poly)):
                    d = (poly[i][0] - pt[0]) ** 2 + ((poly[i][1] - pt[1]) * 0.615) ** 2
                    if best is None or d < best:
                        best, best_i = d, i
                return best_i

            proc_abs = ani.get('procAbs') or []
            if poly and len(poly) > 1 and m_sec and len(proc_abs) == len(m_sec):
                # The movement polyline covers exactly the path driven during the period
                # (starts at the current position). procAbs grows monotonically along it.
                cum = [0.0]
                for k in range(1, len(poly)):
                    dl = poly[k][0] - poly[k - 1][0]
                    dn = (poly[k][1] - poly[k - 1][1]) * 0.615
                    cum.append(cum[-1] + (dl * dl + dn * dn) ** 0.5)
                p0, p1 = proc_abs[0], proc_abs[-1]
                span = (p1 - p0) if p1 != p0 else 0
                for t_ms, pa in zip(m_sec, proc_abs):
                    frac = ((pa - p0) / span) if span else 0.0
                    pt = _point_along(poly, cum, frac)
                    if pt:
                        track.append([int(t_ms), round(pt[0], 6), round(pt[1], 6)])
            elif m_sec and len(proc) == len(m_sec):
                for i, t_ms in enumerate(m_sec):
                    frac = max(0.0, min(1.0, proc[i] / 100.0))
                    o = loc_crd(f_loc[i]) if i < len(f_loc) else None
                    d = loc_crd(t_loc[i]) if i < len(t_loc) else None
                    pt = None
                    if poly and len(poly) > 1 and o and d:
                        io = nearest_idx(o)
                        idd = nearest_idx(d, io) if io is not None else None
                        if io is not None and idd is not None and idd > io:
                            sub = poly[io:idd + 1]
                            cum = [0.0]
                            for k in range(1, len(sub)):
                                dl = sub[k][0] - sub[k - 1][0]
                                dn = (sub[k][1] - sub[k - 1][1]) * 0.615
                                cum.append(cum[-1] + (dl * dl + dn * dn) ** 0.5)
                            pt = _point_along(sub, cum, frac)
                    if pt is None and o and d:
                        pt = [o[0] + (d[0] - o[0]) * frac, o[1] + (d[1] - o[1]) * frac]
                    if pt:
                        track.append([int(t_ms), round(pt[0], 6), round(pt[1], 6)])

            # Next stop + current delay from the stop list.
            # HAFAS sometimes reports nonsense for a single stop (e.g. +39 at one stop, -1 at the next),
            # so a stop only counts if its realtime is not later than the following stop's realtime.
            now_hms = now.strftime('%H%M%S')
            next_stop, delay_min = '', None

            def to_sec(v):
                v = str(v)[-6:]
                return int(v[0:2]) * 3600 + int(v[2:4]) * 60 + int(v[4:6] or 0)

            def stop_delay(st):
                t_r = st.get('dTimeR') or st.get('aTimeR')
                t_s = st.get('dTimeS') or st.get('aTimeS')
                if not (t_r and t_s):
                    return None
                diff = to_sec(t_r) - to_sec(t_s)
                if diff > 43200:
                    diff -= 86400
                elif diff < -43200:
                    diff += 86400
                return diff

            def stop_rt(st):
                t = st.get('aTimeR') or st.get('dTimeR') or st.get('aTimeS') or st.get('dTimeS')
                return to_sec(t) if t else None

            try:
                stops_l = jny.get('stopL') or []
                upcoming = [st for st in stops_l
                            if (st.get('aTimeR') or st.get('dTimeR') or st.get('aTimeS') or st.get('dTimeS') or '')[-6:] >= now_hms]
                chosen = None
                for k, st in enumerate(upcoming):
                    nxt = upcoming[k + 1] if k + 1 < len(upcoming) else None
                    a, b = stop_rt(st), (stop_rt(nxt) if nxt else None)
                    if a is not None and b is not None and a > b + 60:
                        continue  # implausible realtime at this stop
                    chosen = st
                    break
                if chosen is None and upcoming:
                    chosen = upcoming[-1]
                if chosen is not None:
                    lx = chosen.get('locX')
                    if lx is not None and lx < len(loc_l):
                        next_stop = loc_l[lx].get('name', '')
                    diff = stop_delay(chosen)
                    if diff is not None:
                        # round to whole minutes like the departure boards (< 30 s counts as on time)
                        delay_min = int(diff / 60.0 + (0.5 if diff >= 0 else -0.5)) if abs(diff) >= 30 else 0
            except Exception:
                delay_min = None

            line_key = normalize_line_name(name)
            color = get_line_color(name) if vtype in ('tram', 'bus', 'sev') else LINE_COLORS.get(line_key, '#64748b')
            if vtype == 'sbahn':
                color = '#00975F'
            elif vtype in ('regional', 'express'):
                color = '#E30513'
            elif vtype == 'fernbus':
                color = '#5f9e1f'

            vehicles.append({
                'id': jny.get('jid'),
                'line': name,
                'short': short,
                'type': 'sev' if vtype == 'sev' else vtype,
                'direction': jny.get('dirTxt', ''),
                'lat': round(lat, 6),
                'lon': round(lon, 6),
                'color': color,
                'track': track,
                'nextStop': next_stop,
                'delay': delay_min,
            })
        except Exception as ex:
            print(f"[WARN] radar parse: {ex}")

    payload = {'ts': int(now_ts * 1000), 'duration': duration_s * 1000, 'vehicles': vehicles}
    _radar_cache['ts'] = now_ts
    _radar_cache['data'] = payload
    return jsonify(payload)



# -------------------------------------------------------------------
# Trip geometry (current real route incl. line changes) via JourneyDetails
# -------------------------------------------------------------------
import threading

_trip_cache = {}
_TRIP_CACHE_TTL = 45


def _hafas_dt(date_str, time_str):
    """Combine HAFAS date (YYYYMMDD) and time (HHMMSS / DDHHMMSS) to an aware datetime."""
    if not date_str or not time_str:
        return None
    try:
        base = datetime.datetime.strptime(date_str, '%Y%m%d')
        t = str(time_str)
        days = 0
        if len(t) > 6:
            days = int(t[:-6])
            t = t[-6:]
        t = t.zfill(6)
        dt = base + datetime.timedelta(days=days, hours=int(t[0:2]), minutes=int(t[2:4]), seconds=int(t[4:6]))
        return local_tz.localize(dt) if hasattr(local_tz, 'localize') else dt.replace(tzinfo=local_tz)
    except Exception:
        return None


def _fit_stops_to_shape(shape, coords):
    """Monotonic assignment of stops to shape points minimising the total distance."""
    m = len(shape)
    INF = float('inf')
    prev = None
    back = []
    for c in coords:
        if c is None:
            back.append(None)
            continue
        lat, lon = c
        cost = [(((p[0] - lat) * 111.0) ** 2 + ((p[1] - lon) * 68.3) ** 2) ** 0.5 for p in shape]
        cur = [INF] * m
        arg = [0] * m
        if prev is None:
            cur = cost
        else:
            best, best_j = INF, 0
            for j in range(m):
                if prev[j] < best:
                    best, best_j = prev[j], j
                cur[j] = cost[j] + best
                arg[j] = best_j
        back.append(arg if prev is not None else None)
        prev = cur
    if prev is None:
        return [None] * len(coords)
    # backtrack
    j = min(range(m), key=lambda k: (prev[k], k))
    out = [None] * len(coords)
    real = [i for i, c in enumerate(coords) if c is not None]
    for pos in range(len(real) - 1, -1, -1):
        i = real[pos]
        out[i] = j
        arg = back[i]
        if arg is not None:
            j = arg[j]
    return out


def _fetch_trip(jid, want_raw=False):
    now_ts = time.time()
    hit = _trip_cache.get(jid)
    if hit and not want_raw and now_ts - hit[0] < _TRIP_CACHE_TTL:
        return hit[1]

    res, last_err = None, None
    for client in [c for c in (nasa_client, oebb_client) if c is not None]:
        for req in ({'jid': jid, 'getPolyline': True}, {'jid': jid}):
            try:
                r = client.profile.request({'meth': 'JourneyDetails', 'req': req}).res
                if r and r.get('journey'):
                    res = r
                    break
            except Exception as ex:
                last_err = ex
        if res:
            break
    if res is None:
        raise RuntimeError(f'JourneyDetails fehlgeschlagen: {last_err}')
    if want_raw:
        j = res.get('journey', {})
        c = res.get('common', {})
        return {'journeyKeys': list(j.keys()), 'stop0': (j.get('stopL') or [None])[0],
                'polyG': j.get('polyG'), 'polyKeys': list((c.get('polyL') or [{}])[0].keys()) if c.get('polyL') else None,
                'ppLocRefL': ((c.get('polyL') or [{}])[0].get('ppLocRefL') or [])[:5] if c.get('polyL') else None,
                'nStops': len(j.get('stopL') or [])}

    journey = res.get('journey', {})
    common = res.get('common', {})
    prod_l = common.get('prodL') or []
    loc_l = common.get('locL') or []
    poly_l = common.get('polyL') or []
    date_str = journey.get('date')
    now = datetime.datetime.now(local_tz)

    def prod_info(px):
        prod = prod_l[px] if px is not None and 0 <= px < len(prod_l) else {}
        name = (prod.get('name') or prod.get('nameS') or '').strip()
        short = (prod.get('nameS') or (prod.get('prodCtx') or {}).get('line') or re.sub(r'^(Str|Bus|Tram)\s*', '', name)).strip()
        vtype = _classify_radar_product(prod) if prod else 'bus'
        color = get_line_color(name) if name else '#64748b'
        if vtype == 'sbahn':
            color = '#00975F'
        elif vtype in ('regional', 'express'):
            color = '#E30513'
        return name, short, vtype, color

    main_name, main_short, main_type, main_color = prod_info(journey.get('prodX'))

    shape, pp_refs = [], []
    poly_entry = None
    if (journey.get('polyG') or {}).get('polyXL'):
        px = journey['polyG']['polyXL'][0]
        if px < len(poly_l):
            poly_entry = poly_l[px]
    elif journey.get('poly'):
        poly_entry = journey['poly']
    if poly_entry and poly_entry.get('crdEncYX'):
        shape = _decode_hafas_polyline(poly_entry['crdEncYX'])
        pp_refs = poly_entry.get('ppLocRefL') or []

    stops = []
    for st in journey.get('stopL') or []:
        lx = st.get('locX')
        loc = loc_l[lx] if lx is not None and lx < len(loc_l) else {}
        crd = loc.get('crd') or {}
        px = st.get('dProdX', st.get('aProdX', journey.get('prodX')))
        name, short, vtype, color = prod_info(px)
        planned = st.get('dTimeS') or st.get('aTimeS')
        real = st.get('dTimeR') or st.get('aTimeR')
        dt_p = _hafas_dt(date_str, planned)
        dt_r = _hafas_dt(date_str, real) if real else None
        ref_dt = dt_r or dt_p
        delay = int(round((dt_r - dt_p).total_seconds() / 60)) if (dt_r and dt_p) else None
        stops.append({
            'name': (loc.get('name') or '').replace('Magdeburg, ', ''),
            'lat': crd.get('y', 0) / 1e6 if crd else None,
            'lon': crd.get('x', 0) / 1e6 if crd else None,
            'time': dt_p.strftime('%H:%M') if dt_p else '',
            'rt': dt_r.strftime('%H:%M') if dt_r else None,
            'delay': delay,
            'passed': bool(ref_dt and ref_dt < now),
            'line': name or main_name,
            'short': short or main_short,
            'color': color,
            'cancelled': bool(st.get('aCncl') or st.get('dCncl')),
            '_locX': lx,
            '_type': vtype,
        })

    # Map every stop to an index in the shape. HAFAS polylines sometimes contain extra
    # bits (a second pass or the next circulation), so we do a monotonic best fit:
    # stops must appear in order along the shape, ties go to the earliest point.
    if shape:
        idxs = _fit_stops_to_shape(shape, [(st['lat'], st['lon']) if st['lat'] else None for st in stops])
        for st, ix in zip(stops, idxs):
            st['shapeIdx'] = ix
        valid = [ix for ix in idxs if ix is not None]
        if valid:
            a, b = min(valid), max(valid)
            if a > 0 or b < len(shape) - 1:
                shape = shape[a:b + 1]
                for st in stops:
                    if st.get('shapeIdx') is not None:
                        st['shapeIdx'] -= a
    for st in stops:
        st.pop('_locX', None)

    trip = {
        'id': jid,
        'line': main_name,
        'short': main_short,
        'type': main_type,
        'color': main_color,
        'direction': journey.get('dirTxt', ''),
        'types': {st['short']: st.pop('_type', main_type) for st in stops},
        'stops': stops,
        'shape': [[round(p[0], 6), round(p[1], 6)] for p in shape],
    }
    _trip_cache[jid] = (now_ts, trip)
    if len(_trip_cache) > 400:
        for k in sorted(_trip_cache, key=lambda k: _trip_cache[k][0])[:100]:
            _trip_cache.pop(k, None)
    return trip


@app.route('/api/trip')
def get_trip():
    jid = request.args.get('jid', '')
    if not jid:
        return jsonify({'error': 'jid fehlt'}), 400
    try:
        return jsonify(_fetch_trip(jid, want_raw=request.args.get('raw') == '1'))
    except Exception as ex:
        print(f"[WARN] trip {jid[:40]}: {ex}")
        return jsonify({'error': str(ex)}), 502


# -------------------------------------------------------------------
# Current line shapes (built in the background from live trips)
# -------------------------------------------------------------------
LINE_SHAPES_FILE = os.path.join(CACHE_DIR, 'line_shapes_v3.json')
LINE_SHAPES_MAX_AGE = 12 * 3600
_line_shapes = {'loaded': False, 'lines': {}}
_line_shapes_lock = threading.Lock()
_line_shapes_worker = {'running': False}


def _line_key(v):
    group = 'tram' if v.get('type') == 'tram' else ('bus' if v.get('type') in ('bus', 'sev') else None)
    if not group:
        return None
    return f"{group}:{v.get('short') or v.get('line')}"


def _load_line_shapes():
    if _line_shapes['loaded']:
        return
    _line_shapes['loaded'] = True
    try:
        if os.path.exists(LINE_SHAPES_FILE):
            with open(LINE_SHAPES_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            cutoff = time.time() - LINE_SHAPES_MAX_AGE
            for k, v in (data.get('lines') or {}).items():
                v['shapes'] = {d: s for d, s in (v.get('shapes') or {}).items() if s.get('ts', 0) > cutoff}
                if v['shapes']:
                    _line_shapes['lines'][k] = v
    except Exception as ex:
        print(f"[WARN] line shapes cache: {ex}")


def _save_line_shapes():
    try:
        with open(LINE_SHAPES_FILE, 'w', encoding='utf-8') as f:
            json.dump({'lines': _line_shapes['lines']}, f, ensure_ascii=False)
    except Exception as ex:
        print(f"[WARN] could not save line shapes: {ex}")


def _line_shapes_job(jobs):
    try:
        for key, direction, jid, meta in jobs:
            try:
                trip = _fetch_trip(jid)
            except Exception as ex:
                print(f"[WARN] line shape {key}/{direction}: {ex}")
                continue
            shape = trip.get('shape') or []
            if len(shape) < 2:
                continue
            pieces, changes = _split_trip_by_line(trip)
            with _line_shapes_lock:
                for pkey, pmeta, pts in pieces:
                    simp = [[round(p[0], 5), round(p[1], 5)] for p in _dp_simplify(pts, 0.000008)]
                    if len(simp) < 2:
                        continue
                    entry = _line_shapes['lines'].setdefault(pkey, dict(pmeta, shapes={}, changes={}))
                    if pkey == key:
                        entry.update(meta)
                    entry.setdefault('changes', {})
                    entry['shapes'][f"{direction}|{trip.get('short')}" if pkey != key else direction] = {'ts': time.time(), 'pts': simp}
                # remember which stops each line serves (for the stop signs on the map)
                types = trip.get('types') or {}
                for st in trip.get('stops') or []:
                    if st.get('lat') is None or not st.get('name'):
                        continue
                    sk = _line_key({'type': types.get(st.get('short'), trip.get('type')), 'short': st.get('short'), 'line': st.get('line')})
                    if sk and sk in _line_shapes['lines']:
                        _line_shapes['lines'][sk].setdefault('stops', {})[st['name']] = [round(st['lat'], 5), round(st['lon'], 5)]
                for ch in changes:
                    for ck in (ch['fromKey'], ch['toKey']):
                        if ck in _line_shapes['lines']:
                            _line_shapes['lines'][ck].setdefault('changes', {})[ch['id']] = dict(ch, ts=time.time())
            time.sleep(0.25)  # be gentle with the HAFAS server
        with _line_shapes_lock:
            _save_line_shapes()
    finally:
        _line_shapes_worker['running'] = False


def _split_trip_by_line(trip):
    """Cut a trip shape into per-line pieces (a trip may change its line number on the way)."""
    shape = trip.get('shape') or []
    stops = [st for st in trip.get('stops') or [] if st.get('shapeIdx') is not None]
    types = trip.get('types') or {}
    pieces, changes = [], []
    if len(stops) < 2:
        key = _line_key({'type': trip.get('type'), 'short': trip.get('short'), 'line': trip.get('line')})
        if key:
            pieces.append((key, {'key': key, 'short': trip.get('short'), 'line': trip.get('line'),
                                 'type': key.split(':')[0], 'color': trip.get('color')}, shape))
        return pieces, changes
    run_start = 0
    for i in range(1, len(stops) + 1):
        if i < len(stops) and stops[i]['short'] == stops[run_start]['short'] and i < len(stops) - 1:
            continue
        a = stops[run_start]
        end_stop = stops[min(i, len(stops) - 1)]
        pts = shape[a['shapeIdx']:end_stop['shapeIdx'] + 1]
        vtype = types.get(a['short'], trip.get('type'))
        key = _line_key({'type': vtype, 'short': a['short'], 'line': a['line']})
        if key and len(pts) >= 2:
            pieces.append((key, {'key': key, 'short': a['short'], 'line': a['line'],
                                 'type': key.split(':')[0], 'color': a['color']}, pts))
        if i < len(stops) and stops[i]['short'] != a['short']:
            b = stops[i]
            prev = b  # the stop where the vehicle departs under its new number
            to_key = _line_key({'type': types.get(b['short'], vtype), 'short': b['short'], 'line': b['line']})
            if key and to_key:
                changes.append({
                    'id': f"{a['short']}>{b['short']}@{prev['name']}",
                    'stop': prev['name'], 'lat': prev['lat'], 'lon': prev['lon'],
                    'from': a['short'], 'to': b['short'], 'fromColor': a['color'], 'toColor': b['color'],
                    'fromKey': key, 'toKey': to_key,
                })
        run_start = i
    return pieces, changes


@app.route('/api/line-shapes')
def get_line_shapes():
    _load_line_shapes()
    radar = _radar_cache.get('data') or {}
    jobs, seen = [], set()
    cutoff = time.time() - LINE_SHAPES_MAX_AGE
    for v in radar.get('vehicles') or []:
        key = _line_key(v)
        if not key or not v.get('id'):
            continue
        direction = (v.get('direction') or '').strip() or '?'
        entry = _line_shapes['lines'].get(key)
        have = entry['shapes'].get(direction) if entry else None
        if have and have.get('ts', 0) > cutoff:
            continue
        if entry and len([d for d in entry['shapes'] if '|' not in d]) >= 4:
            continue
        if (key, direction) in seen:
            continue
        seen.add((key, direction))
        jobs.append((key, direction, v['id'], {
            'key': key, 'short': v.get('short'), 'line': v.get('line'),
            'type': 'tram' if key.startswith('tram:') else 'bus', 'color': v.get('color'),
        }))
    if jobs and not _line_shapes_worker['running']:
        _line_shapes_worker['running'] = True
        threading.Thread(target=_line_shapes_job, args=(jobs[:40],), daemon=True).start()

    with _line_shapes_lock:
        out = [{
            'key': e['key'], 'short': e.get('short'), 'line': e.get('line'), 'type': e.get('type'),
            'color': e.get('color'), 'shapes': [s['pts'] for s in e['shapes'].values()],
            'changes': [{k: v for k, v in c.items() if k != 'ts'} for c in (e.get('changes') or {}).values()],
            'stops': [[n, ll[0], ll[1]] for n, ll in (e.get('stops') or {}).items()],
        } for e in _line_shapes['lines'].values()]
    return jsonify({'lines': out, 'pending': len(jobs), 'building': _line_shapes_worker['running']})


# ===================================================================
#  WEB PUSH  (real push notifications, also when the app is closed)
#  - VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291)
#  - implemented with `cryptography` only, no extra push library needed
# ===================================================================
import base64
import uuid
from urllib.parse import urlparse

try:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    PUSH_AVAILABLE = True
except Exception as _push_ex:  # pragma: no cover
    print(f"[WARN] Push deaktiviert (cryptography fehlt): {_push_ex}")
    PUSH_AVAILABLE = False

PUSH_SUBS_FILE = os.path.join(CACHE_DIR, 'push_subscriptions.json')
PUSH_STATE_FILE = os.path.join(CACHE_DIR, 'push_state.json')
VAPID_FILE = os.path.join(CACHE_DIR, 'vapid.json')
VAPID_SUBJECT = os.environ.get('VAPID_SUBJECT', 'https://mvb-app.onrender.com')
_push_lock = threading.RLock()
_push = {'subs': None, 'state': None, 'vapid': None, 'watcher': False, 'last_tick': 0, 'last_disr': 0}


def _b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64u_dec(text):
    text = str(text).strip()
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _vapid():
    """VAPID key pair: from env (VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY) or generated once into cache/vapid.json."""
    if _push['vapid']:
        return _push['vapid']
    priv_b64 = os.environ.get('VAPID_PRIVATE_KEY', '').strip()
    if not priv_b64 and os.path.exists(VAPID_FILE):
        try:
            with open(VAPID_FILE, 'r', encoding='utf-8') as f:
                priv_b64 = json.load(f).get('private', '')
        except Exception:
            priv_b64 = ''
    if priv_b64:
        priv_int = int.from_bytes(_b64u_dec(priv_b64), 'big')
        key = ec.derive_private_key(priv_int, ec.SECP256R1())
    else:
        key = ec.generate_private_key(ec.SECP256R1())
        priv_b64 = _b64u(key.private_numbers().private_value.to_bytes(32, 'big'))
        pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        try:
            with open(VAPID_FILE, 'w', encoding='utf-8') as f:
                json.dump({'private': priv_b64, 'public': _b64u(pub)}, f)
            print("[INFO] Neue VAPID-Schlüssel erzeugt (cache/vapid.json)")
        except Exception as ex:
            print(f"[WARN] VAPID-Schlüssel nicht gespeichert: {ex}")
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    _push['vapid'] = {'key': key, 'public': _b64u(pub)}
    return _push['vapid']


def _vapid_auth_header(endpoint):
    v = _vapid()
    u = urlparse(endpoint)
    header = _b64u(json.dumps({'typ': 'JWT', 'alg': 'ES256'}, separators=(',', ':')).encode())
    claims = _b64u(json.dumps({'aud': f'{u.scheme}://{u.netloc}', 'exp': int(time.time()) + 12 * 3600,
                               'sub': VAPID_SUBJECT}, separators=(',', ':')).encode())
    signing_input = f'{header}.{claims}'.encode()
    r, s = decode_dss_signature(v['key'].sign(signing_input, ec.ECDSA(hashes.SHA256())))
    jwt = signing_input.decode() + '.' + _b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
    return f"vapid t={jwt}, k={v['public']}"


def _push_encrypt(payload, p256dh, auth):
    """RFC 8291 aes128gcm encryption of a push message."""
    ua_pub = _b64u_dec(p256dh)
    auth_secret = _b64u_dec(auth)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_pub = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = HKDF(hashes.SHA256(), 32, auth_secret, b'WebPush: info\x00' + ua_pub + as_pub).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt, b'Content-Encoding: aes128gcm\x00').derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b'Content-Encoding: nonce\x00').derive(ikm)
    body = AESGCM(cek).encrypt(nonce, payload + b'\x02', None)
    return salt + (4096).to_bytes(4, 'big') + bytes([len(as_pub)]) + as_pub + body


def _send_push(sub, message, ttl=3600, urgency='high'):
    """Send one push. Returns True (sent), False (failed) or None (subscription gone)."""
    if not PUSH_AVAILABLE:
        return False
    try:
        keys = sub.get('keys') or {}
        data = json.dumps(message, ensure_ascii=False).encode('utf-8')
        body = _push_encrypt(data, keys['p256dh'], keys['auth'])
        resp = requests.post(sub['endpoint'], data=body, timeout=10, headers={
            'Authorization': _vapid_auth_header(sub['endpoint']),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'TTL': str(ttl),
            'Urgency': urgency,
        })
        if resp.status_code in (404, 410):
            return None
        if resp.status_code >= 400:
            print(f"[WARN] Push {resp.status_code}: {resp.text[:160]}")
            return False
        return True
    except Exception as ex:
        print(f"[WARN] Push fehlgeschlagen: {ex}")
        return False


def _load_json_file(path, default):
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as ex:
        print(f"[WARN] {os.path.basename(path)}: {ex}")
    return default


def _save_json_file(path, data):
    try:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as ex:
        print(f"[WARN] {os.path.basename(path)} nicht gespeichert: {ex}")


def _subs():
    if _push['subs'] is None:
        with _push_lock:
            if _push['subs'] is None:
                _push['subs'] = _load_json_file(PUSH_SUBS_FILE, {})
    return _push['subs']


def _push_state():
    if _push['state'] is None:
        with _push_lock:
            if _push['state'] is None:
                _push['state'] = _load_json_file(PUSH_STATE_FILE, {'seen': [], 'seeded': False})
    return _push['state']


def _sub_key(endpoint):
    return hashlib.sha1(str(endpoint).encode()).hexdigest()[:16]


def _drop_sub(key):
    with _push_lock:
        if _subs().pop(key, None) is not None:
            _save_json_file(PUSH_SUBS_FILE, _subs())


def _in_quiet_hours(prefs):
    q = prefs.get('quiet')
    if not q:
        return False
    try:
        start, end = int(q[0]), int(q[1])
    except Exception:
        return False
    h = datetime.datetime.now(local_tz).hour
    return (start <= h or h < end) if start > end else (start <= h < end)


def _disruption_lines(d):
    nums = set()
    for l in d.get('lines') or []:
        m = re.search(r'\d+', str(l))
        if m:
            nums.add(m.group(0))
    text = f"{d.get('title', '')} {d.get('desc', '')}"
    for m in re.finditer(r'(?:Linie|Linien|Str\.?|Bus|Tram|SEV)\s*((?:\d{1,3}(?:\s*(?:,|und|/|&)\s*)?)+)', text, re.I):
        nums.update(re.findall(r'\d{1,3}', m.group(1)))
    return nums


def _check_disruptions_for_push():
    """Detect new Verkehrsmelder entries and notify matching subscribers."""
    try:
        with app.test_request_context('/api/disruptions'):
            resp = get_disruptions()
        if isinstance(resp, tuple):
            return 0
        items = resp.get_json() or []
    except Exception as ex:
        print(f"[WARN] Push-Störungscheck: {ex}")
        return 0
    if not isinstance(items, list):
        return 0
    state = _push_state()
    seen = set(state.get('seen') or [])
    current = [d for d in items if d.get('id')]
    new = [d for d in current if d['id'] not in seen]
    state['seen'] = list(seen | {d['id'] for d in current})[-400:]
    if not state.get('seeded'):
        # first run: remember what already exists, don't spam
        state['seeded'] = True
        _save_json_file(PUSH_STATE_FILE, state)
        return 0
    _save_json_file(PUSH_STATE_FILE, state)
    sent = 0
    for d in new:
        lines = _disruption_lines(d)
        crit = bool(d.get('critical'))
        title = ('🚨 ' if crit else '⚠️ ') + (d.get('title') or 'Neue Meldung')
        body = re.sub(r'\s+', ' ', d.get('desc') or '').strip()
        if len(body) > 170:
            body = body[:167].rsplit(' ', 1)[0] + '…'
        msg = {'title': title, 'body': body or 'Details im Verkehrsmelder', 'tag': f"disr-{d['id']}",
               'url': '/?tab=alerts', 'kind': 'disruption', 'lines': sorted(lines)}
        for key, sub in list(_subs().items()):
            prefs = sub.get('prefs') or {}
            if not prefs.get('disruptions', True):
                continue
            if prefs.get('criticalOnly') and not crit:
                continue
            want = {str(x) for x in prefs.get('lines') or []}
            if want and lines and not (want & lines):
                continue
            if want and not lines and prefs.get('strictLines'):
                continue
            if _in_quiet_hours(prefs) and not crit:
                continue
            ok = _send_push(sub, msg)
            if ok is None:
                _drop_sub(key)
            elif ok:
                sent += 1
    return sent


def _hhmm_to_epoch(hhmm, ref_epoch):
    """Turn 'HH:MM' into an epoch close to ref_epoch (handles midnight)."""
    try:
        h, m = [int(x) for x in hhmm.split(':')[:2]]
    except Exception:
        return None
    ref = datetime.datetime.fromtimestamp(ref_epoch, local_tz)
    best = None
    for day in (-1, 0, 1):
        cand = (ref + datetime.timedelta(days=day)).replace(hour=h, minute=m, second=0, microsecond=0)
        if best is None or abs((cand - ref).total_seconds()) < abs((best - ref).total_seconds()):
            best = cand
    return best.timestamp()


def _norm_station(name):
    return re.sub(r'[^a-z0-9äöüß]', '', re.sub(r'^magdeburg,\s*', '', (name or '').lower()))


def _check_reminders():
    """Send departure reminders ('Abfahrts-Wecker') that are due."""
    now = time.time()
    sent = 0
    done = {}  # sub key -> set(reminder ids) to remove
    for key, sub in list(_subs().items()):
        for r in list(sub.get('reminders') or []):
            planned = r.get('planned', 0) / 1000.0
            if now > planned + 30 * 60:
                done.setdefault(key, set()).add(r.get('id'))
                continue  # long gone
            if now < planned - (r.get('lead', 5) + 25) * 60:
                continue  # far in the future, no need to ask HAFAS yet
            depart = planned + 60 * (r.get('delay') or 0)
            cancelled = False
            try:
                trip = _fetch_trip(r['jid'])
                target = _norm_station(r.get('station'))
                for st in trip.get('stops') or []:
                    n = _norm_station(st.get('name'))
                    if n == target or (target and (target in n or n in target)):
                        ep = _hhmm_to_epoch(st.get('rt') or st.get('time'), planned)
                        if ep:
                            depart = ep
                        cancelled = bool(st.get('cancelled'))
                        break
            except Exception:
                pass
            mins = int(round((depart - now) / 60))
            delay = int(round((depart - planned) / 60))
            if not (cancelled or mins <= r.get('lead', 5)):
                continue
            line = r.get('line') or 'Deine Linie'
            where = f"Richtung {r.get('direction', '')} ab {r.get('station', '')}"
            if cancelled:
                title, body = f"❌ {line} fällt aus", f"Die Fahrt {where} fällt aus."
            else:
                title = f"🚋 {line} fährt jetzt!" if mins <= 0 else f"⏰ {line} fährt in {mins} Min."
                body = where + (f" · +{delay} Min. Verspätung" if delay > 0 else
                                f" · {abs(delay)} Min. zu früh!" if delay < 0 else " · pünktlich")
            ok = _send_push(sub, {'title': title, 'body': body, 'tag': f"rem-{r.get('id')}", 'url': '/?tab=departures',
                                  'kind': 'reminder', 'requireInteraction': True}, ttl=600)
            if ok is None:
                _drop_sub(key)
                break
            done.setdefault(key, set()).add(r.get('id'))
            sent += 1 if ok else 0
    if done:
        with _push_lock:
            for key, ids in done.items():
                sub = _subs().get(key)
                if sub:
                    sub['reminders'] = [r for r in sub.get('reminders') or [] if r.get('id') not in ids]
            _save_json_file(PUSH_SUBS_FILE, _subs())
    return sent


def _push_tick(force=False):
    now = time.time()
    if not force and now - _push['last_tick'] < 25:
        return {}
    _push['last_tick'] = now
    out = {'reminders': 0, 'disruptions': 0}
    if not _subs():
        return out
    try:
        out['reminders'] = _check_reminders()
    except Exception as ex:
        print(f"[WARN] Erinnerungen: {ex}")
    if force or now - _push['last_disr'] > 150:
        _push['last_disr'] = now
        try:
            out['disruptions'] = _check_disruptions_for_push()
        except Exception as ex:
            print(f"[WARN] Störungs-Push: {ex}")
    return out


def _push_watcher():
    while True:
        try:
            _push_tick()
        except Exception as ex:
            print(f"[WARN] Push-Watcher: {ex}")
        time.sleep(30)


def _ensure_push_watcher():
    if PUSH_AVAILABLE and not _push['watcher']:
        with _push_lock:
            if not _push['watcher']:
                _push['watcher'] = True
                threading.Thread(target=_push_watcher, daemon=True, name='push-watcher').start()


@app.before_request
def _start_background_workers():
    _ensure_push_watcher()


def _clean_prefs(p):
    p = p or {}
    lines = []
    for l in p.get('lines') or []:
        m = re.search(r'\d{1,3}', str(l))
        if m and m.group(0) not in lines:
            lines.append(m.group(0))
    quiet = p.get('quiet')
    if quiet and isinstance(quiet, (list, tuple)) and len(quiet) == 2:
        quiet = [int(quiet[0]) % 24, int(quiet[1]) % 24]
    else:
        quiet = None
    return {'disruptions': bool(p.get('disruptions', True)), 'criticalOnly': bool(p.get('criticalOnly', False)),
            'lines': lines[:30], 'quiet': quiet}


@app.route('/api/push/key')
def push_key():
    if not PUSH_AVAILABLE:
        return jsonify({'enabled': False}), 503
    return jsonify({'enabled': True, 'publicKey': _vapid()['public']})


@app.route('/api/push/subscribe', methods=['POST'])
def push_subscribe():
    if not PUSH_AVAILABLE:
        return jsonify({'error': 'Push nicht verfügbar'}), 503
    data = request.get_json(silent=True) or {}
    sub = data.get('subscription') or {}
    if not sub.get('endpoint') or not (sub.get('keys') or {}).get('p256dh'):
        return jsonify({'error': 'Ungültiges Abo'}), 400
    key = _sub_key(sub['endpoint'])
    with _push_lock:
        entry = _subs().get(key) or {'created': int(time.time()), 'reminders': []}
        entry.update({'endpoint': sub['endpoint'], 'keys': sub['keys'], 'prefs': _clean_prefs(data.get('prefs')),
                      'seen': int(time.time()), 'ua': (request.headers.get('User-Agent') or '')[:120]})
        # reminders the device still knows about (e.g. after a server restart)
        if data.get('reminders') and not entry.get('reminders'):
            entry['reminders'] = [r for r in data['reminders'] if isinstance(r, dict) and r.get('jid')][:20]
        _subs()[key] = entry
        _save_json_file(PUSH_SUBS_FILE, _subs())
    return jsonify({'ok': True, 'reminders': entry.get('reminders', [])})


@app.route('/api/push/unsubscribe', methods=['POST'])
def push_unsubscribe():
    data = request.get_json(silent=True) or {}
    if data.get('endpoint'):
        _drop_sub(_sub_key(data['endpoint']))
    return jsonify({'ok': True})


@app.route('/api/push/test', methods=['POST'])
def push_test():
    data = request.get_json(silent=True) or {}
    sub = _subs().get(_sub_key(data.get('endpoint', '')))
    if not sub:
        return jsonify({'error': 'Gerät nicht registriert – bitte Push neu aktivieren'}), 404
    ok = _send_push(sub, {'title': '🔔 Test erfolgreich!', 'body': 'Push-Benachrichtigungen kommen an – auch wenn die App geschlossen ist. 💥',
                          'tag': 'test', 'url': '/?tab=alerts', 'kind': 'test'}, ttl=300)
    if ok is None:
        _drop_sub(_sub_key(data.get('endpoint', '')))
        return jsonify({'error': 'Abo abgelaufen – bitte Push neu aktivieren'}), 410
    return jsonify({'ok': bool(ok)}), (200 if ok else 502)


@app.route('/api/push/remind', methods=['POST'])
def push_remind():
    data = request.get_json(silent=True) or {}
    key = _sub_key(data.get('endpoint', ''))
    with _push_lock:
        sub = _subs().get(key)
        if not sub:
            return jsonify({'error': 'Gerät nicht registriert'}), 404
        rems = sub.setdefault('reminders', [])
        if data.get('cancel'):
            sub['reminders'] = [r for r in rems if r.get('id') != data['cancel']]
            _save_json_file(PUSH_SUBS_FILE, _subs())
            return jsonify({'ok': True, 'reminders': sub['reminders']})
        if not data.get('jid') or not data.get('planned'):
            return jsonify({'error': 'Fahrt fehlt'}), 400
        rem = {
            'id': data.get('id') or uuid.uuid4().hex[:10],
            'jid': data['jid'], 'line': str(data.get('line', ''))[:20], 'direction': str(data.get('direction', ''))[:80],
            'station': str(data.get('station', ''))[:80], 'planned': int(data['planned']),
            'lead': max(1, min(30, int(data.get('lead', 5)))), 'delay': int(data.get('delay') or 0),
        }
        sub['reminders'] = [r for r in rems if r.get('id') != rem['id']][-19:] + [rem]
        _save_json_file(PUSH_SUBS_FILE, _subs())
    _ensure_push_watcher()
    return jsonify({'ok': True, 'reminder': rem, 'reminders': sub['reminders']})


@app.route('/api/push/tick')
def push_tick_route():
    """Can be pinged by an external cron job (keeps a free Render instance awake)."""
    _ensure_push_watcher()
    res = _push_tick(force=request.args.get('force') == '1')
    return jsonify({'ok': True, 'subscribers': len(_subs()), **(res or {})})


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    print("=" * 60)
    print("  MVB Magdeburg Transit Backend")
    print(f"  NASA client: {'OK' if nasa_client else 'UNAVAILABLE'}")
    print(f"  OEBB client: {'OK' if oebb_client else 'UNAVAILABLE'}")
    print(f"  Starting on http://0.0.0.0:{port}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=port, debug=True, use_reloader=False)
