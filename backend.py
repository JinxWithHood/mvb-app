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
app = Flask(__name__, static_folder='.', static_url_path='')
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
                    "direction": dep.direction,
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
if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    print("=" * 60)
    print("  MVB Magdeburg Transit Backend")
    print(f"  NASA client: {'OK' if nasa_client else 'UNAVAILABLE'}")
    print(f"  OEBB client: {'OK' if oebb_client else 'UNAVAILABLE'}")
    print(f"  Starting on http://0.0.0.0:{port}")
    print("=" * 60)
    app.run(host='0.0.0.0', port=port, debug=True, use_reloader=False)
