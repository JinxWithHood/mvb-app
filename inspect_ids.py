import re
import os

app_dir = r"C:\Users\melvi\.gemini\antigravity\scratch\mvb-app"
html_path = os.path.join(app_dir, "index.html")
js_path = os.path.join(app_dir, "app.js")

if not os.path.exists(html_path) or not os.path.exists(js_path):
    print("Files not found.")
    exit(1)

html_content = open(html_path, "r", encoding="utf-8").read()
js_content = open(js_path, "r", encoding="utf-8").read()

html_ids = set(re.findall(r'id=["\']([^"\']+)["\']', html_content))
js_ids = set(re.findall(r'getElementById\(["\']([^"\']+)["\']\)', js_content))

print("=== IDs in index.html ===")
for hid in sorted(html_ids):
    print(f"HTML ID: {hid} - {'FOUND in app.js' if hid in js_content else 'MISSING'}")

print("\n=== IDs queried in app.js ===")
for jid in sorted(js_ids):
    print(f"JS ID: {jid} - {'FOUND in index.html' if jid in html_content else 'MISSING'}")
