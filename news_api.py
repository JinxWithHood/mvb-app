"""Magdeburg Mobil – Störungsmeldungen (mvb-verkehrsmelder.de) und MVB-News (mvbnet.de).

Routen: /api/disruptions, /api/disruptions/check, /api/news, /api/news/article
(aus backend.py ausgelagert, unverändertes Verhalten).
"""
import datetime
import hashlib
import html
import re
import time
import traceback
from urllib.parse import urlparse

import pytz
import requests
from bs4 import BeautifulSoup
from flask import Blueprint, jsonify, request

bp = Blueprint('news_api', __name__)
local_tz = pytz.timezone("Europe/Berlin")


# -------------------------------------------------------------------
# GET /api/disruptions  —  Scrape MVB disruption reports
# -------------------------------------------------------------------
@bp.route('/api/disruptions')
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
@bp.route('/api/disruptions/check')
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

@bp.route('/api/news')
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
    # text comes from a foreign page and ends up as HTML – escape first, then add our own markup
    raw_text = html.escape(raw_text, quote=False)
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

@bp.route('/api/news/article')
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

    try:
        _u = urlparse(article_url)
        _host = (_u.hostname or '').lower()
    except Exception:
        _u, _host = None, ''
    if not _u or _u.scheme not in ('http', 'https') or not (_host == 'mvbnet.de' or _host.endswith('.mvbnet.de')):
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
