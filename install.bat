@echo off
rem Installer: Node (portabel, falls noetig), ComfyUI, Abhaengigkeiten, Modelle. Erneut starten ergaenzt nur, was fehlt.
setlocal
cd /d "%~dp0app"
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
if exist "runtime\node\node.exe" set "PATH=%~dp0app\runtime\node;%PATH%"
call :nodeok && goto run
echo Node.js 22.18 or newer was not found. Getting a portable copy just for Brennglas ...
powershell -NoProfile -ExecutionPolicy Bypass -File "server\src\install\node.ps1" -AppDir "%cd%"
if errorlevel 1 (echo Could not get Node.js. Install Node.js 24 from https://nodejs.org/ and run install.bat again. & pause & exit /b 1)
set "PATH=%~dp0app\runtime\node;%PATH%"
call :nodeok || (echo Node.js is still not usable. & pause & exit /b 1)
:run
node server\src\install\main.ts
pause
exit /b

:nodeok
where node >nul 2>nul || exit /b 1
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
exit /b %errorlevel%
