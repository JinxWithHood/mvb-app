import os
import datetime
import traceback
import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pyhafas import HafasClient
from pyhafas.profile import NASAProfile

# Initialize Flask and CORS
app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# Initialize HAFAS Client with NASA (Saxony-Anhalt) profile
try:
    client = HafasClient(NASAProfile())
except Exception as e:
    print("Warning: Could not initialize HAFAS client:", e)
    client = None

# Fallback routes for Magdeburg lines (Tram and select Bus routes)
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
        "Reform", "Bördepark Ost", "Pallasweg", "Merkurweg", "Flugplatz/Technisches Hilfswerk (Lindenhof)",
        "Am Hopfengarten", "Weinbrennerallee", "Leipziger Chaussee", "Freibad Süd", "Brenneckestr.",
        "Universitätsklinikum", "Fermersleber Weg", "Südfriedhof", "Raiffeisenstr.", "Dodendorfer Str.",
        "S-Bahnhof Buckau/Puppentheater", "Benediktinerstr./Gesellschaftshaus", "AMO/Steubenallee"
    ]
}

def parse_hafas_time(time_str):
    if not time_str:
        return 0
    h = int(time_str[0:2])
    m = int(time_str[2:4])
    return h * 60 + m

def normalize_line_name(name):
    if not name:
        return ""
    name_lower = name.lower()
    for prefix in ["str", "tram", "bus", "nachtbus", "linie", "line"]:
        name_lower = name_lower.replace(prefix, "")
    return name_lower.strip()

def generate_fallback_journey(line, direction, start_time_str, delay, station_name=None):
    line_norm = normalize_line_name(line)
    stops_list = FALLBACK_ROUTES.get(line_norm)
    if not stops_list:
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
        stops_list = list(stops_list)

    stops_list = [s if s.startswith("Magdeburg") else f"Magdeburg, {s}" for s in stops_list]

    dir_lower = direction.lower() if direction else ""
    if len(stops_list) > 1:
        start_stop = stops_list[0].lower()
        end_stop = stops_list[-1].lower()
        if any(x in dir_lower for x in start_stop.replace("magdeburg,", "").strip().split()) or \
           (not any(x in dir_lower for x in end_stop.replace("magdeburg,", "").strip().split()) and \
            any(x in dir_lower for x in start_stop.replace("magdeburg,", "").strip().split())):
            stops_list.reverse()

    idx = 0
    if station_name:
        stat_lower = station_name.lower().replace("magdeburg,", "").strip()
        for i, stop in enumerate(stops_list):
            stop_clean = stop.lower().replace("magdeburg,", "").strip()
            if stat_lower in stop_clean or stop_clean in stat_lower:
                idx = i
                break

    try:
        parts = start_time_str.split(":")
        h, m = int(parts[0]), int(parts[1])
        now = datetime.datetime.now()
        anchor_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    except Exception:
        anchor_dt = datetime.datetime.now()

    stops = []
    now_ts = datetime.datetime.now().timestamp()

    for i, name in enumerate(stops_list):
        diff_min = (i - idx) * 2
        stop_dt = anchor_dt + datetime.timedelta(minutes=diff_min)
        passed = stop_dt.timestamp() < now_ts
        time_str = stop_dt.strftime('%H:%M')
        
        # Calculate slight variations in delay
        stop_delay = delay
        if i < idx and passed:
            stop_delay = max(0, delay - (idx - i) // 2)
        elif i > idx:
            stop_delay = delay + (i - idx) // 3
            
        stops.append({
            "name": name,
            "time": time_str,
            "delay": stop_delay,
            "passed": passed,
            "platform": "",
            "cancelled": False
        })

    return jsonify({
        "line": line,
        "direction": direction if direction else (stops_list[-1] if stops_list else "Endstation"),
        "stops": stops
    })

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/api/search')
def search_station():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])
    try:
        if client:
            locations = client.locations(query)
            result = [{"id": loc.id, "name": loc.name} for loc in locations if loc.id]
            return jsonify(result)
    except Exception as e:
        print("Search API error:", e)
        
    # Local fallback for searching
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
        {"id": "7409", "name": "Magdeburg, Herrenkrug"}
    ]
    query_lower = query.lower()
    matches = [s for s in stations if query_lower in s["name"].lower()]
    return jsonify(matches)

@app.route('/api/departures')
def get_departures():
    station_id = request.args.get('station_id')
    if not station_id:
        return jsonify({"error": "station_id required"}), 400
    
    date_param = request.args.get('date') # YYYY-MM-DD
    time_param = request.args.get('time') # HH:MM
    duration_param = request.args.get('duration', '60') # in minutes
    
    try:
        duration = int(duration_param)
    except ValueError:
        duration = 60
        
    search_dt = datetime.datetime.now()
    if date_param and time_param:
        try:
            search_dt = datetime.datetime.strptime(f"{date_param} {time_param}", "%Y-%m-%d %H:%M")
        except Exception as e:
            print("Departures date parse error:", e)

    try:
        if client:
            departures = client.departures(
                station=station_id,
                date=search_dt,
                duration=duration,
                max_trips=40
            )
            result = []
            for dep in departures:
                delay = None
                if dep.dateTime and dep.delay is not None:
                    delay = int(dep.delay.total_seconds() / 60)
                
                line_name = dep.name
                line_lower = line_name.lower()
                
                clean_num = line_name.replace(" ", "").replace("Str", "").replace("Tram", "").replace("Bus", "").strip()
                is_num = clean_num.isdigit()
                is_tram = any(x in line_lower for x in ["str", "tram", "s-bahn"]) or \
                          (is_num and int(clean_num) <= 15) or \
                          ("n" in line_lower and is_num and int(clean_num.replace("n", "")) <= 10)
                
                result.append({
                    "id": dep.id,
                    "journey_id": dep.id,
                    "line": line_name,
                    "direction": dep.direction,
                    "time": dep.dateTime.strftime('%H:%M') if dep.dateTime else "",
                    "delay": delay,
                    "type": "tram" if is_tram else "bus"
                })
            return jsonify(result)
    except Exception as e:
        print("HAFAS departures error:", e)
        traceback.print_exc()

    # Dynamic fallback departures based on station_id
    print(f"Generating fallback departures for station {station_id}")
    now = datetime.datetime.now()
    result = []
    
    # Generate generic departure slots
    lines_pool = [
        {"line": "Str 2", "dir": "Magdeburg, Westerhüsen", "type": "tram"},
        {"line": "Str 9", "dir": "Magdeburg, Neustädter See", "type": "tram"},
        {"line": "Str 10", "dir": "Magdeburg, Sudenburg", "type": "tram"},
        {"line": "Str 6", "dir": "Magdeburg, Herrenkrug", "type": "tram"},
        {"line": "Bus 57", "dir": "Magdeburg, AMO/Steubenallee", "type": "bus"},
        {"line": "Bus 51", "dir": "Magdeburg, Biederitz", "type": "bus"},
        {"line": "Bus 73", "dir": "Magdeburg, Olvenstedt", "type": "bus"}
    ]
    
    for i, lp in enumerate(lines_pool):
        dep_time = now + datetime.timedelta(minutes=4 + i * 7)
        delay = 0 if i % 3 != 0 else (2 if i % 6 == 0 else 5)
        result.append({
            "id": f"mock_j_{lp['line'].replace(' ', '')}_{i}",
            "journey_id": f"mock_j_{lp['line'].replace(' ', '')}_{i}",
            "line": lp["line"],
            "direction": lp["dir"],
            "time": dep_time.strftime('%H:%M'),
            "delay": delay,
            "type": lp["type"]
        })
        
    return jsonify(result)

@app.route('/api/journey')
def get_journey():
    journey_id = request.args.get('journey_id')
    fallback_line = request.args.get('line', 'Tram')
    fallback_direction = request.args.get('direction', 'Endstation')
    fallback_time = request.args.get('time', '12:00')
    delay_param = request.args.get('delay', '0')
    fallback_delay = 0
    if delay_param and delay_param.lower() not in ['null', 'none']:
        try:
            fallback_delay = int(delay_param)
        except ValueError:
            pass
    station_name = request.args.get('station_name', '')
    
    if not journey_id:
        return jsonify({"error": "journey_id required"}), 400
        
    # Check if mock journey or client not initialized
    if journey_id.startswith("mock_j_") or not client:
        return generate_fallback_journey(fallback_line, fallback_direction, fallback_time, fallback_delay, station_name)

    try:
        req_data = {
            'req': {
                'jid': journey_id
            },
            'meth': 'JourneyDetails'
        }
        res = client.profile.request(req_data).res
        journey = res.get('journey', {})
        common = res.get('common', {})
        locL = common.get('locL', [])
        
        prod_list = journey.get('prodL', [])
        trip_num = None
        if prod_list and len(common.get('prodL', [])) > 0:
            prod_idx = prod_list[0].get('prodX', 0)
            if prod_idx < len(common['prodL']):
                product = common['prodL'][prod_idx]
                prod_ctx = product.get('prodCtx', {})
                trip_num = prod_ctx.get('num')
        
        stops_raw = journey.get('stopL', [])
        lPassSt_raw = journey.get('lPassSt')
        lPassSt = -1
        if isinstance(lPassSt_raw, dict):
            lPassSt = lPassSt_raw.get('idx', -1)
        elif isinstance(lPassSt_raw, int):
            lPassSt = lPassSt_raw
            
        stops = []
        for s in stops_raw:
            loc_idx = s.get('locX', 0)
            name = locL[loc_idx].get('name') if loc_idx < len(locL) else "Unknown"
            idx = s.get('idx', 0)
            
            d_time_s = s.get('dTimeS')
            d_time_r = s.get('dTimeR')
            a_time_s = s.get('aTimeS')
            a_time_r = s.get('aTimeR')
            
            planned = d_time_s if d_time_s else a_time_s
            actual = d_time_r if d_time_r else a_time_r
            
            time_str = ""
            if planned:
                time_str = f"{planned[0:2]}:{planned[2:4]}"
            
            delay = None
            if planned and actual:
                delay = parse_hafas_time(actual) - parse_hafas_time(planned)
                if delay < -1000:
                    delay += 1440
                elif delay > 1000:
                    delay -= 1440
            
            passed = idx <= lPassSt
            
            # Platform (Track/Steig)
            pltf = ""
            pltf_s = s.get('dPltfS', s.get('aPltfS'))
            if pltf_s:
                pltf = pltf_s.get('txt', '')
                
            cancelled = s.get('dCncl', False) or s.get('aCncl', False)

            stops.append({
                "name": name,
                "time": time_str,
                "delay": delay,
                "passed": passed,
                "platform": pltf,
                "cancelled": cancelled
            })
            
        return jsonify({
            "line": journey.get('prodL', [{}])[0].get('name', fallback_line),
            "direction": journey.get('dirTxt', fallback_direction),
            "trip_num": trip_num,
            "stops": stops
        })
    except Exception as e:
        print(f"HAFAS raw journey error: {e}. Utilizing fallback generator.")
        traceback.print_exc()
        return generate_fallback_journey(fallback_line, fallback_direction, fallback_time, fallback_delay, station_name)

@app.route('/api/connections')
def get_connections():
    origin = request.args.get('origin')
    destination = request.args.get('destination')
    
    if not origin or not destination:
        return jsonify({"error": "origin and destination required"}), 400
        
    try:
        date_param = request.args.get('date') # YYYY-MM-DD
        time_param = request.args.get('time') # HH:MM
        
        search_dt = datetime.datetime.now()
        if date_param and time_param:
            try:
                search_dt = datetime.datetime.strptime(f"{date_param} {time_param}", "%Y-%m-%d %H:%M")
            except Exception as e:
                print("Date parse error:", e)

        if client:
            journeys = client.journeys(
                origin=origin,
                destination=destination,
                date=search_dt,
                max_changes=3,
                max_journeys=5
            )
            result = []
            for j in journeys:
                legs = []
                for leg in j.legs:
                    dep_delay = None
                    if leg.departureDelay is not None:
                        dep_delay = int(leg.departureDelay.total_seconds() / 60)
                    arr_delay = None
                    if leg.arrivalDelay is not None:
                        arr_delay = int(leg.arrivalDelay.total_seconds() / 60)
                    
                    line_name = leg.name if leg.name else "Fußweg"
                    line_lower = line_name.lower()
                    
                    clean_num = line_name.replace(" ", "").replace("Str", "").replace("Tram", "").replace("Bus", "").strip()
                    is_num = clean_num.isdigit()
                    is_tram = any(x in line_lower for x in ["str", "tram", "s-bahn"]) or \
                              (is_num and int(clean_num) <= 15) or \
                              ("n" in line_lower and is_num and int(clean_num.replace("n", "")) <= 10)
                    
                    legs.append({
                        "line": line_name,
                        "origin": leg.origin.name,
                        "destination": leg.destination.name,
                        "departure_time": leg.departure.strftime('%H:%M') if leg.departure else "",
                        "departure_delay": dep_delay,
                        "arrival_time": leg.arrival.strftime('%H:%M') if leg.arrival else "",
                        "arrival_delay": arr_delay,
                        "type": "walk" if not leg.name else ("tram" if is_tram else "bus"),
                        "platform": leg.departurePlatform if leg.departurePlatform else "",
                        "cancelled": getattr(leg, 'cancelled', False),
                        "journey_id": getattr(leg, 'id', None)
                    })
                
                duration_min = int(j.duration.total_seconds() / 60) if j.duration else 0
                result.append({
                    "duration": duration_min,
                    "legs": legs
                })
            return jsonify(result)
    except Exception as e:
        print("Connections API error:", e)
        traceback.print_exc()
        
    # Local fallback connection planner if HAFAS fails or station is not found
    print(f"Generating fallback connections from {origin} to {destination}")
    now = datetime.datetime.now()
    dep_time1 = now + datetime.timedelta(minutes=4)
    arr_time1 = dep_time1 + datetime.timedelta(minutes=18)
    
    dep_time2 = now + datetime.timedelta(minutes=15)
    arr_time2 = dep_time2 + datetime.timedelta(minutes=36)
    
    return jsonify([
        {
            "duration": 18,
            "legs": [
                {
                    "line": "Str 9",
                    "origin": "Magdeburg, Neustäder Platz" if origin in ["7335", "733502"] else "Startstation",
                    "destination": "Magdeburg, Allee-Center" if destination in ["4493", "300449301"] else "Zielstation",
                    "departure_time": dep_time1.strftime('%H:%M'),
                    "departure_delay": 2,
                    "arrival_time": arr_time1.strftime('%H:%M'),
                    "arrival_delay": 2,
                    "type": "tram",
                    "platform": "Gleis 1",
                    "cancelled": False,
                    "journey_id": "mock_j_Str9_1"
                }
            ]
        },
        {
            "duration": 21,
            "legs": [
                {
                    "line": "Str 9",
                    "origin": "Magdeburg, Neustäder Platz" if origin in ["7335", "733502"] else "Startstation",
                    "destination": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz",
                    "departure_time": dep_time2.strftime('%H:%M'),
                    "departure_delay": 0,
                    "arrival_time": (dep_time2 + datetime.timedelta(minutes=14)).strftime('%H:%M'),
                    "arrival_delay": 0,
                    "type": "tram",
                    "platform": "Gleis 1",
                    "cancelled": False,
                    "journey_id": "mock_j_Str9_2"
                },
                {
                    "line": "Fußweg",
                    "origin": "Magdeburg, Hauptbahnhof/Willy-Brandt-Platz",
                    "destination": "Magdeburg, City Carré",
                    "departure_time": (dep_time2 + datetime.timedelta(minutes=14)).strftime('%H:%M'),
                    "departure_delay": 0,
                    "arrival_time": (dep_time2 + datetime.timedelta(minutes=16)).strftime('%H:%M'),
                    "arrival_delay": 0,
                    "type": "walk",
                    "platform": "",
                    "cancelled": False,
                    "journey_id": None
                },
                {
                    "line": "Str 6",
                    "origin": "Magdeburg, City Carré",
                    "destination": "Magdeburg, Allee-Center" if destination in ["4493", "300449301"] else "Zielstation",
                    "departure_time": (dep_time2 + datetime.timedelta(minutes=17)).strftime('%H:%M'),
                    "departure_delay": 1,
                    "arrival_time": arr_time2.strftime('%H:%M'),
                    "arrival_delay": 1,
                    "type": "tram",
                    "platform": "Gleis 2",
                    "cancelled": False,
                    "journey_id": "mock_j_Str6_1"
                }
            ]
        }
    ])

@app.route('/api/disruptions')
def get_disruptions():
    try:
        url = "https://mvb-verkehrsmelder.de/"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        response.encoding = 'utf-8'
        
        soup = BeautifulSoup(response.text, 'html.parser')
        articles = soup.find_all('article')
        
        disruptions = []
        for article in articles:
            title_tag = article.find(['h1', 'h2', 'h3'], class_='entry-title')
            title = title_tag.get_text(strip=True) if title_tag else "Meldung"
            
            content_div = article.find('div', class_='entry-content')
            desc = ""
            if content_div:
                paragraphs = content_div.find_all('p')
                desc = "\n".join(p.get_text(strip=True) for p in paragraphs)
            
            lines = []
            meta_div = article.find('div', class_='kt-post-cats')
            if meta_div:
                links = meta_div.find_all('a')
                for link in links:
                    lines.append(link.get_text(strip=True))
            
            critical = any(x in title.lower() or x in desc.lower() for x in ["sperrung", "ausfall", "gesperrt", "unfall"])
            
            if title and desc:
                disruptions.append({
                    "title": title,
                    "desc": desc,
                    "time": "Aktuell",
                    "lines": lines,
                    "critical": critical
                })
        
        if disruptions:
            return jsonify(disruptions)
    except Exception as e:
        print("Disruptions scraping error:", e)
        
    # Return placeholder disruptions if scraping fails or is empty
    return jsonify([
        {
            "title": "Linie 57: Verspätungen wegen technischem Defekt",
            "desc": "Linie 57: Nach einem technischen Defekt kommt es auf der gesamten Linie zu Verspätungen. Wir bitten um Geduld.",
            "time": "Aktuell",
            "lines": ["Linie 57"],
            "critical": False
        },
        {
            "title": "Linie 61: Umleitung wegen Rohrbruch in Rottersdorfer Straße",
            "desc": "Linie 61: Aufgrund eines Rohrbruchs in der Rottersdorfer Straße können die Haltestellen Eiskellerplatz und Sudenburg nicht angefahren werden. Die Busse werden umgeleitet.",
            "time": "Aktuell",
            "lines": ["Linie 61"],
            "critical": True
        },
        {
            "title": "Linie 51: Haltestelle Heyrothsberge entfällt wegen Baustelle",
            "desc": "Linie 51: Wegen einer Baustelle auf der Bundesstraße 1 kann die Haltestelle Heyrothsberge nicht angefahren werden. Ersatzhaltestellen sind eingerichtet.",
            "time": "Aktuell",
            "lines": ["Linie 51"],
            "critical": False
        }
    ])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
