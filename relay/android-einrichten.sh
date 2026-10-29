#!/data/data/com.termux/files/usr/bin/bash
# Magdeburg Mobil – Wagenreihungs-Helfer auf dem Android-Handy einrichten (in der App „Termux“)
#
# Einmal in Termux eintippen:
#   curl -fsSL https://raw.githubusercontent.com/JinxWithHood/mvb-app/main/relay/android-einrichten.sh | bash
#
# Danach holt dein Handy die Wagenreihung über sein eigenes Netz (WLAN oder mobil) –
# bahn.de sperrt nur Rechenzentren, normale Handy-Anschlüsse nicht.
set -e
echo "== Wagenreihungs-Helfer für Android =="
pkg install -y python curl termux-api >/dev/null 2>&1 || pkg install -y python curl
mkdir -p "$HOME/mvb-helfer"
cd "$HOME/mvb-helfer"
curl -fsSLo wagenreihung_helfer.py https://raw.githubusercontent.com/JinxWithHood/mvb-app/main/relay/wagenreihung_helfer.py

# Autostart nach dem Neustart des Handys (braucht die App „Termux:Boot“, einmal öffnen)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/mvb-helfer.sh" <<'EOS'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$HOME/mvb-helfer" && python wagenreihung_helfer.py >> helfer.log 2>&1
EOS
chmod +x "$HOME/.termux/boot/mvb-helfer.sh"

# kurzer Befehl zum Starten
cat > "$PREFIX/bin/mvb-helfer" <<'EOS'
#!/data/data/com.termux/files/usr/bin/sh
cd "$HOME/mvb-helfer" && exec python wagenreihung_helfer.py
EOS
chmod +x "$PREFIX/bin/mvb-helfer"

echo
echo "Fertig! Starte den Helfer jetzt mit:   mvb-helfer"
echo "Beim ersten Start fragt er nach dem Schlüssel (FORMATION_RELAY_KEY von Render)."
echo "Tipp: In den Android-Einstellungen für Termux den Akku auf „Nicht optimieren“ stellen."
