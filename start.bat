@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [Reel Studio] First launch detected. Running setup...
  call npm run setup
  if errorlevel 1 (
    echo Setup failed. Please check Node.js 18+ and internet connection.
    pause
    exit /b 1
  )
)

echo [Reel Studio] Starting local server on http://127.0.0.1:4301 ...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:4301"
node server.mjs
