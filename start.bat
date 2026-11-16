@echo off
rem Startet ComfyUI (falls nicht schon an), Backend und Web, dann den Browser. Pfad zu ComfyUI: COMFY_DIR in app\.env
setlocal
cd /d "%~dp0app"
rem Portables Node von install.bat zuerst; corepack holt pnpm ohne globale Installation.
if exist "runtime\node\node.exe" set "PATH=%~dp0app\runtime\node;%PATH%"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
if not exist "node_modules" (
  echo Brennglas ist noch nicht eingerichtet - bitte zuerst install.bat starten.
  pause
  exit /b 1
)

if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="COMFY_DIR" set "COMFY_DIR=%%b"

call :listening 8188
if not errorlevel 1 (
  echo ComfyUI laeuft schon.
) else if not defined COMFY_DIR (
  echo COMFY_DIR fehlt in app\.env - ComfyUI bitte selbst starten.
) else if not exist "%COMFY_DIR%\python_embeded\python.exe" (
  echo Kein ComfyUI unter "%COMFY_DIR%" - Pfad in app\.env pruefen.
) else (
  echo Starte ComfyUI ...
  start "ComfyUI" /d "%COMFY_DIR%" "%COMFY_DIR%\python_embeded\python.exe" -s ComfyUI\main.py --windows-standalone-build --disable-auto-launch
)

call :listening 3000
if not errorlevel 1 (
  echo Brennglas laeuft schon.
) else (
  echo Starte Brennglas ...
  start "Brennglas" cmd /k corepack pnpm dev
)

rem Das Backend verbindet sich selbst, sobald ComfyUI oben ist - warten nur auf die Weboberflaeche.
for /l %%i in (1,1,60) do (
  call :listening 5173
  if not errorlevel 1 goto open
  timeout /t 1 /nobreak >nul
)
echo Weboberflaeche nicht erreichbar - Fenster "Brennglas" pruefen.
pause
exit /b 1

:open
start "" http://127.0.0.1:5173
exit /b 0

:listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
exit /b %errorlevel%
