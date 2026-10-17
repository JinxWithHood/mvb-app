@echo off
title Magdeburg Mobil - Server
cd /d "%~dp0"
set "PY=python"
where python >NUL 2>NUL || set "PY=py"
echo Pruefe Python-Pakete...
%PY% -m pip install -r requirements.txt --quiet --disable-pip-version-check
echo.
echo Server startet auf http://127.0.0.1:5000  (Fenster offen lassen, Strg+C beendet)
echo.
start "" cmd /c "timeout /t 5 /nobreak >NUL & start http://127.0.0.1:5000/"
%PY% backend.py
echo.
echo Server wurde beendet.
pause
