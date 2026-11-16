@echo off
rem Modell-Installer: zeigt den Stand und laedt gewaehlte Modelle nach ComfyUI\models. Erneut starten fuegt weitere hinzu.
setlocal
cd /d "%~dp0app"
where node >nul 2>nul || (echo Node.js is missing. Install Node.js 22.18 or newer from https://nodejs.org/ & pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" || (echo Node.js 22.18 or newer is needed. Update it from https://nodejs.org/ & pause & exit /b 1)
node server\src\install\main.ts
pause
