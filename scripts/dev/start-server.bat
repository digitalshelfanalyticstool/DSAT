@echo off
cd /d "%~dp0\..\.."
echo Starting Enterprise Web Scraper Backend Server...
cd server
npm run dev
