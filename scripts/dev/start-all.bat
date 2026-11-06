@echo off
cd /d "%~dp0\..\.."
echo Starting Enterprise Web Scraper (Backend + Frontend)...
echo.
echo Opening Backend Server in new window...
start "Backend Server" cmd /k "cd server && npm run dev"
timeout /t 2 /nobreak >nul
echo Opening Frontend Client in new window...
start "Frontend Client" cmd /k "cd client && npm run dev"
echo.
echo Both services are starting in separate windows.
echo Backend: http://localhost:3001
echo Frontend: http://localhost:3000
echo API Docs: http://localhost:3001/api-docs
echo.
pause
