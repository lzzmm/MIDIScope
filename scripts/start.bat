@echo off
rem midivis offline launcher (Windows).
rem Tries the bundled static-web-server binary first, then falls back to
rem python, then `npx serve`.

setlocal
cd /d "%~dp0\.."

if "%MIDIVIS_PORT%"=="" set MIDIVIS_PORT=5173
set URL=http://127.0.0.1:%MIDIVIS_PORT%/

set BIN=vendor\serve-win-x64.exe

if exist "%BIN%" (
  echo [midivis] Serving %cd% on %URL%
  start "" "%URL%"
  "%BIN%" --root "%cd%" --port %MIDIVIS_PORT% --host 127.0.0.1
  goto end
)

where python >nul 2>nul
if not errorlevel 1 (
  echo [midivis] Serving %cd% on %URL%  (python http.server)
  start "" "%URL%"
  python -m http.server %MIDIVIS_PORT% --bind 127.0.0.1
  goto end
)

where py >nul 2>nul
if not errorlevel 1 (
  echo [midivis] Serving %cd% on %URL%  (py http.server)
  start "" "%URL%"
  py -m http.server %MIDIVIS_PORT% --bind 127.0.0.1
  goto end
)

where npx >nul 2>nul
if not errorlevel 1 (
  echo [midivis] Serving %cd% on %URL%  (npx serve)
  start "" "%URL%"
  npx --yes serve -l %MIDIVIS_PORT% .
  goto end
)

echo [midivis] Could not find a way to serve the files.
echo Tried: bundled static-web-server, python, npx serve.
echo.
echo Quick fixes:
echo   - Install Python 3 (https://www.python.org/) and re-run this script.
echo   - Or install Node.js (https://nodejs.org/) and re-run this script.
echo   - Or open the GitHub Pages URL of this project in your browser.
pause

:end
endlocal
