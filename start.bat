@echo off
rem Starts ComfyUI (unless already running), backend and web, then the browser. ComfyUI folder: COMFY_DIR in app\.env
setlocal
cd /d "%~dp0app"
rem Portable Node from install.bat first; corepack fetches pnpm without a global install.
if exist "runtime\node\node.exe" set "PATH=%~dp0app\runtime\node;%PATH%"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
if not exist "node_modules" (
  echo Brennglas is not set up yet - please run install.bat first.
  pause
  exit /b 1
)

set "PORT=3000"
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="COMFY_DIR" set "COMFY_DIR=%%~b"
  if /i "%%a"=="PORT" set "PORT=%%~b"
)

call :listening 8188
if not errorlevel 1 (
  echo ComfyUI is already running.
) else if not defined COMFY_DIR (
  echo COMFY_DIR is missing in app\.env - please start ComfyUI yourself.
) else if not exist "%COMFY_DIR%\python_embeded\python.exe" (
  echo No ComfyUI in "%COMFY_DIR%" - check the path in app\.env.
) else (
  echo Starting ComfyUI ...
  start "ComfyUI" /d "%COMFY_DIR%" "%COMFY_DIR%\python_embeded\python.exe" -s ComfyUI\main.py --windows-standalone-build --disable-auto-launch
)

call :listening %PORT%
if not errorlevel 1 (
  echo Brennglas is already running.
) else (
  echo Starting Brennglas ...
  rem Direkt -r statt "pnpm dev": das Skript dev riefe pnpm ohne corepack auf, das fehlt ohne globales pnpm
  start "Brennglas" cmd /k corepack pnpm -r --parallel dev
)

rem Wait for web and backend (the page fails without the backend); ComfyUI is joined later by the backend itself.
echo Waiting for the web interface and the backend ...
for /l %%i in (1,1,60) do (
  call :listening 5173
  if not errorlevel 1 (
    call :listening %PORT%
    if not errorlevel 1 goto open
  )
  timeout /t 1 /nobreak >nul
)
echo Brennglas not reachable - check the "Brennglas" window.
pause
exit /b 1

:open
start "" http://127.0.0.1:5173
exit /b 0

:listening
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
exit /b %errorlevel%
