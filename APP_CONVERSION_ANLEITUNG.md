# Anleitung: MVB Portal als App verpacken & Google Sites Integration

Dieses Dokument beschreibt Schritt für Schritt, wie Sie dieses Webportal (HTML, CSS, JS + Python-Backend) in eine native Mobil-App (Android/iOS) konvertieren und es auf einer Google-Site (oder anderen Web-Plattformen) skalierbar einbetten.

---

## 1. Google Sites Integration (Skalierung & Desktop Version)

Da Google Sites hauptsächlich als Portal dient, können Sie die Web-App per **IFrame** oder direkte **Code-Einbettung** integrieren.

### Web-App responsiv einbetten:
1. Öffnen Sie Ihre Google Site im Bearbeitungsmodus.
2. Wählen Sie im rechten Menü **Einbetten** (`Embed`).
3. Wählen Sie **Einbettungscode** (`Embed code`).
4. Fügen Sie folgenden HTML-IFrame-Code ein (passen Sie die `src` auf die URL Ihres gehosteten Webservers an):
   ```html
   <iframe src="https://ihre-mvb-app-url.de" 
           style="width:100%; height:800px; border:none; border-radius:12px;" 
           allow="geolocation" 
           loading="lazy">
   </iframe>
   ```
5. **Skalierung & Mobile Ansicht**: Google Sites skaliert eingebettete IFrames automatisch. Die in `styles.css` definierten CSS-Media-Queries `@media (max-width: 991px)` sorgen dafür, dass sich das Layout auf Smartphones automatisch in eine App-ähnliche Ansicht verwandelt und auf Desktop-Monitoren in die übersichtliche Zwei-Spalten-Ansicht.

---

## 2. Option A: Umwandlung in eine Progressive Web App (PWA)

Eine PWA ist die einfachste und modernste Methode, um eine Website direkt auf dem Smartphone als App zu installieren – ohne App-Stores.

1. **Manifest-Datei erstellen (`manifest.json`)**:
   Erstellen Sie eine Datei namens `manifest.json` im Hauptverzeichnis der App:
   ```json
   {
     "name": "MVB Sanduhr Portal",
     "short_name": "MVB Sanduhr",
     "description": "Premium Echtzeit-Verbindungsinfo für Magdeburg & Deutschland",
     "start_url": "/index.html",
     "display": "standalone",
     "background_color": "#f4f6fa",
     "theme_color": "#00675A",
     "orientation": "portrait-primary",
     "icons": [
       {
         "src": "hourglass_logo.png",
         "sizes": "192x192",
         "type": "image/png"
       }
     ]
   }
   ```
2. **Manifest in `index.html` einbinden**:
   Fügen Sie Folgendes im `<head>`-Bereich Ihrer `index.html` hinzu:
   ```html
   <link rel="manifest" href="manifest.json">
   <meta name="theme-color" content="#00675A">
   <meta name="apple-mobile-web-app-capable" content="yes">
   ```
3. **Service Worker registrieren**:
   Erstellen Sie eine leere `sw.js` und registrieren Sie sie am Ende von `app.js`:
   ```javascript
   if ('serviceWorker' in navigator) {
       navigator.serviceWorker.register('/sw.js')
           .then(() => console.log("PWA Service Worker registriert"));
   }
   ```
Jetzt erscheint auf jedem Smartphone beim Aufruf der Seite ein "Zum Startbildschirm hinzufügen"-Button.

---

## 3. Option B: Native App erstellen mit Capacitor (Empfohlen)

Mit **Capacitor** (von den Machern von Ionic) können Sie Ihr HTML/JS-Frontend in ein echtes Android- und iOS-Projekt (mit Android Studio bzw. Xcode) konvertieren.

### Voraussetzungen:
- Node.js auf Ihrem Computer installiert.
- Android Studio (für Android) und Xcode (für iOS, benötigt macOS).

### Schritte:
1. **Projekt initialisieren**:
   Führen Sie im Projektverzeichnis aus:
   ```bash
   npm init -y
   npm install @capacitor/core @capacitor/cli
   ```
2. **Capacitor konfigurieren**:
   Initialisieren Sie Capacitor:
   ```bash
   npx cap init "MVB Sanduhr" "de.mvbsanduhr.app" --web-dir=.
   ```
3. **Plattformen hinzufügen**:
   Fügen Sie die gewünschten Plattformen hinzu:
   ```bash
   npm install @capacitor/android @capacitor/ios
   npx cap add android
   npx cap add ios
   ```
4. **App bauen & synchronisieren**:
   Wann immer Sie Änderungen an Ihren Web-Dateien vornehmen, synchronisieren Sie diese:
   ```bash
   npx cap sync
   ```
5. **Projekt in Android Studio / Xcode öffnen**:
   Öffnen Sie das native Projekt, um es auf dem Smartphone zu testen oder ein APK/IPA zu generieren:
   ```bash
   npx cap open android
   npx cap open ios
   ```
   *Tipp*: Damit die App zur Laufzeit Daten von Ihrem Python-Backend laden kann, stellen Sie sicher, dass in `app.js` die Backend-URL auf Ihre öffentlich erreichbare Server-IP/Domain (z.B. `https://api.ihre-mvb-app-url.de`) zeigt und nicht auf `localhost`.
