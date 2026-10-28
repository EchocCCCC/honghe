@echo off
cd /d "%~dp0"
set "HONGHE_NODE=node"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "HONGHE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%HONGHE_NODE%" scripts/doctor.js
if errorlevel 1 (
  echo Please check Node 24, Poppler, Python with requirements-pdf.txt, and .env configuration.
  pause
  exit /b 1
)
"%HONGHE_NODE%" server/app.js
pause
