@echo off
title محلل الأسهم - Stock Analyst
color 0A

echo.
echo  ========================================
echo   Stock Analyst - BAM Methodology
echo   محلل الأسهم الاحترافي
echo  ========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  [!] Node.js not found. Opening download page...
    echo  [!] Download from: https://nodejs.org  (LTS version)
    echo  [!] After installing, run this file again.
    start https://nodejs.org
    pause
    exit /b 1
)

echo  [OK] Node.js found:
node --version

:: Go to script directory
cd /d "%~dp0"

:: Install dependencies if needed
if not exist "node_modules\express" (
    echo.
    echo  [..] Installing dependencies (first time only)...
    npm install
    if errorlevel 1 (
        echo  [!!] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
)

echo.
echo  [OK] Starting server...
echo  [OK] Opening browser at http://localhost:3000
echo.
echo  Password: bam2024
echo.
echo  Keep this window open while using the app.
echo  Close it when done.
echo  ----------------------------------------

:: Open browser after 2 second delay
start "" "http://localhost:3000"
timeout /t 2 >nul

:: Start server
node server.js
pause
