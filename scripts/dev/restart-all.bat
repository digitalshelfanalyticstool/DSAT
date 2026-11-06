@echo off
cd /d "%~dp0\..\.."
echo Restarting Enterprise Web Scraper (Backend + Frontend)...
echo.

echo Stopping existing processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1 && echo   Stopped backend (port 3001)
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1 && echo   Stopped frontend (port 3000)
)

timeout /t 2 /nobreak >nul
echo.

echo Opening Backend Server in new window...
start "Backend Server" cmd /k "cd server && npm run dev"
timeout /t 2 /nobreak >nul
echo Opening Frontend Client in new window...
start "Frontend Client" cmd /k "cd client && npm run dev"
echo.
echo Both services are restarting in separate windows.
echo Backend: http://localhost:3001
echo Frontend: http://localhost:3000
echo API Docs: http://localhost:3001/api-docs
echo.
pause
