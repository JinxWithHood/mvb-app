@echo off
cd /d "%~dp0"
title Magdeburg Mobil - Wagenreihungs-Helfer
where python >nul 2>nul && (python wagenreihung_helfer.py) || (py wagenreihung_helfer.py)
pause
